---
name: Targeting phone landscape in CSS (hoops-stats)
description: Why width-based breakpoints fail for "phone held sideways" and the reliable way to target it.
---

Do NOT target "phone in landscape" with width-based Tailwind breakpoints like `max-md:landscape:` (max-width < 768px). A phone in landscape is usually WIDER than the `md` breakpoint (e.g. iPhone 14 landscape ≈ 852px wide), so the variant never triggers and the layout falls back to the stacked/portrait rules — on the recording screen this pushed the scoring controls off-screen.

**The reliable signal for a phone held sideways is a SHORT viewport height, not width.** hoops-stats (Tailwind v4, CSS-first) uses a custom variant in `index.css`:
`@custom-variant phone-landscape (@media (orientation: landscape) and (max-height: 600px) and (pointer: coarse));`
The `(pointer: coarse)` clause keeps a desktop browser with a short window from accidentally matching. Use `phone-landscape:*` on the recording overlay so video + scoring panel sit side-by-side only on real phones in landscape.

**Testing caveat:** the recording overlay only mounts when a camera stream is active, which the Playwright/screenshot sandbox has no access to — you cannot screenshot it. Reason about the layout and rely on typecheck + the media-query logic rather than a live capture.

**Portrait video review looks "scrunched" on phone-landscape:** capping a portrait `<video>` by `max-h-*vh` alone makes it tiny on a short landscape viewport, because height is the scarce dimension there and width is derived from it (9:16 aspect → small height means even smaller width). Don't just bump the vh percentage — switch the constraint to `phone-landscape:max-h-none phone-landscape:w-[~60vw]` so the video sizes off the (plentiful) width instead, even if that makes it taller than the viewport (the page already scrolls).

**The `max-height: 600px` clause in `phone-landscape` is correct for the recording overlay, but wrong for video-review sizing.** A tablet in landscape (e.g. iPad, ~800px+ tall) never matches `phone-landscape`, so a portrait review video on a tablet fell back to the height-capped rule and rendered as a narrow pillarboxed strip — same bug as the phone case, just on a bigger screen. Don't reuse `phone-landscape` for width-based video sizing; added a second variant `@custom-variant touch-landscape (@media (orientation: landscape) and (pointer: coarse));` (no height cap, still `pointer: coarse` to exclude desktop mouse users) and use `touch-landscape:*` specifically for the three portrait-review-video className rules (record.tsx main review + per-game highlight, dashboard.tsx season highlight). Keep `phone-landscape:*` reserved for the recording-overlay layout only, since tablets have plenty of vertical space and shouldn't get the cramped side-by-side phone layout.
