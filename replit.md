# Secure Video CMS

A full-stack secure video content management system for a single admin user.

## Architecture

**Full-stack monorepo** — Express backend + React frontend (served on same port via Vite proxy in dev).

- **Frontend**: React + TypeScript + Vite + Tailwind CSS + shadcn/ui + TanStack Query + Wouter
- **Backend**: Node.js + Express 5 (TypeScript)
- **Database**: PostgreSQL via Drizzle ORM
- **Storage**: Backblaze B2 (S3-Compatible) + Cloudflare R2 (S3-Compatible) + AWS S3 (legacy) + local fallback — managed via Storage Connections in System Settings
- **Video Processing**: ffmpeg for HLS transcoding (2s segment duration, AES-128 encrypted)
- **Auth**: Session-based (express-session + connect-pg-simple)

## Features

### Admin Panel
- **Login**: Email/password auth with session management
- **Dashboard**: Stats overview, recent activity, quick actions
- **Video Library**: List/search/manage all videos with status badges
- **Upload Wizard**: File upload to S3 + HLS transcoding, OR URL import (YouTube/Vimeo/Drive/OneDrive/S3/Direct)
- **Video Detail** (tabbed):
  - Overview: metadata editing
  - Player: full StreamYard-style accordion panel with live iframe preview on left; sections: Player Controls, Logo, Overlay, QR Code, Video Clips (intro/outro), Banners & Tickers, Style (brand color, theme, font)
  - Watermark: logo, scrolling ticker, pop-up watermark with variable templates
  - Security: token required, signed URLs, domain whitelist, referrer checks, concurrent limits
  - Embed & Share: iframe code, masked share link, token management
  - Analytics: plays, watch time, top domains, recent sessions
  - Tokens: create/revoke/delete embed tokens
- **Embed Manager**: Global view of all tokens across videos
- **Audit Logs**: Full admin action history
- **System Settings**: Storage Connections (B2 + R2 + S3), Vimeo integration, AWS/S3 legacy config, global kill switch, signing secret, ffmpeg toggle

### Public Pages
- `/embed/:publicId` — Iframe-only LMS player. Shows "Waiting for LMS authorization..." until a postMessage arrives. Blocked if opened as top-level page.
- `/embed/:publicId?token=<adminPreviewJWT>` — Admin preview only (adminPreview:true JWT). Skips iframe enforcement.
- `/v/:publicId?token=...` — masked share link page

### Per-User Token Minting (Secure LMS Flow)
- `POST /api/player/:publicId/mint` — Mints per-user embed token via:
  - **Path A**: Session auth (same-domain logged-in user) — no body needed
  - **Path B**: `{ lmsLaunchToken }` — HMAC-SHA256 signed launch token from external LMS (never via URL)
  - Never trusts userId from URL or body. Server derives identity.
  - Entitlement check before minting (checkEntitlement function, extensible)
  - Session limit scoped per user PER VIDEO (userId + videoId)
- `POST /api/player/:publicId/refresh-token` — Refreshes expired token, re-checks entitlement
- `POST /api/player/:publicId/revoke-other-sessions` — Revokes other sessions for same video, userId derived from token
- `GET /api/lms/origins` — Public endpoint: returns allowed LMS origins from ALLOWED_LMS_ORIGINS env var

### Iframe-Only LMS Embedding Security
The embed player enforces strict iframe-only access:
1. **Top-level check**: If `window.top === window.self`, show "Access Restricted — This video can only be played inside the LMS."
2. **postMessage receiver**: Listens for `{ type: "LMS_LAUNCH_TOKEN", token: "<lmsLaunchToken>" }` from allowed origins only
3. **Origin validation**: Fetches allowed origins from `/api/lms/origins` (from `ALLOWED_LMS_ORIGINS` env var), rejects messages from other origins
4. **Token never in URL**: LMS launch tokens arrive via postMessage only, never `?lmsLaunchToken=` URL param

