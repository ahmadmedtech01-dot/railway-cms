# RxCompendium LMS — CMS Video Integration Guide

> **For the rxcompendium developer.** This tells you exactly what to build and where, step by step.

---

## What You Are Building

Your LMS will embed secure videos from the CMS inside lesson pages. The flow is:

```
Student opens lesson page
    → Your backend generates a signed token
    → Your frontend loads the video in an <iframe>
    → The iframe receives the token via postMessage
    → Video plays securely
```

You need to build **two things**:
1. A **server-side function** that signs a launch token
2. A **frontend snippet** that renders the iframe and sends the token

---

## Step 1 — Get These Credentials from the CMS Admin

Ask the CMS admin to give you:

| Item | Looks Like | Where to Put It |
|---|---|---|
| CMS URL | `https://cms.yourdomain.com` | Hardcode in your frontend |
| Client Key | `syan_ck_abc123...` | Use as `iss` in every token |
| Integration Master Secret | long random string | **Server env var only — never in frontend** |
| Video Public ID | `v_xyz789` | One per video you want to embed |

Store the **Integration Master Secret** as an environment variable on your server:
```
SYAN_MASTER_SECRET=the_secret_you_received
```

---

## Step 2 — Server-Side: Sign a Launch Token

Every time a student opens a lesson page, your backend must generate a fresh signed token. Do this **in your server code, never in the browser**.

### Node.js / Express

```javascript
// utils/syanToken.js
const crypto = require('crypto');

function generateVideoToken({ clientKey, masterSecret, studentId, publicId, courseId, lessonId, studentName }) {
  const nowSec = Math.floor(Date.now() / 1000);

  const payload = {
    iss: clientKey,           // "syan_ck_abc123..." — your client key
    aud: "cms-player",        // always this exact string
    sub: String(studentId),   // your student's unique ID
    publicId: publicId,       // CMS video ID e.g. "v_xyz789"
    exp: nowSec + 300,        // expires in 5 minutes
    iat: nowSec,
    jti: crypto.randomUUID(), // unique per token — required
    courseId: courseId || undefined,
    lessonId: lessonId || undefined,
    name: studentName || undefined,
  };

  // Remove undefined fields
  Object.keys(payload).forEach(k => payload[k] === undefined && delete payload[k]);

  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', masterSecret).update(payloadB64).digest('hex');
  return `${payloadB64}.${sig}`;
}

module.exports = { generateVideoToken };
```

### PHP (Laravel / CodeIgniter)

```php
// app/Helpers/SyanTokenHelper.php

function generateVideoToken(array $params): string {
    $nowSec = time();
    $payload = array_filter([
        'iss'      => $params['clientKey'],
        'aud'      => 'cms-player',
        'sub'      => (string) $params['studentId'],
        'publicId' => $params['publicId'],
        'exp'      => $nowSec + 300,
        'iat'      => $nowSec,
        'jti'      => sprintf('%04x%04x-%04x-%04x-%04x-%04x%04x%04x',
                       mt_rand(0,0xffff), mt_rand(0,0xffff), mt_rand(0,0xffff),
                       mt_rand(0,0x0fff)|0x4000, mt_rand(0,0x3fff)|0x8000,
                       mt_rand(0,0xffff), mt_rand(0,0xffff), mt_rand(0,0xffff)),
        'courseId' => $params['courseId'] ?? null,
        'lessonId' => $params['lessonId'] ?? null,
        'name'     => $params['studentName'] ?? null,
    ], fn($v) => $v !== null);

    $payloadB64 = rtrim(strtr(base64_encode(json_encode($payload)), '+/', '-_'), '=');
    $sig = hash_hmac('sha256', $payloadB64, $params['masterSecret']);
    return "$payloadB64.$sig";
}
```

### Python (Django / Flask)

```python
# utils/syan_token.py
import hmac, hashlib, json, time, uuid, base64

def generate_video_token(client_key, master_secret, student_id, public_id, **kwargs):
    now = int(time.time())
    payload = {
        "iss": client_key,
        "aud": "cms-player",
        "sub": str(student_id),
        "publicId": public_id,
        "exp": now + 300,
        "iat": now,
        "jti": str(uuid.uuid4()),
    }
    for key in ("courseId", "lessonId", "name", "email"):
        if kwargs.get(key):
            payload[key] = kwargs[key]

    payload_bytes = json.dumps(payload, separators=(',', ':')).encode()
    payload_b64 = base64.urlsafe_b64encode(payload_bytes).rstrip(b'=').decode()
    sig = hmac.new(master_secret.encode(), payload_b64.encode(), hashlib.sha256).hexdigest()
    return f"{payload_b64}.{sig}"
```

---

## Step 3 — Route / Controller: Pass Token to the Page

