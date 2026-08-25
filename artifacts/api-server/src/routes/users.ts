import { Router } from "express";
import {
  db,
  feedbackTable,
  gamesTable,
  playersTable,
  purchaseEventsTable,
  teamsTable,
  usersTable,
} from "@workspace/db";
import { requireAuth } from "../middlewares/requireAuth";
import { clerkClient } from "@clerk/express";
import { ObjectStorageService } from "../lib/objectStorage";
import { decryptToken } from "../lib/tokenEncryption";
import { revokeToken } from "../lib/youtubeClient";
import {
  cancelOwnerMediaDeletion,
} from "../lib/highlightGenerator";
import { eq } from "drizzle-orm";

const EXPO_PUSH_TOKEN_RE = /^ExponentPushToken\[.+\]$/;

const router = Router();
const objectStorageService = new ObjectStorageService();

/**
 * Silently sync our DB-stored firstName/lastName back into Clerk so the
 * Clerk `user.firstName` fallback in the mobile greeting is also correct.
 *
 * We do this fire-and-forget — a failure never blocks the response.
 */
async function syncNameToClerk(
  clerkUserId: string,
  firstName: string | null | undefined,
  lastName: string | null | undefined,
): Promise<void> {
  try {
    await clerkClient.users.updateUser(clerkUserId, {
      firstName: firstName ?? "",
      lastName: lastName ?? "",
    });
  } catch {
    // Non-fatal — Replit-managed Clerk may reject writes in some configs.
  }
}

// GET /api/users/me — return the stored first/last name for the current user
router.get("/users/me", requireAuth, async (req, res) => {
  const user = req.appUser!;
  // Prevent Express from returning 304 "Not Modified" for this route.
  // A 304 carries no body — our customFetch returns null for it — so React
  // Query stores null and the greeting falls back to Clerk's stale name.
  // Deleting If-None-Match before res.json() stops Express from doing the
  // ETag comparison; Cache-Control: no-store tells the client not to cache.
  delete (req.headers as Record<string, unknown>)["if-none-match"];
  res.set("Cache-Control", "no-store");
  res.json({
    firstName: user?.firstName ?? null,
    lastName: user?.lastName ?? null,
  });

  // Fire-and-forget: keep Clerk's firstName in sync with our DB so that
  // even the Clerk-fallback path in the mobile greeting shows the right name.
  if (user?.firstName) {
    void syncNameToClerk(
      req.appUser!.clerkUserId,
      user.firstName,
      user.lastName,
    );
  }
});

// PUT /api/users/me/push-token — store or update the Expo push token for push
// notifications (e.g. "Your highlights are ready"). Called once at app launch
// after notification permission is granted.
router.put("/users/me/push-token", requireAuth, async (req, res) => {
  const { token } = req.body ?? {};

  if (typeof token !== "string" || !EXPO_PUSH_TOKEN_RE.test(token)) {
    res.status(400).json({ error: "token must be a valid ExponentPushToken[…] string" });
    return;
  }

  await db
    .update(usersTable)
    .set({ pushToken: token })
    .where(eq(usersTable.id, req.appUser!.id));

  res.status(204).send();
});

// PATCH /api/users/me — store first/last name
// (Replit-managed Clerk instance rejects firstName/lastName writes from client SDK)
router.patch("/users/me", requireAuth, async (req, res) => {
  const { firstName, lastName } = req.body ?? {};

  if (typeof firstName !== "undefined" && (typeof firstName !== "string" || firstName.trim().length < 1)) {
    res.status(400).json({ error: "firstName must be a non-empty string" });
    return;
  }

  const update: Partial<Pick<typeof usersTable.$inferInsert, "firstName" | "lastName">> = {};
  if (typeof firstName === "string") update.firstName = firstName.trim();
  if (typeof lastName === "string") update.lastName = lastName.trim() || null;

  const [updated] = await db
    .update(usersTable)
    .set(update)
    .where(eq(usersTable.id, req.appUser!.id))
    .returning();

  const appUser = req.appUser!;

  res.json({
    firstName: updated.firstName ?? null,
    lastName: updated.lastName ?? null,
  });

  // Also push the new name into Clerk so the mobile fallback stays correct.
  void syncNameToClerk(
    req.appUser!.clerkUserId,
    updated.firstName,
    updated.lastName,
  );
});

/**
 * DELETE /api/users/me — permanently remove the caller's account and data.
 *
 * A subscription is not cancelled here: StoreKit subscriptions are managed in
 * Apple Account Settings. Deleting the account removes the application's data
 * and sign-in identity.
 */
