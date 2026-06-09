---
name: Embed token TTL vs session lifetime
description: Why "Access Link Expired" happens under load and the refresh-must-tolerate-expiry rule
---

# Embed JWT short TTL vs long playback session

The embed JWT placed in the iframe URL (`?token=`) has a SHORT TTL (`EMBED_TOKEN_TTL`, ~300s) while the actual HLS playback session is built to live ~1h. The gating `/api/player/:publicId/manifest` 401 is what renders the "Access Link Expired" screen in the player (status==="error" && errorMsg==="SHARE_TOKEN_EXPIRED").

**Rule:** any code path that recovers a playback session from the embed token MUST tolerate an expired-but-validly-signed token. `verifyToken` (plain `jwt.verify`) throws on expiry. `/refresh-token` must decode with `ignoreExpiration:true` (see `verifyTokenAllowExpired`, bounded by `maxStaleSec`) or an expired token becomes an unrecoverable dead end.

**Why:** under concurrency the server slows (embed-url multi-second, manifest ~2s) and rotation/out-of-window races increase, pushing more players into recovery paths. If recovery can't accept an expired token, those players see "Access Link Expired" mid-watch even though the session is otherwise valid. The signature (SIGNING_SECRET) is the real security boundary — it's still enforced — and entitlement is re-checked on refresh, so accepting an expired-but-signed token is safe.

**How to apply:** when touching manifest/refresh-token/mint auth, keep two recovery layers: (1) server `/refresh-token` accepts expired-but-signed tokens; (2) client `init()` silently calls `/refresh-token` once on a manifest 401 before surfacing the error (admin-preview tokens excluded). Known follow-up for scale: the client recovery does refresh-token (mints a session) then re-fetches /manifest (mints another) → double session on the recovery path only; acceptable but optimizable by consuming the refresh-token response's manifestUrl/sessionId/stealth directly.
