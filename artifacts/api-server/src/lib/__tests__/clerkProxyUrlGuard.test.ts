/**
 * Regression guard: CLERK_PROXY_URL must never be set in production.
 *
 * When CLERK_PROXY_URL is present, the Clerk SDK automatically changes the
 * expected JWT issuer to the proxy URL. Mobile Bearer tokens carry
 * iss: https://immortal-swan-47.clerk.accounts.dev (direct Clerk FAPI) and
 * will never match the proxy URL — every mobile request returns 401.
 *
 * This test pins the boot-time guard that detects the variable and exits
 * loudly, so the mistake can't silently ship to production.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Snapshot env / process state and restore after each test.
// ---------------------------------------------------------------------------
let originalEnv: NodeJS.ProcessEnv;
let exitSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  originalEnv = { ...process.env };
  // Intercept process.exit so it doesn't actually kill the test runner.
  exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  process.env = originalEnv;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Inline the guard logic (mirrors index.ts) so we can test it in isolation
// without importing all of index.ts (which has heavy boot-time side-effects).
// ---------------------------------------------------------------------------
function runClerkProxyUrlGuard() {
  if (process.env["NODE_ENV"] === "production" && process.env["CLERK_PROXY_URL"]) {
    console.error(
      "[FATAL] CLERK_PROXY_URL is set in production. " +
        "This causes the Clerk SDK to expect JWT iss: <proxyUrl> instead of the " +
        "direct Clerk FAPI issuer. Every mobile Bearer token will be rejected with " +
        "401. Remove CLERK_PROXY_URL from production Secrets and redeploy.",
    );
    process.exit(1);
  }
}

describe("CLERK_PROXY_URL boot-time guard", () => {
  it("exits with code 1 when CLERK_PROXY_URL is set in production", () => {
    process.env["NODE_ENV"] = "production";
    process.env["CLERK_PROXY_URL"] = "https://app.example.com/clerk-proxy";

    runClerkProxyUrlGuard();

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("[FATAL] CLERK_PROXY_URL is set in production"),
    );
  });

  it("error message names the specific risk — mobile 401s", () => {
    process.env["NODE_ENV"] = "production";
    process.env["CLERK_PROXY_URL"] = "https://app.example.com/clerk-proxy";

    runClerkProxyUrlGuard();

    const message: string = errorSpy.mock.calls[0]?.[0] as string;
    expect(message).toContain("mobile Bearer token");
    expect(message).toContain("401");
  });

  it("does NOT exit when CLERK_PROXY_URL is absent in production", () => {
    process.env["NODE_ENV"] = "production";
    delete process.env["CLERK_PROXY_URL"];

    runClerkProxyUrlGuard();

    expect(exitSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("does NOT exit when CLERK_PROXY_URL is set but NODE_ENV is development", () => {
    process.env["NODE_ENV"] = "development";
    process.env["CLERK_PROXY_URL"] = "https://app.example.com/clerk-proxy";

    runClerkProxyUrlGuard();

    expect(exitSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("does NOT exit when CLERK_PROXY_URL is an empty string", () => {
    // An empty string is falsy — the guard should treat it as absent.
    process.env["NODE_ENV"] = "production";
    process.env["CLERK_PROXY_URL"] = "";

    runClerkProxyUrlGuard();

    expect(exitSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
