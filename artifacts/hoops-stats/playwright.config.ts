import { defineConfig, devices } from "@playwright/test";

const devDomain = process.env.REPLIT_DEV_DOMAIN;
const baseURL = process.env.PLAYWRIGHT_BASE_URL
  ?? (devDomain ? `https://${devDomain}` : `http://localhost:${process.env.PORT ?? 5173}`);

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
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
