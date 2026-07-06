import { Router, type IRouter, type Request, type Response } from "express";
import { liveStreamRegistry, getIceServers } from "../lib/liveStream";
import { requireAuth } from "../middlewares/requireAuth";
import { getEntitlements } from "../lib/entitlements";

const router: IRouter = Router();

/**
 * GET /live/ice-servers
 *
 * Returns the ICE server configuration (STUN + TURN) that broadcasters and
 * viewers should use for their WebRTC peer connections. Prefers a TURN relay
 * (via Metered.ca) so streams keep working behind restrictive NATs/firewalls
 * where direct/STUN-only connectivity fails; falls back to STUN-only if no
 * TURN provider is configured or reachable.
 */
router.get("/live/ice-servers", async (_req: Request, res: Response) => {
  const iceServers = await getIceServers();
  res.json({ iceServers });
});

/**
 * POST /live/start
 *
 * Starts a new invitation-only live stream session for the given game context.
 * Returns a short code that doubles as the "invitation" — anyone with the
 * code (or the watch link built from it) can join as a viewer. No accounts
 * are required on either side.
 */
router.post("/live/start", requireAuth, async (req: Request, res: Response) => {
  const entitlements = await getEntitlements(req.appUser!.stripeCustomerId);
  if (entitlements.plan !== "pro") {
    res.status(403).json({
      error: "Live streaming is a Pro feature. Upgrade to Pro to broadcast games live.",
      code: "UPGRADE_REQUIRED",
    });
    return;
  }

  const { opponent, teamName } = req.body ?? {};
  if (typeof opponent !== "string" || !opponent.trim() || typeof teamName !== "string" || !teamName.trim()) {
    res.status(400).json({ error: "Missing or invalid required fields" });
    return;
  }

  const session = await liveStreamRegistry.createSession({ opponent, teamName });
  res.json({ code: session.code });
});

/**
 * GET /live/:code/status
 *
 * Public status check used by the viewer page. Does not require the caller
 * to be the broadcaster. Falls back to the persisted session record if the
 * in-memory copy was lost to an api-server restart, so viewers polling this
 * endpoint see "waiting for broadcaster" (and keep retrying) instead of a
 * hard "not found" while the coach's app is busy reconnecting.
 */
router.get("/live/:code/status", async (req: Request, res: Response) => {
  const code = Array.isArray(req.params.code) ? req.params.code[0] : req.params.code;
  const session = await liveStreamRegistry.getOrResumeSession(code ?? "");
  if (!session) {
    res.status(404).json({ error: "Stream not found" });
    return;
  }

  res.json({
    active: session.broadcaster !== null,
    opponent: session.meta.opponent,
    teamName: session.meta.teamName,
    viewerCount: session.viewers.size,
    teamScore: session.scoreboard.teamScore,
    opponentScore: session.scoreboard.opponentScore,
  });
});

/**
 * POST /live/:code/stop
 *
 * Explicit stop (in addition to automatic cleanup when the broadcaster's
 * websocket disconnects).
 */
router.post("/live/:code/stop", requireAuth, async (req: Request, res: Response) => {
  const code = Array.isArray(req.params.code) ? req.params.code[0] : req.params.code;
  await liveStreamRegistry.endSession(code ?? "");
  res.json({ success: true });
});

export default router;
