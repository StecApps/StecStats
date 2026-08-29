/**
 * Contact-support configuration shared by profile.tsx and the unit tests
 * that verify the correct address is wired up.
 *
 * Exporting both the URL and the handler means the test calls the SAME
 * function that profile.tsx binds to the onPress — a change to the address
 * or the Linking call breaks the test immediately.
 */
import { Alert, Linking } from 'react-native';

export const CONTACT_SUPPORT_URL = 'mailto:support@stecstats.com';

/** Opens the device email client addressed to the support inbox. */
export async function openContactSupport(): Promise<void> {
  try {
    await Linking.openURL(CONTACT_SUPPORT_URL);
  } catch {
    Alert.alert(
      'Contact Support',
      `Unable to open your email app. Please email ${CONTACT_SUPPORT_URL.replace('mailto:', '')} directly.`,
    );
  }
}
