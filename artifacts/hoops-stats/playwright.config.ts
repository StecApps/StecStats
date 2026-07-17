import { defineConfig, devices } from "@playwright/test";

const devDomain = process.env.REPLIT_DEV_DOMAIN;
const baseURL = devDomain
  ? `https://${devDomain}`
  : `http://localhost:${process.env.PORT ?? 5173}`;

export default defineConfig({
  testDir: "./tests",
  timeout: 45_000,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: "list",
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
