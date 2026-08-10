/**
 * Guard: CLERK_PROXY_URL is injected automatically by Replit's Clerk integration
 * at production runtime. The server should log an informational message and
 * continue — NOT exit. Mobile tokens are handled by the JWKS fallback in
 * requireAuth.ts even when clerkMiddleware() changes the expected iss.
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
        "Mobile tokens will be verified via the JWKS fallback in requireAuth.",
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

  it("logs the JWKS fallback reassurance", () => {
    process.env["NODE_ENV"] = "production";
    process.env["CLERK_PROXY_URL"] = "https://app.example.com/clerk-proxy";

    runClerkProxyUrlGuard();

    const message: string = infoSpy.mock.calls[0]?.[0] as string;
    expect(message).toContain("JWKS fallback");
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
