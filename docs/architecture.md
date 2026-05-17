# Architecture — Secure Video CMS

Deep technical reference. The top-level `replit.md` carries the slim overview.

---

## 1. Admin Panel

- **Login** — Email/password + session
- **Dashboard** — stats, recent activity, quick actions
- **Video Library** — list/search/manage with status badges
- **Upload Wizard** — file → S3 → HLS transcode, OR URL import (YouTube/Vimeo/Drive/OneDrive/S3/Direct)
- **Video Detail** (tabbed):
  - **Overview** — metadata editing
  - **Player** — StreamYard-style accordion with live iframe preview; sections: Player Controls, Logo, Overlay, QR Code, Video Clips (intro/outro), Banners & Tickers, Style (brand color, theme, font)
  - **Watermark** — logo, scrolling ticker, pop-up watermark with variable templates
  - **Security** — token required, signed URLs, domain whitelist, referrer checks, concurrent limits
  - **Embed & Share** — iframe code, masked share link, token management
  - **Analytics** — plays, watch time, top domains, recent sessions
  - **Tokens** — create/revoke/delete embed tokens
- **Embed Manager** — global token view across videos
- **Audit Logs** — full admin action history
- **System Settings** — Storage Connections (B2 + R2 + S3), Vimeo, AWS/S3 legacy, global kill switch, signing secret, ffmpeg toggle
- **Integrations** — Clients, Launch Logs, Sessions, Docs & Test tabs

## 2. Public Pages

- `/embed/:publicId` — iframe-only LMS player. Shows "Waiting for LMS authorization…" until postMessage arrives. Blocked if opened top-level.
- `/embed/:publicId?token=<adminPreviewJWT>` — admin preview (adminPreview:true JWT); skips iframe enforcement.
- `/v/:publicId?token=...` — masked share link page.

## 3. Per-User Token Minting (Secure LMS Flow)

- `POST /api/player/:publicId/mint` — mints per-user embed token:
  - **Path A** — session auth (same-domain logged-in user), no body needed
  - **Path B** — `{ lmsLaunchToken }` — HMAC-SHA256 signed launch token from external LMS (never via URL)
  - Never trusts userId from URL or body; server derives identity
  - Entitlement check before minting (extensible `checkEntitlement`)
  - Session limit scoped per user **per video** (userId + videoId)
- `POST /api/player/:publicId/refresh-token` — refresh expired token, re-checks entitlement
- `POST /api/player/:publicId/revoke-other-sessions` — revokes other sessions for same video; userId derived from token
- `GET /api/lms/origins` — public; returns allowed LMS origins from `ALLOWED_LMS_ORIGINS`

## 4. Iframe-Only LMS Embedding Security

The embed player enforces:
1. **Top-level check** — `window.top === window.self` → "Access Restricted"
2. **postMessage receiver** — `{ type: "LMS_LAUNCH_TOKEN", token: "..." }` from allowed origins only
3. **Origin validation** — fetched from `/api/lms/origins` (`ALLOWED_LMS_ORIGINS` env)
4. **Token never in URL** — LMS launch tokens arrive via postMessage only

## 5. LMS Launch Token Hardened Verification (`verifyLmsLaunchToken`)

Required payload fields: `userId`, `publicId`, `exp`, `nonce`, `aud`, `origin`
- `aud` must equal `"video-cms"`
- `origin` must match one of `ALLOWED_LMS_ORIGINS`
- `exp` must be in the future AND within 10 minutes (max 600s)
- Nonce replay check removed — on iframe refresh the LMS reuses the same token. Replay protection is provided by `exp` (10-min window) + client instance ID scoped auto-revocation in mint.
- HMAC-SHA256 signature verified with `LMS_HMAC_SECRET`
- Format: `base64url(JSON{userId,publicId,exp,nonce}).hmac_hex`

## 6. Client Instance ID (LMS Refresh Resilience)

