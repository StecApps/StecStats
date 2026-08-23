/**
 * Tests for the getManageBillingLabel and openStoreSubscriptions helpers.
 *
 * Imports the real production functions from lib/manageBilling so that any
 * change to the label or deep-link logic breaks these tests immediately.
 *
 * Verifies:
 *   1. Label is "Manage in App Store" when rcPlan is set and platform is iOS.
 *   2. Label is "Manage in App Store" for "premium" rcPlan on iOS.
 *   3. Label is "Manage in Google Play" when rcPlan is set and platform is Android.
 *   4. Label is "Manage Billing" when rcPlan is null on iOS (Stripe subscriber).
 *   5. Label is "Manage Billing" when rcPlan is null on Android (Stripe subscriber).
 *   6. iOS handler opens itms-apps:// deep-link when canOpenURL returns true.
 *   7. iOS handler falls back to https://apps.apple.com/... when itms-apps:// unsupported.
 *   8. iOS handler shows Store Unavailable alert when openURL rejects.
 *   9. Android handler opens Google Play URL when canOpenURL returns true.
 *  10. Android handler falls back to https Google Play URL when canOpenURL returns false.
 *  11. Android handler shows Store Unavailable alert when openURL rejects.
 */

// ── Mocks (hoisted before imports) ───────────────────────────────────────────

jest.mock('react-native', () => ({
  Alert: { alert: jest.fn() },
  Platform: { OS: 'ios' },   // default; overridden per-test
  Linking: {
    canOpenURL: jest.fn(),
    openURL: jest.fn(),
  },
}));

// ── Imports (after mock hoisting) ─────────────────────────────────────────────

import { Alert, Linking, Platform } from 'react-native';
import { getManageBillingLabel, openStoreSubscriptions } from '@/lib/manageBilling';

const alertSpy = Alert.alert as jest.Mock;
const mockCanOpenURL = Linking.canOpenURL as jest.Mock;
const mockOpenURL = Linking.openURL as jest.Mock;

// ── Tests: label selection ─────────────────────────────────────────────────────

describe('getManageBillingLabel', () => {
  beforeEach(() => jest.clearAllMocks());

  test('returns "Manage in App Store" when rcPlan is set and platform is iOS', () => {
    Object.defineProperty(Platform, 'OS', { get: () => 'ios', configurable: true });
    expect(getManageBillingLabel('pro')).toBe('Manage in App Store');
  });

  test('returns "Manage in App Store" when rcPlan is "premium" and platform is iOS', () => {
    Object.defineProperty(Platform, 'OS', { get: () => 'ios', configurable: true });
    expect(getManageBillingLabel('premium')).toBe('Manage in App Store');
  });

  test('returns "Manage in Google Play" when rcPlan is set and platform is Android', () => {
    Object.defineProperty(Platform, 'OS', { get: () => 'android', configurable: true });
    expect(getManageBillingLabel('pro')).toBe('Manage in Google Play');
  });

  test('returns "Manage Billing" when rcPlan is null on iOS (Stripe subscriber)', () => {
    Object.defineProperty(Platform, 'OS', { get: () => 'ios', configurable: true });
    expect(getManageBillingLabel(null)).toBe('Manage Billing');
  });

  test('returns "Manage Billing" when rcPlan is null on Android (Stripe subscriber)', () => {
    Object.defineProperty(Platform, 'OS', { get: () => 'android', configurable: true });
    expect(getManageBillingLabel(null)).toBe('Manage Billing');
  });
});

// ── Tests: iOS App Store deep-link handler ─────────────────────────────────────

describe('openStoreSubscriptions — iOS', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Object.defineProperty(Platform, 'OS', { get: () => 'ios', configurable: true });
  });

  test('opens itms-apps:// deep link when canOpenURL returns true', async () => {
    mockCanOpenURL.mockResolvedValueOnce(true);
    mockOpenURL.mockResolvedValueOnce(undefined);

    await openStoreSubscriptions();

    expect(mockCanOpenURL).toHaveBeenCalledWith('itms-apps://apps.apple.com/account/subscriptions');
    expect(mockOpenURL).toHaveBeenCalledWith('itms-apps://apps.apple.com/account/subscriptions');
    expect(alertSpy).not.toHaveBeenCalled();
  });

  test('falls back to https://apps.apple.com/... when itms-apps:// is unsupported', async () => {
    mockCanOpenURL.mockResolvedValueOnce(false);
    mockOpenURL.mockResolvedValueOnce(undefined);

    await openStoreSubscriptions();

    expect(mockCanOpenURL).toHaveBeenCalledWith('itms-apps://apps.apple.com/account/subscriptions');
    expect(mockOpenURL).toHaveBeenCalledWith('https://apps.apple.com/account/subscriptions');
    expect(alertSpy).not.toHaveBeenCalled();
  });

  test('shows Store Unavailable alert when openURL rejects', async () => {
    mockCanOpenURL.mockResolvedValueOnce(true);
    mockOpenURL.mockRejectedValueOnce(new Error('OS error'));

    await openStoreSubscriptions();

    // The rejection is caught in the .catch() callback — flush the microtask queue
    await Promise.resolve();

    expect(alertSpy).toHaveBeenCalledWith(
      'Store Unavailable',
      'Unable to open the App Store. Please manage your subscription from the App Store app.',
    );
  });
});

// ── Tests: Android Google Play deep-link handler ───────────────────────────────

describe('openStoreSubscriptions — Android', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Object.defineProperty(Platform, 'OS', { get: () => 'android', configurable: true });
  });

  test('opens Google Play URL when canOpenURL returns true', async () => {
    mockCanOpenURL.mockResolvedValueOnce(true);
    mockOpenURL.mockResolvedValueOnce(undefined);

    await openStoreSubscriptions();

    expect(mockCanOpenURL).toHaveBeenCalledWith(
      'https://play.google.com/store/account/subscriptions',
    );
    expect(mockOpenURL).toHaveBeenCalledWith(
      'https://play.google.com/store/account/subscriptions',
    );
    expect(alertSpy).not.toHaveBeenCalled();
  });

  test('falls back to https Google Play URL when canOpenURL returns false', async () => {
    mockCanOpenURL.mockResolvedValueOnce(false);
    mockOpenURL.mockResolvedValueOnce(undefined);

    await openStoreSubscriptions();

    expect(mockOpenURL).toHaveBeenCalledWith(
      'https://play.google.com/store/account/subscriptions',
    );
    expect(alertSpy).not.toHaveBeenCalled();
  });

  test('shows Store Unavailable alert when openURL rejects', async () => {
    mockCanOpenURL.mockResolvedValueOnce(true);
    mockOpenURL.mockRejectedValueOnce(new Error('OS error'));

    await openStoreSubscriptions();

    await Promise.resolve();

    expect(alertSpy).toHaveBeenCalledWith(
      'Store Unavailable',
      'Unable to open Google Play. Please manage your subscription from the Play Store app.',
    );
  });
});