In whichever route renders a lesson page, call your token function and pass the result into the template.

### Express example

```javascript
// routes/lessons.js
const { generateVideoToken } = require('../utils/syanToken');

router.get('/course/:courseId/lesson/:lessonId', requireLogin, async (req, res) => {
  const lesson = await Lesson.findById(req.params.lessonId);

  // Generate a fresh token for this student + this video
  const videoToken = generateVideoToken({
    clientKey:    process.env.SYAN_CLIENT_KEY,
    masterSecret: process.env.SYAN_MASTER_SECRET,
    studentId:    req.user.id,
    publicId:     lesson.cmsVideoId,   // stored on your lesson model
    courseId:     req.params.courseId,
    lessonId:     req.params.lessonId,
    studentName:  req.user.name,
  });

  res.render('lesson', {
    lesson,
    videoToken,                         // pass to template
    cmsBase: process.env.SYAN_CMS_URL,  // "https://cms.yourdomain.com"
  });
});
```

### Laravel example

```php
// LessonController.php
public function show(Course $course, Lesson $lesson) {
    $videoToken = generateVideoToken([
        'clientKey'    => config('syan.client_key'),
        'masterSecret' => config('syan.master_secret'),
        'studentId'    => auth()->id(),
        'publicId'     => $lesson->cms_video_id,
        'courseId'     => $course->id,
        'lessonId'     => $lesson->id,
        'studentName'  => auth()->user()->name,
    ]);

    return view('lesson', compact('lesson', 'videoToken'));
}
```

---

## Step 4 — Frontend: Render the iframe and Send the Token

In your lesson page template, add this. Replace the variables with your template syntax.

### HTML template (works in any framework)

```html
<!-- Video player container -->
<div class="video-wrapper" style="position:relative; padding-bottom:56.25%; height:0; overflow:hidden;">
  <iframe
    id="syan-player"
    src="{{ cmsBase }}/embed/{{ lesson.cmsVideoId }}"
    style="position:absolute; top:0; left:0; width:100%; height:100%; border:none; background:#000;"
    allowfullscreen
    allow="autoplay; fullscreen"
  ></iframe>
</div>

<script>
  (function () {
    // These values come from your server-rendered template
    var TOKEN    = "{{ videoToken }}";
    var CMS_BASE = "{{ cmsBase }}";

    var iframe = document.getElementById('syan-player');
    var sent   = false;

    function sendToken() {
      if (sent) return;
      try {
        iframe.contentWindow.postMessage(
          { type: 'LMS_LAUNCH_TOKEN', token: TOKEN },
          CMS_BASE  // always use the exact CMS origin, never "*"
        );
      } catch (e) {}
    }

    // Send on load, retry every 1s for 10s (player mounts asynchronously)
    iframe.addEventListener('load', function () {
      sendToken();
      var attempts = 0;
      var retry = setInterval(function () {
        attempts++;
        if (sent || attempts >= 10) { clearInterval(retry); return; }
        sendToken();
      }, 1000);
    });

    // Listen for events from the player
    window.addEventListener('message', function (event) {
      if (event.origin !== CMS_BASE) return;
      var msg = event.data;
      if (!msg || !msg.type) return;

      if (msg.type === 'syan.player.ready') {
        sent = true; // stop retrying
        console.log('Video player ready');
      }

      if (msg.type === 'syan.player.ended') {
        // Mark lesson complete in your LMS
        markLessonComplete();
      }
    });

    function markLessonComplete() {
      fetch('/api/lessons/{{ lesson.id }}/complete', { method: 'POST' })
        .catch(console.error);
    }
  })();
</script>
```

### React component

```jsx
// components/VideoPlayer.jsx
import { useEffect, useRef } from 'react';

export default function VideoPlayer({ publicId, launchToken, cmsBase, onComplete }) {
  const iframeRef = useRef(null);
  const sentRef   = useRef(false);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;

    function sendToken() {
      if (sentRef.current) return;
      iframe.contentWindow?.postMessage(
        { type: 'LMS_LAUNCH_TOKEN', token: launchToken },
        cmsBase
      );
    }

    function handleLoad() {
      sendToken();
      let attempts = 0;
      const retry = setInterval(() => {
        attempts++;
        if (sentRef.current || attempts >= 10) { clearInterval(retry); return; }
        sendToken();
      }, 1000);
    }

    function handleMessage(event) {
      if (event.origin !== cmsBase) return;
      if (event.data?.type === 'syan.player.ready') sentRef.current = true;
      if (event.data?.type === 'syan.player.ended') onComplete?.();
    }

    iframe.addEventListener('load', handleLoad);
    window.addEventListener('message', handleMessage);
    return () => {
      iframe.removeEventListener('load', handleLoad);
      window.removeEventListener('message', handleMessage);
    };
  }, [publicId, launchToken, cmsBase, onComplete]);

  return (
    <div style={{ position: 'relative', paddingBottom: '56.25%', height: 0 }}>
      <iframe
        ref={iframeRef}
        src={`${cmsBase}/embed/${publicId}`}
        style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', border: 'none', background: '#000' }}
        allowFullScreen
        allow="autoplay; fullscreen"
      />
    </div>
  );
}
```

