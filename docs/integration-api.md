# Integration API Module

Gumlet-style integration API for embedding CMS videos in external LMS platforms.

## Overview

The Integration API allows external LMS platforms to securely embed and play videos from the CMS. Each integration client gets a unique key/secret pair, signs launch tokens server-side, and the CMS handles session tracking, progress reporting, and completion events.

## Authentication Flow

1. **Admin creates an integration client** in the CMS admin panel (Integrations page)
2. Admin receives a `clientKey` and one-time-visible `clientSecret`
3. LMS backend signs a **launch token** using HMAC-SHA256 with `INTEGRATION_MASTER_SECRET`
4. Launch token is sent to the CMS player SDK or embed iframe
5. CMS verifies the token, mints an embed token, and starts a playback session

## Launch Token Format

```
base64url(JSON payload) + "." + hex(HMAC-SHA256(base64url part, INTEGRATION_MASTER_SECRET))
```

### Payload Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `iss` | string | Yes | Client key or slug |
| `aud` | string | Yes | Must be `"cms-player"` |
| `sub` | string | Yes | LMS user ID |
| `publicId` | string | Yes | CMS video public ID |
| `exp` | number | Yes | Expiry (unix seconds, max 600s from now) |
| `iat` | number | Yes | Issued at (unix seconds) |
| `jti` | string | Yes | Unique token ID (UUID) |

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `INTEGRATION_MASTER_SECRET` | Yes (prod) | Auto-generated in dev | Master HMAC secret for signing launch tokens |
| `CMS_PUBLIC_BASE_URL` | No | Derived from request | Public URL of the CMS |
| `EMBED_TOKEN_TTL_SECONDS` | No | 300 | Embed token TTL in seconds |

## API Endpoints

### Player Endpoints (Public)

#### `POST /api/integrations/player/:publicId/mint`
Mint an embed token from a launch token.

**Body**: `{ "launchToken": "..." }`
**Response**: `{ "ok": true, "embedToken": "...", "manifestUrl": "...", "integrationSessionId": "...", "expiresIn": 300 }`

#### `POST /api/integrations/player/:publicId/refresh`
Refresh an expiring embed token.

**Body**: `{ "integrationSessionId": "...", "embedToken": "..." }`
**Response**: `{ "ok": true, "embedToken": "...", "expiresIn": 300 }`

#### `POST /api/integrations/player/:publicId/ping`
Report playback progress.

**Body**: `{ "integrationSessionId": "...", "currentTime": 120, "duration": 600, "paused": false, "ended": false, "playbackRate": 1 }`

#### `POST /api/integrations/player/:publicId/events`
Send player events (play, pause, seek, ended, etc.).

**Body**: `{ "integrationSessionId": "...", "events": [{ "type": "play", "time": 0, "payload": {} }] }`

#### `POST /api/integrations/player/:publicId/complete`
Mark video as completed.

**Body**: `{ "integrationSessionId": "...", "completionPercent": 100 }`

#### `GET /api/integrations/videos/:publicId`
Get video metadata (title, duration, thumbnail).

#### `GET /api/integrations/player/:publicId/config`
Get player configuration (controls, autoplay, etc.).

#### `GET /api/integrations/embed/:publicId?launchToken=...`
Server-rendered embed page. Mints token and redirects to the CMS player.

### Admin Endpoints (Session Auth Required)

#### `GET /api/admin/integrations/clients`
List all integration clients.

#### `POST /api/admin/integrations/clients`
Create a new integration client.

**Body**: `{ "name": "...", "slug": "...", "description": "...", "allowedOrigins": [...], "allowedVideoIdsMode": "all"|"selected", "config": {} }`
**Response**: `{ "client": {...}, "rawSecret": "..." }`

#### `PATCH /api/admin/integrations/clients/:id`
Update a client.

#### `DELETE /api/admin/integrations/clients/:id`
Delete a client.

#### `POST /api/admin/integrations/clients/:id/rotate-secret`
Rotate client secret. Returns new one-time-visible secret.

#### `GET /api/admin/integrations/logs`
Query launch logs with filters (status, publicId, lmsUserId, clientId).

#### `GET /api/admin/integrations/sessions`
Query playback sessions with filters (status, publicId, clientId).

#### `POST /api/admin/integrations/sessions/:id/revoke`
Revoke an active session.

#### `POST /api/admin/integrations/test-token`
Generate a test launch token for debugging.

## SDK

### Browser SDK (`/sdk/player.js`)

```html
<div id="player"></div>
<script src="https://your-cms.com/sdk/player.js"></script>
<script>
  var player = SyanPlayer.mount({
    element: '#player',
    publicId: 'VIDEO_PUBLIC_ID',
    launchToken: 'SIGNED_LAUNCH_TOKEN',
    cmsBase: 'https://your-cms.com',
    autoplay: false,
    controls: true,
    onReady: function() { console.log('ready'); },
    onTimeUpdate: function(d) { console.log(d.currentTime, d.duration); },
    onEnded: function() { console.log('ended'); },
    onError: function(e) { console.error(e.code, e.message); }
  });

  // Controls
  player.play();
  player.pause();
  player.seek(60);
  player.getCurrentTime();
  player.getDuration();
  player.getState();
  player.destroy();
</script>
```

### React Component (`SyanVideoPlayer`)

```tsx
import SyanVideoPlayer from './components/SyanVideoPlayer';

<SyanVideoPlayer
  publicId="VIDEO_PUBLIC_ID"
  launchToken={signedToken}
  cmsBase="https://your-cms.com"
  controls
  onReady={() => console.log('ready')}
  onComplete={() => markLessonComplete()}
  onError={(e) => console.error(e)}
/>
```

### iframe Embed

```html
<iframe
  src="https://your-cms.com/api/integrations/embed/VIDEO_PUBLIC_ID?launchToken=SIGNED_TOKEN"
  allow="autoplay; fullscreen"
  allowfullscreen
  style="width:100%;height:400px;border:none;"
></iframe>
```

## Database Tables

| Table | Purpose |
|-------|---------|
| `integration_clients` | Registered LMS platforms with keys, secrets, permissions |
| `integration_client_video_access` | Per-client video access whitelist (when mode is "selected") |
| `integration_launch_logs` | Audit trail of all launch token verifications |
| `integration_playback_sessions` | Active/ended playback sessions with progress tracking |
| `integration_event_logs` | Player events (play, pause, seek, complete, etc.) |
| `integration_api_keys` | API key management (future use) |
| `sdk_build_metadata` | SDK version tracking |

## Signing Example (Node.js)

```javascript
const crypto = require('crypto');

function generateLaunchToken(clientKey, publicId, userId, masterSecret) {
  const payload = {
    iss: clientKey,
    aud: 'cms-player',
    sub: userId,
    publicId: publicId,
    exp: Math.floor(Date.now() / 1000) + 540,
    iat: Math.floor(Date.now() / 1000),
    jti: crypto.randomUUID(),
  };

  const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', masterSecret).update(b64).digest('hex');
  return b64 + '.' + sig;
}
```