- `getClientInstanceId()` in `embed-player.tsx` generates a stable random ID per browser, stored in `localStorage` under `vcms:client-instance`
- Sent as `x-client-instance` header on every `/mint` request
- Stored in token label as `auto:userId:source:inst:<id>`
- On mint: server auto-revokes all active tokens with the same `inst:` label for that user+video before the concurrent session check — iframe refresh silently replaces its own token
- `POST /api/player/:publicId/revoke-sessions-by-launch` — revokes ALL active tokens for userId derived from verified launch token (used by "End Other Session" when no prior token exists)

## 7. Video Security Pipeline (Non-DRM, 3-Layer)

Secure HLS proxy — B2/S3 origin URLs are **never** sent to the frontend.

### Layer 1 — Origin Hidden
All storage URLs are proxied server-side. Browser only sees `/hls/` and `/seg/` on our domain.
- `GET /api/player/:publicId/manifest` — creates in-memory `VideoSession` (deviceHash bound), returns signed proxy URL
- `GET /hls/:publicId/*` — fetches playlists server-side, rewrites all URLs to proxy with HMAC tokens
- `GET /seg/:publicId/*` — fetches segment bytes from B2/S3, streams to client
- `GET /key/:publicId` — AES-128 key endpoint
- `POST /api/video/session` — alternative session creation for custom players

### Layer 2 — Per-Chunk Signed Tokens
Every segment URL includes an HMAC token (10s TTL) binding `sid`, path, expiry. Key tokens: 10s. Playlist tokens: 60s. Manifest tokens: 60s. 3s clock skew tolerance. User-Agent hash validated on all endpoints (`validateUserAgent`).

**Note**: `deviceHash` is NOT in HMAC signing — proxy environments (e.g. Replit preview) modify User-Agent between CMS API call and Worker gateway request, causing 403s. Security maintained via SID binding, UA hash, short TTLs, and abuse detection.

### Layer 3 — EVENT-style Append-Only Playlist
Variant playlists use `#EXT-X-PLAYLIST-TYPE:EVENT` with `#EXT-X-MEDIA-SEQUENCE:0` always. Starts at segment 0 and only grows forward.

```
windowEnd = max(session.maxSegmentExposed, currentSegmentIndex + windowSegs)
```
Clamped to total segments. `maxSegmentExposed` is per-session monotonic high-water, persisted to Postgres (throttled to growths ≥4 segs) so multi-instance deploys don't emit a "shrunk" playlist after DB hydration. ENDLIST added once entire video exposed. Progress tracked via the unified `/tick` (~20s) and via segment access.

**Why EVENT (not sliding window)**: The previous design used `MEDIA-SEQUENCE = currentSegmentIndex - 2`. Backward seeks (idx=410 → idx=23) made MEDIA-SEQUENCE go 408 → 21 — HLS protocol violation. hls.js rejected the new playlist as stale, stuck with OLD playlist (segs 408-414 at offsets 816-828s) while `video.currentTime=46s` → empty buffer → permanent spinner. EVENT semantics fix this — hls.js accepts EVENT growing monotonically with MEDIA-SEQUENCE fixed at 0.

**Forward-scraping protection**: `updateProgress` caps `seekTo:true` jumps at `earnedCeiling + SEEK_FORWARD_CAP_SEGS` (default 900 segs = 30 min of 2s content), where `earnedCeiling = max(currentSegmentIndex, maxSegmentExposed) + windowSegs`. Prevents a SID holder from forging one `seekTo:true currentTime=videoDuration` POST to expose the entire video. Scraping via repeated forged seeks still has to clear `bulk_download`, `velocity_abuse`, and per-segment rate-limit detection. Backward seeks not capped.

### Session Binding
Each session stores: `sessionId`, UA hash, deviceHash, boundIp, createdAt, expiresAt (60 min max — raised for 2k+ daily users on long videos). All `/hls`, `/seg`, `/key` requests validate token + session validity + UA match + device hash. `TOKEN_TTL = 3600s` (matches `SESSION_MAX_AGE_MS` so signed URLs never expire before session).

