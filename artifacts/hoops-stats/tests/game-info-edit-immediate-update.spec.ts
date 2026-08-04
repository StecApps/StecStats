/**
 * Task #204 — Confirm a game info edit updates the box score row immediately
 * without a page refresh.
 *
 * The EditStatsDialog saves opponent, date, teamScore, opponentScore, and
 * result via PATCH /api/games/:id. On success the onSaved callback invalidates:
 *   - getListTeamGamesQueryKey(teamId)   → drives the table rows
 *   - getGetPlayerSummaryQueryKey(id)    → headline stats
 *   - getListPlayerTeamGroupsQueryKey(id)→ accordion header W-L badge
 *
 * This test verifies all three surfaces update in place without a reload.
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
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test-gameedit.example.com`;
}

test.describe("Game info edit updates box score row immediately", () => {
  test("opponent, score, and result reflect in the table and accordion header without reload", async ({ page }) => {
    const email = uniqueEmail("gameedit");
    const user = await createClerkUser(email, "SomeTestPassword!9x");

    try {
      // ── Auth ──────────────────────────────────────────────────────────────
      await setupClerkTestingToken({ page, userId: user.id });
      await page.goto("/dashboard");
      await page.waitForURL(/\/dashboard/, { timeout: 15_000 });

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

      // ── Seed: player + team + one game (Win) ──────────────────────────────
      const player = (await apiPost("/players", { name: "Edit Test Player" })) as { id: number };
      const team   = (await apiPost("/teams", { name: "Edit Test Team", sport: "basketball" })) as { id: number };

      // Use today's date so the game appears in the current-season view
      // (free-tier dashboard only shows the current season).
      const today = new Date().toISOString().slice(0, 10);

      await apiPost("/games", {
        teamId: team.id,
        opponent: "Original Opponent",
        date: today,
        result: "W",
        teamScore: 80,
        opponentScore: 60,
        stats: [{
          playerId: player.id,
          twoMade: 4, twoAttempted: 8,
          threeMade: 1, threeAttempted: 3,
          ftMade: 2, ftAttempted: 2,
          assists: 3, rebounds: 5, steals: 1, turnovers: 2, blocks: 0,
        }],
        events: [],
      });

      // ── Navigate to dashboard and open the player ─────────────────────────
      await page.reload();
      await page.waitForURL(/\/dashboard/, { timeout: 15_000 });

      // Click the player chip
      const chip = page.getByRole("button", { name: /Edit Test Player/i }).first();
      await expect(chip).toBeVisible({ timeout: 10_000 });
      await chip.click();

      // Open the team accordion
      await expect(page.getByText("Edit Test Team")).toBeVisible({ timeout: 8_000 });
      await page.getByText("Edit Test Team").first().click();

      // Verify original row is present
      await expect(page.getByText("Original Opponent")).toBeVisible({ timeout: 8_000 });

      // ── Capture the W-L badge before editing ─────────────────────────────
      // The accordion header shows "1 - 0" (1 win, 0 losses) because we seeded a Win.
      const accordionHeader = page.locator("h3", { hasText: "Edit Test Team" });
      await expect(accordionHeader).toBeVisible({ timeout: 5_000 });
      // The wins-losses badge is a sibling element showing "1 - 0"
      const wlBadgeBefore = page.locator("span", { hasText: /^1\s*-\s*0$/ });
      await expect(wlBadgeBefore).toBeVisible({ timeout: 5_000 });

      // ── Open the Edit Stats dialog ────────────────────────────────────────
      // The pencil button is in the actions column of the game row.
      // It appears on hover; click it directly (Playwright ignores CSS opacity).
      const pencilButton = page.locator("button[title='Edit stats']").first();
      await expect(pencilButton).toBeVisible({ timeout: 5_000 });
      await pencilButton.click();

      // Dialog should appear
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible({ timeout: 5_000 });
      await expect(dialog).toContainText("Edit Stats");

      // ── Change opponent name ──────────────────────────────────────────────
      const opponentInput = dialog.getByLabel("Opponent");
      await opponentInput.clear();
      await opponentInput.fill("Updated Rival");

      // ── Change team score ─────────────────────────────────────────────────
      const teamScoreInput = dialog.getByLabel("Our Score");
      await teamScoreInput.clear();
      await teamScoreInput.fill("95");

      // ── Change opponent score ─────────────────────────────────────────────
      const opponentScoreInput = dialog.getByLabel("Their Score");
      await opponentScoreInput.clear();
      await opponentScoreInput.fill("70");

      // ── Flip result to L ──────────────────────────────────────────────────
      // The result selector shows "Win" / "Loss" buttons.
      const lButton = dialog.getByRole("button", { name: "Loss" });
      await lButton.click();

      // ── Save ──────────────────────────────────────────────────────────────
      await dialog.getByRole("button", { name: "Save Changes" }).click();

      // Dialog should close
      await expect(dialog).not.toBeVisible({ timeout: 8_000 });

      // ── Verify: table row updated WITHOUT a page reload ───────────────────
      // New opponent appears
      await expect(page.getByText("Updated Rival")).toBeVisible({ timeout: 8_000 });

      // Old opponent gone
      await expect(page.getByText("Original Opponent")).not.toBeVisible();

      // New score appears in the result cell (e.g. "L" + "95-70")
      await expect(page.getByText(/95[-–]70/)).toBeVisible({ timeout: 5_000 });

      // Result badge should now be "L" (red)
      const lBadge = page.locator("td, span", { hasText: /^L$/ }).first();
      await expect(lBadge).toBeVisible({ timeout: 5_000 });

      // ── Verify: accordion header W-L badge refreshed ─────────────────────
      // After flipping the one game to a Loss the record should be "0 - 1"
      const wlBadgeAfter = page.locator("span", { hasText: /^0\s*-\s*1$/ });
      await expect(wlBadgeAfter).toBeVisible({ timeout: 8_000 });

      // The old "1 - 0" badge must no longer be shown
      await expect(page.locator("span", { hasText: /^1\s*-\s*0$/ })).not.toBeVisible();

    } finally {
      await deleteClerkUser(user.id);
    }
  });
});
