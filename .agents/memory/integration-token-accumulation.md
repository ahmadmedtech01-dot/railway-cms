---
name: Integration token accumulation bug
description: Two token namespaces (integration: vs auto:) for the same userId must be kept completely separate — cross-namespace revocation and concurrent-limit counting were the root cause of "Access Link Expired".
---

## The Rule
There are TWO token namespaces for integration users sharing the same `userId`:
- **`integration:*`** — created by `/api/integrations/player/mint`, `/refresh`, SIMPLE_EMBED_RENEW. Managed by the LMS SDK server-side.
- **`auto:*`** — created by `/api/player/:publicId/mint` (embed player postMessage flow). Managed by the embed player iframe.

**Never revoke one namespace from code operating in the other.** Never count one namespace's tokens against the other's concurrent session limit.

**Why:** LMS often uses a hybrid: postMessage auth for the iframe (→ regular `auto:` mint) + server-side integration API calls (→ `integration:` tokens). Both sets share the same `userId = integration:slug:studentId`. If the integration refresh cleanup revokes "extra" tokens by userId, it kills the `auto:` token the embed player is actively holding → manifest 401 → "Access Link Expired".

## What was fixed

1. **`server/integrations/routes.ts` → `/refresh` and SIMPLE_EMBED_RENEW:**
   - Filter `getActiveUserTokens` to `integration:` labels only before extending/selecting.
   - **Do NOT revoke any extras.** Old tokens expire naturally (EMBED_TOKEN_TTL = 300s).
   - Extend the best matching token (`:isid:${sessionId}` label match preferred) instead of minting a new JWT.

2. **`server/routes.ts` → `/api/player/mint` concurrent check:**
   - `regularActiveTokens = activeTokens.filter(t => !t.label?.startsWith("integration:"))`
   - Only count `auto:` tokens toward the SESSION_LIMIT. Integration tokens are invisible to the regular mint limit.

## How to apply
- Whenever writing token cleanup/counting code: always check the label prefix.
- Tokens labeled `integration:*` are owned by the integration system.
- Tokens labeled `auto:*` are owned by the embed player.
- The manifest endpoint accepts either as long as the DB row is not revoked/expired — that's intentional.
- `extendEmbedTokenExpiry(tokenValue, newDate)` updates DB `expiresAt` only; the JWT `exp` baked into the token string is not checked when the DB row exists.
