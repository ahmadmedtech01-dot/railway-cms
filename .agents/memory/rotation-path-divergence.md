---
name: Embed-player rotation-path divergence
description: Why the embed player has four near-duplicate rotate-session flows and the invariants all four must share
---

# Four duplicated rotate-session paths must stay behaviorally identical

The embed player (`client/src/pages/embed-player.tsx`) rotates to a fresh signed
session from FOUR independent places, each a hand-rolled copy of the same flow:

1. error-handler `tryRotationRecovery` (fatal 403/401 + NETWORK_ERROR escalation)
2. refresh-token path (canRefresh branch)
3. stall-detector **Level 3** (silent stall ladder L1 recoverMediaError → L2 nudge → L3 rotate)
4. pause-resume path (paused > 90s)

**Why this is dangerous:** drift between the copies is the recurring source of
freeze/loop regressions. The stall-L3 copy had diverged — it lacked the cooldown
gate AND the opId fence the other three had — which produced an infinite ~24s
rotate loop on stalled non-gated VOD (stall ladder ≈ 9s+5s+5s ≈ 24s, no throttle).

## Invariants every rotation path MUST share
- **Cooldown gate:** never rotate if `Date.now() - lastRotationAtRef.current <= ROTATION_COOLDOWN_MS` (60s). If within cooldown, do a passive `stopLoad()/startLoad(pos)+play()` instead. This is what stops the stall ladder from becoming a rotate loop while the freshly-signed URLs are still valid.
- **Stamp at start:** set `lastRotationAtRef.current = Date.now()` when the rotation *begins* (not only on success), in EVERY path — otherwise the shared cooldown is blind to that path's rotations and can't throttle cross-path.
- **opId fence placement:** create `++rotationOpIdRef.current` AFTER the rotate-session response, immediately before `hls.loadSource()` — same as paths 1/2/4. Creating it before the fetch lets a stale in-flight response mutate `streamSidRef`/`loadSource`/`isRotatingRef` after a newer rotation, then the guarded callbacks early-return and strand `isRotatingRef = true` (blocks all future seeks/recovery).
- **Clear `isRotatingRef` on every exit:** success AND all failure branches (bad response, missing hls/video, fetch catch, safety-timeout). A stuck `isRotatingRef` silently disables `onNativeSeeking` and stall recovery.

**How to apply:** when touching any rotation path, mirror the change to the other
three or they will diverge again. The clean long-term fix is a single shared
`rotateAndResume()` helper — proposed but not yet done (far-reaching; needs sign-off).

## Dead code to note
`rotationIntervalRef` is declared and cleared but never `set` — there is NO proactive
180s rotation timer. Every rotation in logs is recovery-triggered (error or stall L3),
so a rotation in the logs always means a stall/error happened, never a schedule.
