---
name: Arena scoreboard theme (hoops-stats)
description: How the app-wide dark "arena scoreboard" look is wired, and the dark-mode gotcha it exposed.
---

The hoops-stats app renders in dark mode app-wide via `class="dark"` on `<html>` in index.html (there is no runtime theme toggle). The `.dark` palette lives in src/index.css; primary is Hoops Orange. Arena ambiance = a fixed radial-glow body background + a `.text-jumbotron` utility (metallic-white gradient text with an orange halo) used for the big player name on the dashboard hero.

**Dark-mode gotcha — never leave text uncolored on `bg-secondary`:** `--secondary` flips between near-black (light) and near-white (dark), while `--foreground` also flips. A `bg-secondary` panel whose child text has no explicit color inherits `foreground`, so it goes white-on-white (invisible) in dark mode. Fix by using `bg-muted`/`bg-card` for panels and setting explicit `text-foreground`. This bit the record-page player stat-card header.

**How to apply:** For any new surface, prefer semantic tokens `bg-card`/`bg-muted` + `text-foreground`/`text-muted-foreground` (they flip safely) and reserve `bg-secondary`/`text-secondary` for shadcn button/badge variants that pair it with `text-secondary-foreground`. Section headers across screens use an orange accent bar or a `from-primary/70 via-primary/20 to-transparent` gradient divider for consistency.
