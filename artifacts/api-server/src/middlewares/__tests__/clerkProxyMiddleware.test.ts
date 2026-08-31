import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const createProxyMiddleware = vi.fn((_options: unknown) => vi.fn());

vi.mock("http-proxy-middleware", () => ({
  createProxyMiddleware,
}));

describe("clerkProxyMiddleware", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalSecretKey = process.env.CLERK_SECRET_KEY;

  beforeEach(() => {
    vi.resetModules();
    createProxyMiddleware.mockClear();
    process.env.NODE_ENV = "production";
    process.env.CLERK_SECRET_KEY = "sk_test_placeholder";
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    process.env.CLERK_SECRET_KEY = originalSecretKey;
  });

  it("requests uncompressed Clerk responses for React Native clients", async () => {
    const { clerkProxyMiddleware } = await import("../clerkProxyMiddleware");
    clerkProxyMiddleware();

    const options = createProxyMiddleware.mock.calls[0]?.[0] as {
      on: {
        proxyReq: (
          proxyReq: { setHeader: ReturnType<typeof vi.fn> },
          req: {
            headers: Record<string, string>;
            socket: { remoteAddress?: string };
          },
        ) => void;
      };
    };
    const setHeader = vi.fn();

    options.on.proxyReq(
      { setHeader },
      {
        headers: {
          host: "stecstats.com",
          "x-forwarded-proto": "https",
        },
        socket: {},
      },
    );

    expect(setHeader).toHaveBeenCalledWith("Accept-Encoding", "identity");
  });
});