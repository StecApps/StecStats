import { useColorScheme } from 'react-native';
import colors from '@/constants/colors';

/**
 * Returns the design-token palette that matches the current OS color scheme.
 * Defaults to dark when the OS reports no preference (undefined / null).
 *
 * To add a user-controlled toggle, replace the `useColorScheme()` call with a
 * context value — the rest of the app reads only through this hook, so a single
 * line change here is all that's needed.
 */
export function useColors() {
  const scheme = useColorScheme();
  const palette = scheme === 'light' ? colors.light : colors.dark;
  return { ...palette, radius: colors.radius };
}
