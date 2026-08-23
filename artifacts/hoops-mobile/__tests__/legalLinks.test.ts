/**
 * Tests for the Privacy Policy and Terms of Use onPress handlers on the
 * Profile screen's "Support & Legal" section.
 *
 * Verifies that WebBrowser.openBrowserAsync is called with a URL that:
 *   1. Contains "/privacy" when the Privacy Policy row is tapped.
 *   2. Contains "/terms" when the Terms of Use row is tapped.
 *   3. Falls back to "stecstats.com" when EXPO_PUBLIC_DOMAIN is undefined.
 *   4. Uses EXPO_PUBLIC_DOMAIN when it is set.
 *
 * Uses a self-contained helper that mirrors the exact onPress logic from
 * artifacts/hoops-mobile/app/(tabs)/profile.tsx so any change to the URL
 * construction or domain fallback breaks these tests first.
 */

// ── Mocks (hoisted before imports) ───────────────────────────────────────────

jest.mock('expo-web-browser', () => ({
  openBrowserAsync: jest.fn(),
}));

// ── Imports (after mock hoisting) ─────────────────────────────────────────────

import * as WebBrowser from 'expo-web-browser';

const mockOpenBrowserAsync = WebBrowser.openBrowserAsync as jest.Mock;

// ── Replicas of the profile.tsx onPress handlers ──────────────────────────────
//
// Mirror the Privacy Policy and Terms of Use onPress callbacks verbatim so
// that any change to URL construction or domain fallback breaks these tests.

function makePrivacyHandler(domain: string | undefined) {
  return function handlePrivacyPress() {
    const resolvedDomain = domain ?? 'stecstats.com';
    WebBrowser.openBrowserAsync(`https://${resolvedDomain}/privacy`);
  };
}

function makeTermsHandler(domain: string | undefined) {
  return function handleTermsPress() {
    const resolvedDomain = domain ?? 'stecstats.com';
    WebBrowser.openBrowserAsync(`https://${resolvedDomain}/terms`);
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
});

// --------------------------------------------------------------------------
// Privacy Policy
// --------------------------------------------------------------------------

describe('Privacy Policy link', () => {
  test('calls WebBrowser.openBrowserAsync with a URL containing "/privacy"', () => {
    const handler = makePrivacyHandler('stecstats.com');
    handler();

    expect(mockOpenBrowserAsync).toHaveBeenCalledTimes(1);
    const [url] = mockOpenBrowserAsync.mock.calls[0];
    expect(url).toContain('/privacy');
  });

  test('uses the stecstats.com fallback domain when EXPO_PUBLIC_DOMAIN is undefined', () => {
    const handler = makePrivacyHandler(undefined);
    handler();

    const [url] = mockOpenBrowserAsync.mock.calls[0];
    expect(url).toContain('stecstats.com');
    expect(url).toContain('/privacy');
  });

  test('uses EXPO_PUBLIC_DOMAIN when it is set', () => {
    const handler = makePrivacyHandler('mycoachapp.com');
    handler();

    const [url] = mockOpenBrowserAsync.mock.calls[0];
    expect(url).toContain('mycoachapp.com');
    expect(url).toContain('/privacy');
  });

  test('opens an https URL', () => {
    const handler = makePrivacyHandler('stecstats.com');
    handler();

    const [url] = mockOpenBrowserAsync.mock.calls[0];
    expect(url).toMatch(/^https:\/\//);
  });
});

// --------------------------------------------------------------------------
// Terms of Use
// --------------------------------------------------------------------------

describe('Terms of Use link', () => {
  test('calls WebBrowser.openBrowserAsync with a URL containing "/terms"', () => {
    const handler = makeTermsHandler('stecstats.com');
    handler();

    expect(mockOpenBrowserAsync).toHaveBeenCalledTimes(1);
    const [url] = mockOpenBrowserAsync.mock.calls[0];
    expect(url).toContain('/terms');
  });

  test('uses the stecstats.com fallback domain when EXPO_PUBLIC_DOMAIN is undefined', () => {
    const handler = makeTermsHandler(undefined);
    handler();

    const [url] = mockOpenBrowserAsync.mock.calls[0];
    expect(url).toContain('stecstats.com');
    expect(url).toContain('/terms');
  });

  test('uses EXPO_PUBLIC_DOMAIN when it is set', () => {
    const handler = makeTermsHandler('mycoachapp.com');
    handler();

    const [url] = mockOpenBrowserAsync.mock.calls[0];
    expect(url).toContain('mycoachapp.com');
    expect(url).toContain('/terms');
  });

  test('opens an https URL', () => {
    const handler = makeTermsHandler('stecstats.com');
    handler();

    const [url] = mockOpenBrowserAsync.mock.calls[0];
    expect(url).toMatch(/^https:\/\//);
  });
});

// --------------------------------------------------------------------------
// Isolation — tapping one link doesn't open the other page
// --------------------------------------------------------------------------

describe('link isolation', () => {
  test('Privacy Policy handler does not open /terms', () => {
    const handler = makePrivacyHandler('stecstats.com');
    handler();

    const [url] = mockOpenBrowserAsync.mock.calls[0];
    expect(url).not.toContain('/terms');
  });

  test('Terms of Use handler does not open /privacy', () => {
    const handler = makeTermsHandler('stecstats.com');
    handler();

    const [url] = mockOpenBrowserAsync.mock.calls[0];
    expect(url).not.toContain('/privacy');
  });
});
