# LMS Integration Setup Guide

> **Who this is for:** CMS administrators and LMS developers connecting an external Learning Management System (Moodle, Teachable, custom LMS, etc.) to this Secure Video CMS.

---

## Table of Contents

1. [How It Works — Big Picture](#1-how-it-works--big-picture)
2. [Step 1 — Set Environment Variables on the CMS](#2-step-1--set-environment-variables-on-the-cms)
3. [Step 2 — Create an Integration Client in the CMS Admin Panel](#3-step-2--create-an-integration-client-in-the-cms-admin-panel)
4. [Step 3 — Share Credentials with Your LMS Developer](#4-step-3--share-credentials-with-your-lms-developer)
5. [Step 4 — LMS Backend Signs a Launch Token](#5-step-4--lms-backend-signs-a-launch-token)
6. [Step 5 — Embed the Video in Your LMS Page](#6-step-5--embed-the-video-in-your-lms-page)
   - [Option A — Iframe + postMessage (recommended)](#option-a--iframe--postmessage-recommended)
   - [Option B — JavaScript SDK](#option-b--javascript-sdk)
7. [Full API Reference](#7-full-api-reference)
8. [Player Events & Progress Tracking](#8-player-events--progress-tracking)
9. [Admin Panel — Viewing Logs & Sessions](#9-admin-panel--viewing-logs--sessions)
10. [Error Code Reference](#10-error-code-reference)
11. [Troubleshooting Checklist](#11-troubleshooting-checklist)

---

## 1. How It Works — Big Picture

```
┌─────────────────────────────────────────────────────────────────────────┐
│  YOUR LMS BACKEND (server-side)                                         │
│                                                                         │
│  1. Student opens a lesson page                                         │
│  2. Backend signs a short-lived Launch Token using INTEGRATION_MASTER_  │
│     SECRET (never exposed to the browser)                               │
│  3. Token is injected into the lesson page HTML                         │
└───────────────────────────┬─────────────────────────────────────────────┘
                            │  token passed to frontend JS
                            ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  STUDENT'S BROWSER                                                      │
│                                                                         │
│  4. LMS frontend renders an <iframe src="https://cms.com/embed/VIDEO">  │
│  5. Once iframe loads, frontend sends the token via postMessage         │
│     OR uses the JavaScript SDK which calls /mint directly               │
└───────────────────────────┬─────────────────────────────────────────────┘
                            │  POST /api/integrations/player/:publicId/mint
                            ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  SECURE VIDEO CMS                                                       │
│                                                                         │
│  6. CMS verifies the HMAC signature on the launch token                 │
│  7. Checks: client active? video available? video allowed for client?   │
│  8. Creates a playback session, mints a short-lived Embed JWT           │
│  9. Returns: embedToken, manifestUrl, integrationSessionId              │
│  10. Player pings /ping every 10s — CMS tracks watch time & progress   │
│  11. Token auto-refreshed 30s before expiry — no interruption          │
└─────────────────────────────────────────────────────────────────────────┘
```

**Key security properties:**
- The `INTEGRATION_MASTER_SECRET` **never leaves the server**. The browser only ever sees the signed token, not the secret.
- Launch tokens are single-use (replay-blocked via `jti`) and expire in at most **600 seconds**.
- The video manifest URL is behind a signed JWT; HLS segments are AES-128 encrypted.
- The iframe blocks direct top-level access — it only works inside an `<iframe>`.

---

## 2. Step 1 — Set Environment Variables on the CMS

Before creating any integration, two environment variables **must** be set on the CMS server.

### `INTEGRATION_MASTER_SECRET`

This is the secret your LMS backend uses to sign all launch tokens. It must be a long random string (minimum 32 characters).

**Generate one:**
```bash
# Node.js
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"

# OpenSSL
openssl rand -hex 48
```

Set it in your deployment environment (Railway, Replit Secrets, etc.) under the key `INTEGRATION_MASTER_SECRET`.

> **Warning:** If this secret changes, all previously issued launch tokens become invalid. Your LMS developer must update their copy immediately.

### `ALLOWED_LMS_ORIGINS`

A comma-separated list of the **exact origins** (protocol + domain + port) where your LMS frontend runs. The CMS will reject postMessage tokens from any origin not on this list.

**Example:**
```
ALLOWED_LMS_ORIGINS=https://learn.yourschool.com,https://lms.yourdomain.com
```

- Include `https://` — no trailing slash.
- If your LMS runs on a non-standard port, include it: `https://lms.local:3000`.
- For local development only: `http://localhost:3000` is acceptable.

---

## 3. Step 2 — Create an Integration Client in the CMS Admin Panel

Each LMS platform you connect is called an **Integration Client**. You create one per LMS (or per tenant if you run multiple LMS instances).

**Steps:**

1. Log into the CMS Admin Panel.
2. Go to **Integrations** in the left sidebar.
3. Click **New Client**.
4. Fill in the form:

| Field | What to Enter | Example |
|---|---|---|
| **Name** | Friendly name for this LMS | `Moodle Production` |
| **Slug** | URL-safe unique ID (lowercase, hyphens) | `moodle-prod` |
| **Description** | Optional notes | `Main student LMS` |
| **Allowed Origins** | Comma-separated frontend origins | `https://lms.myschool.com` |
| **Video Access Mode** | `All videos` or `Selected videos only` | `All videos` |
| **Status** | Leave as `Active` | `Active` |

5. Click **Create Client**.
6. You will be shown the **Client Key** (`syan_ck_...`). Copy this — you need it in Step 3.

> The Client Key is used as the `iss` (issuer) field in every launch token your LMS signs.

### Setting Video Access

If you chose **Selected videos only**, you must explicitly grant access to each video:

1. Open the client you just created.
2. Scroll to **Video Access**.
3. Search for videos and click **Add**.

If you chose **All videos**, every video that is marked **Available** in the CMS is accessible.

---

## 4. Step 3 — Share Credentials with Your LMS Developer

Give your LMS developer the following three pieces of information. Share them securely (not by email or chat).

| What | Value | Notes |
|---|---|---|
| **CMS Base URL** | `https://your-cms-domain.com` | No trailing slash |
| **Client Key** | `syan_ck_xxxxxxxxxxxx` | From the admin panel (public identifier) |
| **Integration Master Secret** | `your-master-secret` | The `INTEGRATION_MASTER_SECRET` env var value |

The developer also needs the **`publicId`** of each video they want to embed. You can find this on any video's detail page in the CMS (it looks like `v_abc123xyz`).

---

## 5. Step 4 — LMS Backend Signs a Launch Token

**This code runs on the LMS server, never in the browser.**

### Token Format

```
{base64url_payload}.{hex_hmac_sha256_signature}
```

### Required Payload Fields

| Field | Type | Description |
|---|---|---|
| `iss` | string | Your **Client Key** from Step 2 (`syan_ck_...`) |
| `aud` | string | Must be exactly `"cms-player"` |
| `sub` | string | The student's unique ID in your LMS |
| `publicId` | string | CMS video public ID (e.g. `v_abc123`) |
| `exp` | number | Unix timestamp (seconds) — **1 to 600 seconds from now** |
| `iat` | number | Unix timestamp of when the token was issued (now) |
| `jti` | string | A unique UUID v4 — prevents replay attacks |

### Optional Payload Fields

| Field | Type | Description |
|---|---|---|
| `courseId` | string | Your LMS course ID (stored in CMS analytics) |
| `lessonId` | string | Your LMS lesson/module ID |
| `sessionId` | string | Your LMS session identifier |
| `name` | string | Student's display name (shown in CMS session logs) |
| `email` | string | Student's email (stored in session record) |
| `startAt` | number | Start playback at this position in seconds |
| `origin` | string | The frontend origin (used for strict origin checking) |

### Signing Code Examples

#### Node.js / JavaScript

```javascript
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

function signLaunchToken(clientKey, masterSecret, studentId, publicId, options = {}) {
  const nowSec = Math.floor(Date.now() / 1000);

  const payload = {
    iss: clientKey,               // "syan_ck_xxxxxxxxxxxx"
    aud: "cms-player",
    sub: String(studentId),       // your student's unique ID
    publicId: publicId,           // CMS video public ID e.g. "v_abc123"
    exp: nowSec + 300,            // expires in 5 minutes (max 600s)
    iat: nowSec,
    jti: uuidv4(),                // unique per token — prevents replay

    // optional
    courseId: options.courseId || undefined,
    lessonId: options.lessonId || undefined,
    name: options.studentName || undefined,
    email: options.studentEmail || undefined,
    startAt: options.startAt || undefined,
  };

  // Remove undefined fields
  Object.keys(payload).forEach(k => payload[k] === undefined && delete payload[k]);

  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', masterSecret).update(payloadB64).digest('hex');

  return `${payloadB64}.${sig}`;
}

// Usage:
const token = signLaunchToken(
  'syan_ck_your_client_key',
  process.env.INTEGRATION_MASTER_SECRET,
  'student_user_42',
  'v_abc123xyz',
  { courseId: 'course_101', lessonId: 'lesson_5', studentName: 'Ali Hassan' }
);
```

#### PHP

```php
<?php
function signLaunchToken(string $clientKey, string $masterSecret, string $studentId, string $publicId, array $options = []): string {
    $nowSec = time();

    $payload = array_filter([
        'iss'      => $clientKey,
        'aud'      => 'cms-player',
        'sub'      => (string)$studentId,
        'publicId' => $publicId,
        'exp'      => $nowSec + 300,
        'iat'      => $nowSec,
        'jti'      => sprintf('%04x%04x-%04x-%04x-%04x-%04x%04x%04x',
                       mt_rand(0,0xffff), mt_rand(0,0xffff), mt_rand(0,0xffff),
                       mt_rand(0,0x0fff)|0x4000, mt_rand(0,0x3fff)|0x8000,
                       mt_rand(0,0xffff), mt_rand(0,0xffff), mt_rand(0,0xffff)),
        'courseId' => $options['courseId'] ?? null,
        'lessonId' => $options['lessonId'] ?? null,
        'name'     => $options['studentName'] ?? null,
        'email'    => $options['studentEmail'] ?? null,
    ], fn($v) => $v !== null);

    $payloadB64 = rtrim(strtr(base64_encode(json_encode($payload)), '+/', '-_'), '=');
    $sig = hash_hmac('sha256', $payloadB64, $masterSecret);

    return "$payloadB64.$sig";
}

// Usage:
$token = signLaunchToken(
    'syan_ck_your_client_key',
    getenv('INTEGRATION_MASTER_SECRET'),
    'student_42',
    'v_abc123xyz',
    ['courseId' => 'course_101', 'studentName' => 'Ali Hassan']
);
```

#### Python

```python
import hmac
import hashlib
import json
import time
import uuid
import base64

def sign_launch_token(client_key: str, master_secret: str, student_id: str, public_id: str, **options) -> str:
    now_sec = int(time.time())

    payload = {
        "iss": client_key,
        "aud": "cms-player",
        "sub": str(student_id),
        "publicId": public_id,
        "exp": now_sec + 300,
        "iat": now_sec,
        "jti": str(uuid.uuid4()),
    }

    # Optional fields
    for key in ("courseId", "lessonId", "name", "email", "startAt"):
        if key in options and options[key] is not None:
            payload[key] = options[key]

    payload_json = json.dumps(payload, separators=(',', ':')).encode('utf-8')
    payload_b64 = base64.urlsafe_b64encode(payload_json).rstrip(b'=').decode('utf-8')
    sig = hmac.new(master_secret.encode('utf-8'), payload_b64.encode('utf-8'), hashlib.sha256).hexdigest()

    return f"{payload_b64}.{sig}"

# Usage:
import os
token = sign_launch_token(
    client_key='syan_ck_your_client_key',
    master_secret=os.environ['INTEGRATION_MASTER_SECRET'],
    student_id='student_42',
    public_id='v_abc123xyz',
    courseId='course_101',
    name='Ali Hassan'
)
```

### Important Rules for Launch Tokens

- **Generate a new token per page load** — do not cache and reuse tokens across students or sessions.
- **`exp` must be 1–600 seconds from now.** Tokens expiring in more than 600 seconds are rejected.
- **`jti` must be a fresh UUID every time.** The CMS blocks re-use of the same `jti`.
- **Keep `INTEGRATION_MASTER_SECRET` server-side only.** Never include it in frontend JavaScript or HTML.
- **Match `publicId` exactly.** The URL and the token payload must reference the same video.

---

## 6. Step 5 — Embed the Video in Your LMS Page

### Option A — Iframe + postMessage (recommended)

This is the standard approach for LMS platforms with server-side templating (Moodle, WordPress, custom PHP/Python).

#### HTML (your LMS lesson page)

```html
<!-- 1. The iframe — token is NOT in the URL -->
<iframe
  id="syan-player"
  src="https://your-cms-domain.com/embed/v_abc123xyz"
  width="100%"
  height="450"
  frameborder="0"
  allowfullscreen
  allow="autoplay; fullscreen"
  style="border:none; background:#000;"
></iframe>

<!-- 2. The launch token injected by your server -->
<script>
  // This token was generated server-side and printed into the page
  var LAUNCH_TOKEN = "{{ launch_token }}";   // server-side template variable
  var CMS_ORIGIN   = "https://your-cms-domain.com";
  var iframe = document.getElementById("syan-player");

  function sendToken() {
    iframe.contentWindow.postMessage(
      { type: "LMS_LAUNCH_TOKEN", token: LAUNCH_TOKEN },
      CMS_ORIGIN   // always specify the exact target origin — never use "*"
    );
  }

  // Send on load, then retry every second for 10 seconds
  iframe.addEventListener("load", function () {
    sendToken();
    var attempts = 0;
    var retry = setInterval(function () {
      attempts++;
      sendToken();
      if (attempts >= 10) clearInterval(retry);
    }, 1000);
  });
</script>
```

> **Why retry?** The player initialises asynchronously. Sending the token once on `iframe.onload` can sometimes miss it if the React app is still mounting. The 1-second retry loop (capped at 10 attempts) ensures delivery without duplicating the session.

#### Listening for events from the player (optional)

The player sends back postMessage events so your LMS can react (e.g. mark a lesson complete):

```javascript
window.addEventListener("message", function (event) {
  if (event.origin !== "https://your-cms-domain.com") return;

  var msg = event.data;
  if (!msg || !msg.type) return;

  if (msg.type === "syan.player.ended") {
    console.log("Video finished — mark lesson complete");
    markLessonComplete(msg.data);
  }

  if (msg.type === "syan.player.timeupdate") {
    // msg.data = { currentTime, duration }
  }
});
```

**Events emitted by the player:**

| `msg.type` | When | `msg.data` |
|---|---|---|
| `syan.player.ready` | Player is loaded and ready | `{}` |
| `syan.player.play` | Playback started | `{ currentTime }` |
| `syan.player.pause` | Playback paused | `{ currentTime }` |
| `syan.player.timeupdate` | Every ~250ms during playback | `{ currentTime, duration }` |
| `syan.player.seek` | User seeked to new position | `{ currentTime }` |
| `syan.player.ended` | Video reached the end | `{ currentTime }` |
| `syan.player.error` | Playback error | `{ code, message }` |

#### Controlling the player from your LMS (optional)

Your LMS page can also **send commands** to the player via postMessage after it has loaded:

```javascript
var iframe = document.getElementById("syan-player");

// Play
iframe.contentWindow.postMessage({ type: "syan.player.play" }, CMS_ORIGIN);

// Pause
iframe.contentWindow.postMessage({ type: "syan.player.pause" }, CMS_ORIGIN);

// Seek to 120 seconds
iframe.contentWindow.postMessage({ type: "syan.player.seek", time: 120 }, CMS_ORIGIN);

// Set playback speed
iframe.contentWindow.postMessage({ type: "syan.player.setRate", rate: 1.5 }, CMS_ORIGIN);
```

---

### Option B — JavaScript SDK

Use the SDK when you are building a React/Vue/Angular frontend and want full programmatic control, or when you need to embed the player without an `<iframe>`.

#### Load the SDK

```html
<script src="https://your-cms-domain.com/sdk/player.js"></script>
```

Or import it in a bundler project (if hosted locally):
```javascript
import SyanPlayer from 'https://your-cms-domain.com/sdk/player.js';
```

#### Mount the Player

```html
<div id="video-container" style="width:100%; aspect-ratio:16/9;"></div>

<script>
  // Token generated server-side and passed into the page
  var launchToken = "{{ launch_token }}";

  var player = SyanPlayer.mount({
    element:     "#video-container",      // CSS selector or DOM element
    publicId:    "v_abc123xyz",           // CMS video public ID
    launchToken: launchToken,             // signed token from your LMS backend
    cmsBase:     "https://your-cms-domain.com",

    // Optional playback settings
    autoplay:    false,
    controls:    true,
    muted:       false,
    startAt:     0,                       // start at N seconds
    poster:      "https://...",           // custom thumbnail URL

    // Callback functions
    onReady:          function ()       { console.log("Player ready"); },
    onPlay:           function ()       { console.log("Playing"); },
    onPause:          function ()       { console.log("Paused"); },
    onEnded:          function ()       { console.log("Video ended — mark complete"); },
    onTimeUpdate:     function (d)      { /* d = { currentTime, duration } */ },
    onSeek:           function (d)      { /* d = { currentTime } */ },
    onError:          function (err)    { console.error("Player error:", err.code, err.message); },
    onSessionExpired: function ()       { console.warn("Session expired"); },
  });

  // You can also call player methods later:
  // player.play()
  // player.pause()
  // player.seek(120)
  // player.setPlaybackRate(1.5)
  // player.getCurrentTime()
  // player.getDuration()
  // player.getState()   // returns { currentTime, duration, paused, ended, sessionId }
  // player.enterFullscreen()
  // player.destroy()    // call when navigating away to clean up timers
</script>
```

#### SDK Internal Behaviour

When you call `SyanPlayer.mount(...)`:

1. Calls `POST /api/integrations/player/:publicId/mint` with the `launchToken`.
2. Receives `embedToken`, `integrationSessionId`, `manifestUrl`.
3. Loads `hls.js` from CDN if needed.
4. Starts HLS playback.
5. Sets a `setInterval` every **10 seconds** to call `/ping` — tracking watch time and position.
6. Schedules a token refresh **30 seconds before the embed token expires** (default: 5 minute TTL).

---

## 7. Full API Reference

All endpoints are on the CMS domain: `https://your-cms-domain.com`

---

### `POST /api/integrations/player/:publicId/mint`

Exchanges a signed launch token for a playback session and embed token.

**URL parameter:** `:publicId` — the CMS video public ID.

**Request body:**
```json
{
  "launchToken": "eyJpc3MiOi....a1b2c3d4e5",
  "context": {
    "courseId": "course_101",
    "lessonId": "lesson_5",
    "origin": "https://lms.myschool.com"
  }
}
```

| Field | Required | Description |
|---|---|---|
| `launchToken` | Yes | Signed HMAC token from your LMS backend |
| `context.courseId` | No | Overrides courseId if not already in token payload |
| `context.lessonId` | No | Overrides lessonId if not already in token payload |
| `context.origin` | No | Frontend origin for strict-mode validation |

**Success response `200`:**
```json
{
  "ok": true,
  "integrationSessionId": "uuid-session-id",
  "embedToken": "eyJhbGciOiJIUzI1NiJ9...",
  "expiresIn": 300,
  "manifestUrl": "https://your-cms.com/api/player/v_abc123/manifest?token=...",
  "refreshUrl": "/api/integrations/player/v_abc123/refresh",
  "pingUrl":    "/api/integrations/player/v_abc123/ping",
  "eventUrl":   "/api/integrations/player/v_abc123/events",
  "metadata": {
    "title": "Introduction to Biology",
    "durationSeconds": 1842,
    "posterUrl": "https://...",
    "publicId": "v_abc123xyz"
  },
  "playerConfig": {
    "allowPlay": true,
    "allowPause": true,
    "allowSeek": true,
    "allowPlaybackRate": true,
    "allowedRates": [0.75, 1, 1.25, 1.5, 2],
    "allowFullscreen": true,
    "showControls": true,
    "autoplay": false,
    "startAt": 0,
    "completionThreshold": 80,
    "watermarkEnabled": false,
    "maxConcurrentSessions": 1
  }
}
```

**Error responses:**

| HTTP | `error.code` | Cause |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Missing required fields in payload |
| 400 | `LAUNCH_TOKEN_EXPIRED` | Token's `exp` has passed |
| 400 | `VALIDATION_ERROR` | Token `exp` is more than 600s in the future |
| 401 | `INVALID_LAUNCH_TOKEN` | HMAC signature mismatch |
| 403 | `INTEGRATION_CLIENT_DISABLED` | Client is set to inactive in CMS |
| 403 | `LAUNCH_TOKEN_VIDEO_MISMATCH` | Token `publicId` ≠ URL `:publicId` |
| 403 | `VIDEO_NOT_ALLOWED` | Video not in client's allowed video list |
| 403 | `ORIGIN_NOT_ALLOWED` | Request origin not in client's allowed origins (strict mode) |
| 404 | `INTEGRATION_CLIENT_NOT_FOUND` | `iss` does not match any client key or slug |
| 404 | `VIDEO_NOT_FOUND` | Video not found or not marked Available |

---

### `POST /api/integrations/player/:publicId/refresh`

Refresh an expiring embed token. Call this ~30 seconds before `expiresIn` runs out.

**Request body:**
```json
{
  "integrationSessionId": "uuid-session-id",
  "embedToken": "current-embed-jwt"
}
```

**Success response `200`:**
```json
{
  "ok": true,
  "embedToken": "new-embed-jwt",
  "expiresIn": 300,
  "manifestUrl": "https://..."
}
```

The old token is revoked. Use the new `embedToken` and update your `manifestUrl`.

---

### `POST /api/integrations/player/:publicId/ping`

Heartbeat — call every 10 seconds during playback. The CMS uses this to calculate watch time and completion percentage.

**Request body:**
```json
{
  "integrationSessionId": "uuid-session-id",
  "currentTime": 142.7,
  "duration": 1842.0,
  "paused": false,
  "ended": false,
  "playbackRate": 1.0
}
```

| Field | Type | Description |
|---|---|---|
| `integrationSessionId` | string | From `/mint` response |
| `currentTime` | number | Current playback position in seconds |
| `duration` | number | Total video duration in seconds |
| `paused` | boolean | Whether playback is paused |
| `ended` | boolean | Whether video has ended (triggers session close) |
| `playbackRate` | number | Optional — current playback speed |

**Success response `200`:**
```json
{
  "ok": true,
  "sessionState": "active",
  "tokenExpiresIn": 300
}
```

When `ended: true` is sent, the session status is set to `"ended"` in the CMS.

---

### `POST /api/integrations/player/:publicId/events`

Log player events for detailed analytics. Batch multiple events in one call.

**Request body:**
```json
{
  "integrationSessionId": "uuid-session-id",
  "events": [
    { "type": "play",   "time": 0 },
    { "type": "pause",  "time": 45.2 },
    { "type": "seek",   "time": 120.0, "payload": { "from": 45.2 } },
    { "type": "ended",  "time": 1842.0 }
  ]
}
```

**Standard event types:** `play`, `pause`, `seek`, `ended`, `error`, `rate_change`, `fullscreen`

**Success response `200`:**
```json
{ "ok": true, "received": 4 }
```

---

### `POST /api/integrations/player/:publicId/complete`

Explicitly mark a session as completed. Use this if you have your own completion logic.

**Request body:**
```json
{
  "integrationSessionId": "uuid-session-id",
  "completionPercent": 95
}
```

**Success response `200`:** `{ "ok": true }`

---

### `GET /api/integrations/player/:publicId/config`

Fetch resolved player permissions for an active session (useful for custom players).

**Query parameter:** `?integrationSessionId=uuid-session-id`

**Success response `200`:**
```json
{
  "ok": true,
  "playerConfig": { "allowSeek": true, "allowFullscreen": true, ... }
}
```

---

### `GET /api/integrations/videos/:publicId`

Fetch basic video metadata. Requires the embed token in the request header.

**Headers:**
```
Authorization: Bearer <embedToken>
```
or
```
X-Api-Key: <embedToken>
```

**Success response `200`:**
```json
{
  "ok": true,
  "publicId": "v_abc123xyz",
  "title": "Introduction to Biology",
  "description": "...",
  "duration": 1842,
  "posterUrl": "https://..."
}
```

---

## 8. Player Events & Progress Tracking

### How Watch Time Is Calculated

The CMS calculates watch time on the server side from `/ping` calls — it does **not** trust the client to self-report.

For each ping:
- If `paused = false` AND `currentTime > maxPositionSeen`, the difference (up to 10s) is added to `watchedSeconds`.
- This prevents the student from scrubbing to the end to fake completion.
- `completionPercent = (maxPositionReached / duration) × 100`

### Completion Threshold

Each video has a configurable **completion threshold** (default: 80%). The CMS reports this as `playerConfig.completionThreshold` in the `/mint` response.

Your LMS can read `completionPercent` from the session record via the Admin Sessions API to determine if the student has met the threshold.

---

## 9. Admin Panel — Viewing Logs & Sessions

### Launch Logs

**Location:** Admin → Integrations → Launch Logs

Shows every token mint attempt with:
- Student ID, course/lesson ID, IP address, user agent
- Status: `success`, `failed`, `denied`
- Failure reason (see error codes above)
- Resolved permissions that were applied

### Playback Sessions

**Location:** Admin → Integrations → Sessions

Shows active and completed playback sessions with:
- Student name/email (if provided in token)
- Watch time in seconds, max position reached, completion %
- Session status: `active`, `ended`, `revoked`

You can **revoke an active session** from this page — it immediately kills the video stream for that student.

### Admin API for Sessions (for LMS webhook integration)

**List sessions:**
```
GET /api/admin/integrations/sessions
  ?clientId=uuid
  ?lmsUserId=student_42
  ?publicId=v_abc123
  ?status=active|ended|revoked
  ?limit=100&offset=0
```

**List launch logs:**
```
GET /api/admin/integrations/logs
  ?clientId=uuid
  ?status=success|failed|denied
  ?lmsUserId=student_42
```

All admin endpoints require an authenticated CMS admin session (cookie-based, `POST /api/auth/login` first).

---

## 10. Error Code Reference

| Code | HTTP | Meaning | Fix |
|---|---|---|---|
| `INTEGRATION_CLIENT_NOT_FOUND` | 404 | `iss` in token doesn't match any client key or slug | Check `clientKey` in admin panel matches what you're using as `iss` |
| `INTEGRATION_CLIENT_DISABLED` | 403 | Client status is not `active` | Enable the client in Admin → Integrations |
| `INVALID_LAUNCH_TOKEN` | 401 | Token format wrong or HMAC signature doesn't match | Verify `INTEGRATION_MASTER_SECRET` is correct and signing logic matches this guide |
| `LAUNCH_TOKEN_EXPIRED` | 400 | Token `exp` has passed | Generate tokens just-in-time; do not cache them |
| `LAUNCH_TOKEN_VIDEO_MISMATCH` | 403 | Token's `publicId` ≠ URL parameter | Ensure the `publicId` in the token payload matches the one in the URL |
| `VIDEO_NOT_FOUND` | 404 | Video doesn't exist or isn't marked Available | Enable the video in Admin → Videos |
| `VIDEO_NOT_ALLOWED` | 403 | Video not in client's access list | Add video to the client in Admin → Integrations → client → Video Access |
| `ORIGIN_NOT_ALLOWED` | 403 | Request came from an origin not in the allowed list | Add the origin to the client's Allowed Origins, or to `ALLOWED_LMS_ORIGINS` env var |
| `INTEGRATION_SESSION_NOT_FOUND` | 404 | Session ID invalid or session already ended/revoked | Start a new session — call `/mint` again |
| `VALIDATION_ERROR` | 400 | Missing or invalid fields in token payload | Check all required fields (`iss`, `aud`, `sub`, `publicId`, `exp`, `iat`, `jti`) |

---

## 11. Troubleshooting Checklist

### Player shows "Waiting for LMS authorization..." and never loads

- [ ] Is the `ALLOWED_LMS_ORIGINS` env var set on the CMS? Does it include your exact LMS frontend origin (`https://` + domain)?
- [ ] Is your postMessage `targetOrigin` set to the exact CMS origin? (Not `"*"`)
- [ ] Are you calling `postMessage` on the correct `iframe.contentWindow`?
- [ ] Is the iframe actually loaded before you call `postMessage`? Use the `onload` event.
- [ ] Check your browser's DevTools console on the parent page for any CORS or postMessage errors.

### `/mint` returns `401 INVALID_LAUNCH_TOKEN`

- [ ] Is `INTEGRATION_MASTER_SECRET` the same on both the CMS and the LMS server? Copy-paste carefully — no extra spaces.
- [ ] Are you base64url-encoding the JSON payload (no padding `=`), not base64 standard?
- [ ] Are you computing HMAC-SHA256 of the **base64url-encoded string** (not the raw JSON)?

### `/mint` returns `400 LAUNCH_TOKEN_EXPIRED`

- [ ] Are you generating a **new token per page load**? Never cache tokens.
- [ ] Is your LMS server's clock correct? `exp` is compared against server time.
- [ ] Is `exp` set to `now + 300` (or similar)? Keep it under 600 seconds.

### `/mint` returns `403 LAUNCH_TOKEN_VIDEO_MISMATCH`

- [ ] Does the `publicId` in your token payload exactly match the `:publicId` in the URL?
- [ ] Check for leading/trailing spaces in the publicId.

### `/mint` returns `404 VIDEO_NOT_FOUND`

- [ ] Is the video marked **Available** in Admin → Videos?
- [ ] Is the video status **Ready** (not still processing)?

### `/mint` returns `403 VIDEO_NOT_ALLOWED`

- [ ] Did you set Video Access Mode to "Selected videos only"?
- [ ] Has this specific video been added to the client's Video Access list?

### Video plays then stops after 5 minutes

- [ ] Your integration is not refreshing the token. Implement the `/refresh` call ~30 seconds before `expiresIn` runs out.
- [ ] If using the SDK (`SyanPlayer.mount`), this is handled automatically.

### `INTEGRATION_MASTER_SECRET` was changed — all tokens are broken

- [ ] Update the secret in both the CMS environment and on the LMS server.
- [ ] Generate a new secret, set it on both sides at the same time.
- [ ] All existing active sessions will be invalidated — students will need to reload the page to get a new token.

---

*For architecture details, see [`docs/architecture.md`](architecture.md). For a minimal quick-start prompt for your LMS developer, see [`docs/LMS_DEVELOPER_PROMPT.md`](LMS_DEVELOPER_PROMPT.md).*
