import { Router } from "express";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireAuth } from "../middlewares/requireAuth";
import { clerkClient } from "@clerk/express";

const EXPO_PUSH_TOKEN_RE = /^ExponentPushToken\[.+\]$/;

const router = Router();

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

export default router;
