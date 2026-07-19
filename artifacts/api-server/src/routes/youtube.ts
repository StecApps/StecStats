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

// POST /api/auth/youtube/disconnect
// Clears the stored refresh token so the coach can reconnect with a different account.
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
  lines.push(`STEC STATS — Highlight Reel`);
  lines.push(`${game.result ?? ""} vs ${game.opponent ?? "Opponent"}  ${game.teamScore ?? ""}–${game.opponentScore ?? ""}  ${dateStr}`.trim());
  lines.push(``);

  if (playerStats.length > 0) {
    lines.push(`📊 GAME STATS`);
    lines.push(`${"Player".padEnd(20)} ${"PTS".padStart(4)} ${"FG".padStart(7)} ${"3PT".padStart(7)} ${"FT".padStart(7)} ${"REB".padStart(4)} ${"AST".padStart(4)} ${"STL".padStart(4)} ${"BLK".padStart(4)} ${"TO".padStart(4)}`);
    lines.push(`${"—".repeat(78)}`);

    const sorted = [...playerStats].sort((a, b) => {
      const pts = (s: typeof a) => s.ftMade + s.twoMade * 2 + s.threeMade * 3;
      return pts(b) - pts(a);
    });

    for (const s of sorted) {
      const pts = s.ftMade + s.twoMade * 2 + s.threeMade * 3;
      const fgMade = s.twoMade + s.threeMade;
      const fgAtt = s.twoAttempted + s.threeAttempted;
      const fg = `${fgMade}/${fgAtt} ${pct(fgMade, fgAtt)}`;
      const threePt = `${s.threeMade}/${s.threeAttempted} ${pct(s.threeMade, s.threeAttempted)}`;
      const ft = `${s.ftMade}/${s.ftAttempted} ${pct(s.ftMade, s.ftAttempted)}`;
      lines.push(
        `${s.name.substring(0, 19).padEnd(20)} ${String(pts).padStart(4)} ${fg.padStart(7)} ${threePt.padStart(7)} ${ft.padStart(7)} ${String(s.rebounds).padStart(4)} ${String(s.assists).padStart(4)} ${String(s.steals).padStart(4)} ${String(s.blocks).padStart(4)} ${String(s.turnovers).padStart(4)}`
      );
    }

    // Team totals
    const totPts = playerStats.reduce((acc, s) => acc + s.ftMade + s.twoMade * 2 + s.threeMade * 3, 0);
    const totFgM = playerStats.reduce((acc, s) => acc + s.twoMade + s.threeMade, 0);
    const totFgA = playerStats.reduce((acc, s) => acc + s.twoAttempted + s.threeAttempted, 0);
    const tot3M = playerStats.reduce((acc, s) => acc + s.threeMade, 0);
    const tot3A = playerStats.reduce((acc, s) => acc + s.threeAttempted, 0);
    const totFtM = playerStats.reduce((acc, s) => acc + s.ftMade, 0);
    const totFtA = playerStats.reduce((acc, s) => acc + s.ftAttempted, 0);
    const totReb = playerStats.reduce((acc, s) => acc + s.rebounds, 0);
    const totAst = playerStats.reduce((acc, s) => acc + s.assists, 0);
    const totStl = playerStats.reduce((acc, s) => acc + s.steals, 0);
    const totBlk = playerStats.reduce((acc, s) => acc + s.blocks, 0);
    const totTo  = playerStats.reduce((acc, s) => acc + s.turnovers, 0);
    lines.push(`${"—".repeat(78)}`);
    lines.push(
      `${"TEAM".padEnd(20)} ${String(totPts).padStart(4)} ${`${totFgM}/${totFgA} ${pct(totFgM, totFgA)}`.padStart(7)} ${`${tot3M}/${tot3A} ${pct(tot3M, tot3A)}`.padStart(7)} ${`${totFtM}/${totFtA} ${pct(totFtM, totFtA)}`.padStart(7)} ${String(totReb).padStart(4)} ${String(totAst).padStart(4)} ${String(totStl).padStart(4)} ${String(totBlk).padStart(4)} ${String(totTo).padStart(4)}`
    );
  }

  lines.push(``);
  lines.push(`Generated by STEC STATS — stecstats.com`);
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
    logger.error({ err, gameId }, "YouTube upload failed");
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: `YouTube upload failed: ${msg}` });
  }
});

export default router;
