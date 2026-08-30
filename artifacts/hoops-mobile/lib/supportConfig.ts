/**
 * Contact-support configuration shared by profile.tsx and the unit tests
 * that verify the correct address is wired up.
 *
 * Exporting both the URL and the handler means the test calls the SAME
 * function that profile.tsx binds to the onPress — a change to the address
 * or the Linking call breaks the test immediately.
 */
import { Alert, Linking, Share } from 'react-native';

export const SUPPORT_EMAIL = 'support@stecstats.com';
export const CONTACT_SUPPORT_URL = `mailto:${SUPPORT_EMAIL}`;

function showSupportFallback(): void {
  Alert.alert(
    'Contact Support',
    `No email app is configured. You can share or copy ${SUPPORT_EMAIL} instead.`,
    [
      {
        text: 'Share / Copy Address',
        onPress: () => {
          void Share.share({
            message: SUPPORT_EMAIL,
            title: 'StecStats Support',
          });
        },
      },
      { text: 'Close', style: 'cancel' },
    ],
  );
}

/** Opens a composer, or offers the native share/copy sheet when none exists. */
export async function openContactSupport(): Promise<void> {
  try {
    const canOpen =
      typeof Linking.canOpenURL !== 'function' ||
      await Linking.canOpenURL(CONTACT_SUPPORT_URL);
    if (!canOpen) {
      showSupportFallback();
      return;
    }
    await Linking.openURL(CONTACT_SUPPORT_URL);
  } catch {
    showSupportFallback();
  }
}
