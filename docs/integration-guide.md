# Integration API — Complete Guide & Flow

## What Is the Integration API?

The Integration API lets external platforms (LMS, e-learning portals, membership sites) securely embed and play videos from the Secure Video CMS. Each platform gets its own credentials, and every playback session is tracked with full analytics.

---

## Key Concepts

| Term | Meaning |
|------|---------|
| **Integration Client** | A registered external platform (e.g. "Acme LMS"). Gets a unique `clientKey` + `clientSecret`. |
| **Launch Token** | A short-lived, HMAC-signed token created by the LMS backend. Proves the student is authorized to watch a specific video. |
| **Embed Token** | A JWT issued by the CMS after verifying a launch token. Used to actually load and play the video. |
| **Integration Session** | A tracked playback session. Records watch time, progress, completion, and player events. |
| **Master Secret** | The `INTEGRATION_MASTER_SECRET` env var. Used by all LMS backends to sign launch tokens. |

---

## How It Works — End-to-End Flow

```
┌──────────────────────────────────────────────────────────────────────┐
│                        SETUP (One-Time)                             │
│                                                                      │
│  1. CMS Admin creates an Integration Client                         │
│     → Admin panel → Integrations → Create Client                    │
│     → Receives: clientKey + clientSecret (one-time visible)         │
│                                                                      │
│  2. CMS Admin sets INTEGRATION_MASTER_SECRET env var                │
│     → Same secret shared with the LMS backend                       │
│                                                                      │
│  3. CMS Admin shares with LMS developer:                            │
│     - clientKey                                                      │
│     - INTEGRATION_MASTER_SECRET                                      │
│     - CMS base URL                                                   │
│     - Video public IDs to embed                                      │
└──────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────┐
│                    RUNTIME (Every Video View)                        │
│                                                                      │
│  Step 1: Student clicks "Watch Video" in the LMS                    │
│                                                                      │
│  Step 2: LMS Backend signs a Launch Token                           │
│     payload = {                                                      │
│       iss: "syan_ck_abc123...",    // clientKey                     │
│       aud: "cms-player",           // must be exactly this          │
│       sub: "student-42",           // student's ID in the LMS       │
│       publicId: "mjakYG627Y",      // CMS video public ID          │
│       exp: now + 540,              // expires in 9 minutes          │
│       iat: now,                    // issued at                     │
│       jti: "uuid-v4"              // unique token ID               │
│     }                                                                │
│     token = base64url(payload) + "." + HMAC-SHA256(base64url, secret)│
│                                                                      │
│  Step 3: LMS Frontend loads the video player                        │
│     Option A: SDK  → SyanPlayer.mount({ launchToken, publicId })    │
│     Option B: iframe → /api/integrations/embed/:publicId?launchToken│
│     Option C: React → <SyanVideoPlayer launchToken={...} />        │
│                                                                      │
│  Step 4: SDK/iframe calls CMS mint endpoint                         │
│     POST /api/integrations/player/:publicId/mint                     │
│     Body: { launchToken: "..." }                                    │
│                                                                      │
│  Step 5: CMS verifies the launch token                              │
│     ✓ Decode base64url payload                                      │
│     ✓ Look up client by iss (clientKey or slug)                     │
│     ✓ Check client is active                                        │
│     ✓ Verify HMAC signature with INTEGRATION_MASTER_SECRET          │
│     ✓ Validate payload (aud, exp, required fields)                  │
│     ✓ Check publicId matches URL                                    │
│     ✓ Check origin allowlist (if configured)                        │
│     ✓ Check video exists and is ready                               │
│     ✓ Check video is allowed for this client                        │
│                                                                      │
│  Step 6: CMS returns embed token + manifest URL                     │
│     Response: {                                                      │
│       ok: true,                                                      │
│       embedToken: "jwt...",                                          │
│       manifestUrl: "/api/player/mjakYG627Y/manifest?token=jwt...",  │
│       integrationSessionId: "uuid",                                  │
│       expiresIn: 300                                                 │
│     }                                                                │
│                                                                      │
│  Step 7: SDK loads HLS manifest and plays video                     │
│     Uses hls.js to load the manifest URL                            │
│     Video plays through the secure HLS pipeline                     │
│                                                                      │
│  Step 8: During playback, SDK sends telemetry                       │
│     Every 10s → POST /ping (progress, watch time)                   │
│     On play/pause/seek → POST /events                               │
│     Before token expires → POST /refresh (get new embed token)      │
│                                                                      │
│  Step 9: When video ends or student leaves                          │
│     POST /complete (mark completion %)                               │
│     Session status → "ended"                                        │
│                                                                      │
│  Step 10: CMS Admin reviews analytics                               │
│     Admin panel → Integrations → Sessions tab                       │
│     See: who watched, how long, completion %, events                │
└──────────────────────────────────────────────────────────────────────┘
```

