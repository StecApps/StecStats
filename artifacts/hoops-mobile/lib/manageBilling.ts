/**
 * Shared billing-management utilities used by the Profile screen.
 *
 * Extracted so that unit tests can import and exercise the real production
 * logic rather than maintaining mirror copies inline.
 */

import { Alert, Linking, Platform } from 'react-native';

/**
 * Returns the correct label for the billing management row.
 *
 * - RevenueCat (App Store / Google Play) subscriber → "Manage in App Store"
 *   or "Manage in Google Play" depending on platform.
 * - Stripe / web subscriber (rcPlan === null) → "Manage Billing".
 */
export function getManageBillingLabel(rcPlan: string | null): string {
  if (rcPlan) {
    return Platform.OS === 'android' ? 'Manage in Google Play' : 'Manage in App Store';
  }
  return 'Manage Billing';
}

/**
 * Opens the OS subscription management page for RevenueCat subscribers.
 *
 * Tries the native deep-link scheme first (itms-apps:// on iOS) and falls
 * back to an https equivalent when the scheme is unavailable.
 *
 * The itms-apps:// scheme must be declared in LSApplicationQueriesSchemes
 * inside app.json for Linking.canOpenURL to return true on iOS 9+.
 */
export async function openStoreSubscriptions(): Promise<void> {
  const isAndroid = Platform.OS === 'android';
  const primaryUrl = isAndroid
    ? 'https://play.google.com/store/account/subscriptions'
    : 'itms-apps://apps.apple.com/account/subscriptions';
  const fallbackUrl = isAndroid
    ? 'https://play.google.com/store/account/subscriptions'
    : 'https://apps.apple.com/account/subscriptions';
  const storeUnavailableMsg = isAndroid
    ? 'Unable to open Google Play. Please manage your subscription from the Play Store app.'
    : 'Unable to open the App Store. Please manage your subscription from the App Store app.';

  try {
    const supported = await Linking.canOpenURL(primaryUrl);
    const urlToOpen = supported ? primaryUrl : fallbackUrl;
    await Linking.openURL(urlToOpen);
  } catch {
    Alert.alert('Store Unavailable', storeUnavailableMsg);
  }
}

/**
 * Opens the Stripe billing portal for web/Stripe subscribers.
 *
 * Shows an Alert and returns early when:
 *   - EXPO_PUBLIC_DOMAIN is not set.
 *   - Linking.canOpenURL returns false for the billing URL.
 *   - Linking.openURL throws.
 */
export async function openBillingPortal(domain: string | undefined): Promise<void> {
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
}
