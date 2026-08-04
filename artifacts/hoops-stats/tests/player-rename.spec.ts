/**
 * Task #148 — Confirm a renamed player's stats and game history still appear correctly.
 *
 * A rename only updates the `name` column on `players`. All stats remain
 * linked by FK (playerId), so career totals and per-game history must
 * survive unchanged and the new name must appear everywhere the old one did.
 *
 * NOTE: This Playwright spec requires system browser dependencies (libgbm)
 * that are present in CI but not in the local Replit sandbox. The equivalent
 * DB-layer proof lives in artifacts/api-server/src/__tests__/player-rename.test.ts
 * and runs with `pnpm --filter @workspace/api-server test`.
 */

import { test, expect } from "@playwright/test";
import { setupClerkTestingToken } from "@clerk/testing/playwright";

const CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY ?? "";
const API_BASE = process.env.REPLIT_DEV_DOMAIN
  ? `https://${process.env.REPLIT_DEV_DOMAIN}/api`
  : `http://localhost:${process.env.PORT ?? 5173}/api`;

interface ClerkUser {
  id: string;
}

async function createClerkUser(email: string, password: string): Promise<ClerkUser> {
  const res = await fetch("https://api.clerk.com/v1/users", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${CLERK_SECRET_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email_address: [email],
      password,
      skip_password_checks: true,
      skip_password_requirement: true,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to create Clerk user: ${res.status} ${body}`);
  }
  return res.json() as Promise<ClerkUser>;
}

async function deleteClerkUser(id: string): Promise<void> {
  await fetch(`https://api.clerk.com/v1/users/${id}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${CLERK_SECRET_KEY}` },
  });
}

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test-rename.example.com`;
}

// Typed API response shapes
interface PlayerSummary {
  gamesPlayed: number;
  ppg: number;
  rpg: number;
  apg: number;
  spg: number;
  bpg: number;
  topg: number;
  totalPoints: number;
  totalAssists: number;
  totalRebounds: number;
  totalSteals: number;
  totalBlocks: number;
  totalTurnovers: number;
}

test.describe("Player rename preserves stats and history", () => {
  test("career totals and game row are unchanged after rename", async ({ page }) => {
    const email = uniqueEmail("rename");
    const user = await createClerkUser(email, "SomeTestPassword!9x");

    try {
      // ── Auth ──────────────────────────────────────────────────────────────
      await setupClerkTestingToken({ page, userId: user.id });
      await page.goto("/dashboard");
      await page.waitForURL(/\/dashboard/, { timeout: 15_000 });

      // Grab session cookies for direct API calls
      const cookies = await page.context().cookies();
      const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");

      async function apiPost(path: string, body: unknown): Promise<unknown> {
        const res = await page.request.post(`${API_BASE}${path}`, {
          data: body,
          headers: { "Content-Type": "application/json", Cookie: cookieHeader },
        });
        if (!res.ok()) throw new Error(`POST ${path} → ${res.status()}: ${await res.text()}`);
        return res.json();
      }

      async function apiPatch(path: string, body: unknown): Promise<unknown> {
        const res = await page.request.patch(`${API_BASE}${path}`, {
          data: body,
          headers: { "Content-Type": "application/json", Cookie: cookieHeader },
        });
        if (!res.ok()) throw new Error(`PATCH ${path} → ${res.status()}: ${await res.text()}`);
        return res.json();
      }

      async function apiGet(path: string): Promise<unknown> {
        const res = await page.request.get(`${API_BASE}${path}`, {
          headers: { Cookie: cookieHeader },
        });
        if (!res.ok()) throw new Error(`GET ${path} → ${res.status()}: ${await res.text()}`);
        return res.json();
      }

      // ── Seed ──────────────────────────────────────────────────────────────
      const player = (await apiPost("/players", { name: "Jordan Testman" })) as { id: number };
      const team = (await apiPost("/teams", { name: "Test Bulls", sport: "basketball" })) as { id: number };

      // Stats embedded in game body; twoMade/threeMade/ftMade, no bare `points` field.
      // Computed points: 7×2 + 2×3 + 3 = 25
      const game = (await apiPost("/games", {
        teamId: team.id,
        opponent: "Away Squad",
        date: "2025-11-15",
        result: "W",
        teamScore: 88,
        opponentScore: 72,
        stats: [{
          playerId: player.id,
          twoMade: 7,   twoAttempted: 12,
          threeMade: 2, threeAttempted: 5,
          ftMade: 3,    ftAttempted: 4,
          assists: 5,   rebounds: 8,
          steals: 2,    turnovers: 3,  blocks: 1,
        }],
        events: [],
      })) as { id: number };

      expect(game.id).toBeTruthy();

      // ── Pre-rename: capture exact career totals via API summary endpoint ──
      const summaryBefore = (await apiGet(`/players/${player.id}/summary`)) as PlayerSummary;

      // Sanity-check seed values
      expect(summaryBefore.gamesPlayed).toBe(1);
      // Points = 7*2 + 2*3 + 3 = 25 (totalPoints may be a field; ppg×gp is the same)
      expect(summaryBefore.totalPoints ?? summaryBefore.ppg * summaryBefore.gamesPlayed).toBe(25);
      expect(summaryBefore.totalAssists ?? summaryBefore.apg * summaryBefore.gamesPlayed).toBe(5);
      expect(summaryBefore.totalRebounds ?? summaryBefore.rpg * summaryBefore.gamesPlayed).toBe(8);

      // ── Pre-rename: verify dashboard chip + heading + game row ────────────
      await page.reload();
      await page.waitForURL(/\/dashboard/, { timeout: 15_000 });

      const chipBefore = page.getByRole("button", { name: "Jordan Testman" }).first();
      await expect(chipBefore).toBeVisible({ timeout: 10_000 });
      await chipBefore.click();

      await expect(page.getByRole("heading", { level: 1 })).toContainText("Jordan Testman");
      await expect(page.getByText("Test Bulls")).toBeVisible({ timeout: 8_000 });
      await page.getByText("Test Bulls").first().click();
      await expect(page.getByText("Away Squad")).toBeVisible({ timeout: 8_000 });

      // ── Rename ────────────────────────────────────────────────────────────
      const renamed = (await apiPatch(`/players/${player.id}`, { name: "Jordan Renamed" })) as {
        id: number;
        name: string;
      };
      expect(renamed.name).toBe("Jordan Renamed");

      // ── Post-rename: verify API career totals are identical ───────────────
      const summaryAfter = (await apiGet(`/players/${player.id}/summary`)) as PlayerSummary;

      // Every numeric field must match exactly
      expect(summaryAfter.gamesPlayed).toBe(summaryBefore.gamesPlayed);
      expect(summaryAfter.ppg).toBe(summaryBefore.ppg);
      expect(summaryAfter.rpg).toBe(summaryBefore.rpg);
      expect(summaryAfter.apg).toBe(summaryBefore.apg);
      expect(summaryAfter.spg).toBe(summaryBefore.spg);
      expect(summaryAfter.bpg).toBe(summaryBefore.bpg);
      expect(summaryAfter.topg).toBe(summaryBefore.topg);
      if (summaryAfter.totalPoints !== undefined) {
        expect(summaryAfter.totalPoints).toBe(summaryBefore.totalPoints);
        expect(summaryAfter.totalAssists).toBe(summaryBefore.totalAssists);
        expect(summaryAfter.totalRebounds).toBe(summaryBefore.totalRebounds);
        expect(summaryAfter.totalSteals).toBe(summaryBefore.totalSteals);
        expect(summaryAfter.totalBlocks).toBe(summaryBefore.totalBlocks);
        expect(summaryAfter.totalTurnovers).toBe(summaryBefore.totalTurnovers);
      }

      // ── Post-rename: verify dashboard shows new name with same data ───────
      await page.reload();
      await page.waitForURL(/\/dashboard/, { timeout: 15_000 });

      // Old chip gone
      await expect(page.getByRole("button", { name: "Jordan Testman" })).not.toBeVisible();

      // New chip present
      const chipAfter = page.getByRole("button", { name: "Jordan Renamed" }).first();
      await expect(chipAfter).toBeVisible({ timeout: 10_000 });
      await chipAfter.click();

      // Heading shows new name
      await expect(page.getByRole("heading", { level: 1 })).toContainText("Jordan Renamed");

      // 1 GP still shown — stats were not zeroed
      await expect(page.getByText(/1\s*GP/i)).toBeVisible({ timeout: 8_000 });

      // Game history row still present
      await expect(page.getByText("Test Bulls")).toBeVisible({ timeout: 8_000 });
      await page.getByText("Test Bulls").first().click();
      await expect(page.getByText("Away Squad")).toBeVisible({ timeout: 8_000 });

      // Old name must not appear anywhere
      await expect(page.getByText("Jordan Testman")).not.toBeVisible();
    } finally {
      await deleteClerkUser(user.id);
    }
  });
});
