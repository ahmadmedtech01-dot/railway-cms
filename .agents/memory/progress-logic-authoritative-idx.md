---
name: _runProgressLogic authoritative index
description: targetSegmentIndex in progress/tick responses must be session.currentSegmentIndex after updateProgress, not the echoed input idx — why and where.
---

## The Rule

In `_runProgressLogic` (routes.ts), after calling `updateProgress(sid, idx, seekTo)`, the `targetSegmentIndex` field in the response must come from `session.currentSegmentIndex`, not from the raw `idx` passed in the request body.

```typescript
// WRONG (old code):
return { ..., targetSegmentIndex: idx };

// CORRECT (new code):
const authoritativeIdx = idx >= 0 ? session.currentSegmentIndex : idx;
return { ..., targetSegmentIndex: authoritativeIdx };
```

`session` is the same in-memory object mutated by `updateProgress` (no extra Map lookup needed).

## Why

`updateProgress` applies a forward-only guard: `s.currentSegmentIndex = Math.max(s.currentSegmentIndex, clamped)`. When a backward/stale post arrives (e.g., idx=114 while csi=459), the guard silently keeps 459. But the old code still echoed `targetSegmentIndex: 114`.

The ONE real consumer of this field is the `/tick` route's integration session position sync (~line 3425):

```typescript
const approxSec = Math.max(
  typeof body.currentTime === "number" ? body.currentTime : 0,
  ((response.progress as any)?.targetSegmentIndex ?? 0) * 2,
);
storage.touchIntegrationSessionPosition(session.integrationSessionId, approxSec);
```

With the old echo, a rejected backward post (idx=114, body.currentTime=228) wrote `approxSec = max(228, 228) = 228s` to the integration session — regressing the stored resume position. With the fix it writes `max(228, 918) = 918s` (correct high-water-mark).

**Note:** The embed-player.tsx client does NOT read `targetSegmentIndex` from tick/progress responses — the progress POST discards the body entirely (`.then(() => undefined)`). The fix's impact is server-internal (integration session persistence), not a client behavior change.

## How to Apply

Any time you modify `_runProgressLogic` or add a new progress endpoint: always use `session.currentSegmentIndex` (the post-`updateProgress` value) for `targetSegmentIndex`, never echo the request body's raw segment index.
