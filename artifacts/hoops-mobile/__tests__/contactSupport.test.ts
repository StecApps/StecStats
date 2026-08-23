/**
 * Tests for the Contact Support onPress handler on the Profile screen's
 * "Support & Legal" section.
 *
 * Imports openContactSupport and CONTACT_SUPPORT_URL directly from
 * lib/supportConfig.ts — the same module that profile.tsx uses as its onPress.
 * Any change to the mailto address or the Linking call in that production
 * module immediately breaks these tests.
 *
 * No real email client is launched — Linking is fully mocked.
 */

// ── Mocks (hoisted before imports) ───────────────────────────────────────────

jest.mock('react-native', () => ({
  Linking: { openURL: jest.fn() },
}));

// ── Imports (after mock hoisting) ─────────────────────────────────────────────

import { Linking } from 'react-native';
import { CONTACT_SUPPORT_URL, openContactSupport } from '../lib/supportConfig';

const mockOpenURL = Linking.openURL as jest.Mock;

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
});

describe('Contact Support link', () => {
  test('CONTACT_SUPPORT_URL contains "mailto:"', () => {
    expect(CONTACT_SUPPORT_URL).toContain('mailto:');
  });

  test('CONTACT_SUPPORT_URL contains the correct support email address', () => {
    expect(CONTACT_SUPPORT_URL).toContain('sstec@stecstats.com');
  });

  test('openContactSupport calls Linking.openURL exactly once', () => {
    openContactSupport();

    expect(mockOpenURL).toHaveBeenCalledTimes(1);
  });

  test('openContactSupport calls Linking.openURL with CONTACT_SUPPORT_URL', () => {
    openContactSupport();

    expect(mockOpenURL).toHaveBeenCalledWith(CONTACT_SUPPORT_URL);
  });

  test('openContactSupport calls Linking.openURL with a mailto: URL', () => {
    openContactSupport();

    const [url] = mockOpenURL.mock.calls[0];
    expect(url).toContain('mailto:');
  });

  test('openContactSupport calls Linking.openURL with the correct email address', () => {
    openContactSupport();

    const [url] = mockOpenURL.mock.calls[0];
    expect(url).toContain('sstec@stecstats.com');
  });

  test('does not open a browser URL (no https://)', () => {
    expect(CONTACT_SUPPORT_URL).not.toMatch(/^https?:\/\//);
  });
});