### LMS Launch Token Hardened Verification (`verifyLmsLaunchToken`)
Required payload fields: `userId`, `publicId`, `exp`, `nonce`, `aud`, `origin`
- `aud` must equal `"video-cms"`
- `origin` must match one of `ALLOWED_LMS_ORIGINS`
- `exp` must be in the future AND within 10 minutes (max 600s from now)
- Nonce replay check removed — on iframe refresh the LMS reuses the same token. Replay protection is provided by `exp` (up to 10-min window, max 600s) + client instance ID scoped auto-revocation in the mint endpoint.
- HMAC-SHA256 signature verified with `LMS_HMAC_SECRET`
- LMS launch token format: `base64url(JSON{userId,publicId,exp,nonce}).hmac_hex`
- Requires `LMS_HMAC_SECRET` env var for LMS launch token verification

### Client Instance ID (LMS Refresh Resilience)
- `getClientInstanceId()` in embed-player.tsx generates a stable random ID per browser, stored in `localStorage` under key `vcms:client-instance`.
- Sent as `x-client-instance` header on every `/mint` request.
- Stored in token label as `auto:userId:source:inst:<id>`.
- On mint: server auto-revokes all active tokens with the same `inst:` label for that user+video before the concurrent session check. This means iframe refresh silently replaces its own token without triggering SESSION_LIMIT.
- `POST /api/player/:publicId/revoke-sessions-by-launch`: Revokes ALL active tokens for userId derived from the verified launch token. Used by "End Other Session" button when no prior token exists.

### Video Security Pipeline (Non-DRM, 3-Layer Protection)
Secure HLS proxy — B2/S3 origin URLs are **never** sent to the frontend:

**Layer 1 — Origin Hidden**: All storage URLs are proxied server-side. Browser only ever sees `/hls/` and `/seg/` endpoints on our domain.
- `GET /api/player/:publicId/manifest` creates an in-memory `VideoSession` (with deviceHash binding) and returns a signed proxy URL
- `GET /hls/:publicId/*` — fetches playlists server-side, rewrites all URLs to proxy with HMAC tokens
- `GET /seg/:publicId/*` — fetches segment bytes from B2/S3, streams to client
- `GET /key/:publicId` — AES-128 key endpoint (ready for when ffmpeg encryption is enabled)
- `POST /api/video/session` — alternative session creation endpoint for custom players

**Layer 2 — Per-Chunk Signed Tokens**: Every segment URL includes an HMAC token (10s TTL) binding `sid`, path, and expiry. Key tokens expire in 10s. Playlist tokens expire in 60s. Manifest tokens expire in 60s. 3-second clock skew tolerance. User-Agent hash validated on all endpoints (via `validateUserAgent`). Note: `deviceHash` is NOT included in HMAC signing — it was removed because proxy environments (e.g., Replit preview) modify User-Agent headers between the CMS API call and the Cloudflare Worker gateway request, causing signature mismatches and 403 errors. Security is maintained through SID binding, UA hash validation, short TTLs, and abuse detection.

**Layer 3 — EVENT-style Append-Only Playlist** (formerly "sliding window"): Variant playlists use `#EXT-X-PLAYLIST-TYPE:EVENT` with `#EXT-X-MEDIA-SEQUENCE:0` always. The playlist starts at segment 0 and only grows forward — never shrinks. `windowEnd = max(session.maxSegmentExposed, currentSegmentIndex + windowSegs)`, clamped to total segments. `session.maxSegmentExposed` is the per-session monotonic high-water mark, persisted to Postgres (throttled to growths ≥4 segs) so multi-instance deployments don't emit a "shrunk" playlist after DB hydration. ENDLIST is added once the entire video has been exposed. Progress tracked via `POST /api/stream/:publicId/progress` (every 10s) and via segment access.

**Why EVENT (not sliding-window)**: The previous design used `#EXT-X-MEDIA-SEQUENCE:<windowStart>` where windowStart = `currentSegmentIndex - 2`. Backward seeks (e.g. idx=410 → idx=23) caused MEDIA-SEQUENCE to go from 408 → 21, which is a HLS protocol violation on live playlists. hls.js rejected the new playlist as stale and stayed stuck with the OLD playlist (segs 408-414 at offsets 816-828s) while video.currentTime=46s → empty buffer → permanent spinner. EVENT semantics fix this because hls.js accepts EVENT playlists growing monotonically with MEDIA-SEQUENCE fixed at 0.

