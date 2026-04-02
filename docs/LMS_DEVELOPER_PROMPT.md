# PROMPT FOR LMS DEVELOPER

Copy everything below and give it to your LMS developer or AI coding assistant.

---

## TASK: Fix Video Player Integration with Secure Video CMS

The LMS needs to automatically generate HMAC-signed tokens and send them to the
CMS video player iframe via postMessage. The player currently shows
"Waiting for LMS authorization..." because the token is not being delivered correctly.

### WHAT IS ALREADY WORKING

- The LMS has an API endpoint `/api/video-courses/:id/lms-token` that returns 200 OK
- The LMS embeds the CMS player in an iframe
- The environment variable `LMS_HMAC_SECRET` is already set on Render

### WHAT NEEDS TO BE FIXED

There are exactly 2 things that need to work together:

---

### PART 1: Backend — The `/lms-token` endpoint must return a valid HMAC token

The token is NOT a JWT. It is a two-part string: `{base64url_payload}.{hex_signature}`

Here is the exact Node.js code for generating the token:

```javascript
const crypto = require('crypto');

function generateCmsLaunchToken(publicId, userId) {
  const LMS_ORIGIN = 'https://complete-video-hr-syan-exams-test-final-dww7.onrender.com';
  const secret = process.env.LMS_HMAC_SECRET;

  const payload = {
    userId:   String(userId),
    publicId: String(publicId),
    exp:      Math.floor(Date.now() / 1000) + 240,
    nonce:    crypto.randomUUID(),
    aud:      'video-cms',
    origin:   LMS_ORIGIN
  };

  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(payloadB64).digest('hex');

  return `${payloadB64}.${sig}`;
}
```

The `/lms-token` endpoint should look like this:

```javascript
router.post('/api/video-courses/:id/lms-token', requireAuth, async (req, res) => {
  const course = await getCourseById(req.params.id);
  if (!course) return res.status(404).json({ error: 'Not found' });

  const token = generateCmsLaunchToken(course.cmsPublicVideoId, req.user.id);
  res.json({ token, publicId: course.cmsPublicVideoId });
});
```

**CRITICAL RULES for the token:**
- `userId` — the logged-in student's unique ID (string)
- `publicId` — the CMS video's public ID, e.g. `"mjakYG627Y"` (stored in your DB per video)
- `exp` — Unix timestamp in SECONDS, must be 1-5 minutes in the future
- `nonce` — a fresh random UUID for every request, never reuse
- `aud` — must be exactly the string `"video-cms"`
- `origin` — must be exactly `"https://complete-video-hr-syan-exams-test-final-dww7.onrender.com"` with NO trailing slash
- The signature signs the base64url-encoded string, NOT the raw JSON

---

### PART 2: Frontend — Send the token to the iframe via postMessage

After the iframe loads, the LMS frontend must:
1. Call the backend `/lms-token` endpoint to get a fresh token
2. Send it to the iframe using `window.postMessage`

**The postMessage MUST use this EXACT format:**

```javascript
iframe.contentWindow.postMessage(
  {
    type: 'LMS_LAUNCH_TOKEN',
    token: 'the-hmac-token-string-from-backend'
  },
  'https://railway-cms-production.up.railway.app'
);
```

Here is complete working frontend code:

```javascript
async function authorizeVideoPlayer(iframeElement, courseId) {
  const CMS_ORIGIN = 'https://railway-cms-production.up.railway.app';

  // 1. Get fresh token from your backend
  const res = await fetch(`/api/video-courses/${courseId}/lms-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
  });
  if (!res.ok) return console.error('Token generation failed');
  const { token } = await res.json();

  // 2. Send to the CMS player iframe
  function send() {
    iframeElement.contentWindow.postMessage(
      { type: 'LMS_LAUNCH_TOKEN', token: token },
      CMS_ORIGIN
    );
  }

  // 3. Send immediately + retry every second for 10 seconds
  send();
  let count = 0;
  const interval = setInterval(() => {
    if (++count >= 10) return clearInterval(interval);
    send();
  }, 1000);
}
```

Call it like this after the iframe loads:

```javascript
const iframe = document.getElementById('video-player-iframe');
iframe.addEventListener('load', () => {
  authorizeVideoPlayer(iframe, courseId);
});
```

If using React:

```jsx
const iframeRef = useRef(null);

