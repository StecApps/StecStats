---
name: Centering a letter in a small box on iOS
description: Why CSS flex/lineHeight fail for single-char boxes on iOS Safari and the proven SVG fix.
---

## The problem

Centering a single capital letter (e.g. "S") inside a fixed-size colored square on iOS Safari is deceptively hard. All these CSS approaches produced S clearly above or below center:

- `display:flex; alignItems:center; justifyContent:center` — anonymous text node centering is unreliable on iOS for Teko font (large usWinAscent metrics).
- `position:absolute; top:50%; translate(-50%,-50%)` — S was visually too high.
- `lineHeight: "32px"; textAlign:center` on a block — S was visually too low (same Teko em-box issue).
- `lineHeight: 1; paddingTop: N` experiments — hard to predict exact N due to font metric uncertainty.

Root cause: Teko (and other condensed fonts) can have usWinAscent/usWinDescent metrics that are much larger than the sTypoAscender/Descender values. iOS Safari uses Win metrics for layout, placing the visual glyph far from the mathematical center of the line box. This makes any lineHeight-based centering unpredictable without knowing the exact metrics.

## The fix

**For single-letter logo boxes**: Use an inline SVG with `dominantBaseline="middle"` and `textAnchor="middle"`:

```jsx
<div style={{ width: 28, height: 28, background: ORANGE, borderRadius: 6, overflow: "hidden" }}>
  <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
    <text
      x="14" y="14"
      textAnchor="middle"
      dominantBaseline="middle"
      fill="white"
      fontFamily="system-ui, -apple-system, Helvetica, Arial, sans-serif"
      fontSize="15"
      fontWeight="800"
    >S</text>
  </svg>
</div>
```

SVG's `dominantBaseline="middle"` places the center of the em-box at the given y coordinate regardless of OS-level font metric interpretation. This works reliably on iOS Safari.

For the nav bar (Teko font): same pattern with `fontFamily="Teko, sans-serif"`.

**For text badges (WIN/LOSS pill)**: Use equal vertical padding + `lineHeight: 1` rather than any flex centering or lineHeight tricks:

```jsx
<div style={{
  padding: "6px 14px",
  lineHeight: 1,
  textAlign: "center",
  fontFamily: "'Inter', sans-serif",
  fontSize: 14,
  ...
}}>WIN</div>
```

`lineHeight: 1` collapses the line box to exactly font-size height. Equal top/bottom padding then produces perfectly symmetric spacing. No font metric knowledge required.

**Why:**
- `dominantBaseline` is SVG-native and OS-independent; CSS line-height IS OS-dependent via font metric flags.
- Equal padding centering is purely geometric and always correct regardless of font metrics.

**How to apply:**
- Any new "letter in a box" logo → SVG text approach.
- Any text pill/badge needing vertical centering → equal padding + lineHeight:1, no flex.
- GameStatCard.tsx and layout.tsx both use these patterns.
