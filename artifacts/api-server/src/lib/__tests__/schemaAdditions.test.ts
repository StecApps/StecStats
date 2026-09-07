import { beforeEach, describe, expect, it, vi } from "vitest";

const { executeMock } = vi.hoisted(() => ({
  executeMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@workspace/db", () => ({
  db: { execute: executeMock },
  playersTable: {},
  gamesTable: {},
}));

vi.mock("../logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { applyReelLeaseSchemaAdditions } from "../seed";

function sqlText(value: unknown): string {
  const seen = new Set<unknown>();
  const strings: string[] = [];
  const visit = (part: unknown): void => {
    if (typeof part === "string") {
      strings.push(part);
      return;
    }
    if (!part || typeof part !== "object" || seen.has(part)) return;
    seen.add(part);
    for (const child of Object.values(part)) visit(child);
  };
  visit(value);
  return strings.join(" ");
}

describe("boot-time schema additions", () => {
  beforeEach(() => executeMock.mockClear());

  it("idempotently creates both segmented Highlight playback columns", async () => {
    await applyReelLeaseSchemaAdditions();
    const statements = executeMock.mock.calls.map(([query]) => sqlText(query));

    expect(statements.some((statement) =>
      statement.includes("ADD COLUMN IF NOT EXISTS highlight_clip_manifest jsonb"),
    )).toBe(true);
    expect(statements.some((statement) =>
      statement.includes("ADD COLUMN IF NOT EXISTS highlight_playback_version integer"),
    )).toBe(true);
  });
});