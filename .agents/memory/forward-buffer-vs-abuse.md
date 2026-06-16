---
name: Forward buffer vs. abuse detection
description: Why the real forward-buffer limit is the server window, and the three-way coupling that makes a bigger buffer a security tradeoff.
---

# Forward buffer is server-gated, not client-gated

The HLS player's forward buffer is capped by the **server's sliding window**, not by the
client `maxBufferLength`. The client already targets up to 2 min
(`maxBufferLength`/`maxMaxBufferLength` in embed-player Hls config), but the server only
exposes `getWindowSegs = ceil(maxPrebufferSec / 2s)` segments ahead. With the balanced
default `maxPrebufferSec: 45` that is ~23 segments ≈ 46s — that 46s is the true buffer.

**Why:** the window is the core anti-scraping control — it bounds how far ahead a client
can pull encrypted segments at once.

## The three-way coupling — never raise the window alone

To genuinely enlarge the forward buffer you must move three knobs in lockstep, and each one
weakens protection or risks the 403 freeze:

1. `maxPrebufferSec` (window) — directly widens the scraper's reach.
2. `maxDownloadAheadSec` (velocity burst budget = `ceil(maxDownloadAheadSec/2)` segs per 5s)
   — must rise too, else hls.js filling a big buffer on fast wifi trips `velocity_abuse` →
   session revoked → black screen. Raising it weakens the *primary* scraper gate.
3. segment/key/playlist token TTL (`tokenTtl*Sec`, default 120) — must exceed
   time-to-reach-deepest-segment, else segments near the window edge expire as the player
   reaches them → the exact "Invalid chunk token" 403 freeze-loop. Keep ~2x margin
   (e.g. a 120s window needs ~240s TTL).

**Decision (2026-06-16):** user chose to KEEP the ~46s window — already smooth and most
secure. Do not widen it without re-confirming, because a true 2-min buffer measurably
weakens bulk-download protection.

# LMS auto-resume is disabled by product choice

LMS launches always start from the beginning. The `maxPositionSeconds` fallback was removed
from the SIMPLE_EMBED path so a stale/poisoned saved position can never seek a student
forward. An explicit caller-supplied `startAt` is still honored (intentional, not
auto-resume) and flows through as `?t=` on the embed URL.
