---
name: Stealth chunk byte path (302 redirect, not proxy)
description: Why stealth video segments redirect via the Worker instead of proxying through Railway, and the security tradeoff it carries.
---

# Stealth chunk byte path

The stealth segment route `/api/player/:publicId/stream/chunk/:opaqueId` returns a
**302** to a short-lived (~20s) presigned storage URL instead of proxying the bytes
through the origin (Railway). The Cloudflare Worker fetches stealth chunks with
`redirect: "manual"` and FOLLOWS the 302 server-side, so bytes flow
`Storage → Worker → Browser` and Railway is out of the video byte path entirely
(only tiny playlist/tick JSON still transits Railway).

**Why:** proxying every segment's bytes through Railway saturated origin bandwidth
and caused `ERR_CONNECTION_CLOSED` / 0-byte failures when Railway keep-alive
connections closed mid-stream. It also meant paying Railway egress for every video
watched. The legacy `/seg/` route already used the redirect model; the stealth
chunk route was the missing half.

**How to apply:** the Worker's 302-follow branch (chunk kind only) already handles
CORS, Range, and edge-cache fill. Keep `redirect: "manual"` on the Worker's
upstream fetch. The browser never sees the storage URL because the Worker — not the
browser — follows the redirect.

**Security tradeoff (known):** if a client hits the Railway origin DIRECTLY
(bypassing the Worker hostname), the raw 302 `Location` exposes the presigned URL.
All security gates (UA bind, segment window, abuse, velocity) still run before the
redirect, and the URL lives ~20s. To fully preserve the stealth contract, gate the
redirect on an edge-only shared secret (Worker adds a header derived from
SIGNING_SECRET; origin redirects only when present, otherwise falls back to byte
proxy). Not yet implemented.

**Also:** `releaseSegment(sid)` now fires immediately before the redirect (byte
transfer is off-origin and no longer observable), so concurrency protection is
request-rate based rather than in-flight-byte based.