router.delete("/users/me", requireAuth, async (req, res) => {
  const user = req.appUser!;
  const authenticatedClerkUserId = req.authenticatedClerkUserId;

  if (!authenticatedClerkUserId || authenticatedClerkUserId !== user.clerkUserId) {
    res.status(409).json({
      error: "This account is linked to a different sign-in identity. Sign in with the original identity to delete it.",
    });
    return;
  }

  let deletionMarked = false;

  try {
    // Persist the write barrier before looking up media. A failed prefix sweep
    // can delete some objects, so the account must be quarantined rather than
    // resumed as an otherwise active account with missing recordings.
    if (user.deletionStatus !== "deleting") {
      await db
        .update(usersTable)
        .set({ deletionStatus: "deleting", deletionStartedAt: new Date() })
        .where(eq(usersTable.id, user.id));
    }
    deletionMarked = true;

    // Capture all known media paths before removing the database records. The
    // upload namespace sweep below also catches abandoned uploads and encoding
    // chunks that were never linked to a completed game.
    const [games, account] = await Promise.all([
      db.query.gamesTable.findMany({
        where: eq(gamesTable.ownerId, user.id),
        columns: {
          id: true,
          videoObjectPath: true,
          highlightObjectPath: true,
          lowlightObjectPath: true,
          videoProxyObjectPath: true,
        },
      }),
      db.query.usersTable.findFirst({
        where: eq(usersTable.id, user.id),
        columns: { youtubeRefreshToken: true, pendingUploadExpiresAt: true },
      }),
    ]);

    // Stop background encodes before deleting their objects. The upload guard
    // closes the cancellation race so a reel/proxy cannot recreate media after
    // the namespace sweep.
    cancelOwnerMediaDeletion(user.id, games.map((game) => game.id));

    // A direct GCS PUT URL cannot be revoked after it is issued. The upload
    // route reserves each URL in the user row for only 30 seconds, so wait out
    // the latest capability before the final sweep. The durable deleting state
    // prevents any replacement URL from being issued during this window.
    const pendingUploadDelayMs = Math.max(
      0,
      (account?.pendingUploadExpiresAt?.getTime() ?? 0) - Date.now(),
    );
    if (pendingUploadDelayMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, pendingUploadDelayMs));
    }

    // A single namespace sweep catches both linked and orphaned media. It is
    // idempotent but not atomic, so failures intentionally leave the durable
    // deletion barrier in place; retrying this endpoint sweeps the namespace
    // again without exposing a partially-cleaned account.
    await objectStorageService.deleteObjectEntityPrefix(`/objects/uploads/${user.id}/`);

    // Complete the local transaction before removing the Clerk identity. A
    // database failure must leave the caller's sign-in identity intact so they
    // can retry; deleting Clerk first would strand inaccessible retained data.
    await db.transaction(async (tx) => {
      // Account-level feedback and purchase-event records contain the user's
      // identity, so delete rather than orphaning them.
      await tx.delete(feedbackTable).where(eq(feedbackTable.userId, user.id));
      await tx.delete(purchaseEventsTable).where(eq(purchaseEventsTable.userId, user.id));

      // Game event and stat rows cascade from games. Delete games first so
      // player/team deletion cannot leave cross-references behind.
      await tx.delete(gamesTable).where(eq(gamesTable.ownerId, user.id));
      await tx.delete(playersTable).where(eq(playersTable.ownerId, user.id));
      await tx.delete(teamsTable).where(eq(teamsTable.ownerId, user.id));
      // Keep a scrubbed tombstone until Clerk removal succeeds. It prevents
      // requireAuth from provisioning a new writable account if the identity
      // service is temporarily unavailable after local cleanup.
      await tx
        .update(usersTable)
        .set({
          email: null,
          stripeCustomerId: null,
          youtubeRefreshToken: null,
          revenueCatEntitlement: null,
          firstName: null,
          lastName: null,
          pushToken: null,
          pendingUploadExpiresAt: null,
          deletionStatus: "deleting",
        })
        .where(eq(usersTable.id, user.id));
    });

    // Revoke the separate Google authorization only after local cleanup has
    // committed. If storage or the transaction fails, the retained account
    // keeps its YouTube connection unchanged and can safely retry deletion.
    // A revoke failure is non-fatal: the local token is already gone and the
    // user must not be stranded after their account data has been deleted.
    if (account?.youtubeRefreshToken) {
      try {
        await revokeToken(decryptToken(account.youtubeRefreshToken));
      } catch (err) {
        req.log?.warn({ err, userId: user.id }, "Could not revoke YouTube authorization");
      }
    }

    try {
      await clerkClient.users.deleteUser(user.clerkUserId);
    } catch (err: any) {
      if (err?.status === 404 || err?.statusCode === 404) {
        // The account was already removed from Clerk; the scrubbed local
        // tombstone is harmless and prevents stale jobs from writing media.
      } else {
        throw err;
      }
    }

    res.status(204).send();
  } catch (err) {
    req.log?.error({ err, userId: user.id }, "Account deletion failed");
    if (deletionMarked) {
      res.status(503).json({
        error: "Account deletion is still being finalized. Please retry shortly; your account remains unavailable while cleanup completes.",
      });
      return;
    }
    res.status(500).json({ error: "Could not delete your account. Please try again." });
  }
});

export default router;
