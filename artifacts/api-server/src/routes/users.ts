import { Router } from "express";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireAuth } from "../middlewares/requireAuth";

const router = Router();

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
});

export default router;
