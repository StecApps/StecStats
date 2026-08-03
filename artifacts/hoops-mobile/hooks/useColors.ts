import colors from '@/constants/colors';

/**
 * StecStats is always dark — the arena theme is dark-mode-only,
 * matching the web app's `<html class="dark">` approach.
 * We never flip to a light palette regardless of the OS preference.
 */
export function useColors() {
  return { ...colors.dark, radius: colors.radius };
}
