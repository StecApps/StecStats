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
import { eq } from "drizzle-orm";
import { requireAuth } from "../middlewares/requireAuth";
import { clerkClient } from "@clerk/express";
import { ObjectStorageService } from "../lib/objectStorage";
import { decryptToken } from "../lib/tokenEncryption";
import { revokeToken } from "../lib/youtubeClient";
import {
  cancelOwnerMediaDeletion,
  resumeOwnerMediaWrites,
} from "../lib/highlightGenerator";

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
  const user = await db.query.usersTable.findFirst({
    where: eq(usersTable.id, req.appUser!.id),
  });
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
 * A subscription is not cancelled here: StoreKit subscriptions must be managed
 * in Apple Account Settings, and web subscribers can cancel in the Stripe
 * portal before deleting their account. Deleting the account only removes the
 * application's data and sign-in identity.
 */
router.delete("/users/me", requireAuth, async (req, res) => {
  const user = req.appUser!;
  let clerkIdentityDeleted = false;

  try {
    // Capture all known media paths before removing the database records. The
    // upload namespace sweep below also catches abandoned uploads and encoding
    // chunks that were never linked to a completed game.
    const [games, players, teams, account] = await Promise.all([
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
      db.query.playersTable.findMany({
        where: eq(playersTable.ownerId, user.id),
        columns: { photoObjectPath: true },
      }),
      db.query.teamsTable.findMany({
        where: eq(teamsTable.ownerId, user.id),
        columns: { highlightObjectPath: true },
      }),
      db.query.usersTable.findFirst({
        where: eq(usersTable.id, user.id),
        columns: { youtubeRefreshToken: true },
      }),
    ]);

    // Stop background encodes before deleting their objects. The upload guard
    // closes the cancellation race so a reel/proxy cannot recreate media after
    // the namespace sweep.
    cancelOwnerMediaDeletion(user.id, games.map((game) => game.id));

    // Revoke the separate Google authorization before removing its encrypted
    // token. revokeToken intentionally treats an already-revoked token as a
    // successful no-op.
    if (account?.youtubeRefreshToken) {
      try {
        await revokeToken(decryptToken(account.youtubeRefreshToken));
      } catch (err) {
        req.log?.warn({ err, userId: user.id }, "Could not revoke YouTube authorization");
      }
      await db
        .update(usersTable)
        .set({ youtubeRefreshToken: null })
        .where(eq(usersTable.id, user.id));
    }

    const mediaPaths = new Set<string>();
    for (const game of games) {
      for (const path of [
        game.videoObjectPath,
        game.highlightObjectPath,
        game.lowlightObjectPath,
        game.videoProxyObjectPath,
      ]) {
        if (path) mediaPaths.add(path);
      }
    }
    for (const player of players) {
      if (player.photoObjectPath) mediaPaths.add(player.photoObjectPath);
    }
    for (const team of teams) {
      if (team.highlightObjectPath) mediaPaths.add(team.highlightObjectPath);
    }

    // Delete storage before database rows. If storage cannot be removed, the
    // account remains available so the caller can retry instead of us silently
    // dropping the references and retaining private media.
    await Promise.all([
      ...Array.from(mediaPaths, (path) => objectStorageService.deleteObjectEntity(path)),
      objectStorageService.deleteOwnerUploadNamespace(user.id),
    ]);

    // Delete the Clerk identity before local records. If Clerk is unavailable,
    // local records remain in place and the signed-in caller can retry. This
    // avoids the former path where the app reported a failed deletion after it
    // had already discarded all local data.
    try {
      await clerkClient.users.deleteUser(user.clerkUserId);
      clerkIdentityDeleted = true;
    } catch (err: any) {
      if (err?.status === 404 || err?.statusCode === 404) {
        clerkIdentityDeleted = true;
      } else {
        throw err;
      }
    }

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
      await tx.delete(usersTable).where(eq(usersTable.id, user.id));
    });

    res.status(204).send();
  } catch (err) {
    req.log?.error({ err, userId: user.id }, "Account deletion failed");
    if (!clerkIdentityDeleted) resumeOwnerMediaWrites(user.id);
    res.status(500).json({ error: "Could not delete your account. Please try again." });
  }
});

export default router;