**Forward-scraping protection**: `updateProgress` caps `seekTo:true` jumps at `earnedCeiling + SEEK_FORWARD_CAP_SEGS` (default 900 segs = 30 min of 2s content), where `earnedCeiling = max(currentSegmentIndex, maxSegmentExposed) + windowSegs`. This prevents a holder of the SID from forging one `seekTo:true currentTime=videoDuration` POST to expose the entire video in a single playlist response. Scraping the whole video via repeated forged seeks still has to clear `bulk_download` (>30 segs in 5s), `velocity_abuse`, and per-segment rate-limit abuse detection. Backward seeks are NOT capped (the caller can't gain any additional segment exposure by seeking backward within already-exposed content).

**Session Binding**: Each session stores: sessionId, userAgent hash, deviceHash, boundIp, createdAt, expiresAt (60 min max — raised for 2k+ daily users watching long videos). All /hls, /seg, /key requests validate token + session validity + UA match + device hash. TOKEN_TTL is 3600s (60 min) for all resource types (manifest, playlist, segment, key) — matches SESSION_MAX_AGE_MS so signed URLs never expire before the session ends.

**HLS Session Heartbeat** (embed-player.tsx): Every 3 minutes, the player calls `POST /api/player/:publicId/extend-session` to extend the session TTL without changing the SID or reloading the manifest. This completely eliminates the 1-2s black screen that the old `rotate-session` approach caused: rotating created a new SID + new manifest URL → `hls.loadSource(newUrl)` → HLS.js flushed the MSE SourceBuffer → black screen while segments re-buffered. The heartbeat keeps the same SID so HLS.js never touches the manifest or SourceBuffer. Session stays alive for 20 minutes from each ping (so long videos play without expiry). The `rotate-session` endpoint is still available for forced rotation on error recovery paths. A monotonic `rotationOpIdRef` + `isRotatingRef` guard is used only by the error recovery paths (fatal-403, token-refresh, pause-resume >90s). HLS retries: manifest/level/fragment/key loading all retry 4 times.

**Abuse Detection** (server/video-session.ts): Controlled by `suspiciousDetectionEnabled` (per-video or global). When OFF, all abuse scoring, segment window enforcement, session revocation, and denial overlays are completely bypassed. When ON:
- Rate limit: >10 requests/second (burst 15) → +3/+5 score
- Concurrent segments: >6 simultaneous → +5
- Bulk download detection: >30 segments in 5s → +8 (logged as SECURITY_BULK_DOWNLOAD)
- Playlist abuse: >30 fetches/min → +3
- IP mismatch: **DISABLED** — not enforced (playlist requests arrive via Cloudflare Worker with one IP; segments arrive directly from the browser with another IP, causing false revocations). IP is only recorded on first request for logging.
- Out-of-window: segment request outside [current-1, current+20] → +2 (windowSize=20 covers hls.js 30s buffer)
- Key abuse: >30 key requests/min → +5
- Violation limit: configurable per-video via `violationLimit` (default 6), stored in session object
- On breach: session blocked for 10 minutes, returns 429/403
- Breach response format: `{ error: "SECURITY_BREACH", breach: "X/limit" }` in denial responses

**CORS Policy**: Origin-restricted (not wildcard). In production, only configured ALLOWED_ORIGINS + Replit domains permitted. Dev mode allows all origins.

**Cache Policy**: Playlists and keys: `Cache-Control: no-store`. Segments: `Cache-Control: private, no-store, no-cache, max-age=0`.

**Manifest Guard**: Direct external m3u8 URLs are blocked with `UNSECURE_MANIFEST_BLOCKED` log. External URLs in playlists are stripped.

**Storage Cleanup on Delete**: When a video is deleted from the CMS, `deleteVideoStorage()` deletes all associated files from B2/S3: HLS segments (under `hlsS3Prefix`), raw upload (`rawS3Key`), and assets like thumbnails (`assets/videos/<videoId>/`). Uses batch `DeleteObjectsCommand` with automatic fallback to individual `DeleteObjectCommand` calls for B2 compatibility. Each cleanup step (HLS, raw, assets) has independent error handling so one failure doesn't block others.

**AES-128 Double Encryption**: Server decrypts segments with master key (fetched from B2, cached), re-encrypts with session-specific ephemeral key/IV. Player never sees master key.

**Client-Side Protection** (useSecurityViolations hook): Violation counter with per-video localStorage persistence, 3s debounce per event type, configurable limit. On limit reached: 10-minute cooldown with countdown overlay. Events: RIGHT_CLICK, FOCUS_LOST, DEVTOOLS_DETECTED, FULLSCREEN_REQUIRED_BREACH, DOWNLOAD_ATTEMPT.

Signing secret: `SIGNING_SECRET` env var (REQUIRED in production). No fallbacks — server crashes on startup if missing in production. Generate a new one via `GET /api/admin/generate-signing-secret` (admin-only). Must set the SAME value in Railway env vars AND Cloudflare Worker env vars, then redeploy both.

### Integration API Module (Gumlet-style)
- **Admin Panel**: Integrations page with tabs — Clients, Launch Logs, Sessions, Docs & Test
- **Integration Clients**: CRUD management with HMAC key/secret pairs, origin whitelisting, video access modes (all / selected)
- **Launch Token Flow**: LMS backend signs `base64url(payload).hmacHex` with `INTEGRATION_MASTER_SECRET`; CMS verifies, mints embed token, starts tracked session
- **Player SDK**: `/sdk/player.js` (vanilla JS, auto-loads HLS.js), React wrapper `SyanVideoPlayer.tsx`
- **Embed Options**: Direct SDK mount, React component, or iframe via `/api/integrations/embed/:publicId?launchToken=`
- **Session Tracking**: Ping every 10s, event logging (play/pause/seek/ended), completion reporting
- **Admin Endpoints**: `/api/admin/integrations/clients`, `/api/admin/integrations/logs`, `/api/admin/integrations/sessions`, test token generator
- **Player Endpoints**: `/api/integrations/player/:publicId/mint|refresh|ping|events|complete`, `/api/integrations/videos/:publicId`, `/api/integrations/embed/:publicId`

## Database Tables

- `admin_users` — single admin account
- `videos` — video metadata, status, S3 keys
- `video_player_settings` — per-video player config
- `video_watermark_settings` — logo, ticker (with color/size/bg), author overlay, pop-up watermark
- `media_assets` — uploaded logo/watermark images (stored in same video bucket)
- `video_security_settings` — token, domain, signed URL config
- `embed_tokens` — JWT tokens with expiry and domain restriction
- `playback_sessions` — analytics sessions
- `audit_logs` — admin action log
- `system_settings` — key-value config store (AWS, kill switch, Vimeo token, etc.)
- `storage_connections` — named storage providers (Backblaze B2 / AWS S3) with config + active flag
- `video_client_security` — per-video client-side security overrides (violations, fullscreen, etc.)
- `user_sessions` — express session store
- `integration_clients` — registered LMS platforms with keys, secrets, permissions
- `integration_client_video_access` — per-client video access whitelist
- `integration_launch_logs` — launch token verification audit trail
- `integration_playback_sessions` — integration playback sessions with progress
- `integration_event_logs` — player events from integration sessions
- `integration_api_keys` — API key management
- `sdk_build_metadata` — SDK version tracking

## Key API Routes

### Auth
- `POST /api/auth/login` — Login with email/password
- `POST /api/auth/logout` — Logout
- `GET /api/auth/me` — Check session

### Videos
- `GET/POST /api/videos` — List/create videos
- `GET/PUT/DELETE /api/videos/:id` — Get/update/delete video
- `POST /api/videos/:id/upload` — Upload video file (multipart)
- `PUT /api/videos/:id/player-settings` — Update player config
- `PUT /api/videos/:id/watermark-settings` — Update watermark config
- `PUT /api/videos/:id/security-settings` — Update security config
- `POST /api/videos/:id/toggle-availability` — Show/hide video
- `GET /api/videos/:id/analytics` — Analytics data
- `POST /api/videos/:id/tokens` — Create embed token

### Player (Public)
- `GET /api/player/:publicId/manifest` — Get signed HLS manifest URL
- `GET /api/player/:publicId/settings` — Get player/watermark settings
- `POST /api/player/:publicId/ping` — Update playback session

### System
- `GET/PUT /api/settings` — Get/update system settings
- `GET /api/audit` — Get audit logs
- `GET /api/dashboard` — Dashboard stats

### Debug (dev mode only)
- `GET /api/_debug/secure-hls/selftest?videoId=...` — Runs automated checks (transcode, masking, token expiry, rate limit, block, iOS compatibility)
- `GET /api/_debug/cache-probe?url=<signedSegUrl>&n=5&secret=<DEBUG_CACHE_PROBE_SECRET>` — Admin-only. Fetches a signed `/seg/` URL N times through the Worker and reports `cf-cache-status` + latency per request. Requires `DEBUG_CACHE_PROBE_SECRET` env var (404 if absent). Never returns segment bytes or echoes the signed URL.

### Cloudflare Edge Cache (Worker)
The Worker (`cloudflare-worker/worker.js`) implements synthetic-key edge caching **only for the `/seg/` route**, which serves master-encrypted B2 segment bytes that are identical across all viewers.

**Order of operations (validation always first):**
1. Parse `sid`, `st`, `exp` from query params. Reject 401 if any missing.
2. Expiry check with 15s skew tolerance for segments/keys, 30s for playlists. Reject 403 if expired.
3. Compute UA device hash, verify HMAC signature against candidate paths. Reject 403 if invalid.
4. **Only after auth passes**, for `/seg/` GET requests without `Range`: cache lookup.

**Cache key:** `https://cache.internal/seg/${publicId}${subPath}` — strips `sid`, `st`, `exp`, and the entire query string. Stable across users. Same segment of same video at same quality always hits the same key.

**What is cached:**
- `/seg/` segment responses (legacy route) with status 200, no Range header.
- `/api/player/.../stream/chunk/<opaqueId>?st=<hmac>&exp=<unix>` stealth chunk responses with status 200, no Range header. Bytes are master-encrypted (the previously-documented "per-session re-encryption" was aspirational/legacy and never actually implemented in the stealth chunk handler — it has always streamed master-encrypted bytes through Railway). Stable cache key is a 16-hex HMAC prefix derived from `(SIGNING_SECRET, "chunk|publicId|segSubPath")` and prepended to the opaque ID at mint time (`mintOpaqueChunkId`). Worker reads the prefix from the URL and uses it as a synthetic cache key: `https://cache.internal/stealth-chunk/<publicId>/<16hexPrefix>`. The encrypted suffix of the opaque ID stays per-session — server validation (UA, window, abuse, session binding) is unchanged. URL still appears fully opaque in the browser.

  **Edge auth gate (mandatory before cache lookup):** Worker validates `exp` (now ≤ exp + 15s) and `st` (= `HMAC-SHA256(SIGNING_SECRET, "chunk-cache-v1|publicId|prefix|exp")`) BEFORE any `cache.match`. Without this gate, any holder of a previously-observed chunk URL could keep pulling cached bytes after session revocation — for the full cache TTL (24h). With the gate, replay is bounded by `exp + 15s skew`, matching the `/seg/` model exactly. `st` comparison is constant-time. Old-format chunk URLs without `st`/`exp` are not edge-cached (forwarded straight to Railway for full validation), preserving backward compatibility during deploy.

Stored internally with `Cache-Control: public, max-age=86400, immutable` (segments are content-addressed and never change).

**What is NOT cached (intentional):**
- `/hls/` variant playlists — contain per-session signed URLs
- `/key/` AES keys — per-session ephemeral
- `/api/player/.../stream/window` stealth playlist — user/window-specific
- `/api/player/.../stream/secret/<opaqueId>` stealth key — per-session AES key material
- All 4xx/5xx responses
- All Range requests (v1 limitation; HLS.js doesn't issue Range on `.ts` segments)
- Stealth chunks with old-format opaque IDs missing the 16-hex prefix (backward-compatible — old IDs in flight after deploy still validate, just bypass the cache)

**Railway is skipped entirely on `/seg/` and stealth-chunk cache HITs.** Worker returns cached bytes directly from Cloudflare edge — zero calls to Railway, zero calls to B2/R2.

**Browser response always carries `Cache-Control: private, no-store`** regardless of HIT or MISS, so token rotation, session binding, and per-user revocation stay enforceable. Only the *internal* cached copy uses `public, max-age=86400, immutable`.

**Security preserved:** HMAC validation, SID/session binding, expiry, UA/device hash, signed-URL contract, master-key protection (both `/key` and `/stream/secret` never cached), LMS iframe enforcement (client-side, untouched), one-session-per-user (Railway-enforced), global/per-video security settings (Railway-enforced), abuse detection (Railway-enforced on `/hls/` and stealth playlist `/stream/window` which are never cached).

**Revocation latency for stealth chunks:** Identical to `/seg/` — on cache HIT the Worker skips Railway, but the URL itself carries an `exp` that the Worker rejects after `exp + 15s` BEFORE the cache lookup. So a revoked session can replay only until the `exp` baked into the URLs it already holds (max segment TTL + 15s skew ≈ `TOKEN_TTL`). The chokepoint is `/stream/window` (NEVER cached, fetched every few seconds by hls.js): once it returns SESSION_REVOKED / kill-switch / abuse-block, no new opaque chunk URLs are minted and existing ones reach `exp` within seconds.

**Stealth mode clarification:** "Stealth Mode" in the admin UI controls URL obfuscation — it hides storage URLs behind opaque AES-encrypted tokens and enforces per-session validation. It does NOT perform per-session segment re-encryption. The AES-128 HLS encryption key is per-video (master key, fetched only via `/key` or `/stream/secret` which are never cached and are per-session validated). Bytes are master-encrypted at storage and decrypted by the player using a session-bound key delivery — making cached segment bytes useless without a valid live session.

## Environment Variables

- `DATABASE_URL` — PostgreSQL connection string (auto-provisioned)
- `SESSION_SECRET` — Session encryption secret
- `ADMIN_EMAIL` / `ADMIN_PASSWORD` — Seeded admin credentials
- `SIGNING_SECRET` — HMAC signing secret for HLS tokens + embed JWTs (REQUIRED in production, no fallback)
- `HLS_GATEWAY_BASE` — Cloudflare Worker gateway domain for HLS playback (e.g. `https://video.syanmedtech.com`). All HLS/segment/key URLs are prefixed with this. Omit in dev for relative paths.
- `VIMEO_ACCESS_TOKEN` — Vimeo Personal Access Token (or set via System Settings)
- `B2_KEY_ID` — Backblaze B2 Application Key ID (required for B2 uploads)
- `B2_APPLICATION_KEY` — Backblaze B2 Application Key secret (required for B2 uploads)
- `B2_S3_ENDPOINT` — B2 S3-compatible endpoint (e.g. `https://s3.ca-east-006.backblazeb2.com`)
- `B2_BUCKET` — Default B2 bucket name (e.g. `mytestvideo`)
- `R2_ACCESS_KEY_ID` — Cloudflare R2 API Token Access Key ID (required for R2 uploads)
- `R2_SECRET_ACCESS_KEY` — Cloudflare R2 API Token Secret Access Key (required for R2 uploads)
- `R2_ENDPOINT` — R2 S3-compatible endpoint (e.g. `https://<account-id>.r2.cloudflarestorage.com`)
- `R2_REGION` — R2 region (defaults to `auto`)
- `LMS_HMAC_SECRET` — HMAC-SHA256 secret for verifying LMS launch tokens (required for external LMS embed flow)
- `ALLOWED_ORIGINS` — Comma-separated list of allowed CORS origins for production (e.g. `https://yourdomain.com,https://app.yourdomain.com`)
- `INTEGRATION_MASTER_SECRET` — Master HMAC secret for signing/verifying integration launch tokens (REQUIRED in production, auto-generated in dev)
- `CMS_PUBLIC_BASE_URL` — Public URL of the CMS (optional, derived from request if not set)
- `EMBED_TOKEN_TTL_SECONDS` — Integration embed token TTL in seconds (default: 300)

## Storage Configuration

The system supports three storage backends managed via System Settings → Storage Connections:

1. **Backblaze B2 (S3-Compatible)** — Requires `B2_KEY_ID` and `B2_APPLICATION_KEY` in Replit Secrets. Non-secret config (endpoint, bucket, prefixes) stored in `storage_connections` table.
2. **Cloudflare R2 (S3-Compatible)** — Requires `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` in Replit Secrets. Endpoint format: `https://<account-id>.r2.cloudflarestorage.com`. Region defaults to `auto`.
3. **AWS S3** — Legacy. Credentials stored in `system_settings` key-value store.
4. **Local fallback** — When no cloud storage is configured, files stored on local disk (not persistent between restarts).

The active connection is selected per connection card in System Settings. New uploads and HLS outputs automatically use the active connection. The manifest endpoint signs URLs using the connection associated with each video.

The system supports these video source types:
- **upload** — Direct file upload → S3 → ffmpeg HLS
- **youtube** — YouTube embed URL
- **vimeo** — Vimeo embed URL
- **drive** — Google Drive URL
- **onedrive** — OneDrive URL
- **s3** — Direct S3 URL
- **direct** — Any direct video URL

## Run Instructions

1. Start via "Start application" workflow — runs `npm run dev`
2. Access admin at `http://localhost:5000`
3. Login with configured admin credentials
4. Configure AWS in System Settings if using S3 uploads
5. Upload or import videos
6. Generate embed tokens and use the iframe/share codes on external sites

## Vercel Deployment

The app is Vercel-compatible via:
- **`api/index.ts`** — Serverless Express handler (lazy-initialised, exported as default)
- **`vercel.json`** — Build config: `npm run build`, static files from `dist/public/`, API rewrites

### Vercel Setup Steps

1. Push repo to GitHub
2. Import project on [vercel.com](https://vercel.com)
3. Vercel auto-detects `vercel.json` — no framework override needed
4. Add these environment variables in Vercel Project Settings → Environment Variables:

| Variable | Value |
|---|---|
| `SUPABASE_DATABASE_URL` | Supabase pooler connection string (port 6543) |
| `SESSION_SECRET` | Strong random string |
| `ADMIN_EMAIL` | Admin login email |
| `ADMIN_PASSWORD` | Admin login password |
| `SIGNING_SECRET` | HMAC signing secret (REQUIRED — generate via admin endpoint) |
| `HLS_GATEWAY_BASE` | `https://video.syanmedtech.com` |
| `B2_KEY_ID` | Backblaze B2 Key ID |
| `B2_APPLICATION_KEY` | Backblaze B2 Application Key |
| `B2_S3_ENDPOINT` | e.g. `https://s3.ca-east-006.backblazeb2.com` |
| `B2_BUCKET` | B2 bucket name |

5. Deploy — Vercel runs `npm run build`, serves frontend from CDN, routes `/api/*` to serverless function

### Vercel Limitations

- **File uploads**: Vercel limits request bodies to 4.5 MB. Large video file uploads (> 4.5 MB) must use the pre-signed direct-to-B2 upload flow already in the app.
- **No filesystem persistence**: `/tmp` is available but ephemeral between invocations. Temporary upload files are fine; do not rely on local disk for permanent storage.
- **Function timeout**: 30 seconds max per request. HLS segment proxying and API calls are well within this limit.
