import type { NextFunction, Request, Response } from "express";
import { getAuth, clerkClient } from "@clerk/express";
import { eq, isNull } from "drizzle-orm";
import { db, usersTable, playersTable, teamsTable, gamesTable, type User } from "@workspace/db";

declare global {
  namespace Express {
    interface Request {
      appUser?: User;
    }
  }
}

/**
 * Requires a valid Clerk session. On success, JIT-provisions (or looks up) a
 * local `users` row mirroring the Clerk user id and attaches it to
 * `req.appUser` — this gives other tables a stable local id to reference for
 * per-account data ownership in a later phase, without this phase needing to
 * scope any existing data by it yet.
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const auth = getAuth(req);
  const clerkUserId = auth?.userId;
  if (!clerkUserId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    let user = await db.query.usersTable.findFirst({
      where: eq(usersTable.clerkUserId, clerkUserId),
    });

    if (!user) {
      // Look up the account's email from Clerk so we can identify whether
      // this is the designated project owner (see below) — never trust a
      // client-supplied email for this decision.
      let email: string | null = null;
      try {
        const clerkUser = await clerkClient.users.getUser(clerkUserId);
        email =
          clerkUser.emailAddresses.find(
            (e) => e.id === clerkUser.primaryEmailAddressId,
          )?.emailAddress ??
          clerkUser.emailAddresses[0]?.emailAddress ??
          null;
      } catch (err) {
        req.log?.warn({ err, clerkUserId }, "Failed to fetch Clerk user email");
      }

      const [inserted] = await db
        .insert(usersTable)
        .values({ clerkUserId, email })
        .onConflictDoNothing()
        .returning();
      user =
        inserted ??
        (await db.query.usersTable.findFirst({
          where: eq(usersTable.clerkUserId, clerkUserId),
        }));

      // One-time legacy backfill: pre-existing STEC data (created before
      // accounts existed) is assigned to the designated project owner only —
      // never to whichever account happens to sign in first. This is
      // self-limiting: once claimed, no NULL-owner rows remain, so it's a
      // no-op for every other signup, including future signups by the owner.
      const ownerEmail = process.env.OWNER_CLERK_EMAIL;
      const isDesignatedOwner =
        inserted &&
        !!ownerEmail &&
        !!email &&
        email.toLowerCase() === ownerEmail.toLowerCase();

      if (isDesignatedOwner) {
        await db.transaction(async (tx) => {
          await tx
            .update(playersTable)
            .set({ ownerId: inserted.id })
            .where(isNull(playersTable.ownerId));
          await tx
            .update(teamsTable)
            .set({ ownerId: inserted.id })
            .where(isNull(teamsTable.ownerId));
          await tx
            .update(gamesTable)
            .set({ ownerId: inserted.id })
            .where(isNull(gamesTable.ownerId));
        });
      }
    }

    if (!user) {
      req.log?.error({ clerkUserId }, "Failed to provision or locate local user record");
      res.status(500).json({ error: "Failed to resolve authenticated user" });
      return;
    }

    req.appUser = user;
    next();
  } catch (error) {
    req.log?.error({ err: error }, "Failed to resolve authenticated user");
    res.status(500).json({ error: "Failed to resolve authenticated user" });
  }
}
