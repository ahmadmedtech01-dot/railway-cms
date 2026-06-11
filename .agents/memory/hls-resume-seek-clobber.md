---
name: HLS startup resume-seek clobber
description: Why a resumed embed player restarts from 0 mid-buffer, and why the fix must live in the client native-seek handler, not the server.
---

# HLS startup resume-seek clobber (embed player)

## Startup resume variant
On an LMS resume, the player seeks to the saved offset (e.g. segment 322) and posts an authoritative `seekTo:true` progress, moving the server sliding window forward. While that offset is still buffering, **HLS.js synthesizes a native `seeking` event that snaps `video.currentTime` back toward 0**. The native-seek handler (`onNativeSeeking`) reads the *live* `currentTime` (now ~0) and posts another `seekTo:true` with `currentTime≈0`, resetting the server window to 0 → video restarts from the beginning.

Fixed via `initialResumeTargetRef` startup-clobber guard in `onNativeSeeking`.

## Session rotation variant (video freezes at 0:00 after ~3 min)
Every 3 minutes the embed player rotates its session. `hls.loadSource(newUrl)` is called during rotation, which **snaps `currentTime→0` synchronously**. `onNativeSeeking` fires with `target=0`. Since the startup-clobber guard (`initialResumeTargetRef`) is NOT armed during rotation (only armed on initial startup), the handler falls through and posts `seekTo:0` → server resets window → video restarts from beginning.

**Symptom in Railway logs:** `SESSION_ROTATED` logged, then `rotate-session 200`, then a progress POST showing `targetSegmentIndex` jumping to a large value (player's real position), then video shows `0:00` on screen. Gap between rotation log and HTTP response can be several seconds.

**Fix:** Add `if (isRotatingRef.current) return;` as the FIRST check in `onNativeSeeking`, before all other guards. `isRotatingRef.current` is already set to `true` at line 1376 (before the rotate-session fetch) and stays true through `MANIFEST_PARSED`, so this guard covers the entire window where `hls.loadSource()` can fire the spurious seek.

**Why the fix is client-side:** the server cannot distinguish a spurious snap-to-0 from a legitimate user seek-to-0 without an explicit user-intent flag. Guard it at the source.

**How to apply:** whenever a session-rotation variant is suspected (stalls ~3 min into an LMS session, video resets to 0:00, Railway logs show SESSION_ROTATED then normal chunks resuming), check that `onNativeSeeking` has `isRotatingRef.current` guard at the top.
