import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { and, eq, sql } from "drizzle-orm";
import { randomUUID } from "crypto";
import { db, playersTable, gamesTable, playerGameStatsTable, teamsTable } from "@workspace/db";
import {
  ListPlayersResponse,
  CreatePlayerBody,
  CreatePlayerResponse,
  GetPlayerParams,
  GetPlayerResponse,
  UpdatePlayerParams,
  UpdatePlayerBody,
  UpdatePlayerResponse,
  DeletePlayerParams,
  GetPlayerSummaryParams,
  GetPlayerSummaryResponse,
  ListPlayerTeamGroupsParams,
  ListPlayerTeamGroupsResponse,
} from "@workspace/api-zod";
import { computePoints, safeDiv } from "../lib/stats";
import { requireAuth } from "../middlewares/requireAuth";
import { getEntitlementsForUser, getEntitlements } from "../lib/entitlements";
import { getCurrentSeasonStartDate } from "../lib/season";
import { gte } from "drizzle-orm";

// ── Simple in-memory rate limiter for the public profile endpoint ─────────────
// Keyed by IP address. Allows up to 60 requests per minute per IP.
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 60;
const rateBuckets = new Map<string, { count: number; resetAt: number }>();

function publicRateLimit(req: Request, res: Response, next: NextFunction): void {
  const ip = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim()
    ?? req.socket.remoteAddress
    ?? "unknown";
  const now = Date.now();
  const bucket = rateBuckets.get(ip);
  if (!bucket || now > bucket.resetAt) {
    rateBuckets.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    next();
    return;
  }
  bucket.count += 1;
  if (bucket.count > RATE_LIMIT) {
    res.status(429).json({ error: "Too many requests — try again in a minute" });
    return;
  }
  next();
}
// Prune stale buckets every 5 minutes to avoid unbounded memory growth.
setInterval(() => {
  const now = Date.now();
  for (const [ip, bucket] of rateBuckets) {
    if (now > bucket.resetAt) rateBuckets.delete(ip);
  }
}, 5 * 60_000).unref();

const router: IRouter = Router();

// Free tier is capped at 1 player. Enforced server-side (source of truth) --
// the UI gate is cosmetic only.
const FREE_PLAYER_LIMIT = 1;

// ── Public profile (no auth) ─────────────────────────────────────────────────
// IMPORTANT: registered before GET /players/:playerId so Express does not
// swallow "public" as a numeric playerId.
// Rate-limited to 60 req/min per IP.
router.get("/players/public/:shareToken", publicRateLimit, async (req, res) => {
  const shareToken = String(req.params["shareToken"] ?? "");
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!UUID_RE.test(shareToken)) {
    res.status(404).json({ error: "Player not found" });
    return;
  }

  const player = await db.query.playersTable.findFirst({
    where: eq(playersTable.shareToken, shareToken),
  });
  if (!player) {
    res.status(404).json({ error: "Player not found" });
    return;
  }

  // Pull career stats — joined only on gameId (no ownerId filter needed since
  // the token itself proves the coach shared this player intentionally).
  const rows = await db
    .select({
      stat: playerGameStatsTable,
      result: gamesTable.result,
    })
    .from(playerGameStatsTable)
    .innerJoin(gamesTable, eq(playerGameStatsTable.gameId, gamesTable.id))
    .where(eq(playerGameStatsTable.playerId, player.id));

  const totals = {
    games: rows.length,
    wins: 0,
    losses: 0,
    points: 0,
    rebounds: 0,
    assists: 0,
    steals: 0,
    turnovers: 0,
    blocks: 0,
    ftMade: 0,
    ftAttempted: 0,
    twoMade: 0,
    twoAttempted: 0,
    threeMade: 0,
    threeAttempted: 0,
  };

  for (const { stat, result } of rows) {
    if (result === "W") totals.wins += 1;
    else totals.losses += 1;
    totals.points += computePoints(stat);
    totals.rebounds += stat.rebounds;
    totals.assists += stat.assists;
    totals.steals += stat.steals;
    totals.turnovers += stat.turnovers;
    totals.blocks += stat.blocks;
    totals.ftMade += stat.ftMade;
    totals.ftAttempted += stat.ftAttempted;
    totals.twoMade += stat.twoMade;
    totals.twoAttempted += stat.twoAttempted;
    totals.threeMade += stat.threeMade;
    totals.threeAttempted += stat.threeAttempted;
  }

  const fgMade = totals.twoMade + totals.threeMade;
  const fgAttempted = totals.twoAttempted + totals.threeAttempted;
  const games = totals.games;

  // Return only the fields safe to share publicly — no ownerId, no teamId.
  res.json({
    playerName: player.name,
    photoObjectPath: null, // Photos are auth-gated; don't expose in public profile
    ...totals,
    ppg: safeDiv(totals.points, games),
    rpg: safeDiv(totals.rebounds, games),
    apg: safeDiv(totals.assists, games),
    spg: safeDiv(totals.steals, games),
    topg: safeDiv(totals.turnovers, games),
    bpg: safeDiv(totals.blocks, games),
    fgPct: fgAttempted > 0 ? safeDiv(fgMade, fgAttempted) : null,
    threePct: totals.threeAttempted > 0 ? safeDiv(totals.threeMade, totals.threeAttempted) : null,
    ftPct: totals.ftAttempted > 0 ? safeDiv(totals.ftMade, totals.ftAttempted) : null,
  });
});

