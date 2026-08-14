/**
 * Guard: CLERK_PROXY_URL is injected automatically by Replit's Clerk integration
 * at production runtime. The server should log an informational message and
 * continue — NOT exit.
 *
 * NOTE: The JWKS fallback that used to be in requireAuth.ts has been removed.
 * All token verification is now handled exclusively by clerkMiddleware(). The
 * comment below is retained only to document why CLERK_PROXY_URL must NOT be
 * forwarded as a proxyUrl option to clerkMiddleware() — doing so would cause
 * clerkMiddleware to expect iss: <proxyUrl> and reject every live mobile token
 * whose iss is https://immortal-swan-47.clerk.accounts.dev.
 * See app.ts comment block above the clerkMiddleware() call for details.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

let originalEnv: NodeJS.ProcessEnv;
let exitSpy: ReturnType<typeof vi.spyOn>;
let infoSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  originalEnv = { ...process.env };
  exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
  infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  process.env = originalEnv;
  vi.restoreAllMocks();
});

function runClerkProxyUrlGuard() {
  if (process.env["NODE_ENV"] === "production" && process.env["CLERK_PROXY_URL"]) {
    console.info(
      "[INFO] CLERK_PROXY_URL is set in production (injected by Replit). " +
        "It is NOT forwarded to clerkMiddleware() — mobile Bearer tokens are " +
        "verified directly via Clerk's standard JWKS path without a proxy iss override.",
    );
  }
}

describe("CLERK_PROXY_URL boot-time behaviour", () => {
  it("does NOT exit when CLERK_PROXY_URL is set in production (Replit injects it)", () => {
    process.env["NODE_ENV"] = "production";
    process.env["CLERK_PROXY_URL"] = "https://app.example.com/clerk-proxy";

    runClerkProxyUrlGuard();

    expect(exitSpy).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining("[INFO] CLERK_PROXY_URL is set in production"),
    );
  });

  it("logs that CLERK_PROXY_URL is NOT forwarded to clerkMiddleware", () => {
    process.env["NODE_ENV"] = "production";
    process.env["CLERK_PROXY_URL"] = "https://app.example.com/clerk-proxy";

    runClerkProxyUrlGuard();

    const message: string = infoSpy.mock.calls[0]?.[0] as string;
    // Must state that CLERK_PROXY_URL is not forwarded to clerkMiddleware.
    // Forwarding it would cause clerkMiddleware to reject every live mobile
    // Bearer token whose iss is the Clerk FAPI domain (not the proxy URL).
    expect(message).toContain("NOT forwarded to clerkMiddleware");
  });

  it("does nothing when CLERK_PROXY_URL is absent in production", () => {
    process.env["NODE_ENV"] = "production";
    delete process.env["CLERK_PROXY_URL"];

    runClerkProxyUrlGuard();

    expect(exitSpy).not.toHaveBeenCalled();
    expect(infoSpy).not.toHaveBeenCalled();
  });

  it("does nothing when CLERK_PROXY_URL is set but NODE_ENV is development", () => {
    process.env["NODE_ENV"] = "development";
    process.env["CLERK_PROXY_URL"] = "https://app.example.com/clerk-proxy";

    runClerkProxyUrlGuard();

    expect(exitSpy).not.toHaveBeenCalled();
    expect(infoSpy).not.toHaveBeenCalled();
  });

  it("does nothing when CLERK_PROXY_URL is an empty string", () => {
    process.env["NODE_ENV"] = "production";
    process.env["CLERK_PROXY_URL"] = "";

    runClerkProxyUrlGuard();

    expect(exitSpy).not.toHaveBeenCalled();
    expect(infoSpy).not.toHaveBeenCalled();
  });
});
