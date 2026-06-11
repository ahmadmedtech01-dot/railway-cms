---
name: Non-gated VOD + short signed-URL TTL freeze
description: Why non-gated (whole-video VOD) playback freezes ~2min in and rotate-loops, while gated sliding-window playback works
---

# Non-gated VOD + short token TTL = mid-watch 403 freeze loop

## The rule
Short signed-URL TTLs (`hardening.tokenTtlSegmentSec`, e.g. 120s) are ONLY safe when the
playlist is RE-FETCHED. They must never be applied to a non-gated playlist.

- **Gated** (`serverGatedWindowEnabled = true`) → `#EXT-X-PLAYLIST-TYPE:EVENT`, no ENDLIST
  until final window. hls.js re-polls every ~20s and the server re-signs every segment/key
  URL, so a 120s TTL is continuously refreshed.
- **Non-gated** (`serverGatedWindowEnabled = false`) → whole-video `#EXT-X-PLAYLIST-TYPE:VOD`
  with `#EXT-X-ENDLIST`. hls.js fetches the playlist ONCE and never re-polls, so every
  embedded segment/key URL keeps its original signature for the entire watch.

**Why:** On a non-gated VOD, the moment playback passes the TTL horizon (~120s in), every
not-yet-downloaded segment URL is expired → 403 → fatal HLS error → `/rotate-session`
recovery. Rotation re-signs but the new playlist is again a never-refetched VOD, so it
403s again ~120s later. Combined with the stall detector L1→L2→L3 escalation (~9s+5s+5s)
this presents as a ~24s rotate loop with ZERO `/stream/chunk/` fetches = frozen video.

**How to apply:** `getSessionTokenTTL()` (server/video-session.ts) returns `getTokenTTL()`
(the long 3600s defaults, sized to `SESSION_MAX_AGE_MS`) when `!serverGatedWindowEnabled`,
even if `shortTokenTtlEnabled`. This is central — both the legacy `/hls/` and stealth
playlist builders, plus all master/manifest signing, consume `getSessionTokenTTL(sid)`.

## Config trap that makes videos non-gated by default
`defaultHardening.serverGatedWindowEnabled = true` (the secure intent) BUT
`securityTypes.ts` default and `securityRepo.postgres.ts` reads default it to `false`.
`buildHardening` uses `s?.serverGatedWindowEnabled ?? default` — since the loaded value is
`false` (not `undefined`), the `?? true` never kicks in → videos run non-gated unless the
security row explicitly sets it true. Gated mode is both more secure (anti-scrape sliding
window) AND avoids this freeze. Flipping the default is far-reaching; surface to the user.

## Companion client fix
`onNativeSeeking` (embed-player.tsx) now early-returns when `isRotatingRef.current` so
`hls.loadSource()`'s synchronous currentTime→0 snap during rotation can't post seekTo:0 and
reset the server window. Every rotation exit (success AND all failure branches in the
stall-L3 path) MUST clear `isRotatingRef`, or that guard would block legitimate user seeks.