router.get("/players", requireAuth, async (req, res) => {
  const players = await db
    .select()
    .from(playersTable)
    .where(eq(playersTable.ownerId, req.appUser!.id))
    .orderBy(playersTable.name);
  res.json(ListPlayersResponse.parse(players));
});

router.post("/players", requireAuth, async (req, res) => {
  const body = CreatePlayerBody.parse(req.body);
  const ownerId = req.appUser!.id;

  const entitlements = await getEntitlementsForUser(req.appUser!);
  if (entitlements.plan === "free") {
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(playersTable)
      .where(eq(playersTable.ownerId, ownerId));
    if (count >= FREE_PLAYER_LIMIT) {
      res.status(403).json({
        error: `Free plan is limited to ${FREE_PLAYER_LIMIT} player. Upgrade to Pro for unlimited players.`,
        code: "UPGRADE_REQUIRED",
      });
      return;
    }
  }

  const [player] = await db
    .insert(playersTable)
    .values({ ...body, ownerId })
    .returning();
  res.status(201).json(CreatePlayerResponse.parse(player));
});

router.get("/players/:playerId", requireAuth, async (req, res) => {
  const { playerId } = GetPlayerParams.parse(req.params);
  const player = await db.query.playersTable.findFirst({
    where: and(eq(playersTable.id, playerId), eq(playersTable.ownerId, req.appUser!.id)),
  });
  if (!player) {
    res.status(404).json({ error: "Player not found" });
    return;
  }
  res.json(GetPlayerResponse.parse(player));
});

router.patch("/players/:playerId", requireAuth, async (req, res) => {
  const { playerId } = UpdatePlayerParams.parse(req.params);
  const body = UpdatePlayerBody.parse(req.body);

  // When the photo is being updated, stamp the server-side timestamp so the
  // client can enforce the 6-month freshness rule without trusting a
  // client-supplied date.
  const updatePayload: Record<string, unknown> = { ...body };
  if ("photoObjectPath" in body) {
    updatePayload.photoUpdatedAt = body.photoObjectPath ? new Date() : null;
  }

  const [player] = await db
    .update(playersTable)
    .set(updatePayload)
    .where(and(eq(playersTable.id, playerId), eq(playersTable.ownerId, req.appUser!.id)))
    .returning();
  if (!player) {
    res.status(404).json({ error: "Player not found" });
    return;
  }
  res.json(UpdatePlayerResponse.parse(player));
});

router.delete("/players/:playerId", requireAuth, async (req, res) => {
  const { playerId } = DeletePlayerParams.parse(req.params);
  await db
    .delete(playersTable)
    .where(and(eq(playersTable.id, playerId), eq(playersTable.ownerId, req.appUser!.id)));
  res.status(204).send();
});

router.get("/players/:playerId/summary", requireAuth, async (req, res) => {
  const { playerId } = GetPlayerSummaryParams.parse(req.params);
  const player = await db.query.playersTable.findFirst({
    where: and(eq(playersTable.id, playerId), eq(playersTable.ownerId, req.appUser!.id)),
  });
  if (!player) {
    res.status(404).json({ error: "Player not found" });
    return;
  }

  // Free plan: "current season only, basic stats" -- no career-spanning
  // data and no shooting-efficiency percentages (Pro-only gauges). This is
  // enforced here server-side; the UI gate is cosmetic only.
  const entitlements = await getEntitlementsForUser(req.appUser!);
  const isFree = entitlements.plan === "free";
  const seasonStart = getCurrentSeasonStartDate();

  const rows = await db
    .select({
      stat: playerGameStatsTable,
      result: gamesTable.result,
    })
    .from(playerGameStatsTable)
    .innerJoin(
      gamesTable,
      and(eq(playerGameStatsTable.gameId, gamesTable.id), eq(gamesTable.ownerId, req.appUser!.id)),
    )
    .where(
      isFree
        ? and(eq(playerGameStatsTable.playerId, playerId), gte(gamesTable.date, seasonStart))
        : eq(playerGameStatsTable.playerId, playerId),
    );

  const totals = {
    games: rows.length,
    wins: 0,
    losses: 0,
    points: 0,
    rebounds: 0,
    assists: 0,
    steals: 0,
    turnovers: 0,
    blocks: 0,
    ftMade: 0,
    ftAttempted: 0,
    twoMade: 0,
    twoAttempted: 0,
    threeMade: 0,
    threeAttempted: 0,
  };

  for (const { stat, result } of rows) {
    if (result === "W") totals.wins += 1;
    else totals.losses += 1;
    totals.points += computePoints(stat);
    totals.rebounds += stat.rebounds;
    totals.assists += stat.assists;
    totals.steals += stat.steals;
    totals.turnovers += stat.turnovers;
    totals.blocks += stat.blocks;
    totals.ftMade += stat.ftMade;
    totals.ftAttempted += stat.ftAttempted;
    totals.twoMade += stat.twoMade;
    totals.twoAttempted += stat.twoAttempted;
    totals.threeMade += stat.threeMade;
    totals.threeAttempted += stat.threeAttempted;
  }

  const fgMade = totals.twoMade + totals.threeMade;
  const fgAttempted = totals.twoAttempted + totals.threeAttempted;
  const games = totals.games || 0;

  const summary = {
    playerId: player.id,
    playerName: player.name,
    plan: entitlements.plan,
    seasonScope: isFree ? ("current" as const) : ("career" as const),
    ...totals,
    ppg: safeDiv(totals.points, games),
    rpg: safeDiv(totals.rebounds, games),
    apg: safeDiv(totals.assists, games),
    spg: safeDiv(totals.steals, games),
    topg: safeDiv(totals.turnovers, games),
    bpg: safeDiv(totals.blocks, games),
    // Shooting-efficiency gauges are a Pro-only feature -- omit entirely for
    // free accounts rather than sending (and relying on the client to hide)
    // the real numbers.
    ...(isFree
      ? {}
      : {
          fgPct: safeDiv(fgMade, fgAttempted),
          threePct: safeDiv(totals.threeMade, totals.threeAttempted),
          ftPct: safeDiv(totals.ftMade, totals.ftAttempted),
        }),
  };

  res.json(GetPlayerSummaryResponse.parse(summary));
});

