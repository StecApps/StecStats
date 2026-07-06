import type { NextFunction, Request, Response } from "express";
import { getAuth } from "@clerk/express";
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
      const [inserted] = await db
        .insert(usersTable)
        .values({ clerkUserId })
        .onConflictDoNothing()
        .returning();
      user =
        inserted ??
        (await db.query.usersTable.findFirst({
          where: eq(usersTable.clerkUserId, clerkUserId),
        }));

      // Claim any still-unowned legacy rows (created before accounts existed)
      // for whichever account signs in first. This is self-limiting: once
      // claimed, no more NULL-owner rows remain, so it's a cheap no-op for
      // every subsequent signup. We only attempt this when we actually
      // inserted a brand-new user row, not on a lookup of an existing one.
      if (inserted) {
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
