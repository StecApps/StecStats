import { Router, type IRouter } from "express";
import { eq, and } from "drizzle-orm";
import { randomUUID } from "crypto";
import { db, usersTable, gamesTable, playerGameStatsTable, playersTable } from "@workspace/db";
import { GetGameParams } from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { getEntitlements, isPro } from "../lib/entitlements";
import { ObjectStorageService } from "../lib/objectStorage";
import { logger } from "../lib/logger";
import {
  isYoutubeConfigured,
  getAuthUrl,
  exchangeCode,
  uploadToYoutube,
  YouTubeAuthError,
} from "../lib/youtubeClient";
import { encryptToken, decryptToken } from "../lib/tokenEncryption";

const router: IRouter = Router();
const objectStorageService = new ObjectStorageService();

// In-memory state map: nonce → { userId, returnTo, expiresAt }
// Nonces expire after 10 min; a server restart invalidates in-flight OAuth
// flows (user just needs to click Connect again — acceptable trade-off vs.
// the complexity of DB-backed nonces for a low-frequency action).
const oauthStateMap = new Map<string, { userId: number; returnTo: string; expiresAt: number }>();

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of oauthStateMap.entries()) {
    if (v.expiresAt < now) oauthStateMap.delete(k);
  }
}, 60_000);

// GET /api/auth/youtube/connect
// Requires auth. Redirects the coach to Google's OAuth consent screen.
router.get("/auth/youtube/connect", requireAuth, (req, res) => {
  if (!isYoutubeConfigured()) {
    res.status(503).json({ error: "YouTube OAuth not configured on this server" });
    return;
  }

  const raw = typeof req.query.returnTo === "string" ? req.query.returnTo : "/";
  const returnTo = raw.startsWith("/") && !raw.startsWith("//") ? raw : "/";

  const nonce = randomUUID();
  oauthStateMap.set(nonce, {
    userId: req.appUser!.id,
    returnTo,
    expiresAt: Date.now() + 10 * 60 * 1000,
  });

  res.redirect(getAuthUrl(nonce));
});

// GET /api/auth/youtube/callback
// No Clerk auth — this comes directly from Google after the user consents.
router.get("/auth/youtube/callback", async (req, res) => {
  const code = typeof req.query.code === "string" ? req.query.code : null;
  const state = typeof req.query.state === "string" ? req.query.state : null;

  if (!code || !state) {
    res.status(400).send("Missing OAuth code or state — please try connecting again.");
    return;
  }

  const stateData = oauthStateMap.get(state);
  if (!stateData || stateData.expiresAt < Date.now()) {
    oauthStateMap.delete(state);
    res.status(400).send("OAuth state expired or invalid — please try connecting again.");
    return;
  }

  oauthStateMap.delete(state);

  try {
    const { refreshToken } = await exchangeCode(code);

    // Google only issues a refresh_token on first consent or after revocation.
    // If it is absent, the coach must reconnect — treat as a failure so the
    // DB does not silently stay connected=false while the UI says connected=true.
    if (!refreshToken) {
      logger.warn({ userId: stateData.userId }, "YouTube OAuth returned no refresh_token");
      res.redirect(`${stateData.returnTo}?youtube=error`);
      return;
    }

    // Encrypt before persisting — refresh tokens are long-lived credentials.
    const encryptedToken = encryptToken(refreshToken);
    await db
      .update(usersTable)
      .set({ youtubeRefreshToken: encryptedToken })
      .where(eq(usersTable.id, stateData.userId));

    res.redirect(`${stateData.returnTo}?youtube=connected`);
  } catch (err) {
    logger.error({ err }, "YouTube OAuth callback failed");
    res.redirect(`${stateData.returnTo}?youtube=error`);
  }
});

// DELETE /api/auth/youtube
// Clears the stored refresh token so the coach can reconnect with a different account.
router.delete("/auth/youtube", requireAuth, async (req, res) => {
  await db
    .update(usersTable)
    .set({ youtubeRefreshToken: null })
    .where(eq(usersTable.id, req.appUser!.id));
  res.json({ disconnected: true });
});

// POST /api/auth/youtube/disconnect — kept as backward-compatible alias
router.post("/auth/youtube/disconnect", requireAuth, async (req, res) => {
  await db
    .update(usersTable)
    .set({ youtubeRefreshToken: null })
    .where(eq(usersTable.id, req.appUser!.id));
  res.json({ disconnected: true });
});

// GET /api/auth/youtube/status
// Returns whether the current user has connected their YouTube account.
router.get("/auth/youtube/status", requireAuth, async (req, res) => {
  const user = await db.query.usersTable.findFirst({
    where: eq(usersTable.id, req.appUser!.id),
    columns: { youtubeRefreshToken: true },
  });
  res.json({ connected: !!(user?.youtubeRefreshToken) });
});

