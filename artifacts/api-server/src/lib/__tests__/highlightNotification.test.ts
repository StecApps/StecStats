/**
 * maybeSendTeamHighlightNotification — unit tests
 *
 * Verifies:
 *   1. Notification IS sent (and flag claimed) when highlightNotificationSent is false.
 *   2. Notification is NOT sent when highlightNotificationSent is already true.
 *   3. Notification is skipped when the user has no push token.
 *   4. Notification is skipped when ownerId is null (orphaned team).
 *   5. Under concurrent calls both seeing highlightNotificationSent=false, the push
 *      fires exactly once (atomic DB claim: first claimant wins, second exits).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// In-memory state shared across mocks
// ---------------------------------------------------------------------------
const state = {
  pushToken: "ExponentPushToken[testAbc]" as string | null,
  notificationSent: false as boolean,
  dbUpdateCalled: false,
  sendExpoPushCallCount: 0,
  sendExpoPushPayload: null as Record<string, unknown> | null,
  // Controls how many concurrent .returning() calls see a successful claim.
  // Default: first call always claims (returns [{id}]); subsequent return [].
  claimCallCount: 0,
};

function resetState() {
  state.pushToken = "ExponentPushToken[testAbc]";
  state.notificationSent = false;
  state.dbUpdateCalled = false;
  state.sendExpoPushCallCount = 0;
  state.sendExpoPushPayload = null;
  state.claimCallCount = 0;
}

// ---------------------------------------------------------------------------
// Mocks — declared before any real imports that resolve them
// ---------------------------------------------------------------------------

vi.mock("@workspace/db", () => ({
  db: {
    query: {
      usersTable: {
        findFirst: vi.fn().mockImplementation(async () =>
          state.pushToken != null
            ? { id: 1, pushToken: state.pushToken }
            : { id: 1, pushToken: null },
        ),
      },
    },
    update: vi.fn().mockImplementation(() => ({
      set: vi.fn().mockImplementation((vals: Record<string, unknown>) => ({
        where: vi.fn().mockImplementation(() => ({
          // Atomic claim: first concurrent caller sees [{id}], subsequent see [].
          returning: vi.fn().mockImplementation(() => {
            state.dbUpdateCalled = true;
            if ("highlightNotificationSent" in vals) {
              state.notificationSent = vals.highlightNotificationSent as boolean;
            }
            state.claimCallCount++;
            const claimed = state.claimCallCount === 1 ? [{ id: 42 }] : [];
            return Promise.resolve(claimed);
          }),
        })),
      })),
    })),
  },
  teamsTable: "teamsTable",
  usersTable: "usersTable",
}));

vi.mock("../expoPush", () => ({
  sendExpoPush: vi.fn().mockImplementation(async (_token: string, msg: Record<string, unknown>) => {
    state.sendExpoPushCallCount++;
    state.sendExpoPushPayload = msg;
  }),
}));

vi.mock("../logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Real import — after mocks are in place
import { maybeSendTeamHighlightNotification } from "../highlightGenerator";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTeam(overrides: {
  highlightNotificationSent?: boolean | null;
  ownerId?: number | null;
} = {}) {
  return {
    id: 42,
    name: "Varsity Bears",
    ownerId: overrides.ownerId !== undefined ? overrides.ownerId : 7,
    highlightNotificationSent:
      "highlightNotificationSent" in overrides ? overrides.highlightNotificationSent! : false,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(resetState);

describe("maybeSendTeamHighlightNotification — notification fires when pending", () => {
  it("sends the push notification when highlightNotificationSent is false", async () => {
    await maybeSendTeamHighlightNotification(makeTeam({ highlightNotificationSent: false }));
    expect(state.sendExpoPushCallCount).toBe(1);
  });

  it("uses the correct title and body", async () => {
    await maybeSendTeamHighlightNotification(makeTeam({ highlightNotificationSent: false }));
    expect(state.sendExpoPushPayload?.title).toBe("Your highlights are ready 🏀");
    expect((state.sendExpoPushPayload?.body as string)).toContain("Varsity Bears");
  });

  it("claims the flag in the DB before sending", async () => {
    await maybeSendTeamHighlightNotification(makeTeam({ highlightNotificationSent: false }));
    expect(state.dbUpdateCalled).toBe(true);
    expect(state.notificationSent).toBe(true);
  });
});

describe("maybeSendTeamHighlightNotification — notification suppressed when already sent", () => {
  it("does NOT send when highlightNotificationSent is true", async () => {
    await maybeSendTeamHighlightNotification(makeTeam({ highlightNotificationSent: true }));
    expect(state.sendExpoPushCallCount).toBe(0);
  });

  it("does NOT touch the DB when highlightNotificationSent is already true", async () => {
    await maybeSendTeamHighlightNotification(makeTeam({ highlightNotificationSent: true }));
    expect(state.dbUpdateCalled).toBe(false);
  });
});

describe("maybeSendTeamHighlightNotification — skipped for teams without a push token", () => {
  it("does not call sendExpoPush when the user has no push token", async () => {
    state.pushToken = null;
    await maybeSendTeamHighlightNotification(makeTeam({ highlightNotificationSent: false }));
    expect(state.sendExpoPushCallCount).toBe(0);
  });

  it("still claims the DB flag even when no push token is stored", async () => {
    state.pushToken = null;
    await maybeSendTeamHighlightNotification(makeTeam({ highlightNotificationSent: false }));
    // Flag is claimed so subsequent calls don't re-attempt notification
    expect(state.dbUpdateCalled).toBe(true);
    expect(state.notificationSent).toBe(true);
  });
});

describe("maybeSendTeamHighlightNotification — skipped for orphaned teams", () => {
  it("does nothing when ownerId is null", async () => {
    await maybeSendTeamHighlightNotification(makeTeam({ ownerId: null }));
    expect(state.sendExpoPushCallCount).toBe(0);
    expect(state.dbUpdateCalled).toBe(false);
  });
});

describe("maybeSendTeamHighlightNotification — null flag treated as unsent (legacy rows)", () => {
  it("sends the push when highlightNotificationSent is null", async () => {
    await maybeSendTeamHighlightNotification(makeTeam({ highlightNotificationSent: null }));
    expect(state.sendExpoPushCallCount).toBe(1);
  });

  it("claims the DB flag when highlightNotificationSent is null", async () => {
    await maybeSendTeamHighlightNotification(makeTeam({ highlightNotificationSent: null }));
    expect(state.dbUpdateCalled).toBe(true);
    expect(state.notificationSent).toBe(true);
  });

  it("sends exactly once when two callers race with a null flag", async () => {
    // Simulates two concurrent GET /highlight polls both reading NULL from the DB.
    await Promise.all([
      maybeSendTeamHighlightNotification(makeTeam({ highlightNotificationSent: null })),
      maybeSendTeamHighlightNotification(makeTeam({ highlightNotificationSent: null })),
    ]);
    expect(state.sendExpoPushCallCount).toBe(1);
  });
});

describe("maybeSendTeamHighlightNotification — at-most-once under concurrent calls", () => {
  it("sends the push exactly once when two callers race with highlightNotificationSent=false", async () => {
    // Both callers read highlightNotificationSent=false from the DB (as happens
    // when concurrent GET /highlight polls arrive after a server restart).
    // The mock simulates the DB atomic claim: claimCallCount===1 → [{id}],
    // claimCallCount===2 → [] (already claimed).
    await Promise.all([
      maybeSendTeamHighlightNotification(makeTeam({ highlightNotificationSent: false })),
      maybeSendTeamHighlightNotification(makeTeam({ highlightNotificationSent: false })),
    ]);

    // Exactly one push, regardless of which Promise resolved first.
    expect(state.sendExpoPushCallCount).toBe(1);
  });

  it("only claims the flag once when two callers race", async () => {
    await Promise.all([
      maybeSendTeamHighlightNotification(makeTeam({ highlightNotificationSent: false })),
      maybeSendTeamHighlightNotification(makeTeam({ highlightNotificationSent: false })),
    ]);

    // Both callers attempted the claim DB call, but only one succeeded.
    expect(state.claimCallCount).toBe(2);
  });
});
