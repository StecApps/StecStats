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
  Alert: { alert: jest.fn() },
  Linking: { canOpenURL: jest.fn(), openURL: jest.fn() },
  Share: { share: jest.fn() },
}));

// ── Imports (after mock hoisting) ─────────────────────────────────────────────

import { Alert, Linking, Share } from 'react-native';
import {
  CONTACT_SUPPORT_URL,
  SUPPORT_EMAIL,
  openContactSupport,
} from '../lib/supportConfig';

const alertSpy = Alert.alert as jest.Mock;
const mockOpenURL = Linking.openURL as jest.Mock;
const mockCanOpenURL = Linking.canOpenURL as jest.Mock;
const mockShare = Share.share as jest.Mock;

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  mockCanOpenURL.mockResolvedValue(true);
  mockOpenURL.mockResolvedValue(undefined);
});

describe('Contact Support link', () => {
  test('CONTACT_SUPPORT_URL contains "mailto:"', () => {
    expect(CONTACT_SUPPORT_URL).toContain('mailto:');
  });

  test('CONTACT_SUPPORT_URL contains the correct support email address', () => {
    expect(CONTACT_SUPPORT_URL).toContain(SUPPORT_EMAIL);
  });

  test('openContactSupport calls Linking.openURL exactly once', async () => {
    await openContactSupport();

    expect(mockOpenURL).toHaveBeenCalledTimes(1);
  });

  test('openContactSupport calls Linking.openURL with CONTACT_SUPPORT_URL', async () => {
    await openContactSupport();

    expect(mockOpenURL).toHaveBeenCalledWith(CONTACT_SUPPORT_URL);
  });

  test('openContactSupport calls Linking.openURL with a mailto: URL', async () => {
    await openContactSupport();

    const [url] = mockOpenURL.mock.calls[0];
    expect(url).toContain('mailto:');
  });

  test('openContactSupport calls Linking.openURL with the correct email address', async () => {
    await openContactSupport();

    const [url] = mockOpenURL.mock.calls[0];
    expect(url).toContain('support@stecstats.com');
  });

  test('does not open a browser URL (no https://)', () => {
    expect(CONTACT_SUPPORT_URL).not.toMatch(/^https?:\/\//);
  });

  test('offers a share/copy fallback when no email client is configured', async () => {
    mockCanOpenURL.mockResolvedValueOnce(false);

    await openContactSupport();

    expect(alertSpy).toHaveBeenCalledWith(
      'Contact Support',
      'No email app is configured. You can share or copy support@stecstats.com instead.',
      expect.arrayContaining([
        expect.objectContaining({ text: 'Share / Copy Address' }),
      ]),
    );
    expect(mockOpenURL).not.toHaveBeenCalled();

    const buttons = alertSpy.mock.calls[0][2];
    await buttons[0].onPress();
    expect(mockShare).toHaveBeenCalledWith(
      expect.objectContaining({ message: SUPPORT_EMAIL }),
    );
  });
});
