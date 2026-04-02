# Secure Video CMS — LMS Integration Guide

## Overview

This guide explains how to integrate your LMS with the Secure Video CMS so that
videos play automatically for students without "Access Link Expired" errors.

**CMS Player URL (production):**
```
https://railway-cms-production.up.railway.app
```

**Your LMS Origin (Render):**
```
https://complete-video-hr-syan-exams-test-final-dww7.onrender.com
```

---

## How the Flow Works

```
┌──────────────────────┐          ┌─────────────────────────────────────┐
│       YOUR LMS       │          │        CMS PLAYER (iframe)          │
│                      │          │                                     │
│  1. Student opens    │          │  3. Player loads, shows             │
│     video page       │          │     "Waiting for LMS               │
│                      │          │      authorization..."             │
│  2. LMS embeds the   │──iframe──▶                                     │
│     player iframe    │          │                                     │
│                      │          │  5. Player receives postMessage     │
│  4. LMS generates    │          │     and calls /api/player/          │
│     HMAC token on    │──postMsg─▶     {publicId}/mint                │
│     the server and   │          │                                     │
│     sends via        │          │  6. Player gets session and         │
│     postMessage      │          │     starts video playback           │
└──────────────────────┘          └─────────────────────────────────────┘
```

---

## Step 1 — Environment Variable

Your LMS on Render must have this environment variable:

| Key | Value |
|-----|-------|
| `LMS_HMAC_SECRET` | `a41afc36c3216bc49b9e780ed4004dfa847a3c26446d1a216be6cecf836bf5d6` |

This secret is shared between your LMS and the CMS. Both sides must have the exact same value.

---

## Step 2 — Backend: Generate the HMAC Launch Token

Your LMS backend must generate a fresh HMAC-signed token **every time** a student
opens a video page. Never cache or reuse tokens.

### Token Format

The token is **NOT** a JWT. It is a custom two-part format:

```
{base64url_encoded_payload}.{hex_hmac_sha256_signature}
```

### Required Payload Fields

| Field      | Type   | Description | Example |
|------------|--------|-------------|---------|
| `userId`   | string | Unique ID of the student viewing the video | `"student_42"` |
| `publicId` | string | The video's Public Video ID from CMS | `"mjakYG627Y"` |
| `exp`      | number | Unix timestamp in **seconds** — must be 1–5 minutes from now | `1775154000` |
| `nonce`    | string | Random unique string (UUID recommended) | `"f47ac10b-58cc-4372-a567-0e02b2c3d479"` |
| `aud`      | string | Must be exactly `"video-cms"` | `"video-cms"` |
| `origin`   | string | Your LMS origin — must match exactly what CMS has registered | `"https://complete-video-hr-syan-exams-test-final-dww7.onrender.com"` |

**All 6 fields are required. Missing any field will cause token rejection.**

### Node.js / JavaScript Implementation

```javascript
const crypto = require('crypto');

const LMS_HMAC_SECRET = process.env.LMS_HMAC_SECRET;
const LMS_ORIGIN = 'https://complete-video-hr-syan-exams-test-final-dww7.onrender.com';

function generateCmsLaunchToken(publicId, userId) {
  // 1. Build the payload with all 6 required fields
  const payload = {
    userId:   String(userId),
    publicId: String(publicId),
    exp:      Math.floor(Date.now() / 1000) + 240,   // 4 minutes from now
    nonce:    crypto.randomUUID(),
    aud:      'video-cms',
    origin:   LMS_ORIGIN
  };

  // 2. Base64url-encode the JSON payload
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');

  // 3. HMAC-SHA256 sign the base64url string (NOT the raw JSON)
  const signature = crypto
    .createHmac('sha256', LMS_HMAC_SECRET)
    .update(payloadB64)
    .digest('hex');

  // 4. Return as "payload.signature"
  return `${payloadB64}.${signature}`;
}

// Example usage in your API route:
// app.post('/api/video-courses/:id/lms-token', (req, res) => {
//   const publicId = getVideoPublicId(req.params.id);  // e.g. "mjakYG627Y"
//   const userId = req.user.id;                        // logged-in student ID
//   const token = generateCmsLaunchToken(publicId, userId);
//   res.json({ token, publicId });
// });
```

