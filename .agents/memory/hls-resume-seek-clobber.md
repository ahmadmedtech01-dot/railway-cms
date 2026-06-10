---
name: HLS startup resume-seek clobber
description: Why a resumed embed player restarts from 0 mid-buffer, and why the fix must live in the client native-seek handler, not the server.
---

# HLS startup resume-seek clobber (embed player)

On an LMS resume, the player seeks to the saved offset (e.g. segment 322) and posts an authoritative `seekTo:true` progress, moving the server sliding window forward. While that offset is still buffering, **HLS.js synthesizes a native `seeking` event that snaps `video.currentTime` back toward 0**. The native-seek handler (`onNativeSeeking`) reads the *live* `currentTime` (now ~0) and posts another `seekTo:true` with `currentTime≈0`, resetting the server window to 0 → video restarts from the beginning and buffers. Symptom in logs: two `/progress` for one session with `targetSegmentIndex` 322 then 0, no rotation/refresh/pause between them.

**Why this slipped past existing guards:** the `sendProgress` STALE-ZERO guard only applies to *non-authoritative* reasons; `onNativeSeeking` posts as reason `"seek"` (authoritative), so it bypasses it. Every *other* authoritative path passes an explicit `resumeAt`, but `onNativeSeeking` is the one that trusts live `currentTime`.

**Why the fix is client-side, not server-side:** the server cannot distinguish a spurious snap-to-0 from a legitimate user seek-to-0 (replay-from-end, deliberate rewind) without an explicit user-intent flag — a blanket server monotonic/backward guard would break legit backward seeks. The spurious event originates in the client, so guard it there.

**Fix shape (a "startup resume-clobber guard"):** arm a target ref only for the *initial resume* seek to a meaningful offset; in `onNativeSeeking` suppress a snap-to-start (target≈0) while armed + not stale, and re-assert the resume offset a bounded number of times; disarm once playback actually reaches the offset OR on any genuine (non-snap) native seek OR after a stale ceiling. Distinct from the heartbeat backward-seek reset bug (that one was forward-only Math.max in verifyHeartbeat); this is the explicit-seek path.

**How to apply:** when an embed/HLS player "restarts from 0" or buffers shortly after resuming a saved position, suspect a spurious HLS.js `seeking`→0 being reported as authoritative progress. Check that any handler reading live `currentTime` cannot post a window-shrinking seek during unsettled startup.
