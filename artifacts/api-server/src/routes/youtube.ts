import { Router, type IRouter } from "express";
import { eq, and } from "drizzle-orm";
import { randomUUID, createHmac, timingSafeEqual } from "crypto";
import { db, usersTable, gamesTable, playerGameStatsTable, playersTable } from "@workspace/db";
import { GetGameParams } from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { getEntitlementsForUser, getEntitlements, isPro } from "../lib/entitlements";
import { ObjectStorageService } from "../lib/objectStorage";
import { logger } from "../lib/logger";
import {
  isYoutubeConfigured,
  getAuthUrl,
  exchangeCode,
  revokeToken,
  probeToken,
  uploadToYoutube,
  YouTubeAuthError,
} from "../lib/youtubeClient";
import { encryptToken, decryptToken } from "../lib/tokenEncryption";

const router: IRouter = Router();
const objectStorageService = new ObjectStorageService();

// Stateless OAuth state using HMAC-signed tokens.
// This replaces the old in-memory nonce map so OAuth flows survive server
// restarts without any DB schema changes.
const OAUTH_STATE_SECRET = process.env.SESSION_SECRET ?? "dev-oauth-secret";
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function signOAuthState(payload: { userId: number; returnTo: string }): string {
  const data = JSON.stringify({
    userId: payload.userId,
    returnTo: payload.returnTo,
    jti: randomUUID(), // ensures each token is unique even for the same user
    exp: Date.now() + OAUTH_STATE_TTL_MS,
  });
  const sig = createHmac("sha256", OAUTH_STATE_SECRET).update(data).digest("hex");
  return Buffer.from(JSON.stringify({ data, sig })).toString("base64url");
}

function verifyOAuthState(state: string): { userId: number; returnTo: string } | null {
  try {
    const parsed = JSON.parse(Buffer.from(state, "base64url").toString("utf8"));
    if (typeof parsed.data !== "string" || typeof parsed.sig !== "string") return null;
    const expected = createHmac("sha256", OAUTH_STATE_SECRET).update(parsed.data).digest("hex");
    // Constant-time comparison prevents timing attacks on the signature.
    const sigBuf = Buffer.from(parsed.sig, "hex");
    const expBuf = Buffer.from(expected, "hex");
    if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) return null;
    const payload = JSON.parse(parsed.data);
    if (typeof payload.exp !== "number" || Date.now() > payload.exp) return null;
    if (typeof payload.userId !== "number" || typeof payload.returnTo !== "string") return null;
    return { userId: payload.userId, returnTo: payload.returnTo };
  } catch {
    return null;
  }
}

// Returns a validated returnTo value, allowing root-relative web paths and
// the mobile deep-link scheme so we don't accept open redirects.
function validateReturnTo(raw: string): string {
  const isWebPath = raw.startsWith("/") && !raw.startsWith("//");
  const isMobileDeepLink = /^hoopsstats:\/\//i.test(raw);
  return isWebPath || isMobileDeepLink ? raw : "/";
}

// GET /api/auth/youtube/connect
// Requires auth. Redirects the coach to Google's OAuth consent screen.
router.get("/auth/youtube/connect", requireAuth, (req, res) => {
  if (!isYoutubeConfigured()) {
    res.status(503).json({ error: "YouTube OAuth not configured on this server" });
    return;
  }

  const raw = typeof req.query.returnTo === "string" ? req.query.returnTo : "/";
  const returnTo = validateReturnTo(raw);

  const state = signOAuthState({ userId: req.appUser!.id, returnTo });
  res.redirect(getAuthUrl(state));
});