router.get("/players/:playerId/teams", requireAuth, async (req, res) => {
  const { playerId } = ListPlayerTeamGroupsParams.parse(req.params);
  const player = await db.query.playersTable.findFirst({
    where: and(eq(playersTable.id, playerId), eq(playersTable.ownerId, req.appUser!.id)),
  });
  if (!player) {
    res.status(404).json({ error: "Player not found" });
    return;
  }

  // Free plan: "current season only" -- career team/season history beyond
  // the current season is Pro-only. Enforced server-side.
  const isFree = (await getEntitlementsForUser(req.appUser!)).plan === "free";
  const seasonStart = getCurrentSeasonStartDate();

  const rows = await db
    .select({
      teamId: teamsTable.id,
      teamName: teamsTable.name,
      result: gamesTable.result,
    })
    .from(playerGameStatsTable)
    .innerJoin(
      gamesTable,
      and(eq(playerGameStatsTable.gameId, gamesTable.id), eq(gamesTable.ownerId, req.appUser!.id)),
    )
    .innerJoin(
      teamsTable,
      and(eq(gamesTable.teamId, teamsTable.id), eq(teamsTable.ownerId, req.appUser!.id)),
    )
    .where(
      isFree
        ? and(eq(playerGameStatsTable.playerId, playerId), gte(gamesTable.date, seasonStart))
        : eq(playerGameStatsTable.playerId, playerId),
    );

  const groups = new Map<
    number,
    { teamId: number; teamName: string; games: number; wins: number; losses: number }
  >();

  for (const row of rows) {
    const existing = groups.get(row.teamId) ?? {
      teamId: row.teamId,
      teamName: row.teamName,
      games: 0,
      wins: 0,
      losses: 0,
    };
    existing.games += 1;
    if (row.result === "W") existing.wins += 1;
    else existing.losses += 1;
    groups.set(row.teamId, existing);
  }

  res.json(ListPlayerTeamGroupsResponse.parse(Array.from(groups.values())));
});

// ── Share-token generation (authenticated) ───────────────────────────────────
// POST /players/:playerId/share-token — returns (or generates on first call)
// the public share token for a player. Idempotent: calling again returns the
// same token. Pro feature — only Pro/Premium coaches can share profiles.
router.post("/players/:playerId/share-token", requireAuth, async (req, res) => {
  const { playerId } = GetPlayerParams.parse(req.params);

  const entitlements = await getEntitlementsForUser(req.appUser!);
  if (entitlements.plan === "free") {
    res.status(403).json({
      error: "Shareable player profiles are a Pro feature. Upgrade to share your players.",
      code: "UPGRADE_REQUIRED",
    });
    return;
  }

  const player = await db.query.playersTable.findFirst({
    where: and(eq(playersTable.id, playerId), eq(playersTable.ownerId, req.appUser!.id)),
  });
  if (!player) {
    res.status(404).json({ error: "Player not found" });
    return;
  }

  // Already has a token — return it.
  if (player.shareToken) {
    res.json({ shareToken: player.shareToken });
    return;
  }

  // Generate one now.
  const shareToken = randomUUID();
  const [updated] = await db
    .update(playersTable)
    .set({ shareToken })
    .where(eq(playersTable.id, playerId))
    .returning({ shareToken: playersTable.shareToken });

  res.json({ shareToken: updated.shareToken });
});

export default router;
