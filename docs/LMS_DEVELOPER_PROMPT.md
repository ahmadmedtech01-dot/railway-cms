# PROMPT FOR LMS DEVELOPER

Copy everything below and give it to your LMS developer or AI coding assistant.
The full reference guide is at `docs/LMS_INTEGRATION_GUIDE.md`.

---

## YOUR TASK

Integrate the Secure Video CMS player into your LMS so that videos play automatically for students.

**CMS player URL:** `https://railway-cms-production.up.railway.app`
**Shared HMAC secret:** ask the CMS admin — they will give you the value of `LMS_HMAC_SECRET` from Railway.
**Your LMS origin:** the exact URL your LMS is deployed at, e.g. `https://your-lms.com` — no trailing slash.

---

## STEP 1 — Backend: Token generation endpoint

Add this function and endpoint to your LMS backend.

```javascript
const crypto = require('crypto');

const LMS_HMAC_SECRET = process.env.LMS_HMAC_SECRET; // set in your env vars
const LMS_ORIGIN = 'https://your-lms.com';           // your deployed URL, no trailing slash

function generateCmsLaunchToken(publicId, userId) {
  const payload = {
    userId:   String(userId),
    publicId: String(publicId),
    exp:      Math.floor(Date.now() / 1000) + 540,  // 9 minutes from now (max allowed: 600s)
    nonce:    crypto.randomUUID(),                   // fresh UUID every time — never reuse
    aud:      'video-cms',                           // must be exactly this string
    origin:   LMS_ORIGIN,                            // must match ALLOWED_LMS_ORIGINS on CMS
  };

  // IMPORTANT: sign the base64url string, NOT the raw JSON
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature  = crypto.createHmac('sha256', LMS_HMAC_SECRET)
                           .update(payloadB64)
                           .digest('hex');

  return `${payloadB64}.${signature}`;
}

// Endpoint — your frontend calls this to get a fresh token
app.post('/api/lms-token', requireAuth, (req, res) => {
  const { publicId } = req.body;
  const token = generateCmsLaunchToken(publicId, req.user.id);
  res.json({ token });
});
```

**Python version:**
```python
import hmac, hashlib, json, base64, time, uuid, os

LMS_HMAC_SECRET = os.environ['LMS_HMAC_SECRET']
LMS_ORIGIN = 'https://your-lms.com'

def generate_cms_launch_token(public_id, user_id):
    payload = {
        'userId':   str(user_id),
        'publicId': str(public_id),
        'exp':      int(time.time()) + 540,  # 9 minutes from now (max allowed: 600s)
        'nonce':    str(uuid.uuid4()),
        'aud':      'video-cms',
        'origin':   LMS_ORIGIN,
    }
    payload_b64 = base64.urlsafe_b64encode(
        json.dumps(payload, separators=(',',':')).encode()
    ).rstrip(b'=').decode()
    sig = hmac.new(LMS_HMAC_SECRET.encode(), payload_b64.encode(), hashlib.sha256).hexdigest()
    return f'{payload_b64}.{sig}'
```

---

## STEP 2 — Frontend: Embed the iframe (no token in URL)

```html
<iframe
  id="cms-video-player"
  src="https://railway-cms-production.up.railway.app/embed/VIDEO_PUBLIC_ID"
  width="100%" height="500"
  frameborder="0" allowfullscreen
  allow="autoplay; fullscreen; encrypted-media"
  referrerpolicy="no-referrer-when-downgrade"
  sandbox="allow-scripts allow-same-origin allow-presentation"
></iframe>
```

**There must be NO `?token=` in the `src`.** The token is sent via `postMessage` only.

---

## STEP 3 — Frontend: Send the token via postMessage

```javascript
const CMS_ORIGIN = 'https://railway-cms-production.up.railway.app';

async function initCmsPlayer(iframeId, publicId) {
  const iframe = document.getElementById(iframeId);
  if (!iframe) return;

  const res = await fetch('/api/lms-token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ publicId }),
  });
  if (!res.ok) return;
  const { token } = await res.json();

  function sendToken() {
    iframe.contentWindow?.postMessage(
      { type: 'LMS_LAUNCH_TOKEN', token },  // type must be exactly this string
      CMS_ORIGIN                              // targetOrigin must be exactly this
    );
  }

  // Send immediately + retry every second for 10 seconds
  sendToken();
  let retries = 0;
  const interval = setInterval(() => {
    if (++retries >= 10) { clearInterval(interval); return; }
    sendToken();
  }, 1000);
}

document.getElementById('cms-video-player').addEventListener('load', () => {
  initCmsPlayer('cms-video-player', 'VIDEO_PUBLIC_ID');
});
```

---

## THINGS THAT WILL BREAK IT

| Mistake | Result |
|---------|--------|
| `type: 'token'` or any other type | Player ignores the message, waits forever |
| `postMessage(msg, '*')` | Player may reject the wildcard origin |
| Trailing slash on targetOrigin or LMS_ORIGIN | Token rejected |
| `?token=` in the iframe src | Expires after a day, can't refresh |
| LMS_HMAC_SECRET value different from CMS | HMAC mismatch, 401 |
| Signing raw JSON instead of base64url string | HMAC mismatch, 401 |
| `aud` not exactly `"video-cms"` | Token rejected |
| `exp` more than 300 seconds from now | Token rejected |
| Reusing the same nonce | Token rejected on second use |

---

## QUICK TEST

Run this in your terminal to verify your token generation is correct before browser testing:

```bash
TOKEN=$(node -e "
const crypto = require('crypto');
const secret = 'PASTE_YOUR_LMS_HMAC_SECRET_HERE';
const origin = 'https://your-lms.com';
const p = { userId:'test', publicId:'mjakYG627Y', exp:Math.floor(Date.now()/1000)+240, nonce:crypto.randomUUID(), aud:'video-cms', origin };
const b64 = Buffer.from(JSON.stringify(p)).toString('base64url');
const sig = crypto.createHmac('sha256',secret).update(b64).digest('hex');
console.log(b64+'.'+sig);
")

curl -s -X POST https://railway-cms-production.up.railway.app/api/player/mjakYG627Y/mint \
  -H 'Content-Type: application/json' \
  -d "{\"lmsLaunchToken\":\"$TOKEN\"}"
```

Expected success: `{"token":"eyJ...","expiresAt":"...","tokenId":"..."}`
Any 4xx response means the token is wrong — the message will tell you exactly why.

---

For full debugging reference, error message explanations, and Python/PHP code: see `docs/LMS_INTEGRATION_GUIDE.md`.