---

## Three Ways to Embed

### Option A: JavaScript SDK (Recommended)

Best for custom LMS frontends with full control over the player.

```html
<div id="player" style="width:100%;height:400px;"></div>
<script src="https://your-cms.com/sdk/player.js"></script>
<script>
  // launchToken comes from your backend
  var player = SyanPlayer.mount({
    element: '#player',
    publicId: 'mjakYG627Y',
    launchToken: launchTokenFromBackend,
    cmsBase: 'https://your-cms.com',
    controls: true,
    autoplay: false,

    onReady: function() {
      console.log('Video loaded and ready to play');
    },
    onTimeUpdate: function(data) {
      // data.currentTime, data.duration
      updateProgressBar(data.currentTime / data.duration);
    },
    onEnded: function() {
      markLessonComplete();
    },
    onError: function(err) {
      // err.code, err.message
      showErrorMessage(err.message);
    }
  });

  // Player controls
  player.play();
  player.pause();
  player.seek(120);          // seek to 2 minutes
  player.setPlaybackRate(1.5);
  player.enterFullscreen();
  player.getCurrentTime();   // returns seconds
  player.getDuration();      // returns seconds
  player.getState();         // { currentTime, duration, paused, ended, sessionId }
  player.destroy();          // cleanup when leaving page
</script>
```

### Option B: iframe Embed

Simplest integration — just drop an iframe into any page.

```html
<iframe
  src="https://your-cms.com/api/integrations/embed/mjakYG627Y?launchToken=SIGNED_TOKEN"
  allow="autoplay; fullscreen; encrypted-media"
  allowfullscreen
  style="width:100%; height:450px; border:none;"
></iframe>
```

The embed page automatically mints the token and redirects to the CMS player. The parent page can listen for player events via postMessage:

```javascript
window.addEventListener('message', function(event) {
  if (event.data.type === 'syan.player.ready') {
    console.log('Player is ready');
  }
  if (event.data.type === 'syan.player.error') {
    console.error('Player error:', event.data.data);
  }
});
```

### Option C: React Component

For React-based LMS frontends.

```tsx
import SyanVideoPlayer from './components/SyanVideoPlayer';

function LessonPage({ videoId, launchToken }) {
  return (
    <SyanVideoPlayer
      publicId={videoId}
      launchToken={launchToken}
      cmsBase="https://your-cms.com"
      controls
      autoplay={false}
      style={{ width: '100%', height: '450px' }}
      onReady={() => console.log('Ready')}
      onEnded={() => markLessonComplete()}
      onError={(e) => console.error(e.code, e.message)}
      onTimeUpdate={({ currentTime, duration }) => {
        updateProgress(currentTime / duration * 100);
      }}
    />
  );
}
```

---

## LMS Backend: Signing Launch Tokens

### Node.js

```javascript
const crypto = require('crypto');

const MASTER_SECRET = process.env.INTEGRATION_MASTER_SECRET;
const CLIENT_KEY = process.env.CMS_CLIENT_KEY;

function createLaunchToken(studentId, videoPublicId) {
  const payload = {
    iss: CLIENT_KEY,
    aud: 'cms-player',
    sub: studentId,
    publicId: videoPublicId,
    exp: Math.floor(Date.now() / 1000) + 540,  // 9 minutes
    iat: Math.floor(Date.now() / 1000),
    jti: crypto.randomUUID(),
  };

  const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', MASTER_SECRET).update(b64).digest('hex');
  return b64 + '.' + sig;
}

// Express route example
app.get('/api/lesson/:lessonId/video-token', requireStudentAuth, (req, res) => {
  const videoId = getVideoIdForLesson(req.params.lessonId);
  const token = createLaunchToken(req.user.id, videoId);
  res.json({ launchToken: token, publicId: videoId });
});
```

### Python

