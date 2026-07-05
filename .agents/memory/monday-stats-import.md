---
name: monday.com stats xlsx import format (hoops-stats)
description: How the Stec player stats spreadsheets (exported from monday.com) are structured, and the parsing gotchas when importing them.
---

The players' stats spreadsheets (e.g. `<Name>_Stats_*.xlsx` in attached_assets) are monday.com exports with MULTIPLE season sections stacked in a single sheet. Each section is: a **title row** (team/season name in col A, date column blank), a **header row** (`Name, Date, Result, FT Made, FT Attempt, FT %, 2P Made, 2P Attempt, 3P Made, 3P Attempt, FG%, 3P %, Total PTs, Asst., Rebs, Steals, TO, Blks, Item ID`), the **game rows**, then a **summary/total row** (col A blank, Date holds a range like "2023-12-02 to 2024-03-07").

**Row classification (reliable):** header = A=="Name" & B=="Date"; section title = col A non-empty AND Date (col B) empty; summary = col A empty; otherwise a game row (col A = opponent, col B = date). Do NOT detect titles by "only one non-empty cell" — the first title rows contain monday.com marketing text ("This spreadsheet was created using monday.com", "Try it free →") in col C.

**Result column has two formats:** most rows are `"W 45-33 #!g"` / `"L 40-44 #x"`; a later varsity season uses `"64-18✅"` / `"51-71❌"` (no W/L letter, win/loss shown by emoji). Parser must accept both: take the first two numbers as teamScore-opponentScore, then derive result from an explicit W/L letter, else ✅/❌, else score comparison.

**Import path:** map to the `/api/import` endpoint body (`ImportDataBody`, rows[]). teamName = section title, opponent = col A, playerName = fixed (the file's player). The endpoint is idempotent (find-or-create team by name, game by team+opponent+date, stat by game+player), so re-imports are safe and sibling players sharing a game/team correctly reuse the same game row. Column indices: FT Made=3, FT Att=4, 2P Made=6, 2P Att=7, 3P Made=8, 3P Att=9, Asst=13, Rebs=14, Steals=15, TO=16, Blks=17.
