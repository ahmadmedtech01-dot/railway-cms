---
name: Integration token accumulation bug
description: /refresh and SIMPLE_EMBED_RENEW minted new embed tokens instead of extending existing ones, causing concurrent-session limit collisions that killed the embed player's token.
---

## The Rule
Integration `/refresh` and SIMPLE_EMBED_RENEW must **extend the existing embed token's DB expiry** (`extendEmbedTokenExpiry`) instead of minting a new JWT. Never accumulate tokens for the same userId.

**Why:** Each call to `/refresh` or `/api/integrations/embed-url` (for a renew) previously inserted a new `embed_tokens` row for the same `userId`. After 2-3 cycles: 3+ active tokens for one user. `getActiveUserTokens()` returns all of them → concurrent session limit (1) exceeded → next `/mint` gets 429 SESSION_LIMIT → user/system clicks "End Other Session" → `revokeUserTokensExcept()` → revokes the token the embed player is actively holding → manifest 401 "Token revoked" → "Access Link Expired" during active playback.

**How to apply:**
- In `/refresh`: call `storage.getActiveUserTokens(videoId, userId)`, find the token whose label contains `:isid:${session.id}` (or fall back to `existingTokens[0]`), call `storage.extendEmbedTokenExpiry(token.value, newExpiresAt)`, revoke extras, return the SAME token value.
- In SIMPLE_EMBED_RENEW (activeSession branch of `/api/integrations/embed-url`): same pattern — look up, extend, revoke extras. If no existing token found, mint new as fallback.
- Manifest endpoint checks `dbToken.expiresAt` from DB (NOT the JWT `exp` claim) when the token exists in DB, so extending the DB row is sufficient — the JWT itself doesn't need to be reissued.
- Initial HMAC mint (`/api/integrations/player/:publicId/mint`) is fine — each call creates a new integration session (unique jti), so 1 token per session.
