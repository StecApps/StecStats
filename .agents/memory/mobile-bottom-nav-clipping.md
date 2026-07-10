---
name: Fixed mobile bottom nav clips page content
description: Why the last item in a scrollable page can be unreachable on mobile, and the padding convention that fixes it.
---

The mobile bottom nav (`layout.tsx`) is `fixed bottom-0` with `h-16` plus
`env(safe-area-inset-bottom)`, and it overlays whatever is beneath it — it
does not reserve space in the document flow. `<main>` only has a flat
`py-6`, so any page whose content reaches the bottom of the viewport has its
last item(s) rendered underneath the nav bar, unclickable and often not even
visible (reported first on the dashboard's "Teams & Seasons" list, where the
last team card was hidden behind the nav on mobile/iPad portrait).

**Convention:** pages with content that can run long (lists, accordions,
forms) should add `pb-20 md:pb-0` (or more, e.g. `record.tsx` already used
`pb-40 md:pb-24` because it also has its own fixed footer bar) to their own
root container — not to the shared `<main>`, since that would double up with
pages that already manage their own bottom spacing (like the recording
overlay). `pb-20` (80px) comfortably clears the 64px nav plus safe-area
inset. `md:pb-0` because the nav is `md:hidden` (desktop has no fixed bottom
bar to clear).

**How to apply:** when adding a new page or a page with a list/section that
can extend near the viewport bottom on mobile, add this padding to its root
div rather than assuming `<main>`'s padding is enough.
