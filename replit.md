# Secure Video CMS

A full-stack secure video content management system for a single admin user.

## Architecture

**Full-stack monorepo** — Express backend + React frontend (served on same port via Vite proxy in dev).

- **Frontend**: React + TypeScript + Vite + Tailwind CSS + shadcn/ui + TanStack Query + Wouter
- **Backend**: Node.js + Express 5 (TypeScript)
- **Database**: PostgreSQL via Drizzle ORM
- **Storage**: Backblaze B2 (S3-Compatible, primary) + AWS S3 (legacy) + local fallback — managed via Storage Connections in System Settings
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
  - Player: controls configuration (speed, quality, fullscreen, skip, brightness, resume, autoplay)
  - Watermark: logo, scrolling ticker, pop-up watermark with variable templates
  - Security: token required, signed URLs, domain whitelist, referrer checks, concurrent limits
  - Embed & Share: iframe code, masked share link, token management
  - Analytics: plays, watch time, top domains, recent sessions
  - Tokens: create/revoke/delete embed tokens
- **Embed Manager**: Global view of all tokens across videos
- **Audit Logs**: Full admin action history
- **System Settings**: Storage Connections (B2 + S3), Vimeo integration, AWS/S3 legacy config, global kill switch, signing secret, ffmpeg toggle

### Public Pages
- `/embed/:publicId?token=...` — iframe-embeddable HLS player
- `/v/:publicId?token=...` — masked share link page
- Both support: hls.js playback, watermark overlays, token validation, domain checking

### Video Security Pipeline (Non-DRM, 3-Layer Protection)
Secure HLS proxy — B2/S3 origin URLs are **never** sent to the frontend:

**Layer 1 — Origin Hidden**: All storage URLs are proxied server-side. Browser only ever sees `/hls/` and `/seg/` endpoints on our domain.
- `GET /api/player/:publicId/manifest` creates an in-memory `VideoSession` (with deviceHash binding) and returns a signed proxy URL
- `GET /hls/:publicId/*` — fetches playlists server-side, rewrites all URLs to proxy with HMAC tokens
- `GET /seg/:publicId/*` — fetches segment bytes from B2/S3, streams to client
- `GET /key/:publicId` — AES-128 key endpoint (ready for when ffmpeg encryption is enabled)
- `POST /api/video/session` — alternative session creation endpoint for custom players

**Layer 2 — Per-Chunk Signed Tokens**: Every segment URL includes an HMAC token (15s TTL) binding `sid`, path, expiry, and `deviceHash` (SHA256 of User-Agent). Segments from different browsers/devices are rejected. 3-second clock skew tolerance.

**Layer 3 — Sliding Window Playlist**: Variant playlists return only the next 6 segments (not the entire video). The playlist is served as a live-like HLS stream (no `#EXT-X-ENDLIST` until the final window). hls.js reloads it periodically and only sees segments in the current window. Progress tracked via `POST /api/stream/:publicId/progress` (every 10s) and via segment access (auto-advances window when segments are fetched).

**Abuse Detection** (server/video-session.ts): Sessions revoked when abuse score reaches 15:
- Rate limit: >50 requests/5s → +5 score
- Concurrent segments: >6 simultaneous → +5
- Playlist abuse: >60 fetches/min → +3
- IP mismatch: different IP on same session → +8
- Out-of-window: segment request outside [current-1, current+6] → +3 (after 3 violations)
- Key abuse: >120 key requests/min → +5
- Breach response format: `{ error: "SECURITY_BREACH", breach: "X/6" }` in denial responses

**AES-128 Double Encryption**: Server decrypts segments with master key (fetched from B2, cached), re-encrypts with session-specific ephemeral key/IV. Player never sees master key.

**Client-Side Protection** (useSecurityViolations hook): Violation counter with per-video localStorage persistence, 3s debounce per event type, configurable limit. On limit reached: 10-minute cooldown with countdown overlay. Events: RIGHT_CLICK, FOCUS_LOST, DEVTOOLS_DETECTED, FULLSCREEN_REQUIRED_BREACH, DOWNLOAD_ATTEMPT.

Signing secret: auto-derived from `SESSION_SECRET`; override with `SIGNING_SECRET` env var

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

## Environment Variables

- `DATABASE_URL` — PostgreSQL connection string (auto-provisioned)
- `SESSION_SECRET` — Session encryption secret
- `ADMIN_EMAIL` / `ADMIN_PASSWORD` — Seeded admin credentials
- `SIGNING_SECRET` — JWT signing secret for embed tokens
- `VIMEO_ACCESS_TOKEN` — Vimeo Personal Access Token (or set via System Settings)
- `B2_KEY_ID` — Backblaze B2 Application Key ID (required for B2 uploads)
- `B2_APPLICATION_KEY` — Backblaze B2 Application Key secret (required for B2 uploads)
- `B2_S3_ENDPOINT` — B2 S3-compatible endpoint (e.g. `https://s3.ca-east-006.backblazeb2.com`)
- `B2_BUCKET` — Default B2 bucket name (e.g. `mytestvideo`)

## Storage Configuration

The system supports two storage backends managed via System Settings → Storage Connections:

1. **Backblaze B2 (S3-Compatible)** — Recommended. Requires `B2_KEY_ID` and `B2_APPLICATION_KEY` in Replit Secrets. Non-secret config (endpoint, bucket, prefixes) stored in `storage_connections` table.
2. **AWS S3** — Legacy. Credentials stored in `system_settings` key-value store.
3. **Local fallback** — When no cloud storage is configured, files stored on local disk (not persistent between restarts).

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
| `SIGNING_SECRET` | JWT signing secret |
| `B2_KEY_ID` | Backblaze B2 Key ID |
| `B2_APPLICATION_KEY` | Backblaze B2 Application Key |
| `B2_S3_ENDPOINT` | e.g. `https://s3.ca-east-006.backblazeb2.com` |
| `B2_BUCKET` | B2 bucket name |

5. Deploy — Vercel runs `npm run build`, serves frontend from CDN, routes `/api/*` to serverless function

### Vercel Limitations

- **File uploads**: Vercel limits request bodies to 4.5 MB. Large video file uploads (> 4.5 MB) must use the pre-signed direct-to-B2 upload flow already in the app.
- **No filesystem persistence**: `/tmp` is available but ephemeral between invocations. Temporary upload files are fine; do not rely on local disk for permanent storage.
- **Function timeout**: 30 seconds max per request. HLS segment proxying and API calls are well within this limit.
