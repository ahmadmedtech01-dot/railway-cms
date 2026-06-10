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

L3 (+5s still stuck): `POST /api/player/:publicId/rotate-session` with `{sid, currentTime}` → on success: `hls.loadSource(freshUrl)`, `streamSidRef.current = rd.sessionId`, `isRotatingRef.current = true`, `lastRotationAtRef.current = Date.now()`, then on MANIFEST_PARSED: `hls.startLoad(resumeAt)`, on FRAG_BUFFERED: seek + play + log SUCCESS.

Logs emitted: `HLS_STALL_DETECTED`, `HLS_SOFT_RECOVERY_START`, `HLS_BUFFER_NUDGE`, `HLS_FULL_RELOAD_START`, `HLS_RECOVERY_SUCCESS`, `HLS_RECOVERY_FAILED`.

## Critical constraint: `tryRotationRecovery` is NOT accessible from here

`tryRotationRecovery` is defined as a `const` INSIDE the `hls.on(Hls.Events.ERROR, ...)` callback closure. It cannot be called from the stall detector. L3 therefore uses its own inline `rotate-session` fetch — a simpler version (no 60s cooldown bypass needed since we control when it fires via `isStallRecoveringRef`).

**Why:** The ERROR handler is a single large closure. Hoisting `tryRotationRecovery` above it would be a large refactor with blast radius. Inline L3 is safer for a self-contained recovery path.

## Cleanup

Both `stallDetectorIntervalRef` and `stallRecoveryTimerRef` are cleared in the useEffect cleanup (alongside the other intervals). `isRotatingRef` is reset on any early exit to prevent the player from getting stuck in rotation state.

## What it does NOT do

- Never resets `video.currentTime` to 0
- Never calls `embed-url`
- Never recreates the LMS iframe
- Does not bypass security — L3 uses the same `rotate-session` path as the existing 403 recovery
