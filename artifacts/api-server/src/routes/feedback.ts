import { Router, type IRouter } from "express";
import { desc, eq } from "drizzle-orm";
import { db, feedbackTable } from "@workspace/db";
import { requireAuth } from "../middlewares/requireAuth";

const router: IRouter = Router();

// POST /api/feedback — open to all (signed-in or not)
router.post("/feedback", async (req, res) => {
  const { message, name, email, userId } = req.body as {
    message?: string;
    name?: string;
    email?: string;
    userId?: number;
  };

  if (!message || typeof message !== "string" || message.trim().length === 0) {
    res.status(400).json({ error: "message is required" });
    return;
  }
  if (message.trim().length > 2000) {
    res.status(400).json({ error: "message is too long" });
    return;
  }

  await db.insert(feedbackTable).values({
    userId: typeof userId === "number" ? userId : null,
    name: name?.trim() || null,
    email: email?.trim() || null,
    message: message.trim(),
  });

  res.status(201).json({ ok: true });
});

// GET /api/admin/feedback — owner only (userId === 1)
router.get("/admin/feedback", requireAuth, async (req, res) => {
  if (req.appUser!.id !== 1) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const rows = await db
    .select()
    .from(feedbackTable)
    .orderBy(desc(feedbackTable.createdAt));

  res.json(rows);
});

// PATCH /api/admin/feedback/:id — mark as reviewed
router.patch("/admin/feedback/:id", requireAuth, async (req, res) => {
  if (req.appUser!.id !== 1) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  await db
    .update(feedbackTable)
    .set({ status: "reviewed" })
    .where(eq(feedbackTable.id, id));

  res.json({ ok: true });
});

export default router;