### Control-plane consolidation: `/tick`
- Single `POST /api/player/:publicId/tick` replaces `/progress`, `/heartbeat`, `/ping`
- Client cadence: progress every 20s, heartbeat every 40s (2nd tick), ping every 60s (3rd tick)
- Final tick on pause/end/visibility-hidden/beforeunload/pagehide via `navigator.sendBeacon`
- Old endpoints kept as thin wrapper shims for in-flight players from before deploy
- Server uses shared `_runProgressLogic` / `_runHeartbeatLogic` / `_runPingLogic` helpers
- UA gate at `/tick` entry (defense-in-depth on every consolidated request)
- Beacon-safe body parser (accepts text/plain + octet-stream as JSON fallback)
- Heartbeat v2 seq+nonce replay protection preserved unchanged

### Abuse Detection (`server/video-session.ts`)
Controlled by `suspiciousDetectionEnabled` (per-video or global). When OFF, all abuse scoring, window enforcement, revocation, and denial overlays are completely bypassed. When ON:
- Rate limit: >10 req/s (burst 15) → +3/+5
- Concurrent segments: >6 simultaneous → +5
- Bulk download: >30 segs in 5s → +8 (logged `SECURITY_BULK_DOWNLOAD`)
- Playlist abuse: >30 fetches/min → +3
- IP mismatch: **DISABLED** — playlists arrive via Worker IP, segments direct from browser IP; only recorded for logging
- Out-of-window: segment request outside `[current-1, current+20]` → +2 (covers hls.js 30s buffer)
- Key abuse: >30 key req/min → +5
- Violation limit configurable per-video via `violationLimit` (default 6)
- On breach: 10-minute block, 429/403 response: `{ error: "SECURITY_BREACH", breach: "X/limit" }`

### CORS & Cache Policy
- **CORS**: Origin-restricted in production (`ALLOWED_ORIGINS` + Replit domains). Dev allows all.
- **Cache**: Playlists + keys = `no-store`. Segments = `private, no-store, no-cache, max-age=0`.

### Manifest Guard
Direct external `.m3u8` URLs blocked with `UNSECURE_MANIFEST_BLOCKED` log. External URLs in playlists are stripped.

### Storage Cleanup on Delete
`deleteVideoStorage()` deletes from B2/S3: HLS segments (`hlsS3Prefix`), raw upload (`rawS3Key`), assets (`assets/videos/<videoId>/`). Batch `DeleteObjectsCommand` with fallback to individual `DeleteObjectCommand` for B2 compat. Each cleanup step has independent error handling.

### AES-128 Double Encryption
Server decrypts segments with master key (fetched from B2, cached), re-encrypts with session-specific ephemeral key/IV. Player never sees master key.

### Client-Side Protection (`useSecurityViolations` hook)
Violation counter with per-video localStorage persistence, 3s debounce per event type, configurable limit. On limit: 10-minute cooldown with countdown overlay. Events: `RIGHT_CLICK`, `FOCUS_LOST`, `DEVTOOLS_DETECTED`, `FULLSCREEN_REQUIRED_BREACH`, `DOWNLOAD_ATTEMPT`.

### Signing Secret
`SIGNING_SECRET` env var — REQUIRED in production, no fallback. Server crashes on startup if missing. Generate via `GET /api/admin/generate-signing-secret` (admin-only). Must set SAME value in Railway env vars AND Cloudflare Worker env vars, then redeploy both.

## 8. Integration API Module (Gumlet-style)

- **Admin**: Integrations page with Clients, Launch Logs, Sessions, Docs & Test tabs
- **Clients**: CRUD with HMAC key/secret pairs, origin whitelisting, video access modes (all / selected)
- **Launch Token Flow**: LMS backend signs `base64url(payload).hmacHex` with `INTEGRATION_MASTER_SECRET`; CMS verifies, mints embed token, starts tracked session
- **Player SDK**: `/sdk/player.js` (vanilla JS, auto-loads HLS.js), React wrapper `SyanVideoPlayer.tsx`
- **Embed Options**: Direct SDK mount, React component, or iframe via `/api/integrations/embed/:publicId?launchToken=`
- **Session Tracking**: Ping every 10s, event logging (play/pause/seek/ended), completion reporting
- **Admin Endpoints**: `/api/admin/integrations/{clients,logs,sessions}`, test token generator
- **Player Endpoints**: `/api/integrations/player/:publicId/{mint,refresh,ping,events,complete}`, `/api/integrations/{videos/:publicId,embed/:publicId}`

