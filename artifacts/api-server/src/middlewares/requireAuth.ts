import type { NextFunction, Request, Response } from "express";
import { getAuth, clerkClient } from "@clerk/express";
import { createPublicKey, createVerify } from "crypto";
import { and, eq, isNull, ne } from "drizzle-orm";
import { db, usersTable, playersTable, teamsTable, gamesTable, type User } from "@workspace/db";

declare global {
  namespace Express {
    interface Request {
      appUser?: User;
    }
  }
}

/** Module-level JWKS cache keyed by `iss`. Entries expire after 5 minutes. */
const jwksCache = new Map<string, { keys: Record<string, unknown>[]; fetchedAt: number }>();
const JWKS_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function fetchJwks(iss: string): Promise<Record<string, unknown>[]> {
  const jwksRes = await fetch(`${iss}/.well-known/jwks.json`);
  if (!jwksRes.ok) throw new Error(`JWKS fetch failed: ${jwksRes.status}`);
  const jwks = await jwksRes.json() as { keys: Record<string, unknown>[] };
  jwksCache.set(iss, { keys: jwks.keys, fetchedAt: Date.now() });
  return jwks.keys;
}

async function getJwkForKid(iss: string, kid: string): Promise<Record<string, unknown>> {
  const cached = jwksCache.get(iss);
  const now = Date.now();

  // Use cached keys if they are fresh.
  if (cached && now - cached.fetchedAt < JWKS_TTL_MS) {
    const jwk = cached.keys.find((k) => k["kid"] === kid);
    if (jwk) return jwk;
    // kid miss on a fresh cache — key rotation; fall through to refetch.
  }

  // Cache is cold, expired, or had a kid miss — fetch fresh JWKS.
  const keys = await fetchJwks(iss);
  const jwk = keys.find((k) => k["kid"] === kid);
  if (!jwk) throw new Error(`No JWK found for kid=${kid}`);
  return jwk;
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
  // instance (stecstats.stecco.org / clerk.stecstats.com). Older TestFlight
  // builds were compiled with the test key (immortal-swan-47.clerk.accounts.dev)
  // and send tokens that clerkMiddleware() rejects.  This block verifies those
  // tokens via the test instance's JWKS so that existing installs keep working
  // while the user rolls out a new build compiled with pk_live_...
  //
  // REMOVE THIS BLOCK once the new TestFlight binary (compiled with
  // pk_live_Y2xlcmsuc3RlY3N0YXRzLnN0ZWNjby5vcmck in eas.json) is live
  // and you've confirmed sign-in works from a device running that build.
  if (!clerkUserId) {
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

    if (token) {
      try {
        // Decode header (kid) and payload (iss) without verifying — signature
        // verification happens below via JWKS.
        const parts = token.split(".");
        if (parts.length !== 3) throw new Error("Malformed JWT");
        const header  = JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8")) as { kid?: string };
        const jwtBody = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as { iss?: string; exp?: number; sub?: string };
        const iss = jwtBody.iss ?? "";
        const kid = header.kid ?? "";

        // Only trust the specific legacy Replit-managed test instance that the
        // old TestFlight binary was compiled against.  Do NOT widen this to a
        // pattern like *.clerk.accounts.dev — any Clerk developer can create
        // their own dev instance under that domain and forge access.
        const LEGACY_ISS = "https://immortal-swan-47.clerk.accounts.dev";
        if (iss !== LEGACY_ISS) {
          throw new Error(`Untrusted iss: ${iss}`);
        }

        // Fetch JWKS from the pinned legacy instance (cached with 5-min TTL;
        // kid miss on a fresh cache triggers an immediate refetch for rotation).
        const jwk = await getJwkForKid(LEGACY_ISS, kid);

        // Manual RS256 signature verification — bypass Clerk's verifyToken
        // entirely so its iss-check against CLERK_PUBLISHABLE_KEY (the live
        // instance) can't interfere with tokens from immortal-swan-47.
        const publicKey = createPublicKey({ key: jwk as any, format: "jwk" });
        const signerInput = `${parts[0]}.${parts[1]}`;
        const sigBuffer = Buffer.from(parts[2]!, "base64url");
        const verifier = createVerify("SHA256");
        verifier.update(signerInput);
        const signatureValid = verifier.verify(publicKey, sigBuffer);
        if (!signatureValid) throw new Error("Invalid signature");

        // Validate standard claims manually.
        if ((jwtBody.exp ?? 0) < Date.now() / 1000) throw new Error("Token expired");

        clerkUserId = typeof jwtBody.sub === "string" ? jwtBody.sub : null;
        if (clerkUserId) {
          req.log?.info(
            { clerkUserId: clerkUserId.slice(0, 14) + "…", iss },
            "requireAuth: mobile token verified via JWKS fallback",
          );
        }
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        req.log?.warn({ verifyErr: errMsg }, "requireAuth: 401 — JWKS fallback failed");
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

    // A durable account-deletion tombstone may only be accessed by the retry
    // endpoint. This prevents a partially completed deletion from accepting
    // profile, roster, recording, or upload writes that would recreate data.
    if (user?.deletionPending) {
      if (req.method === "DELETE" && req.path === "/users/me") {
        req.appUser = user;
        next();
        return;
      }
      res.status(409).json({ error: "Account deletion is in progress" });
      return;
    }

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
