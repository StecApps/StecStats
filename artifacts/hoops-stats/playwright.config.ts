import { defineConfig, devices } from "@playwright/test";
import { execSync } from "child_process";

const devDomain = process.env.REPLIT_DEV_DOMAIN;
const baseURL = process.env.PLAYWRIGHT_BASE_URL
  ?? (devDomain ? `https://${devDomain}` : `http://localhost:${process.env.PORT ?? 5173}`);

// Prefer the Nix-managed system Chromium when the Playwright-bundled headless
// shell can't find its system libraries (common in the Replit sandbox).
// Fall back to undefined so Playwright uses its default resolution.
function resolveChromiumExecutable(): string | undefined {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) {
    return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  }
  try {
    const path = execSync("which chromium 2>/dev/null || which chromium-browser 2>/dev/null", {
      encoding: "utf8",
    }).trim();
    return path || undefined;
  } catch {
    return undefined;
  }
}

const chromiumExecutable = resolveChromiumExecutable();

export default defineConfig({
  testDir: "./tests",
  timeout: 45_000,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: "list",
  globalSetup: "./tests/global-setup.ts",
  use: {
    baseURL,
    trace: "on-first-retry",
    actionTimeout: 15_000,
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        ...(chromiumExecutable
          ? { launchOptions: { executablePath: chromiumExecutable } }
          : {}),
      },
    },
  ],
});