### Python Implementation

```python
import hmac, hashlib, json, base64, time, uuid, os

LMS_HMAC_SECRET = os.environ['LMS_HMAC_SECRET']
LMS_ORIGIN = 'https://complete-video-hr-syan-exams-test-final-dww7.onrender.com'

def generate_cms_launch_token(public_id, user_id):
    payload = {
        'userId':   str(user_id),
        'publicId': str(public_id),
        'exp':      int(time.time()) + 240,
        'nonce':    str(uuid.uuid4()),
        'aud':      'video-cms',
        'origin':   LMS_ORIGIN,
    }

    payload_json = json.dumps(payload, separators=(',', ':'))
    payload_b64 = base64.urlsafe_b64encode(payload_json.encode()).rstrip(b'=').decode()

    signature = hmac.new(
        LMS_HMAC_SECRET.encode(),
        payload_b64.encode(),
        hashlib.sha256
    ).hexdigest()

    return f'{payload_b64}.{signature}'
```

### PHP Implementation

```php
function generateCmsLaunchToken($publicId, $userId) {
    $secret = $_ENV['LMS_HMAC_SECRET'];
    $origin = 'https://complete-video-hr-syan-exams-test-final-dww7.onrender.com';

    $payload = json_encode([
        'userId'   => (string)$userId,
        'publicId' => (string)$publicId,
        'exp'      => time() + 240,
        'nonce'    => bin2hex(random_bytes(16)),
        'aud'      => 'video-cms',
        'origin'   => $origin,
    ]);

    $payloadB64 = rtrim(strtr(base64_encode($payload), '+/', '-_'), '=');
    $sig = hash_hmac('sha256', $payloadB64, $secret);

    return "{$payloadB64}.{$sig}";
}
```

---

## Step 3 — Frontend: Embed the Player Iframe

In your LMS video page, embed the CMS player as an iframe.

**IMPORTANT: The embed URL must NOT contain any `?token=` parameter.**

```html
<iframe
  id="cms-video-player"
  src="https://railway-cms-production.up.railway.app/embed/VIDEO_PUBLIC_ID_HERE"
  width="100%"
  height="480"
  frameborder="0"
  allowfullscreen
  allow="autoplay; fullscreen; encrypted-media"
  style="border: none;"
></iframe>
```

For the test video, the src would be:
```
https://railway-cms-production.up.railway.app/embed/mjakYG627Y
```

---

## Step 4 — Frontend: Send the Token via postMessage

After the iframe loads, your LMS frontend must:
1. Call your LMS backend to generate a fresh HMAC token
2. Send the token to the iframe using `postMessage`

### The postMessage format must be EXACTLY:

```javascript
{
  type: "LMS_LAUNCH_TOKEN",      // MUST be this exact string
  token: "eyJ1c2VySW...abc123"   // The HMAC token from your backend
}
```

### Complete Frontend Code

```javascript
// This runs on your LMS video page after the page loads

async function initializeSecureVideoPlayer(videoPublicId, iframeElementId) {
  const iframe = document.getElementById(iframeElementId);
  if (!iframe) {
    console.error('Video iframe not found');
    return;
  }

  // 1. Call your LMS backend to get a fresh HMAC launch token
  let tokenData;
  try {
    const response = await fetch(`/api/video-courses/${videoPublicId}/lms-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
    });
    if (!response.ok) throw new Error(`Token generation failed: ${response.status}`);
    tokenData = await response.json();
  } catch (err) {
    console.error('Failed to generate CMS launch token:', err);
    return;
  }

  // 2. Send the token to the CMS player iframe via postMessage
  //    CRITICAL: targetOrigin must EXACTLY match the CMS origin
  const CMS_ORIGIN = 'https://railway-cms-production.up.railway.app';

  function sendToken() {
    iframe.contentWindow.postMessage(
      {
        type: 'LMS_LAUNCH_TOKEN',     // <-- MUST be this exact string
        token: tokenData.token         // <-- The HMAC token string
      },
      CMS_ORIGIN                       // <-- MUST match CMS origin exactly
    );
  }

  // 3. Send immediately if iframe is loaded, otherwise wait for load
  if (iframe.contentDocument?.readyState === 'complete') {
    sendToken();
  } else {
    iframe.addEventListener('load', sendToken);
  }

  // 4. Also re-send periodically in case the player missed the first message
  //    (the player ignores duplicate tokens gracefully)
  let retries = 0;
  const interval = setInterval(() => {
    retries++;
    if (retries > 10) {
      clearInterval(interval);
      return;
    }
    sendToken();
  }, 1000);  // retry every 1 second for 10 seconds
}