// POST /api/games/:gameId/highlight/upload-youtube
// Streams the highlight MP4 from object storage to the coach's YouTube channel.
router.post("/games/:gameId/highlight/upload-youtube", requireAuth, async (req, res) => {
  if (!isYoutubeConfigured()) {
    res.status(503).json({ error: "YouTube OAuth not configured on this server" });
    return;
  }

  const { gameId } = GetGameParams.parse(req.params);

  const game = await db.query.gamesTable.findFirst({
    where: and(eq(gamesTable.id, gameId), eq(gamesTable.ownerId, req.appUser!.id)),
  });
  if (!game) {
    res.status(404).json({ error: "Game not found" });
    return;
  }

  const entitlements = await getEntitlements(req.appUser!.stripeCustomerId, req.appUser!.email);
  if (!isPro(entitlements)) {
    res.status(403).json({ error: "UPGRADE_REQUIRED", message: "YouTube upload is a Pro feature" });
    return;
  }

  if (game.highlightStatus !== "ready" || !game.highlightObjectPath) {
    res.status(400).json({ error: "Highlight reel is not ready" });
    return;
  }

  const user = await db.query.usersTable.findFirst({
    where: eq(usersTable.id, req.appUser!.id),
    columns: { youtubeRefreshToken: true },
  });
  if (!user?.youtubeRefreshToken) {
    res.status(403).json({
      error: "YOUTUBE_NOT_CONNECTED",
      message: "Connect your YouTube account first",
    });
    return;
  }

  const { title, privacyStatus = "unlisted" } = req.body as {
    title?: string;
    privacyStatus?: string;
  };
  if (!title || typeof title !== "string" || title.trim().length === 0) {
    res.status(400).json({ error: "title is required" });
    return;
  }
  if (!["public", "unlisted", "private"].includes(privacyStatus)) {
    res.status(400).json({ error: "privacyStatus must be public, unlisted, or private" });
    return;
  }

  let refreshToken: string;
  try {
    refreshToken = decryptToken(user.youtubeRefreshToken);
  } catch (err) {
    logger.error({ err, userId: req.appUser!.id }, "Failed to decrypt YouTube refresh token");
    // Treat as disconnected — coach will need to reconnect.
    await db
      .update(usersTable)
      .set({ youtubeRefreshToken: null })
      .where(eq(usersTable.id, req.appUser!.id));
    res.status(403).json({
      error: "YOUTUBE_NOT_CONNECTED",
      message: "YouTube connection is invalid — please reconnect",
    });
    return;
  }

  // Build statline description from player stats
  const playerStats = await db
    .select({
      name: playersTable.name,
      ftMade: playerGameStatsTable.ftMade,
      ftAttempted: playerGameStatsTable.ftAttempted,
      twoMade: playerGameStatsTable.twoMade,
      twoAttempted: playerGameStatsTable.twoAttempted,
      threeMade: playerGameStatsTable.threeMade,
      threeAttempted: playerGameStatsTable.threeAttempted,
      assists: playerGameStatsTable.assists,
      rebounds: playerGameStatsTable.rebounds,
      steals: playerGameStatsTable.steals,
      blocks: playerGameStatsTable.blocks,
      turnovers: playerGameStatsTable.turnovers,
    })
    .from(playerGameStatsTable)
    .innerJoin(playersTable, eq(playerGameStatsTable.playerId, playersTable.id))
    .where(eq(playerGameStatsTable.gameId, gameId));

  const pct = (made: number, att: number) =>
    att > 0 ? `${Math.round((made / att) * 100)}%` : "—";

  const dateStr = game.date
    ? new Date(game.date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
    : "";

  const lines: string[] = [];
  lines.push(`StecStats - Highlight Reel`);
  lines.push(`${game.result ?? ""} vs ${game.opponent ?? "Opponent"}  ${game.teamScore ?? ""}–${game.opponentScore ?? ""}  ${dateStr}`.trim());
  lines.push(``);

  if (playerStats.length > 0) {
    lines.push(`📊 GAME STATS`);

    const sorted = [...playerStats].sort((a, b) => {
      const pts = (s: typeof a) => s.ftMade + s.twoMade * 2 + s.threeMade * 3;
      return pts(b) - pts(a);
    });

    for (const s of sorted) {
      const pts = s.ftMade + s.twoMade * 2 + s.threeMade * 3;
      const fgMade = s.twoMade + s.threeMade;
      const fgAtt = s.twoAttempted + s.threeAttempted;
      const parts = [
        s.name,
        `${pts} PTS`,
        `${fgMade}/${fgAtt} FG (${pct(fgMade, fgAtt)})`,
        `${s.threeMade}/${s.threeAttempted} 3PT (${pct(s.threeMade, s.threeAttempted)})`,
        `${s.ftMade}/${s.ftAttempted} FT (${pct(s.ftMade, s.ftAttempted)})`,
        `${s.rebounds} REB`,
        `${s.assists} AST`,
        `${s.steals} STL`,
        `${s.blocks} BLK`,
        `${s.turnovers} TO`,
      ];
      lines.push(parts.join("  |  "));
    }
  }

  lines.push(``);
  lines.push(`StecStats — stecstats.com`);
  const description = lines.join("\n");

  try {
    const objectFile = await objectStorageService.getObjectEntityFile(game.highlightObjectPath);
    const stream = objectFile.createReadStream();

    const youtubeUrl = await uploadToYoutube({
      refreshToken,
      title: title.trim(),
      description,
      privacyStatus: privacyStatus as "public" | "unlisted" | "private",
      stream,
    });

    res.json({ youtubeUrl });
  } catch (err) {
    if (err instanceof YouTubeAuthError) {
      logger.warn({ gameId, userId: req.appUser!.id }, "YouTube token expired — clearing stale token");
      await db
        .update(usersTable)
        .set({ youtubeRefreshToken: null })
        .where(eq(usersTable.id, req.appUser!.id));
      res.status(403).json({
        error: "YOUTUBE_NOT_CONNECTED",
        message: "Your YouTube connection expired — please reconnect to continue",
      });
      return;
    }
    logger.error({ err, gameId }, "YouTube upload failed");
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: `YouTube upload failed: ${msg}` });
  }
});

export default router;
