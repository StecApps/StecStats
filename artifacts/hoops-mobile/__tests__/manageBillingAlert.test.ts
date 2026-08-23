/**
 * Tests for the openBillingPortal helper (Stripe / web path).
 *
 * Imports the real production function from lib/manageBilling so that any
 * change to the Alert messages or logic breaks these tests immediately.
 *
 * Verifies that Alert.alert fires with the correct title when:
 *   1. domain is undefined (EXPO_PUBLIC_DOMAIN not set).
 *   2. Linking.canOpenURL resolves to false (device can't open the URL).
 *   3. Linking.openURL rejects (OS-level error opening the URL).
 *   4. URL opens successfully — no alert should fire.
 *   5. canOpenURL is called with the correct billing URL.
 */

// ── Mocks (hoisted before imports) ───────────────────────────────────────────

jest.mock('react-native', () => ({
  Alert: { alert: jest.fn() },
  Platform: { OS: 'ios' },
  Linking: {
    canOpenURL: jest.fn(),
    openURL: jest.fn(),
  },
}));

// ── Imports (after mock hoisting) ─────────────────────────────────────────────

import { Alert, Linking } from 'react-native';
import { openBillingPortal } from '@/lib/manageBilling';

const alertSpy = Alert.alert as jest.Mock;
const mockCanOpenURL = Linking.canOpenURL as jest.Mock;
const mockOpenURL = Linking.openURL as jest.Mock;

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
});

test('shows Billing Unavailable alert when domain is undefined', async () => {
  await openBillingPortal(undefined);

  expect(alertSpy).toHaveBeenCalledTimes(1);
  expect(alertSpy).toHaveBeenCalledWith(
    'Billing Unavailable',
    'Unable to open billing management right now. Please try again later or visit the website.',
  );
  // Linking must not be touched when the domain is missing
  expect(mockCanOpenURL).not.toHaveBeenCalled();
  expect(mockOpenURL).not.toHaveBeenCalled();
});

test('shows Billing Unavailable alert when Linking.canOpenURL returns false', async () => {
  mockCanOpenURL.mockResolvedValueOnce(false);

  await openBillingPortal('example.com');

  expect(alertSpy).toHaveBeenCalledTimes(1);
  expect(alertSpy).toHaveBeenCalledWith(
    'Billing Unavailable',
    'Your device was unable to open the billing page. Please visit the website to manage your subscription.',
  );
  expect(mockOpenURL).not.toHaveBeenCalled();
});

test('shows Billing Unavailable alert when Linking.openURL rejects', async () => {
  mockCanOpenURL.mockResolvedValueOnce(true);
  mockOpenURL.mockRejectedValueOnce(new Error('Could not open URL'));

  await openBillingPortal('example.com');

  expect(alertSpy).toHaveBeenCalledTimes(1);
  expect(alertSpy).toHaveBeenCalledWith(
    'Billing Unavailable',
    'Something went wrong opening billing management. Please try again later.',
  );
});

test('does NOT show an alert when the URL opens successfully', async () => {
  mockCanOpenURL.mockResolvedValueOnce(true);
  mockOpenURL.mockResolvedValueOnce(undefined);

  await openBillingPortal('example.com');

  expect(alertSpy).not.toHaveBeenCalled();
});

test('canOpenURL is called with the correct billing URL', async () => {
  mockCanOpenURL.mockResolvedValueOnce(true);
  mockOpenURL.mockResolvedValueOnce(undefined);

  await openBillingPortal('mycoachapp.com');

  expect(mockCanOpenURL).toHaveBeenCalledWith('https://mycoachapp.com/billing');
  expect(mockOpenURL).toHaveBeenCalledWith('https://mycoachapp.com/billing');
});
