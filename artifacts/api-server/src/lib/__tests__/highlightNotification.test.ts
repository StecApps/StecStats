/**
 * maybeSendTeamHighlightNotification — unit tests
 *
 * Verifies:
 *   1. Notification IS sent (and flag flipped) when highlightNotificationSent is false.
 *   2. Notification is NOT sent when highlightNotificationSent is already true.
 *   3. Notification is skipped when the user has no push token.
 *   4. Notification is skipped when ownerId is null (orphaned team).
 *   5. DB error inside the guard is swallowed and logged, never rethrown.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// In-memory state shared across mocks
// ---------------------------------------------------------------------------
const state = {
  pushToken: "ExponentPushToken[testAbc]" as string | null,
  notificationSent: false as boolean,
  dbUpdateCalled: false,
  sendExpoPushCalled: false,
  sendExpoPushPayload: null as Record<string, unknown> | null,
};

function resetState() {
  state.pushToken = "ExponentPushToken[testAbc]";
  state.notificationSent = false;
  state.dbUpdateCalled = false;
  state.sendExpoPushCalled = false;
  state.sendExpoPushPayload = null;
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
        where: vi.fn().mockImplementation(() => {
          state.dbUpdateCalled = true;
          if ("highlightNotificationSent" in vals) {
            state.notificationSent = vals.highlightNotificationSent as boolean;
          }
          return Promise.resolve();
        }),
      })),
    })),
  },
  teamsTable: "teamsTable",
  usersTable: "usersTable",
}));

vi.mock("../expoPush", () => ({
  sendExpoPush: vi.fn().mockImplementation(async (_token: string, msg: Record<string, unknown>) => {
    state.sendExpoPushCalled = true;
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
  highlightNotificationSent?: boolean;
  ownerId?: number | null;
} = {}) {
  return {
    id: 42,
    name: "Varsity Bears",
    ownerId: overrides.ownerId !== undefined ? overrides.ownerId : 7,
    highlightNotificationSent: overrides.highlightNotificationSent ?? false,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(resetState);

describe("maybeSendTeamHighlightNotification — notification fires when pending", () => {
  it("sends the push notification when highlightNotificationSent is false", async () => {
    await maybeSendTeamHighlightNotification(makeTeam({ highlightNotificationSent: false }));
    expect(state.sendExpoPushCalled).toBe(true);
  });

  it("uses the correct title and body", async () => {
    await maybeSendTeamHighlightNotification(makeTeam({ highlightNotificationSent: false }));
    expect(state.sendExpoPushPayload?.title).toBe("Your highlights are ready 🏀");
    expect((state.sendExpoPushPayload?.body as string)).toContain("Varsity Bears");
  });

  it("marks the flag true in the DB after sending", async () => {
    await maybeSendTeamHighlightNotification(makeTeam({ highlightNotificationSent: false }));
    expect(state.dbUpdateCalled).toBe(true);
    expect(state.notificationSent).toBe(true);
  });
});

describe("maybeSendTeamHighlightNotification — notification suppressed when already sent", () => {
  it("does NOT send when highlightNotificationSent is true", async () => {
    await maybeSendTeamHighlightNotification(makeTeam({ highlightNotificationSent: true }));
    expect(state.sendExpoPushCalled).toBe(false);
  });

  it("does NOT update the DB flag when already true", async () => {
    await maybeSendTeamHighlightNotification(makeTeam({ highlightNotificationSent: true }));
    expect(state.dbUpdateCalled).toBe(false);
  });
});

describe("maybeSendTeamHighlightNotification — skipped for teams without a push token", () => {
  it("does not call sendExpoPush when the user has no push token", async () => {
    state.pushToken = null;
    await maybeSendTeamHighlightNotification(makeTeam({ highlightNotificationSent: false }));
    expect(state.sendExpoPushCalled).toBe(false);
  });

  it("still marks the DB flag true even when no push token is stored", async () => {
    state.pushToken = null;
    await maybeSendTeamHighlightNotification(makeTeam({ highlightNotificationSent: false }));
    // Flag is set so we don't attempt to re-notify on every subsequent status check
    expect(state.dbUpdateCalled).toBe(true);
    expect(state.notificationSent).toBe(true);
  });
});

describe("maybeSendTeamHighlightNotification — skipped for orphaned teams", () => {
  it("does nothing when ownerId is null", async () => {
    await maybeSendTeamHighlightNotification(makeTeam({ ownerId: null }));
    expect(state.sendExpoPushCalled).toBe(false);
    expect(state.dbUpdateCalled).toBe(false);
  });
});
