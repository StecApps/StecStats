/**
 * tekoStyle — safe line-height helper for Teko fonts
 *
 * Teko_700Bold and Teko_600SemiBold glyphs extend above the em-box.
 * On iOS, the default lineHeight clips the tops of digits and uppercase
 * letters. This helper returns { fontFamily, fontSize, lineHeight } with
 * lineHeight set to Math.ceil(fontSize × 1.3), which gives enough headroom
 * to prevent clipping on all tested iOS versions.
 *
 * RULE: every Text node that uses a Teko font MUST source its fontFamily,
 * fontSize, and lineHeight from this helper — never hard-code them
 * separately. This is the single source of truth.
 *
 * Usage (in a StyleSheet.create block or a makeStyles function):
 *
 *   import { tekoStyle } from '@/lib/tekoStyle';
 *
 *   const styles = StyleSheet.create({
 *     scoreNum: { ...tekoStyle(44), color: colors.foreground },
 *     pillValue: { ...tekoStyle(20, 'semiBold') },
 *     timer:     { ...tekoStyle(20, 'regular') },
 *   });
 *
 * Do NOT apply fontFamily inline in JSX when using this helper — the helper
 * already sets it, and an inline override would hide the guarantee.
 */

export type TekoVariant = 'bold' | 'semiBold' | 'regular';

const FONT_FAMILY: Record<TekoVariant, string> = {
  bold: 'Teko_700Bold',
  semiBold: 'Teko_600SemiBold',
  regular: 'Teko_400Regular',
};

export function tekoStyle(fontSize: number, variant: TekoVariant = 'bold') {
  return {
    fontFamily: FONT_FAMILY[variant],
    fontSize,
    lineHeight: Math.ceil(fontSize * 1.3),
  };
}
