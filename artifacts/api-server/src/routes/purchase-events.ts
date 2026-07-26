import { Router, type IRouter } from "express";
import { desc } from "drizzle-orm";
import { db, purchaseEventsTable } from "@workspace/db";
import { requireAuth } from "../middlewares/requireAuth";

const router: IRouter = Router();

// POST /api/purchase-events — called by the frontend on checkout success
router.post("/purchase-events", requireAuth, async (req, res) => {
  const { plan, interval } = req.body as { plan?: string; interval?: string };
  if (!plan || typeof plan !== "string") {
    res.status(400).json({ error: "plan is required" });
    return;
  }

  const appUser = req.appUser!;

  await db.insert(purchaseEventsTable).values({
    userId: appUser.id,
    email: appUser.email ?? null,
    plan: plan.trim(),
    interval: typeof interval === "string" ? interval.trim() : null,
  });

  res.status(201).json({ ok: true });
});

// GET /api/admin/purchase-events — owner only
router.get("/admin/purchase-events", requireAuth, async (req, res) => {
  if (req.appUser!.id !== 1) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const rows = await db
    .select()
    .from(purchaseEventsTable)
    .orderBy(desc(purchaseEventsTable.createdAt));

  res.json(rows);
});

export default router;
