---
name: performLocalSeek onNativeSeeking guard
description: Any direct video.currentTime write in performLocalSeek must be bracketed by isSeeking.current = true/false to prevent onNativeSeeking from double-firing.
---

## The rule

In `performLocalSeek` (and any other path that writes `video.currentTime` directly outside of `applyPendingSeek`), always set `isSeeking.current = true` immediately before the write and `isSeeking.current = false` immediately after.

**Why:** The browser dispatches the `"seeking"` event synchronously during the `currentTime` assignment. `onNativeSeeking` checks `isSeeking.current || isSeekingRef.current` — if both are false at the moment of dispatch (which they are before `seekProgressWithTimeout` is called), `onNativeSeeking` proceeds and:
1. Calls `hls.stopLoad()` — cancels the already-started optimistic load
2. Calls `seekProgressWithTimeout(sid, target)` — registers a second epoch increment and a `hls.startLoad(target)` callback at ~700 ms
3. That second `startLoad` fires while the player is already buffering → stream state confusion → **seek freeze**

Because the freeze keeps `currentTime` pinned at the seek target, every subsequent progress tick reports the same position. `maxPositionSeconds` in `integration_playback_sessions` stays at that value → the next session resumes at the wrong (frozen) position.

**How to apply:**
- Pattern: `isSeeking.current = true; try { v.currentTime = x; } catch {} isSeeking.current = false;`
- The guard only needs to span the synchronous `currentTime` write. Clear it immediately after — the seeking event has already been dispatched and handled.
- Exception: writes inside `onNativeSeeking` itself are safe (no re-entrancy). Writes inside rotation paths are safe because `isRotatingRef.current = true` blocks `onNativeSeeking` at its first guard.
- The 1.5 s watchdog retry in `performLocalSeek` needs the same bracket around its `cur.currentTime = retryTarget` write.
