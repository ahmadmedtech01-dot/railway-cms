---
name: Stealth chunk 403 root causes
description: Why stealth chunk requests returned 403, what the actual causes were, and how they were fixed.
---

## Root causes (confirmed via Railway logs)

### 1. Short segment TTL (primary chunk 403 cause)
- DB schema default for `token_ttl_segment_sec` = **30 seconds**
- With "Short Token TTLs" toggle ON, the player used this 30s value
- After `bucketExp` rounding (60s bucket), URLs lived 30–90s
- Cloudflare Worker returns 403 `TOKEN_EXPIRED` (at the edge, before forwarding to Railway) when `now > exp + 15`
- Railway logs showed NO chunk 403s — confirming Worker rejected before forwarding
- Fixed: `defaultHardening.tokenTtlSegmentSec` raised 30→120 in `server/video-session.ts`

### 2. Tick race on rotate-session (tick 403 cause)
- `isRotatingRef.current = true` was set AFTER rotate-session response arrived
- Any tick timer firing in the ~250ms fetch window used old SID → `SESSION_INVALID` 403
- Fixed: set `isRotatingRef.current = true` BEFORE the rotate-session fetch in `embed-player.tsx`

### 3. SIGNING_SECRET was NOT the cause
- Previous session analysis concluded SIGNING_SECRET mismatch; this was wrong
- Both Railway and Cloudflare Worker had identical secrets (confirmed by user)
- All chunks that reached Railway succeeded with 200

## What to check in future
- If fresh chunk URLs (large exp remaining) return 403 at the Worker, check `expNum - now > 3600` (Worker rejects exp > 1 hour in future) before assuming SIGNING_SECRET mismatch
- Railway logs only show requests that PASSED the Worker's edge validation — Worker-level 403s are invisible in Railway logs
- "Short Token TTLs" toggle ON + DB default of 30s is dangerous; UI must be set to ≥120s

## How Short Token TTLs setting works
- Toggle OFF → always uses hardcoded `TOKEN_TTL = 3600s` (ignores UI values)
- Toggle ON → uses `session.hardening.tokenTtlSegmentSec` from DB (your UI value)
- DB schema default is 30s — turning ON without setting UI value first causes 403s on slow/pause
- Recommended: either turn OFF (safest), or set all TTLs to ≥300s in UI
