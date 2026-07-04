import { Router, type IRouter, type Request, type Response } from "express";
import { liveStreamRegistry } from "../lib/liveStream";

const router: IRouter = Router();

/**
 * POST /live/start
 *
 * Starts a new invitation-only live stream session for the given game context.
 * Returns a short code that doubles as the "invitation" — anyone with the
 * code (or the watch link built from it) can join as a viewer. No accounts
 * are required on either side.
 */
router.post("/live/start", (req: Request, res: Response) => {
  const { opponent, teamName } = req.body ?? {};
  if (typeof opponent !== "string" || !opponent.trim() || typeof teamName !== "string" || !teamName.trim()) {
    res.status(400).json({ error: "Missing or invalid required fields" });
    return;
  }

  const session = liveStreamRegistry.createSession({ opponent, teamName });
  res.json({ code: session.code });
});

/**
 * GET /live/:code/status
 *
 * Public status check used by the viewer page. Does not require the caller
 * to be the broadcaster.
 */
router.get("/live/:code/status", (req: Request, res: Response) => {
  const code = Array.isArray(req.params.code) ? req.params.code[0] : req.params.code;
  const session = liveStreamRegistry.getSession(code ?? "");
  if (!session) {
    res.status(404).json({ error: "Stream not found" });
    return;
  }

  res.json({
    active: session.broadcaster !== null,
    opponent: session.meta.opponent,
    teamName: session.meta.teamName,
    viewerCount: session.viewers.size,
  });
});

/**
 * POST /live/:code/stop
 *
 * Explicit stop (in addition to automatic cleanup when the broadcaster's
 * websocket disconnects).
 */
router.post("/live/:code/stop", (req: Request, res: Response) => {
  const code = Array.isArray(req.params.code) ? req.params.code[0] : req.params.code;
  liveStreamRegistry.endSession(code ?? "");
  res.json({ success: true });
});

export default router;
