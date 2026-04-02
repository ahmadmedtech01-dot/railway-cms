# Secure Video CMS — LMS Integration Guide

**Production CMS URL:** `https://railway-cms-production.up.railway.app`
**Last updated:** April 2026

---

## Table of Contents

1. [How It Works](#1-how-it-works)
2. [CMS Admin Setup](#2-cms-admin-setup)
3. [LMS Environment Variables](#3-lms-environment-variables)
4. [Token Specification (read carefully)](#4-token-specification)
5. [Backend: Generate the Token](#5-backend-generate-the-token)
6. [Frontend: Embed the Player and Send the Token](#6-frontend-embed-the-player-and-send-the-token)
7. [Testing Your Integration](#7-testing-your-integration)
8. [Debugging Error Messages](#8-debugging-error-messages)
9. [Common Mistakes Reference](#9-common-mistakes-reference)
10. [CMS Admin: Adding a New LMS](#10-cms-admin-adding-a-new-lms)

---

## 1. How It Works

The CMS player uses a zero-trust model. It never trusts the URL or the page it is embedded in. Every playback session requires a cryptographically signed token delivered via `postMessage`.

```
┌─────────────────────────────────┐        ┌──────────────────────────────────────┐
│           YOUR LMS              │        │       CMS PLAYER (iframe)            │
│                                 │        │                                      │
│  1. Student opens video page    │        │  3. Player loads, shows              │
│                                 │        │     "Waiting for LMS auth..."        │
│  2. LMS embeds the iframe  ─────┼──────▶ │                                      │
│     (no ?token= in URL)         │        │  5. Player receives postMessage,     │
│                                 │        │     verifies HMAC signature,         │
│  4. LMS backend generates  ─────┼──msg──▶│     mints a secure session           │
│     HMAC token + sends via      │        │                                      │
│     postMessage                 │        │  6. HLS video playback begins        │
│                                 │        │                                      │
│                                 │        │  7. Every 3 min: player pings CMS    │
│                                 │        │     to keep session alive            │
└─────────────────────────────────┘        └──────────────────────────────────────┘
```

**Key points:**
- The token is generated fresh on your backend every time a student opens a video page
- It is delivered to the player via `postMessage` (never in the iframe URL)
- The player uses it once to create a session, then discards it
- Sessions stay alive via automatic heartbeat — no action needed from the LMS after initial auth

---

## 2. CMS Admin Setup

Before any LMS can play videos, the CMS admin must configure two things in Railway environment variables:

### 2a. `LMS_HMAC_SECRET`

A shared secret between the CMS and the LMS. Generate once and set on both sides.

```bash
# Generate a secure random secret (run this once)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Set the output as `LMS_HMAC_SECRET` on Railway.

### 2b. `ALLOWED_LMS_ORIGINS`

A comma-separated list of LMS origins that are allowed to embed the player. No trailing slashes.

```
ALLOWED_LMS_ORIGINS=https://your-lms.com,https://another-lms.yoursite.com
```

**Verify these are applied:**
```
GET https://railway-cms-production.up.railway.app/api/lms/origins
```
Returns a JSON list of all configured origins. If your LMS URL is not in this list, the token will be rejected.

---

## 3. LMS Environment Variables

Set this on your LMS server:

| Variable | Value |
|----------|-------|
| `LMS_HMAC_SECRET` | Same value as `LMS_HMAC_SECRET` on Railway (the CMS) |

The variable name on your LMS can be anything — just make sure your token generation code reads it correctly. The value **must be identical** on both sides.

**Current shared secret (update both sides if you ever rotate it):**
```
a41afc36c3216bc49b9e780ed4004dfa847a3c26446d1a216be6cecf836bf5d6
```

---

## 4. Token Specification

Read this section carefully. The token format is custom — it is NOT a JWT.

### Format

```
{base64url_payload}.{hex_hmac_sha256_signature}
```

Two parts separated by a single dot. No header. No three-part JWT structure.

### Payload Fields

All 6 fields are required. Missing any one will cause rejection.

| Field | Type | Rules |
|-------|------|-------|
| `userId` | string | The logged-in student's unique ID. Any stable unique string. |
| `publicId` | string | The CMS video's Public Video ID, e.g. `"mjakYG627Y"` |
| `exp` | number | Unix timestamp in **seconds**. Must be **1 to 300 seconds** from now. Tokens more than 5 minutes in the future are also rejected. |
| `nonce` | string | A fresh random string for every single request. Never reuse. Use `crypto.randomUUID()`. |
| `aud` | string | Must be exactly `"video-cms"` — no other value works. |
| `origin` | string | Your LMS origin exactly as registered in `ALLOWED_LMS_ORIGINS`. No trailing slash. |

### How the signature is computed

```
1. JSON-stringify the payload (any key order is fine)
2. Base64url-encode the JSON string
3. HMAC-SHA256 the base64url string using the shared secret
4. Hex-encode the HMAC output
5. Token = base64url_payload + "." + hex_signature
```

**Critical:** You sign the base64url-encoded string, NOT the raw JSON.

---

## 5. Backend: Generate the Token

### Node.js / JavaScript

```javascript
const crypto = require('crypto');

const LMS_HMAC_SECRET = process.env.LMS_HMAC_SECRET; // must match CMS
const LMS_ORIGIN = 'https://your-lms.com';           // your registered origin, no trailing slash

function generateCmsLaunchToken(publicId, userId) {
  const payload = {
    userId:   String(userId),
    publicId: String(publicId),
    exp:      Math.floor(Date.now() / 1000) + 240,  // 4 minutes from now (must be ≤ 300s)
    nonce:    crypto.randomUUID(),                   // fresh every time
    aud:      'video-cms',                           // must be exactly this
    origin:   LMS_ORIGIN,                            // must match ALLOWED_LMS_ORIGINS exactly
  };

  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature  = crypto.createHmac('sha256', LMS_HMAC_SECRET)
                           .update(payloadB64)
                           .digest('hex');

  return `${payloadB64}.${signature}`;
}

// Endpoint — called from the LMS frontend
app.post('/api/lms-token', requireAuth, async (req, res) => {
  const { publicId } = req.body; // the CMS video public ID for this page
  const token = generateCmsLaunchToken(publicId, req.user.id);
  res.json({ token });
});
```

### Python

```python
import hmac, hashlib, json, base64, time, uuid, os

LMS_HMAC_SECRET = os.environ['LMS_HMAC_SECRET']
LMS_ORIGIN = 'https://your-lms.com'

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
    payload_b64  = base64.urlsafe_b64encode(payload_json.encode()).rstrip(b'=').decode()

    signature = hmac.new(
        LMS_HMAC_SECRET.encode(),
        payload_b64.encode(),
        hashlib.sha256
    ).hexdigest()

    return f'{payload_b64}.{signature}'
```

### PHP

```php
function generateCmsLaunchToken(string $publicId, string $userId): string {
    $secret = getenv('LMS_HMAC_SECRET');
    $origin = 'https://your-lms.com';

    $payload = json_encode([
        'userId'   => $userId,
        'publicId' => $publicId,
        'exp'      => time() + 240,
        'nonce'    => bin2hex(random_bytes(16)),
        'aud'      => 'video-cms',
        'origin'   => $origin,
    ], JSON_UNESCAPED_SLASHES);

    $payloadB64 = rtrim(strtr(base64_encode($payload), '+/', '-_'), '=');
    $sig        = hash_hmac('sha256', $payloadB64, $secret);

    return "{$payloadB64}.{$sig}";
}
```

---

## 6. Frontend: Embed the Player and Send the Token

### Step 1 — The iframe

```html
<iframe
  id="cms-video-player"
  src="https://railway-cms-production.up.railway.app/embed/VIDEO_PUBLIC_ID"
  width="100%"
  height="500"
  frameborder="0"
  allowfullscreen
  allow="autoplay; fullscreen; encrypted-media"
  referrerpolicy="no-referrer-when-downgrade"
  sandbox="allow-scripts allow-same-origin allow-presentation"
  style="border: none;"
></iframe>
```

**Do NOT put `?token=` in the iframe `src`.** The token is sent separately via postMessage.

### Step 2 — Send the token

After the iframe loads, call your backend to get a fresh token, then send it to the iframe.

```javascript
const CMS_ORIGIN = 'https://railway-cms-production.up.railway.app';

async function initCmsPlayer(iframeId, publicId) {
  const iframe = document.getElementById(iframeId);
  if (!iframe) return;

  // Get a fresh HMAC token from your LMS backend
  const res = await fetch('/api/lms-token', {
    method:      'POST',
    headers:     { 'Content-Type': 'application/json' },
    credentials: 'include',
    body:        JSON.stringify({ publicId }),
  });
  if (!res.ok) { console.error('Token generation failed:', res.status); return; }
  const { token } = await res.json();

  // Send the token to the CMS player iframe
  function sendToken() {
    iframe.contentWindow?.postMessage(
      { type: 'LMS_LAUNCH_TOKEN', token },
      CMS_ORIGIN
    );
  }

  // Send once immediately, then retry every second for 10 seconds.
  // The player ignores duplicates once the session is started.
  sendToken();
  let retries = 0;
  const interval = setInterval(() => {
    if (++retries >= 10) { clearInterval(interval); return; }
    sendToken();
  }, 1000);
}

// Call this after the page loads
document.getElementById('cms-video-player').addEventListener('load', () => {
  initCmsPlayer('cms-video-player', 'mjakYG627Y');
});
```

### React Component (full working example)

```jsx
import { useEffect, useRef } from 'react';

const CMS_ORIGIN = 'https://railway-cms-production.up.railway.app';

export function SecureVideoPlayer({ publicId, courseId }) {
  const iframeRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    let intervalId = null;

    async function authorize() {
      // 1. Get fresh HMAC token from your LMS backend
      let token;
      try {
        const res = await fetch('/api/lms-token', {
          method:      'POST',
          headers:     { 'Content-Type': 'application/json' },
          credentials: 'include',
          body:        JSON.stringify({ publicId, courseId }),
        });
        if (!res.ok || cancelled) return;
        ({ token } = await res.json());
      } catch (err) {
        console.error('CMS token generation failed:', err);
        return;
      }

      // 2. Send token to iframe via postMessage
      function sendToken() {
        iframeRef.current?.contentWindow?.postMessage(
          { type: 'LMS_LAUNCH_TOKEN', token },
          CMS_ORIGIN
        );
      }

      sendToken();
      let retries = 0;
      intervalId = setInterval(() => {
        if (cancelled || ++retries >= 10) { clearInterval(intervalId); return; }
        sendToken();
      }, 1000);
    }

    // Run when iframe loads (handles both first load and re-navigation)
    const iframe = iframeRef.current;
    if (iframe) {
      iframe.addEventListener('load', authorize);
    }

    return () => {
      cancelled = true;
      clearInterval(intervalId);
      iframe?.removeEventListener('load', authorize);
    };
  }, [publicId, courseId]);

  return (
    <iframe
      ref={iframeRef}
      src={`${CMS_ORIGIN}/embed/${publicId}`}
      width="100%"
      height="500"
      frameBorder="0"
      allowFullScreen
      allow="autoplay; fullscreen; encrypted-media"
      referrerPolicy="no-referrer-when-downgrade"
      sandbox="allow-scripts allow-same-origin allow-presentation"
      style={{ border: 'none' }}
    />
  );
}
```

---

## 7. Testing Your Integration

### Test 1 — Verify token generation (terminal)

Run this locally to confirm your backend produces valid tokens that the CMS accepts:

```bash
# Step 1: generate a test token
TOKEN=$(node -e "
const crypto = require('crypto');
const secret = 'a41afc36c3216bc49b9e780ed4004dfa847a3c26446d1a216be6cecf836bf5d6';
const origin = 'https://your-lms.com'; // use your actual registered LMS origin
const payload = {
  userId:   'test-student-1',
  publicId: 'mjakYG627Y',
  exp:      Math.floor(Date.now() / 1000) + 240,
  nonce:    crypto.randomUUID(),
  aud:      'video-cms',
  origin:   origin,
};
const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
const sig = crypto.createHmac('sha256', secret).update(b64).digest('hex');
console.log(b64 + '.' + sig);
")

# Step 2: send to the CMS mint endpoint
curl -s -X POST \
  https://railway-cms-production.up.railway.app/api/player/mjakYG627Y/mint \
  -H 'Content-Type: application/json' \
  -d "{\"lmsLaunchToken\": \"$TOKEN\"}" | jq .
```

**Success response:**
```json
{ "token": "eyJ...", "expiresAt": "2026-...", "tokenId": "..." }
```

**Failure response:** any 4xx with a message explaining what is wrong.

### Test 2 — Verify allowed origins

```bash
curl https://railway-cms-production.up.railway.app/api/lms/origins
```

Your LMS URL must appear in the `origins` array. If not, the CMS admin needs to add it to `ALLOWED_LMS_ORIGINS` on Railway.

### Test 3 — Debug a specific token (CMS admin only)

If you have admin access to the CMS, you can validate any token without needing curl:

```bash
curl -s -X POST \
  https://railway-cms-production.up.railway.app/api/lms/debug-hmac \
  -H 'Content-Type: application/json' \
  -H 'Cookie: <your-admin-session-cookie>' \
  -d '{"token": "PASTE_TOKEN_HERE"}'
```

Returns a detailed breakdown of what passed and what failed in verification.

---

## 8. Debugging Error Messages

### Player shows: "Waiting for LMS authorization..."

The player never received a valid postMessage token.

Checklist:
- [ ] Is your `/api/lms-token` endpoint returning 200? Check your LMS server logs.
- [ ] Is the postMessage being sent? Add `console.log('sending token', token)` before the postMessage.
- [ ] Is the `targetOrigin` exactly `https://railway-cms-production.up.railway.app` (no trailing slash)?
- [ ] Is the message `type` exactly `LMS_LAUNCH_TOKEN` (case sensitive)?
- [ ] Is the iframe fully loaded before postMessage is sent? Add the `load` event listener.

### Player shows: "Unauthorized" or "Invalid token"

Token verification failed on the CMS.

Checklist:
- [ ] Does `LMS_HMAC_SECRET` on your LMS equal `LMS_HMAC_SECRET` on Railway? Check both, they must be byte-for-byte identical.
- [ ] Is your LMS URL in `ALLOWED_LMS_ORIGINS` on Railway? Check via `GET /api/lms/origins`.
- [ ] Does the `origin` field in your payload exactly match one of those URLs (no trailing slash, https not http)?
- [ ] Is `aud` exactly `"video-cms"`?
- [ ] Is `exp` between 1 and 300 seconds from now? (Tokens valid for more than 5 minutes are rejected.)
- [ ] Are you signing the **base64url string**, not the raw JSON?

Run the **Test 1 curl** above. If it succeeds there but fails in the browser, the issue is on the frontend (postMessage format or timing).

### Player shows: "Access Link Expired"

A static embed token (from the CMS Access tab) was used in the iframe URL instead of postMessage. Remove `?token=` from the iframe `src` and use postMessage instead.

### Player shows: "Access Denied" / "Domain not allowed"

The domain-whitelist setting on the CMS video is blocking the LMS origin. The CMS admin must add the LMS hostname to the video's allowed domains in the CMS Access settings, or disable domain whitelisting.

### Player shows: "Session limit reached"

A concurrent session limit is configured on this video. Each student can only have 1 active session at a time. If they open the video in two tabs simultaneously, the second tab will show this error.

### Player shows: "Video not available"

The video's "Available" toggle is off in the CMS, or the video is still being transcoded. The CMS admin must mark the video as available.

### CMS admin preview shows: "Access Link Expired"

This is a different issue — it happens when the admin navigates to the video page on the CMS but the page has been open for more than 24 hours (admin preview tokens last 24 hours). Click the Refresh button in the preview panel or reload the page.

### Video plays then goes blank

This was a known bug (session rotation every 3 minutes flushed the HLS buffer). It has been fixed: the player now uses a heartbeat instead of manifest rotation. Deploy the latest CMS code to Railway to apply the fix.

---

## 9. Common Mistakes Reference

| Mistake | Symptom | Fix |
|---------|---------|-----|
| `type: 'token'` or `type: 'auth'` in postMessage | Player waits forever | Must be exactly `type: 'LMS_LAUNCH_TOKEN'` |
| `postMessage(msg, '*')` | Player may reject (wildcard insecure) | Use exact CMS origin string |
| Trailing slash in postMessage targetOrigin | Token rejected | `https://railway-cms-production.up.railway.app` (no slash) |
| Token in iframe `src` URL (`?token=...`) | Token expires, player breaks after a day | Remove from URL, use postMessage |
| LMS secret value differs from CMS secret | HMAC mismatch, 401 on mint | Copy exact value from Railway env vars |
| `origin` field has trailing slash | Token rejected | `https://your-lms.com` not `https://your-lms.com/` |
| `aud: 'lms'` or any other value | Token rejected | Must be exactly `"video-cms"` |
| `exp` more than 5 minutes from now | Token rejected | Max is 300 seconds (`Date.now()/1000 + 240` is safe) |
| Reusing the same nonce | Token rejected on second use | Generate a new `crypto.randomUUID()` every call |
| Signing raw JSON instead of base64url string | HMAC mismatch | Sign `payloadB64`, not `JSON.stringify(payload)` |
| Python: not stripping base64 padding (`=`) | Signature mismatch | `.rstrip(b'=').decode()` after `b64encode()` |
| LMS origin not in `ALLOWED_LMS_ORIGINS` on Railway | Token rejected | CMS admin adds it to Railway env var, redeploys |
| Sending postMessage before iframe is loaded | Message lost | Use `iframe.addEventListener('load', ...)` |
| Student opens video in two tabs | Second tab shows session limit error | Expected behaviour — one session per student per video |

---

## 10. CMS Admin: Adding a New LMS

When a new LMS system needs to be integrated:

**Step 1 — Get the LMS origin URL**

The exact URL the LMS is deployed at, e.g. `https://new-lms.example.com`. No trailing slash.

**Step 2 — Update `ALLOWED_LMS_ORIGINS` on Railway**

```
ALLOWED_LMS_ORIGINS=https://existing-lms.com,https://new-lms.example.com
```

Add the new URL to the comma-separated list. Redeploy on Railway.

**Step 3 — Share the secret with the LMS developer**

Tell them the value of `LMS_HMAC_SECRET` from Railway. They must set the exact same value on their server.

**Step 4 — Give them this guide**

Share this file. The LMS developer needs Section 4 (token spec) and Section 5 (backend code). Everything else is for debugging.

**Step 5 — Verify**

After they deploy:
```bash
curl https://railway-cms-production.up.railway.app/api/lms/origins
```
Their URL must appear. Then ask them to run the curl test in Section 7 (Test 1) to confirm their token generation is correct before browser testing.

---

## Appendix: Token Verification Flow (what the CMS does)

Understanding this helps debug failures:

```
1. CMS receives postMessage { type: "LMS_LAUNCH_TOKEN", token: "..." }
2. Split token on "." → [payloadB64, sig]
3. base64url-decode payloadB64 → JSON → parse
4. Verify 6 fields present: userId, publicId, exp, nonce, aud, origin
5. Check aud === "video-cms"
6. Check origin is in ALLOWED_LMS_ORIGINS
7. Check exp is in the past? → rejected (expired)
8. Check exp is more than 300s from now? → rejected (too far in future)
9. Recompute HMAC: createHmac('sha256', LMS_HMAC_SECRET).update(payloadB64).digest('hex')
10. Timing-safe compare recomputed sig vs received sig → mismatch = rejected
11. All checks pass → mint secure session → return HLS stream token to player
12. Player begins HLS playback
13. Every 3 minutes: player pings /api/player/:publicId/extend-session (no LMS involvement)
```

If any step fails, the CMS logs a `[lms-verify] FAIL:` line with the specific reason. The CMS admin can see these in Railway logs.