```python
import json, time, uuid, hmac, hashlib, base64

MASTER_SECRET = os.environ['INTEGRATION_MASTER_SECRET']
CLIENT_KEY = os.environ['CMS_CLIENT_KEY']

def create_launch_token(student_id, video_public_id):
    payload = {
        'iss': CLIENT_KEY,
        'aud': 'cms-player',
        'sub': student_id,
        'publicId': video_public_id,
        'exp': int(time.time()) + 540,
        'iat': int(time.time()),
        'jti': str(uuid.uuid4()),
    }

    b64 = base64.urlsafe_b64encode(
        json.dumps(payload).encode()
    ).decode().rstrip('=')

    sig = hmac.new(
        MASTER_SECRET.encode(),
        b64.encode(),
        hashlib.sha256
    ).hexdigest()

    return f'{b64}.{sig}'
```

### PHP

```php
function createLaunchToken($studentId, $videoPublicId) {
    $masterSecret = getenv('INTEGRATION_MASTER_SECRET');
    $clientKey = getenv('CMS_CLIENT_KEY');

    $payload = json_encode([
        'iss' => $clientKey,
        'aud' => 'cms-player',
        'sub' => $studentId,
        'publicId' => $videoPublicId,
        'exp' => time() + 540,
        'iat' => time(),
        'jti' => bin2hex(random_bytes(16)),
    ]);

    $b64 = rtrim(strtr(base64_encode($payload), '+/', '-_'), '=');
    $sig = hash_hmac('sha256', $b64, $masterSecret);

    return $b64 . '.' . $sig;
}
```

---

## Launch Token Payload Reference

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `iss` | string | Yes | Your `clientKey` from the CMS admin panel |
| `aud` | string | Yes | Must be exactly `"cms-player"` |
| `sub` | string | Yes | Student/user ID in your system |
| `publicId` | string | Yes | Video public ID from the CMS |
| `exp` | number | Yes | Expiry time (unix seconds). Max 600s from now. Recommended: now + 540. |
| `iat` | number | Yes | Issued-at time (unix seconds) |
| `jti` | string | Yes | Unique token ID (use UUID v4) |
| `courseId` | string | No | Course identifier (for analytics grouping) |
| `lessonId` | string | No | Lesson identifier (for analytics grouping) |
| `name` | string | No | Student display name (for admin session view) |
| `email` | string | No | Student email (for admin session view) |
| `origin` | string | No | Embedding page origin (for origin validation) |
| `startAt` | number | No | Start playback at this position (seconds) |
| `permissions` | object | No | Override player permissions (see below) |

### Optional Permissions Override

```json
{
  "permissions": {
    "allowSeek": false,
    "allowPlaybackRate": false,
    "allowFullscreen": true,
    "showControls": true,
    "autoplay": false,
    "completionThreshold": 95
  }
}
```

Note: `maxConcurrentSessions`, `watermarkEnabled`, and `bannerEnabled` are server-authoritative and cannot be overridden via launch token.

---

## API Endpoints Reference

### Player Endpoints (No Auth Required — Token-Based)

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/integrations/player/:publicId/mint` | Exchange launch token for embed token |
| POST | `/api/integrations/player/:publicId/refresh` | Refresh expiring embed token |
| POST | `/api/integrations/player/:publicId/ping` | Report playback progress |
| POST | `/api/integrations/player/:publicId/events` | Send player events |
| POST | `/api/integrations/player/:publicId/complete` | Mark video as completed |
| GET | `/api/integrations/videos/:publicId` | Get video metadata (requires token) |
| GET | `/api/integrations/player/:publicId/config` | Get player config for session |
| GET | `/api/integrations/embed/:publicId` | Rendered embed page (iframe src) |

### Admin Endpoints (Session Auth Required)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/admin/integrations/clients` | List all integration clients |
| POST | `/api/admin/integrations/clients` | Create new client |
| GET | `/api/admin/integrations/clients/:id` | Get client details |
| PATCH | `/api/admin/integrations/clients/:id` | Update client |
| DELETE | `/api/admin/integrations/clients/:id` | Delete client |
| POST | `/api/admin/integrations/clients/:id/rotate-secret` | Rotate client secret |
| GET | `/api/admin/integrations/logs` | Query launch logs |
| GET | `/api/admin/integrations/sessions` | Query playback sessions |
| POST | `/api/admin/integrations/sessions/:id/revoke` | Revoke active session |
| GET | `/api/admin/integrations/sessions/:id/events` | Get session events |
| POST | `/api/admin/integrations/test-token` | Generate test launch token |