// POST /api/auth/youtube/connect-url
// Mobile clients cannot navigate a protected browser redirect while sending a
// Bearer token. This endpoint authenticates via the Clerk JWT in the
// Authorization header, creates the OAuth nonce, and returns the Google
// consent URL so the mobile app can open it in an in-app browser session.
router.post("/auth/youtube/connect-url", requireAuth, (req, res) => {
  if (!isYoutubeConfigured()) {
    res.status(503).json({ error: "YouTube OAuth not configured on this server" });
    return;
  }

  const raw = typeof req.body?.returnTo === "string" ? req.body.returnTo : "/";
  const returnTo = validateReturnTo(raw);

  const state = signOAuthState({ userId: req.appUser!.id, returnTo });
  res.json({ url: getAuthUrl(state) });
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

  const stateData = verifyOAuthState(state);
  if (!stateData) {
    res.status(400).send("OAuth state expired or invalid — please try connecting again.");
    return;
  }

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

async function disconnectYoutube(userId: number): Promise<void> {
  const user = await db.query.usersTable.findFirst({
    where: eq(usersTable.id, userId),
    columns: { youtubeRefreshToken: true },
  });
  if (user?.youtubeRefreshToken) {
    try {
      const plainToken = decryptToken(user.youtubeRefreshToken);
      await revokeToken(plainToken);
    } catch (err) {
      logger.warn({ err }, "YouTube token revocation failed — clearing DB record anyway");
    }
  }
  await db
    .update(usersTable)
    .set({ youtubeRefreshToken: null })
    .where(eq(usersTable.id, userId));
}

// DELETE /api/auth/youtube
// Revokes the token on Google's side and clears it from the DB.
router.delete("/auth/youtube", requireAuth, async (req, res) => {
  await disconnectYoutube(req.appUser!.id);
  res.json({ disconnected: true });
});

// POST /api/auth/youtube/disconnect — kept as backward-compatible alias
router.post("/auth/youtube/disconnect", requireAuth, async (req, res) => {
  await disconnectYoutube(req.appUser!.id);
  res.json({ disconnected: true });
});

// GET /api/auth/youtube/status
// Returns whether the current user has connected their YouTube account.
// Pass ?probe=true to also make a lightweight googleapis call (channels.list)
// that verifies the stored token is still valid.  If the probe fails with an
// auth error the DB record is cleared and connected:false is returned, so the
// coach sees the reconnect prompt before attempting an upload.
router.get("/auth/youtube/status", requireAuth, async (req, res) => {
  const user = await db.query.usersTable.findFirst({
    where: eq(usersTable.id, req.appUser!.id),
    columns: { youtubeRefreshToken: true },
  });

  if (!user?.youtubeRefreshToken) {
    res.json({ connected: false });
    return;
  }

  if (req.query.probe !== "true") {
    res.json({ connected: true });
    return;
  }

  // Probe path: decrypt + make a real API call to catch revoked tokens early.
  let plainToken: string;
  try {
    plainToken = decryptToken(user.youtubeRefreshToken);
  } catch (err) {
    logger.error({ err, userId: req.appUser!.id }, "Failed to decrypt YouTube refresh token during probe");
    await db.update(usersTable).set({ youtubeRefreshToken: null }).where(eq(usersTable.id, req.appUser!.id));
    res.json({ connected: false });
    return;
  }

  try {
    await probeToken(plainToken);
    res.json({ connected: true });
  } catch (err) {
    if (err instanceof YouTubeAuthError) {
      logger.warn({ userId: req.appUser!.id }, "YouTube token probe failed — clearing stale token");
      await db.update(usersTable).set({ youtubeRefreshToken: null }).where(eq(usersTable.id, req.appUser!.id));
      res.json({ connected: false });
      return;
    }
    // Non-auth error (network hiccup, etc.) — don't clear the token,
    // report connected:true so the coach can still attempt the upload.
    logger.warn({ err, userId: req.appUser!.id }, "YouTube token probe encountered non-auth error — assuming connected");
    res.json({ connected: true });
  }
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

  const entitlements = await getEntitlementsForUser(req.appUser!);
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

    // Persist so the mobile app can re-surface the link after remounting.
    await db
      .update(gamesTable)
      .set({ highlightYoutubeUrl: youtubeUrl })
      .where(eq(gamesTable.id, gameId));

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