## 9. Cloudflare Edge Cache (Worker)

`cloudflare-worker/worker.js` implements synthetic-key edge caching **only for `/seg/`** (master-encrypted B2 segments, identical across viewers) and stealth chunks.

**Order of operations (validation always first):**
1. Parse `sid`, `st`, `exp` from query params. Reject 401 if missing.
2. Expiry check with 15s skew tolerance (segments/keys), 30s (playlists). Reject 403 if expired.
3. Compute UA device hash, verify HMAC signature against candidate paths. Reject 403 if invalid.
4. **Only after auth passes**, for `/seg/` GET without `Range`: cache lookup.

**Cache key**: `https://cache.internal/seg/${publicId}${subPath}` — strips `sid`, `st`, `exp`. Stable across users.

**What IS cached**:
- `/seg/` segment responses (legacy route), status 200, no Range
- `/api/player/.../stream/chunk/<opaqueId>?st=<hmac>&exp=<unix>` stealth chunks, status 200, no Range. Bytes are master-encrypted (per-session re-encryption was aspirational/legacy and never implemented in the stealth chunk handler — has always streamed master-encrypted through Railway). Stable cache key = 16-hex HMAC prefix derived from `(SIGNING_SECRET, "chunk|publicId|segSubPath")` and prepended to the opaque ID at mint (`mintOpaqueChunkId`). Worker reads prefix from URL, uses as synthetic key: `https://cache.internal/stealth-chunk/<publicId>/<16hexPrefix>`. Encrypted suffix stays per-session — server validation (UA, window, abuse, session) unchanged. URL still appears fully opaque in browser.

  **Edge auth gate (MANDATORY before cache lookup)**: Worker validates `exp` (now ≤ exp + 15s) and `st` (= `HMAC-SHA256(SIGNING_SECRET, "chunk-cache-v1|publicId|prefix|exp")`) BEFORE any `cache.match`. Without this, any holder of a previously-observed chunk URL could pull cached bytes after session revocation for the full 24h TTL. With it, replay is bounded by `exp + 15s skew`, matching `/seg/` model. `st` comparison is constant-time. Old-format chunk URLs without `st`/`exp` are NOT edge-cached (forwarded to Railway for full validation) — preserves backward compat during deploy.

Stored internally with `Cache-Control: public, max-age=86400, immutable` (segments are content-addressed, never change).