---

## Admin Panel Guide

### Creating an Integration Client

1. Log in to the CMS admin panel
2. Click **Integrations** in the sidebar
3. Click **Create Client**
4. Fill in:
   - **Name**: Human-readable name (e.g. "Acme LMS Production")
   - **Slug**: URL-safe identifier (e.g. "acme-lms")
   - **Allowed Origins**: Comma-separated origins that can embed videos (e.g. "https://acme-lms.com")
   - **Video Access Mode**: "All Videos" or "Selected Videos Only"
5. Click **Create**
6. **Copy the secret immediately** — it will never be shown again

### Monitoring Sessions

1. Go to **Integrations** → **Sessions** tab
2. Filter by status (active/ended/revoked), video, or user
3. See watch time, completion %, last ping time
4. Revoke active sessions if needed

### Viewing Launch Logs

1. Go to **Integrations** → **Launch Logs** tab
2. Filter by status (success/failed/denied)
3. See all token verification attempts with failure reasons

### Testing Integration

1. Go to **Integrations** → **Docs & Test** tab
2. Select a client, enter a video public ID and test user ID
3. Click **Generate Test Token**
4. Copy the token and use it with the SDK or iframe to test

---

## Security Model

| Layer | Protection |
|-------|-----------|
| **HMAC Signing** | Launch tokens are signed with INTEGRATION_MASTER_SECRET. Tampering is detected. |
| **Short TTL** | Launch tokens expire in max 10 minutes (recommended: 9 min). |
| **Audience Check** | Token `aud` must be `"cms-player"`. Prevents cross-system token reuse. |
| **Client Validation** | Client must be active. Disabled clients are rejected. |
| **Origin Allowlist** | Optional strict origin checking per client. |
| **Video Access Control** | Clients can be limited to specific videos only. |
| **Embed Token** | Short-lived JWT (default 5 min). Auto-refreshed by SDK. |
| **Session Tracking** | Every playback is logged with user, time, progress, events. |
| **HLS Pipeline** | Once minted, videos play through the existing 3-layer secure HLS pipeline (origin hidden, per-chunk signed, sliding window). |

---

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `INTEGRATION_MASTER_SECRET` | Yes (production) | Auto-generated in dev | Shared secret for HMAC signing. Must be the same in CMS and all LMS backends. |
| `CMS_PUBLIC_BASE_URL` | No | Derived from request | Public-facing URL of the CMS (e.g. `https://cms.example.com`). Used in manifest URLs. |
| `EMBED_TOKEN_TTL_SECONDS` | No | 300 | How long embed tokens last before needing refresh. |

---

## Error Codes

| Code | HTTP | Meaning |
|------|------|---------|
| `VALIDATION_ERROR` | 400 | Missing or invalid fields in request |
| `INVALID_LAUNCH_TOKEN` | 401 | Token format bad, signature invalid, or not decodable |
| `LAUNCH_TOKEN_EXPIRED` | 400 | Token `exp` is in the past |
| `INTEGRATION_CLIENT_NOT_FOUND` | 404 | `iss` doesn't match any client key or slug |
| `INTEGRATION_CLIENT_DISABLED` | 403 | Client exists but is disabled |
| `LAUNCH_TOKEN_VIDEO_MISMATCH` | 403 | Token `publicId` doesn't match the URL |
| `ORIGIN_NOT_ALLOWED` | 403 | Request origin not in client's allowed list |
| `VIDEO_NOT_FOUND` | 404 | Video doesn't exist or is unavailable |
| `VIDEO_NOT_ALLOWED` | 403 | Client doesn't have access to this video |
| `INTEGRATION_SESSION_NOT_FOUND` | 404 | Session ID not found or already ended |
| `EMBED_TOKEN_INVALID` | 401 | Embed token is invalid or expired |
| `INTERNAL_ERROR` | 500 | Server-side error |

---

## Typical Integration Timeline

| Day | Task |
|-----|------|
| Day 1 | CMS admin creates integration client, shares credentials with LMS dev |
| Day 1 | LMS dev adds token signing to their backend (see code examples above) |
| Day 2 | LMS dev adds SDK/iframe to their lesson pages |
| Day 2 | Test with the admin test-token generator |
| Day 3 | Go live. Monitor via Integrations → Sessions and Launch Logs |
