---
name: WebM split detector chunk overlap bug
description: Why detectWebMSplitOffsetLocal silently returned null for real two-half WebM files, and how to verify the fix worked.
---

## The rule

When scanning a local file in fixed-size chunks for a pattern that needs N bytes of context after the match, the read overlap between chunks must be at least N bytes — not just the size of the search pattern itself.

**Why:** The old code used `CHUNK + 4` (4 = length of EBML magic). If the second EBML header landed in the last 116 bytes of a chunk, the 120-byte verify window was cut short and the doctype string "webm" fell outside the read buffer. The check failed silently; `candidatesFound` was never logged so there was no way to distinguish "no magic present" from "magic found but verify truncated".

**How to apply:** Any chunk-based binary scanner with a post-match verification window needs `overlap = VERIFY_WINDOW`, not `overlap = PATTERN_LENGTH`. Concretely for the WebM scanner:

```
const VERIFY_WINDOW = 300;
const length = Math.min(CHUNK + VERIFY_WINDOW, fileSize - offset);
```

## Verification checks (in priority order)

1. **Segment ID binary check** (`18 53 80 67`) — always present immediately after the EBML header (~36 bytes in), binary, no false-positive risk from video data containing the word "webm".
2. **Doctype string fallback** — `verifySlice.toString("binary").includes("webm")` — handles non-standard EBML header layouts.

## Diagnostic logging

Add a `candidatesFound` counter to the final log:
- `candidatesFound === 0` → genuine single continuous recording (no second EBML header anywhere in the file)
- `candidatesFound > 0` → magic(s) found but none passed verify — overlap or verification bug

## Game 158 context (resolved)

Game 158 confirmed as a **single continuous WebM recording** (candidatesFound=1, false-positive VP9 byte sequence). No second EBML header. The repair was crashing the production server because:
- Old path: download 2.3 GB (35 min) → scan local file (2.5 min) → ffmpeg on 2.3 GB (7 min crash)
- New path: GCS stream scan (2-3 min, no download) → single recording detected → DB metadata reset only, no ffmpeg

For single-WebM games: `videoOffsetMs ?? 0` is used in the highlight generator, so null defaults to 0 and highlights generate correctly from game clock timestamps directly.