**What is NOT cached (intentional)**:
- `/hls/` variant playlists — contain per-session signed URLs
- `/key/` AES keys — per-session ephemeral
- `/api/player/.../stream/window` stealth playlist — user/window-specific
- `/api/player/.../stream/secret/<opaqueId>` stealth key — per-session AES key material
- All 4xx/5xx responses
- All Range requests (v1 limitation; HLS.js doesn't issue Range on `.ts` segments)
- Stealth chunks with old-format opaque IDs missing the 16-hex prefix (backward-compat)

**Railway skipped entirely on `/seg/` and stealth-chunk cache HITs.** Worker returns cached bytes directly — zero calls to Railway, zero to B2/R2.

**Browser response always carries `Cache-Control: private, no-store`** regardless of HIT/MISS, so token rotation, session binding, and per-user revocation stay enforceable. Only the *internal* cached copy uses `public, max-age=86400, immutable`.

**Security preserved**: HMAC validation, SID/session binding, expiry, UA/device hash, signed-URL contract, master-key protection (both `/key` and `/stream/secret` never cached), LMS iframe enforcement (client-side, untouched), one-session-per-user (Railway-enforced), global/per-video security settings (Railway-enforced), abuse detection (Railway-enforced on `/hls/` and stealth `/stream/window` which are never cached).

**Revocation latency for stealth chunks**: Identical to `/seg/` — on cache HIT Worker skips Railway, but URL carries `exp` that Worker rejects after `exp + 15s` BEFORE cache lookup. Revoked session replay bounded by `exp` baked into URLs already held (max segment TTL + 15s ≈ `TOKEN_TTL`). Chokepoint is `/stream/window` (NEVER cached, fetched every few seconds): once it returns SESSION_REVOKED / kill-switch / abuse-block, no new opaque chunk URLs minted; existing ones reach `exp` within seconds.

**Stealth mode clarification**: "Stealth Mode" in admin UI controls URL obfuscation — hides storage URLs behind opaque AES-encrypted tokens with per-session validation. Does NOT perform per-session segment re-encryption. AES-128 HLS encryption key is per-video (master key, fetched only via `/key` or `/stream/secret` which are never cached and per-session validated). Bytes are master-encrypted at storage and decrypted by the player using session-bound key delivery — making cached segment bytes useless without a valid live session.

## 10. Database Tables (Detailed)

- `admin_users` — single admin account
- `videos` — metadata, status, S3 keys
- `video_player_settings` — per-video player config
- `video_watermark_settings` — logo, ticker (color/size/bg), author overlay, pop-up watermark
- `media_assets` — uploaded logo/watermark images (stored in same video bucket)
- `video_security_settings` — token, domain, signed URL config
- `embed_tokens` — JWTs with expiry and domain restriction
- `playback_sessions` — analytics sessions
- `audit_logs` — admin action log
- `system_settings` — key-value config (AWS, kill switch, Vimeo token, etc.)
- `storage_connections` — named storage providers (B2 / S3 / R2) with config + active flag
- `video_client_security` — per-video client-side security overrides
- `video_sessions` — durable persistence for in-memory HLS session state (multi-instance safety)
- `user_sessions` — express session store
- `integration_clients` — registered LMS platforms with keys, secrets, permissions
- `integration_client_video_access` — per-client video access whitelist
- `integration_launch_logs` — launch token verification audit trail
- `integration_playback_sessions` — integration playback sessions with progress
- `integration_event_logs` — player events from integration sessions
- `integration_api_keys` — API key management
- `sdk_build_metadata` — SDK version tracking

## 11. Storage Backends

Three backends managed via System Settings → Storage Connections:
1. **Backblaze B2 (S3-Compatible)** — `B2_KEY_ID` + `B2_APPLICATION_KEY` in Replit Secrets. Non-secret config in `storage_connections`.
2. **Cloudflare R2 (S3-Compatible)** — `R2_ACCESS_KEY_ID` + `R2_SECRET_ACCESS_KEY` in Secrets. Endpoint: `https://<account-id>.r2.cloudflarestorage.com`. Region defaults to `auto`.
3. **AWS S3 (legacy)** — credentials in `system_settings` key-value store.
4. **Local fallback** — when no cloud configured; not persistent between restarts.

Active connection is selected per-card in System Settings. New uploads + HLS outputs use the active connection. Manifest endpoint signs URLs using the connection associated with each video.

Video source types: `upload`, `youtube`, `vimeo`, `drive`, `onedrive`, `s3`, `direct`.

## 12. Debug Endpoints (dev mode only)

- `GET /api/_debug/secure-hls/selftest?videoId=...` — automated checks (transcode, masking, token expiry, rate limit, block, iOS compat)
- `GET /api/_debug/cache-probe?url=<signedSegUrl>&n=5&secret=<DEBUG_CACHE_PROBE_SECRET>` — admin-only. Fetches signed `/seg/` URL N times through Worker, reports `cf-cache-status` + latency per request. Requires `DEBUG_CACHE_PROBE_SECRET` (404 if absent). Never returns segment bytes or echoes the signed URL.

## 13. Vercel Deployment Notes

- `api/index.ts` — serverless Express handler (lazy-init, default export)
- `vercel.json` — `npm run build`, static from `dist/public/`, API rewrites
- **Setup**: import project on vercel.com → add env vars in Project Settings → deploy
- **Limitations**:
  - **File uploads**: 4.5 MB body limit. Large uploads must use the pre-signed direct-to-B2 flow already in the app.
  - **Filesystem**: `/tmp` is ephemeral between invocations. OK for temp upload files; not for permanent storage.
  - **Function timeout**: 30s max. HLS segment proxying and API calls are well within.
