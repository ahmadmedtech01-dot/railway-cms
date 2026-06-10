---
name: Integration token accumulation + heartbeat window bugs
description: Two token namespaces (integration: vs auto:) must be kept separate; also heartbeat backward-seek reset in verifyHeartbeat was collapsing the HLS sliding window and freezing playback.
---

## Rule 1: Two token namespaces — never cross-revoke or cross-count
There are TWO token namespaces for integration users sharing the same `userId`:
- **`integration:*`** — created by `/api/integrations/player/mint`, `/refresh`, SIMPLE_EMBED_RENEW
- **`auto:*`** — created by `/api/player/:publicId/mint` (embed player postMessage flow)

**Never revoke one namespace's tokens from code operating in the other. Never count one namespace against the other's concurrent session limit.**

**Why:** LMS uses hybrid: postMessage auth for iframe (→ `auto:` tokens) + server-side integration API calls (→ `integration:` tokens). Same `userId` for both. Cross-revocation kills active player tokens. Cross-counting produces false SESSION_LIMIT 429s.

**Fixes applied:**
- `server/integrations/routes.ts` `/refresh` and SIMPLE_EMBED_RENEW: filter `getActiveUserTokens` to `integration:` labels only. Never revoke extras — extend only.
- `server/routes.ts` `/api/player/mint` concurrent check: only count `auto:` tokens (`!label.startsWith("integration:")`).
- `server/storage.ts` `revokeUserTokensExcept`: this filtered by `videoId`+`userId` ONLY (ignored label) — so the "End other sessions & continue" endpoint cross-revoked live `integration:` tokens. Now classifies each token's namespace (label prefix, falling back to `userId` prefix for label-less/jwt-only rows) and revokes only tokens in the SAME namespace as the kept token.

**How to apply (the general invariant):** EVERY token-revocation or concurrent-count path must scope to one namespace. Label is the primary signal; `userId.startsWith("integration:")` is the fallback when a row has no/malformed label. A new revoke path that filters by `userId` alone WILL silently kill the other system's session.

---

## Rule 2: Heartbeat must NEVER reset currentSegmentIndex downward
`verifyHeartbeat` in `server/video-session.ts` previously had:
```javascript
if (requestedSeg < s.currentSegmentIndex - 10) {
  s.currentSegmentIndex = Math.max(0, requestedSeg);
}
```

**This was removed.** The heartbeat should only advance the window forward. The `Math.max` on the assignment line already ignores low `requestedSeg` values silently.

**Why:** When player seeks to a far position (e.g. `?t=1991`), `applyPendingSeek` sends `seekTo:true` progress → server sets `currentSegmentIndex=995`. Then the heartbeat arrives with `currentTime=165` (player hasn't caught up yet) → the reset dropped `currentSegmentIndex` back to 82 → window collapsed from 0–1040 to 0–127 → player stalled every ~5 min.

**How to apply:** Backward seeks are handled ONLY via `updateProgress(seekTo=true)` from the client's explicit seekProgressWithTimeout POST. Heartbeat is forward-only.

---

## Rule 3: "Video starts at 2:45" is expected behavior
`autoResumeAt = session.maxPositionSeconds` (updated via `GREATEST` SQL in touchIntegrationSessionPosition on every tick). Included as `?t=` in the SIMPLE_EMBED iframe URL. This is the resume-from-last-position feature. Not a bug unless `studentId` is wrong from the LMS side.