Usage in a lesson page:
```jsx
// pages/Lesson.jsx
export default function Lesson({ lesson, videoToken }) {
  return (
    <div>
      <h1>{lesson.title}</h1>
      <VideoPlayer
        publicId={lesson.cmsVideoId}
        launchToken={videoToken}           // from server
        cmsBase={import.meta.env.VITE_CMS_BASE}
        onComplete={() => markLessonDone(lesson.id)}
      />
    </div>
  );
}
```

---

## Step 5 — Database: What to Store on the LMS Side

Add one column to your lessons table to link each lesson to a CMS video:

```sql
ALTER TABLE lessons ADD COLUMN cms_video_id VARCHAR(50);
```

That's all. The CMS tracks everything else (watch time, completion %, session logs).

Example lesson record:
```
id            | 42
title         | "Pharmacology Module 1"
cms_video_id  | "v_xyz789abc"   ← the publicId from CMS
content       | "..."
```

---

## Step 6 — Environment Variables on Your LMS Server

Add these to your `.env` / deployment config:

```env
# Secure Video CMS
SYAN_CMS_URL=https://cms.yourdomain.com
SYAN_CLIENT_KEY=syan_ck_your_client_key_here
SYAN_MASTER_SECRET=your_integration_master_secret_here
```

**Never** put `SYAN_MASTER_SECRET` in frontend JavaScript or HTML. It must stay on the server.

---

## Step 7 — Tell the CMS Admin to Add Your Origin

Send the CMS admin the **exact URL** where your LMS frontend runs (including `https://`), for example:

```
https://app.rxcompendium.com
```

They need to:
1. Go to Admin → Integrations → your client → **Allowed Origins** and add it.
2. Add it to the `ALLOWED_LMS_ORIGINS` server env var.

Without this, the video iframe will not accept your postMessage token.

---

## Quick Checklist Before Testing

- [ ] `SYAN_MASTER_SECRET` is set as a **server-side** environment variable only
- [ ] Token is generated fresh on **every page load** (do not cache)
- [ ] The `iss` field in the token equals your **Client Key** exactly
- [ ] The `publicId` in the token matches the video ID in the iframe URL
- [ ] The `exp` is set to `now + 300` (or less — max 600 seconds)
- [ ] `jti` is a fresh UUID on every token
- [ ] Your LMS frontend origin is added to the CMS client's Allowed Origins
- [ ] The iframe `src` does **not** contain the token — token is sent via postMessage only
- [ ] postMessage target origin is the exact CMS URL, not `"*"`

---

## Testing It Works

1. Open a lesson page as a student.
2. Open browser DevTools → Network tab.
3. You should see a request to `/api/integrations/player/v_xyz.../mint` returning `200 ok: true`.
4. The video should start loading.

If you see an error, check the response body — it will tell you exactly what's wrong:

| Error in response | Fix |
|---|---|
| `INTEGRATION_CLIENT_NOT_FOUND` | Wrong `clientKey` in your `iss` field |
| `INVALID_LAUNCH_TOKEN` | Wrong `SYAN_MASTER_SECRET` — check it matches exactly |
| `LAUNCH_TOKEN_EXPIRED` | You're caching a token — generate fresh per page load |
| `VIDEO_NOT_FOUND` | Wrong `publicId` or video not marked Available in CMS |
| `VIDEO_NOT_ALLOWED` | Ask CMS admin to add this video to your client's access list |
| `ORIGIN_NOT_ALLOWED` | Ask CMS admin to add your frontend origin to the allowed list |

If the iframe shows "Waiting for LMS authorization..." and never changes:
- Your postMessage is not reaching the iframe — check the target origin in your JS
- Your LMS frontend origin is not in `ALLOWED_LMS_ORIGINS` on the CMS

---

## Summary: Files to Create/Modify in rxcompendium

```
rxcompendium/
├── .env                          ← add SYAN_CMS_URL, SYAN_CLIENT_KEY, SYAN_MASTER_SECRET
├── utils/
│   └── syanToken.js              ← token signing function (Step 2)
├── routes/
│   └── lessons.js                ← generate token, pass to template (Step 3)
├── views/
│   └── lesson.html               ← iframe + postMessage JS (Step 4)
└── database/migrations/
    └── add_cms_video_id.sql      ← add cms_video_id column to lessons (Step 5)
```

That is the complete integration. No other CMS SDK or library needed.
