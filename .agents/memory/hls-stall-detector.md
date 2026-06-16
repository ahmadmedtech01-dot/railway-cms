---
name: HLS stall detector
description: How the embed-player stall detector and recovery ladder are implemented; key design constraints.
---

## What was added

A stall detector + 3-level recovery ladder in embed-player.tsx, inside the `Hls.isSupported()` block, placed AFTER the main `hls.on(Hls.Events.ERROR, ...)` handler closes (~line 1673 as of this writing).

Six refs in component body:
- `stallDetectorIntervalRef`, `stallRecoveryTimerRef` — interval/timeout handles
- `stallLastTimeRef`, `stallTicksRef` — polling state
- `stallRecoveryLevelRef` (0/1/2), `isStallRecoveringRef` — ladder state

## Algorithm

Poll every 3s (`STALL_POLL_MS`). Skip if: paused, ended, not yet ready, rotating, seeking.
- If `currentTime` advanced > 0.1s: reset ticks; if recovering log SUCCESS.
- Else: increment ticks. At 3 ticks (~9s): log `HLS_STALL_DETECTED`, call `runStallRecovery(ct)`.

Fast-track (set ticks to STALL_TICKS-1) on:
- `video.stalled` event (native)
- Non-fatal HLS errors: `bufferStalledError`, `fragLoadError`, `levelLoadError`, `fragLoadTimeOut`, `levelLoadTimeOut`

Also listen to `video.playing` event → immediately clear stall state and log SUCCESS if recovering.

## Recovery ladder

L1 (9s stall): `hls.recoverMediaError()` + `hls.startLoad(ct)` + `video.play()`
→ wait 5s

L2 (+5s still stuck): `video.currentTime += 0.2` + `hls.startLoad()` + `video.play()`
→ wait 5s

L3 (+5s still stuck): **passive only** — `hls.stopLoad()` + `hls.startLoad(ct)` + `video.play()`. The ladder MUST NEVER rotate the session.

**Why:** L3 used to `POST rotate-session` + `hls.loadSource(freshUrl)`. For a pure buffering stall (no auth error) that destructive teardown made the stall *longer*, and because each rotate→rebuffer cycle (~65s) lands just past `ROTATION_COOLDOWN_MS` (60s), the ladder re-rotated ~once/minute forever → the multi-minute freeze users reported ("buffers 1-2 min then resumes or needs refresh"). Prod logs showed NO 403s and NO proactive rotation timer — every rotation was self-inflicted by this L3. The rotate re-anchor seekTo also permanently inflated server `maxSegmentExposed` to the whole video (bumpMaxSegmentExposed never shrinks).

**How to apply:** Session rotation is reserved for GENUINE token/session expiry, which surfaces as a FATAL hls.js ERROR (403/401/network) and is rotated by the ERROR handler's `tryRotationRecovery` — the single correct origin for a rotation. A silent buffering stall only re-primes the loader; signed URLs are still valid within TTL. Accepted tradeoff: a "silent" expiry that never escalates to a fatal error won't self-heal via L3 (architect-reviewed as acceptable given prod evidence).

Logs emitted: `HLS_STALL_DETECTED`, `HLS_SOFT_RECOVERY_START`, `HLS_BUFFER_NUDGE`, `HLS_PASSIVE_RELOAD` (L3, replaced `HLS_FULL_RELOAD_START`), `HLS_RECOVERY_SUCCESS`, `HLS_RECOVERY_FAILED`.

## Note: `tryRotationRecovery` is NOT accessible from here

`tryRotationRecovery` is defined as a `const` INSIDE the `hls.on(Hls.Events.ERROR, ...)` callback closure, so the stall detector cannot call it. This is fine and intentional now: the stall ladder must not rotate at all (see L3 above). Rotation lives only in the ERROR handler where `tryRotationRecovery` is in scope. (Historically L3 had its own inline `rotate-session` fetch to work around this scoping — that fetch has been removed.)

**Why:** The ERROR handler is a single large closure. Hoisting `tryRotationRecovery` above it would be a large refactor with blast radius. Inline L3 is safer for a self-contained recovery path.

## Cleanup

Both `stallDetectorIntervalRef` and `stallRecoveryTimerRef` are cleared in the useEffect cleanup (alongside the other intervals). `isRotatingRef` is reset on any early exit to prevent the player from getting stuck in rotation state.

## What it does NOT do

- Never resets `video.currentTime` to 0
- Never calls `embed-url`
- Never recreates the LMS iframe
- Does not bypass security — L3 uses the same `rotate-session` path as the existing 403 recovery