useEffect(() => {
  const iframe = iframeRef.current;
  if (!iframe) return;

  const onLoad = () => authorizeVideoPlayer(iframe, courseId);
  iframe.addEventListener('load', onLoad);
  return () => iframe.removeEventListener('load', onLoad);
}, [courseId]);

return (
  <iframe
    ref={iframeRef}
    src={`https://railway-cms-production.up.railway.app/embed/${publicId}`}
    width="100%"
    height="480"
    frameBorder="0"
    allowFullScreen
    allow="autoplay; fullscreen; encrypted-media"
  />
);
```

---

### THE IFRAME URL

The iframe `src` must be:
```
https://railway-cms-production.up.railway.app/embed/{publicId}
```

**DO NOT put any `?token=` in the iframe URL.** The token goes through postMessage only.

---

### THINGS THAT WILL CAUSE FAILURE

| Mistake | Why it fails |
|---------|-------------|
| `postMessage({ type: 'token', ... })` | Player only accepts `type: 'LMS_LAUNCH_TOKEN'` exactly |
| `postMessage({ token: '...' })` | Missing `type` field — player ignores it |
| `postMessage(msg, '*')` | Insecure — player may reject wildcard origin |
| `postMessage(msg, 'https://railway-cms.up.railway.app')` | Wrong subdomain — must be `railway-cms-production` |
| Token with trailing slash in `origin` field | CMS does exact string match — no trailing slash |
| Token with `aud: 'lms'` or any value other than `"video-cms"` | CMS rejects tokens with wrong audience |
| Reusing old tokens instead of generating fresh ones | Tokens expire after 5 minutes — always generate new |
| Signing raw JSON instead of base64url string | Signature won't match — CMS rejects |
| Putting `?token=eyJ...` in the iframe URL | URL tokens expire and can't be refreshed — use postMessage |

---

### HOW TO TEST

Run this in your terminal to verify your backend generates valid tokens:

```bash
# Generate a test token
TOKEN=$(node -e "
const crypto = require('crypto');
const p = {
  userId: 'test',
  publicId: 'mjakYG627Y',
  exp: Math.floor(Date.now()/1000) + 240,
  nonce: crypto.randomUUID(),
  aud: 'video-cms',
  origin: 'https://complete-video-hr-syan-exams-test-final-dww7.onrender.com'
};
const b = Buffer.from(JSON.stringify(p)).toString('base64url');
const s = crypto.createHmac('sha256','a41afc36c3216bc49b9e780ed4004dfa847a3c26446d1a216be6cecf836bf5d6').update(b).digest('hex');
console.log(b+'.'+s);
")

# Test against the CMS
curl -s -X POST \
  https://railway-cms-production.up.railway.app/api/player/mjakYG627Y/mint \
  -H 'Content-Type: application/json' \
  -d "{\"lmsLaunchToken\":\"$TOKEN\"}"
```

**Expected success response:**
```json
{"token":"eyJ...","expiresAt":"2026-...","tokenId":"..."}
```

If you get this response, your token format is correct and the CMS accepts it.

---

### SUMMARY OF CHANGES NEEDED IN LMS CODE

1. **Backend file** (wherever `/api/video-courses/:id/lms-token` is defined):
   - Add the `generateCmsLaunchToken()` function shown above
   - Make the endpoint return `{ token, publicId }` using that function

2. **Frontend file** (wherever the video player iframe is rendered):
   - Add the `authorizeVideoPlayer()` function shown above
   - Call it when the iframe loads
   - Make sure the iframe `src` has NO `?token=` parameter

That's it. Two files, two changes. The video will start playing automatically.
