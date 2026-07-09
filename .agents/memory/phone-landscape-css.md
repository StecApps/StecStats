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

**The `max-height: 600px` clause in `phone-landscape` is correct for the recording overlay, but wrong for video-review sizing.** A tablet in landscape (e.g. iPad, ~800px+ tall) never matches `phone-landscape`, so a portrait review video on a tablet fell back to the height-capped rule and rendered as a narrow pillarboxed strip — same bug as the phone case, just on a bigger screen.

**Also don't gate video-review sizing on `pointer: coarse` either** — a first attempt introduced `touch-landscape` (`orientation: landscape` + `pointer: coarse`, no height cap) to fix tablets while still excluding desktop, on the assumption desktop's height-based cap already looked fine there. Wrong: a desktop/laptop browser window in its normal (landscape) shape hit the exact same narrow-pillarbox bug, since `pointer: coarse` excluded it too. The real rule has nothing to do with touch vs. mouse — ANY viewport wider than tall, showing a portrait (9:16) video, needs width-based sizing, or height-capping starves the width. Ended up using Tailwind's plain built-in `landscape:` variant (no custom variant needed) for the three portrait-review-video className rules (record.tsx main review + per-game highlight, dashboard.tsx season highlight) — accepting that on a very wide-but-short desktop window the video may render taller than the viewport and require scrolling, which is a better tradeoff than an unusably narrow video. Keep the dedicated `phone-landscape:*` custom variant (with its `max-height: 600px` + `pointer: coarse` gates) reserved only for the recording-overlay layout, which genuinely is phone-specific.