// Usage: call this when your video page renders
// initializeSecureVideoPlayer('mjakYG627Y', 'cms-video-player');
```

### React Component Example

```jsx
import { useEffect, useRef } from 'react';

function SecureVideoPlayer({ publicId, courseId }) {
  const iframeRef = useRef(null);
  const CMS_BASE = 'https://railway-cms-production.up.railway.app';

  useEffect(() => {
    let cancelled = false;
    let intervalId;

    async function authorize() {
      // Get fresh HMAC token from your backend
      const res = await fetch(`/api/video-courses/${courseId}/lms-token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
      });
      if (!res.ok || cancelled) return;
      const { token } = await res.json();

      // Send to iframe via postMessage
      const sendToken = () => {
        iframeRef.current?.contentWindow?.postMessage(
          { type: 'LMS_LAUNCH_TOKEN', token },
          CMS_BASE
        );
      };

      // Send immediately + retry for 10 seconds
      sendToken();
      let retries = 0;
      intervalId = setInterval(() => {
        if (++retries > 10) { clearInterval(intervalId); return; }
        sendToken();
      }, 1000);
    }

    // Wait for iframe to load, then authorize
    const iframe = iframeRef.current;
    if (iframe) {
      iframe.addEventListener('load', authorize);
      // Also try immediately in case already loaded
      authorize();
    }

    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [publicId, courseId]);

  return (
    <iframe
      ref={iframeRef}
      src={`${CMS_BASE}/embed/${publicId}`}
      width="100%"
      height="480"
      frameBorder="0"
      allowFullScreen
      allow="autoplay; fullscreen; encrypted-media"
      style={{ border: 'none' }}
    />
  );
}

export default SecureVideoPlayer;
```

---

## Step 5 — LMS Backend: Token Endpoint

Your LMS backend needs an endpoint that generates the HMAC token when called by the frontend:

### Node.js / Express Example

```javascript
const crypto = require('crypto');

// POST /api/video-courses/:id/lms-token
app.post('/api/video-courses/:id/lms-token', requireAuth, async (req, res) => {
  // 1. Get the video record from your LMS database
  const course = await VideoCourse.findById(req.params.id);
  if (!course) return res.status(404).json({ error: 'Video not found' });

  // 2. The publicId is the CMS video's public ID (e.g. "mjakYG627Y")
  //    This should be stored in your LMS database for each video
  const publicId = course.cmsPublicId;  // or however you store it

  // 3. Generate the HMAC launch token
  const token = generateCmsLaunchToken(publicId, req.user.id);

  // 4. Return the token to the frontend
  res.json({ token, publicId });
});
```

---

## Verification Checklist

Before testing, verify ALL of these:

| # | Check | Expected |
|---|-------|----------|
| 1 | `LMS_HMAC_SECRET` env var is set on Render | `a41afc36c...36bf5d6` |
| 2 | CMS `ALLOWED_LMS_ORIGINS` includes your LMS URL | `https://complete-video-hr-syan-exams-test-final-dww7.onrender.com` |
| 3 | Token payload `origin` field matches EXACTLY (no trailing slash) | `https://complete-video-hr-syan-exams-test-final-dww7.onrender.com` |
| 4 | Token payload `aud` field is exactly | `"video-cms"` |
| 5 | Token `exp` is 1–5 minutes in the future (Unix seconds) | e.g. `Math.floor(Date.now()/1000) + 240` |
| 6 | All 6 payload fields are present | `userId, publicId, exp, nonce, aud, origin` |
| 7 | Signature is HMAC-SHA256 of the **base64url** string (not raw JSON) | `crypto.createHmac('sha256', secret).update(payloadB64).digest('hex')` |
| 8 | postMessage `type` is exactly | `"LMS_LAUNCH_TOKEN"` |
| 9 | postMessage `targetOrigin` is exactly | `"https://railway-cms-production.up.railway.app"` |
| 10 | Embed iframe URL has NO `?token=` in it | `https://railway-cms-production.up.railway.app/embed/{publicId}` |

---

## Common Mistakes

### 1. Wrong postMessage type
```javascript
// WRONG - player will ignore this
iframe.contentWindow.postMessage({ type: 'auth_token', token }, origin);
iframe.contentWindow.postMessage({ type: 'token', data: token }, origin);
iframe.contentWindow.postMessage(token, origin);

// CORRECT - player expects this exact format
iframe.contentWindow.postMessage({ type: 'LMS_LAUNCH_TOKEN', token: tokenString }, origin);
```

### 2. Wrong targetOrigin in postMessage
```javascript
// WRONG
iframe.contentWindow.postMessage(msg, '*');                    // wildcard - insecure
iframe.contentWindow.postMessage(msg, 'https://railway-cms.up.railway.app');  // wrong subdomain
iframe.contentWindow.postMessage(msg, 'https://railway-cms-production.up.railway.app/');  // trailing slash

// CORRECT
iframe.contentWindow.postMessage(msg, 'https://railway-cms-production.up.railway.app');
```

### 3. Token in the embed URL
```html
<!-- WRONG - token in URL gets cached and expires -->
<iframe src="https://railway-cms-production.up.railway.app/embed/mjakYG627Y?token=eyJ..."></iframe>

<!-- CORRECT - no token in URL, sent via postMessage -->
<iframe src="https://railway-cms-production.up.railway.app/embed/mjakYG627Y"></iframe>
```

### 4. Signing the wrong data
```javascript
// WRONG - signing the raw JSON
const sig = crypto.createHmac('sha256', secret).update(JSON.stringify(payload)).digest('hex');

// CORRECT - signing the base64url-encoded string
const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
const sig = crypto.createHmac('sha256', secret).update(payloadB64).digest('hex');
```

### 5. Origin field mismatch
```javascript
// WRONG - trailing slash
origin: 'https://complete-video-hr-syan-exams-test-final-dww7.onrender.com/'

// WRONG - http instead of https
origin: 'http://complete-video-hr-syan-exams-test-final-dww7.onrender.com'

// CORRECT - exact match, no trailing slash
origin: 'https://complete-video-hr-syan-exams-test-final-dww7.onrender.com'
```

---

## Debugging

If the player shows "Waiting for LMS authorization...", open the browser console and check:

1. **Is the token being generated?** — Your `/api/video-courses/:id/lms-token` should return 200
2. **Is postMessage being sent?** — Add `console.log('Sending token to CMS')` before the postMessage call
3. **Is the CMS receiving it?** — Open the iframe in a new tab and check its console for errors
4. **Check origins match** — Visit `https://railway-cms-production.up.railway.app/api/lms/origins` and verify your LMS URL is listed

---

## Quick Test

To verify your HMAC token generation is correct, you can test it with curl:

```bash
# Generate a token (replace with your actual values)
TOKEN=$(node -e "
const crypto = require('crypto');
const payload = {
  userId: 'test-user',
  publicId: 'mjakYG627Y',
  exp: Math.floor(Date.now()/1000) + 240,
  nonce: crypto.randomUUID(),
  aud: 'video-cms',
  origin: 'https://complete-video-hr-syan-exams-test-final-dww7.onrender.com'
};
const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
const sig = crypto.createHmac('sha256', 'a41afc36c3216bc49b9e780ed4004dfa847a3c26446d1a216be6cecf836bf5d6').update(b64).digest('hex');
console.log(b64+'.'+sig);
")

# Test the token against the CMS mint endpoint
curl -X POST https://railway-cms-production.up.railway.app/api/player/mjakYG627Y/mint \
  -H "Content-Type: application/json" \
  -d "{\"lmsLaunchToken\": \"$TOKEN\"}"

# Expected response: {"token":"eyJ...","expiresAt":"...","tokenId":"..."}
# If you get this, your token generation is correct!
```
