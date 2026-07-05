---
name: Targeting phone landscape in CSS (hoops-stats)
description: Why width-based breakpoints fail for "phone held sideways" and the reliable way to target it.
---

Do NOT target "phone in landscape" with width-based Tailwind breakpoints like `max-md:landscape:` (max-width < 768px). A phone in landscape is usually WIDER than the `md` breakpoint (e.g. iPhone 14 landscape ≈ 852px wide), so the variant never triggers and the layout falls back to the stacked/portrait rules — on the recording screen this pushed the scoring controls off-screen.

**The reliable signal for a phone held sideways is a SHORT viewport height, not width.** hoops-stats (Tailwind v4, CSS-first) uses a custom variant in `index.css`:
`@custom-variant phone-landscape (@media (orientation: landscape) and (max-height: 600px) and (pointer: coarse));`
The `(pointer: coarse)` clause keeps a desktop browser with a short window from accidentally matching. Use `phone-landscape:*` on the recording overlay so video + scoring panel sit side-by-side only on real phones in landscape.

**Testing caveat:** the recording overlay only mounts when a camera stream is active, which the Playwright/screenshot sandbox has no access to — you cannot screenshot it. Reason about the layout and rely on typecheck + the media-query logic rather than a live capture.
