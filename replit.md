# Secure Video CMS

A full-stack secure video content management system for a single admin user.

## Stack

- **Frontend**: React + TypeScript + Vite + Tailwind + shadcn/ui + TanStack Query + Wouter
- **Backend**: Node.js + Express 5 (TypeScript)
- **Database**: PostgreSQL via Drizzle ORM
- **Storage**: Backblaze B2 / Cloudflare R2 / AWS S3 / local fallback (configured via System Settings → Storage Connections)
- **Video Processing**: ffmpeg HLS (2s segments, AES-128 encrypted)
- **Edge Cache**: Cloudflare Worker (`cloudflare-worker/worker.js`) — caches `/seg/` + stealth chunks only

## Architecture Overview

- **Admin panel** (`/admin/*`) — login, dashboard, video library, upload wizard, player config (StreamYard-style accordion), watermark, security, embed/share, analytics, tokens, integrations, audit logs, system settings
- **Public embed** (`/embed/:publicId`) — iframe-only LMS player. Requires LMS launch token via postMessage; blocks top-level access.
- **Shareable link** (`/v/:publicId?token=...`) — masked share-link page
- **Integration API** (Gumlet-style) — registered LMS clients sign launch tokens with HMAC; CMS verifies, mints embed token, tracks sessions. SDK at `/sdk/player.js`.

**Deep architecture details** (security pipeline, edge cache rules, LMS flow, stealth mode, integration API): see [`docs/architecture.md`](docs/architecture.md).

## Database Tables

- `admin_users`, `videos`, `video_player_settings`, `video_watermark_settings`, `media_assets`
- `video_security_settings`, `video_client_security`, `embed_tokens`, `playback_sessions`
- `audit_logs`, `system_settings`, `storage_connections`, `user_sessions`
- `video_sessions` — durable persistence for in-memory HLS session state
- `integration_clients`, `integration_client_video_access`, `integration_launch_logs`
- `integration_playback_sessions`, `integration_event_logs`, `integration_api_keys`, `sdk_build_metadata`

## Key API Routes

### Auth & Admin
- `POST /api/auth/login` · `POST /api/auth/logout` · `GET /api/auth/me`
- `GET /api/dashboard` · `GET /api/audit` · `GET/PUT /api/settings`

### Videos
- `GET/POST /api/videos` · `GET/PUT/DELETE /api/videos/:id`
- `POST /api/videos/:id/upload` (multipart) · `POST /api/videos/:id/toggle-availability`
- `PUT /api/videos/:id/{player,watermark,security}-settings`
- `GET /api/videos/:id/analytics` · `POST /api/videos/:id/tokens`

### Player (public)
- `GET /api/player/:publicId/manifest` — signed HLS manifest URL
- `GET /api/player/:publicId/settings` — player + watermark + banners
- `POST /api/player/:publicId/tick` — **unified** progress + heartbeat + ping (replaces the three separate endpoints; old endpoints kept as shims for in-flight players)
- `POST /api/player/:publicId/mint|refresh-token|revoke-other-sessions|extend-session|rotate-session|heartbeat|security-event`
- `GET /api/lms/origins` — public list of allowed LMS origins

### Integrations
- `/api/admin/integrations/{clients,logs,sessions}` — admin CRUD + audit
- `/api/integrations/player/:publicId/{mint,refresh,ping,events,complete}` — runtime
- `/api/integrations/{videos/:publicId,embed/:publicId}` — fetch + iframe embed

## Environment Variables

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | PostgreSQL (auto-provisioned on Replit) |
| `SESSION_SECRET` | yes | express-session encryption |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | yes | Seeded admin login |
| `SIGNING_SECRET` | yes in prod | HMAC for HLS tokens + embed JWTs. **No fallback** — server crashes on startup if missing. Must match Cloudflare Worker `SIGNING_SECRET`. |
| `HLS_GATEWAY_BASE` | prod | Cloudflare Worker domain (e.g. `https://video.syanmedtech.com`) |
| `LMS_HMAC_SECRET` | LMS embed | HMAC-SHA256 for LMS launch token verification |
| `INTEGRATION_MASTER_SECRET` | yes in prod | HMAC for integration launch tokens (auto-generated in dev) |
| `ALLOWED_ORIGINS` | prod | Comma-separated CORS allowlist |
| `ALLOWED_LMS_ORIGINS` | LMS embed | Comma-separated allowed postMessage origins |
| `EMBED_TOKEN_TTL_SECONDS` | optional | Integration embed token TTL (default 300) |
| `CMS_PUBLIC_BASE_URL` | optional | Public URL (derived from request if absent) |
| `VIMEO_ACCESS_TOKEN` | optional | Vimeo PAT (can also be set via System Settings) |
| `B2_KEY_ID`, `B2_APPLICATION_KEY`, `B2_S3_ENDPOINT`, `B2_BUCKET` | for B2 | Backblaze B2 |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ENDPOINT`, `R2_REGION` | for R2 | Cloudflare R2 |
| `DEBUG_CACHE_PROBE_SECRET` | optional | Enables `/api/_debug/cache-probe` (404 if absent) |

## Run Instructions

1. Start via **Start application** workflow (`npm run dev`)
2. Open `http://localhost:5000`
3. Login with seeded admin credentials
4. Configure a Storage Connection in System Settings (B2 / R2 / S3)
5. Upload or import videos; generate embed tokens; copy iframe/share codes

## Deployment

- **Replit Autoscale / Reserved VM**: use the Replit deployment skill — env vars are set in deployment settings
- **Vercel**: serverless via `api/index.ts` + `vercel.json`. File uploads >4.5MB must use the pre-signed direct-to-B2 flow (Vercel body limit). `/tmp` is ephemeral.
- **Railway** (current prod): standard Node deployment. Pair with Cloudflare Worker on a custom domain for edge caching.

## User Preferences

- Keep `replit.md` slim — deep architecture lives in `docs/architecture.md`
- Speak in plain language; user is technical but values concise answers
- Always preserve security invariants (signed URLs, session binding, UA hash, LMS iframe enforcement, abuse detection) when optimizing
- Before destructive or far-reaching changes, summarize the plan and tradeoffs first
