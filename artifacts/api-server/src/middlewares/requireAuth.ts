import type { NextFunction, Request, Response } from "express";
import { getAuth, clerkClient, verifyToken } from "@clerk/express";
import { createPublicKey } from "crypto";
import { eq, isNull } from "drizzle-orm";
import { db, usersTable, playersTable, teamsTable, gamesTable, type User } from "@workspace/db";

// ---------------------------------------------------------------------------
// Mobile Clerk instance JWKS cache
//
// The mobile app uses EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY (test instance) which
// Replit does NOT auto-swap on publish. The server's clerkMiddleware() uses the
// live instance (auto-swapped). We verify mobile Bearer tokens manually using
// JWKS fetched from the token's own iss URL so no separate secret is needed.
// ---------------------------------------------------------------------------
interface JwkEntry { pem: string; }
const jwksCache = new Map<string, { keys: Map<string, JwkEntry>; fetchedAt: number }>();
const JWKS_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function getPemForToken(token: string): Promise<string | null> {
  // Decode header to get kid + alg, payload to get iss.
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    header  = JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8"));
    payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
  } catch { return null; }

  const kid = typeof header["kid"] === "string" ? header["kid"] : null;
  const iss = typeof payload["iss"] === "string" ? payload["iss"] : null;
  if (!kid || !iss) return null;

  // Only trust the test/mobile Clerk instance (from EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY).
  // Derive the expected FAPI host from the publishable key so we never blindly
  // fetch JWKS from an untrusted iss value.
  const mobilePubKey = process.env["EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY"] ?? "";
  const b64 = mobilePubKey.replace(/^pk_(test|live)_/, "").replace(/\$?$/, "");
  let trustedFapi: string | null = null;
  try { trustedFapi = Buffer.from(b64, "base64").toString("utf8").replace(/\$$/, ""); } catch { /* ignore */ }
  if (!trustedFapi || !iss.includes(trustedFapi)) return null;

  // Check cache.
  const cached = jwksCache.get(iss);
  if (cached && Date.now() - cached.fetchedAt < JWKS_TTL_MS) {
    return cached.keys.get(kid)?.pem ?? null;
  }

  // Fetch fresh JWKS.
  try {
    const res = await fetch(`${iss}/.well-known/jwks.json`);
    if (!res.ok) return null;
    const json = await res.json() as { keys?: unknown[] };
    const keyMap = new Map<string, JwkEntry>();
    for (const jwk of json.keys ?? []) {
      if (!jwk || typeof jwk !== "object") continue;
      const j = jwk as Record<string, unknown>;
      const kId = typeof j["kid"] === "string" ? j["kid"] : null;
      if (!kId) continue;
      try {
        const pem = createPublicKey({ key: j as Parameters<typeof createPublicKey>[0], format: "jwk" })
          .export({ type: "spki", format: "pem" }) as string;
        keyMap.set(kId, { pem });
      } catch { /* skip unrecognized key */ }
    }
    jwksCache.set(iss, { keys: keyMap, fetchedAt: Date.now() });
    return keyMap.get(kid)?.pem ?? null;
  } catch { return null; }
}

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

  // Fallback: if the primary clerkMiddleware (live Clerk instance) didn't
  // authenticate the request but a Bearer token is present, try verifying it
  // against the mobile/test Clerk instance (EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY).
  //
  // Why this is needed: Replit auto-swaps CLERK_PUBLISHABLE_KEY to a live key
  // on publish, but EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY is a user-set secret that
  // stays as the test key. Mobile Bearer tokens come from the test Clerk
  // instance; the live-instance clerkMiddleware rejects them. This fallback
  // verifies them directly so no new app build is required.
  if (!clerkUserId) {
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

    if (token) {
      try {
        const pem = await getPemForToken(token);
        if (pem) {
          const mobilePayload = await verifyToken(token, { jwtKey: pem });
          clerkUserId = mobilePayload.sub ?? null;
          if (clerkUserId) {
            req.log?.info({ clerkUserId: clerkUserId.slice(0, 14) + '…' },
              'requireAuth: mobile token verified via EXPO instance JWKS');
          }
        } else {
          // Token iss doesn't match the trusted mobile instance — log and fall through to 401.
          const parts = token.split('.');
          if (parts.length === 3) {
            try {
              const p = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'));
              req.log?.warn({
                jwtIss: p.iss,
                jwtSub: typeof p.sub === 'string' ? p.sub.slice(0, 14) + '…' : null,
                jwtExp: p.exp,
                jwtExpired: p.exp < Date.now() / 1000,
                secondsToExpiry: Math.round(p.exp - Date.now() / 1000),
              }, 'requireAuth: 401 — JWT payload (iss not in trusted mobile instance)');
            } catch { /* ignore */ }
          }
        }
      } catch (err: any) {
        req.log?.warn({ verifyErr: err?.message ?? String(err) },
          'requireAuth: 401 — mobile verifyToken failed');
      }
    } else {
      req.log?.warn({ hasAuthHeader: !!req.headers.authorization },
        'requireAuth: 401 — no Bearer token');
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
