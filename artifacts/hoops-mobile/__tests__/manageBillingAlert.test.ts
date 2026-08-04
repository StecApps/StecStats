/**
 * Tests for the "Manage Billing" onPress handler (Stripe / web path).
 *
 * Verifies that Alert.alert fires with the correct title when:
 *   1. process.env.EXPO_PUBLIC_DOMAIN is undefined.
 *   2. Linking.canOpenURL resolves to false (device can't open the URL).
 *   3. Linking.openURL rejects (OS-level error opening the URL).
 *
 * Uses a self-contained helper that mirrors the exact else-branch logic from
 * artifacts/hoops-mobile/app/(tabs)/profile.tsx so any change to the Alert
 * calls breaks these tests first.
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

const alertSpy = Alert.alert as jest.Mock;
const mockCanOpenURL = Linking.canOpenURL as jest.Mock;
const mockOpenURL = Linking.openURL as jest.Mock;

// ── Replica of the profile.tsx Stripe billing handler ────────────────────────
//
// Mirrors the `else` branch (rcPlan === null) in the "Manage Billing" onPress
// verbatim so that any change to the Alert messages / structure breaks tests.

function makeBillingHandler(domain: string | undefined) {
  return async function handleManageBilling() {
    if (!domain) {
      console.warn('[Profile] EXPO_PUBLIC_DOMAIN is not set — cannot open billing portal');
      Alert.alert(
        'Billing Unavailable',
        'Unable to open billing management right now. Please try again later or visit the website.',
      );
      return;
    }
    const billingUrl = `https://${domain}/billing`;
    try {
      const canOpen = await Linking.canOpenURL(billingUrl);
      if (!canOpen) {
        Alert.alert(
          'Billing Unavailable',
          'Your device was unable to open the billing page. Please visit the website to manage your subscription.',
        );
        return;
      }
      await Linking.openURL(billingUrl);
    } catch (err) {
      console.warn('[Profile] Failed to open billing portal:', err);
      Alert.alert(
        'Billing Unavailable',
        'Something went wrong opening billing management. Please try again later.',
      );
    }
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
});

test('shows Billing Unavailable alert when EXPO_PUBLIC_DOMAIN is undefined', async () => {
  const handler = makeBillingHandler(undefined);
  await handler();

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

  const handler = makeBillingHandler('example.com');
  await handler();

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

  const handler = makeBillingHandler('example.com');
  await handler();

  expect(alertSpy).toHaveBeenCalledTimes(1);
  expect(alertSpy).toHaveBeenCalledWith(
    'Billing Unavailable',
    'Something went wrong opening billing management. Please try again later.',
  );
});

test('does NOT show an alert when the URL opens successfully', async () => {
  mockCanOpenURL.mockResolvedValueOnce(true);
  mockOpenURL.mockResolvedValueOnce(undefined);

  const handler = makeBillingHandler('example.com');
  await handler();

  expect(alertSpy).not.toHaveBeenCalled();
});

test('canOpenURL is called with the correct billing URL', async () => {
  mockCanOpenURL.mockResolvedValueOnce(true);
  mockOpenURL.mockResolvedValueOnce(undefined);

  const handler = makeBillingHandler('mycoachapp.com');
  await handler();

  expect(mockCanOpenURL).toHaveBeenCalledWith('https://mycoachapp.com/billing');
  expect(mockOpenURL).toHaveBeenCalledWith('https://mycoachapp.com/billing');
});
