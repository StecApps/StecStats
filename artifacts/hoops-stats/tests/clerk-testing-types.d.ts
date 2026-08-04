/**
 * Local module augmentation for @clerk/testing/playwright.
 *
 * @clerk/testing v2.2.9 does not declare `userId` in SetupClerkTestingTokenParams.
 * Tests pass `userId` so they can target a specific user when generating the
 * testing token. This augmentation widens the accepted params type to include it
 * without requiring an upstream version bump.
 */
import type { BrowserContext, Page } from "@playwright/test";

declare module "@clerk/testing/playwright" {
  export function setupClerkTestingToken(params: {
    context?: BrowserContext;
    page?: Page;
    userId?: string;
    options?: { frontendApiUrl?: string };
  }): Promise<void>;
}
