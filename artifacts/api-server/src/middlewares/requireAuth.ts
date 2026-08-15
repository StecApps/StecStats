import type { NextFunction, Request, Response } from "express";
import { getAuth, clerkClient, verifyToken } from "@clerk/express";
import { and, eq, isNull, ne } from "drizzle-orm";
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
 *
 * IMPORTANT — intentional per-request DB read:
 * The `users` row (including `revenueCatEntitlement` and `stripeCustomerId`)
 * is re-fetched from the database on every authenticated request. Do NOT
 * replace this with a session-level cache or an in-memory map. A RevenueCat
 * EXPIRATION/BILLING_ISSUE webhook can revoke a mobile subscription at any
 * time; caching would let a user whose subscription just expired continue
 * accessing premium features until the server restarts. The per-request DB
 * read is the guarantee that revoked entitlements are honoured immediately.
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  let clerkUserId = getAuth(req)?.userId ?? null;

  // Fallback: the primary clerkMiddleware() is configured for the live Clerk
  // instance. Mobile Bearer tokens come from the Replit-managed test instance
  // (EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY). When the live middleware rejects them,
  // verify directly against the mobile instance's JWKS so no new app build is
  // required to restore access.
  if (!clerkUserId) {
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

    if (token) {
      const mobilePubKey = process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY;
      if (mobilePubKey) {
        try {
          const payload = await verifyToken(token, { publishableKey: mobilePubKey } as any);
          clerkUserId = payload.sub ?? null;
          if (clerkUserId) {
            req.log?.info(
              { clerkUserId: clerkUserId.slice(0, 14) + "…" },
              "requireAuth: mobile token verified via EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY",
            );
          }
        } catch (err: unknown) {
          // Log why the mobile fallback also failed — helps diagnose instance mismatches.
          try {
            const parts = token.split(".");
            if (parts.length === 3) {
              const p = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
              req.log?.warn(
                {
                  jwtIss: p.iss,
                  jwtExp: p.exp,
                  jwtExpired: p.exp < Date.now() / 1000,
                  verifyErr: err instanceof Error ? err.message : String(err),
                },
                "requireAuth: 401 — mobile verifyToken also failed",
              );
            }
          } catch { /* ignore decode errors */ }
        }
      } else {
        req.log?.warn({}, "requireAuth: 401 — Bearer token present but EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY not set");
      }
    } else {
      req.log?.warn({ hasAuthHeader: !!authHeader }, "requireAuth: 401 — no Bearer token");
    }
  }

  if (!clerkUserId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    let user = await db.query.usersTable.findFirst({
      where: eq(usersTable.clerkUserId, clerkUserId),
    });

    let email: string | null = user?.email ?? null;

    // Look up the account's email from Clerk when we don't already have it
    // locally (brand-new user, or an existing row predating the email
    // column) so we can identify whether this is the designated project
    // owner below — never trust a client-supplied email for this decision.
    if (!email) {
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
    }

    if (!user) {
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
    } else if (email && user.email !== email) {
      // Backfill the email column for a pre-existing row that predates it.
      await db.update(usersTable).set({ email }).where(eq(usersTable.id, user.id));
      user = { ...user, email };
    }

    // One-time legacy backfill: pre-existing STEC data (created before
    // accounts existed) is assigned to the designated project owner only —
    // never to whichever account happens to sign in first. Runs regardless
    // of whether this is the owner's first-ever login or a later one (the
    // owner's local `users` row may already exist from an earlier phase),
    // and is self-limiting: once claimed, no NULL-owner rows remain, so the
    // existence check below makes it a cheap no-op afterward.
    if (user) {
      const ownerEmail = process.env.OWNER_CLERK_EMAIL;
      const isDesignatedOwner =
        !!ownerEmail && !!email && email.toLowerCase() === ownerEmail.toLowerCase();

      if (isDesignatedOwner) {
        const unclaimed = await db
          .select({ id: playersTable.id })
          .from(playersTable)
          .where(isNull(playersTable.ownerId))
          .limit(1)
          .union(
            db
              .select({ id: teamsTable.id })
              .from(teamsTable)
              .where(isNull(teamsTable.ownerId))
              .limit(1),
          )
          .union(
            db
              .select({ id: gamesTable.id })
              .from(gamesTable)
              .where(isNull(gamesTable.ownerId))
              .limit(1),
          );

        if (unclaimed.length > 0) {
          const ownerId = user.id;
          await db.transaction(async (tx) => {
            await tx
              .update(playersTable)
              .set({ ownerId })
              .where(isNull(playersTable.ownerId));
            await tx
              .update(teamsTable)
              .set({ ownerId })
              .where(isNull(teamsTable.ownerId));
            await tx
              .update(gamesTable)
              .set({ ownerId })
              .where(isNull(gamesTable.ownerId));
          });
        }
      }
    }

    // If this user record has an email that matches another existing user (e.g. the
    // same person authenticated via a different Clerk instance — mobile test vs web
    // live), use the primary account (lower id) so both surfaces share the same data.
    if (user && email) {
      const primaryUser = await db.query.usersTable.findFirst({
        where: and(eq(usersTable.email, email), ne(usersTable.id, user.id)),
        orderBy: (u, { asc }) => [asc(u.id)],
      });
      if (primaryUser) {
        req.log?.info(
          { secondaryId: user.id, primaryId: primaryUser.id },
          "requireAuth: mapped secondary Clerk account to primary user by email",
        );
        user = primaryUser;
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
