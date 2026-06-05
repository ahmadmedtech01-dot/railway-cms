import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { Plus, Copy, RotateCw, Trash2, Shield, Activity, FileText, PlayCircle, XCircle, Key, Zap, Download } from "lucide-react";

function generateGuide(cmsBase: string): string {
  return `# Syan CMS — LMS Integration Developer Guide

> **Hand this document to your LMS developer.**  
> Everything they need to integrate Syan Video CMS into your LMS is on this page.

---

## 1. What Is This?

Syan CMS is a secure video hosting platform. Your LMS embeds videos from Syan CMS using short-lived iframe URLs. Students never get a direct video link — every playback session is tracked and time-limited.

---

## 2. Prerequisites (Admin Does This Once)

Before the developer starts, the **CMS admin** must:

1. Log in to the CMS at \`${cmsBase}\`
2. Go to **Integrations → Clients** and click **Create Client**
   - Name: e.g. \`SyanRx LMS\`
   - Slug: e.g. \`syanrx-lms\`
   - Allowed Origins: \`https://syanrx.com, https://www.syanrx.com\`
   - Video Access Mode: \`All Videos\` (or \`Selected Videos Only\`)
3. Go to **Integrations → API Keys**, select the client, and click **Create Key**
   - Label: e.g. \`production\`
   - **Copy the key immediately** — it is shown only once
   - It starts with \`syan_ak_...\`
4. Share the following with the developer:

| Item | Value |
|---|---|
| CMS Base URL | \`${cmsBase}\` |
| API Key | \`syan_ak_xxxxxxxxxxxxxxxxxx...\` (from step 3) |

---

## 3. Environment Variable (LMS Server)

Add one environment variable to your LMS server:

\`\`\`
SYAN_API_KEY=syan_ak_xxxxxxxxxxxxxxxxxx...
SYAN_CMS_BASE=\${cmsBase}
\`\`\`

---

## 4. How to Upload Videos to the CMS

1. Log in to CMS at \`${cmsBase}\`
2. Go to **Video Library → Upload**
3. Upload your video file (MP4 recommended)
4. Wait for processing to complete (status becomes **Ready**)
5. Open the video — copy its **Public ID** (looks like \`sm_AbCdEfGh\`)
6. Store this Public ID in your LMS database alongside the course/lesson it belongs to

> **The Public ID is what you pass in the API call to get the embed URL.**

---

## 5. The One API Call (Server-Side)

Your LMS **server** calls this endpoint **every time a student opens a video page**:

\`\`\`
POST \${cmsBase}/api/integrations/embed-url
\`\`\`

### Request

| Header | Value |
|---|---|
| \`Content-Type\` | \`application/json\` |
| \`X-Api-Key\` | \`syan_ak_...\` (your API key) |

### Body

\`\`\`json
{
  "videoId":     "sm_AbCdEfGh",   // required — CMS video Public ID
  "studentId":   "user_123",      // required — unique student ID in your LMS
  "courseId":    "course_45",     // optional — for your analytics
  "lessonId":    "lesson_7",      // optional — for your analytics
  "studentName": "John Doe",      // optional — shown in CMS session logs
  "studentEmail":"john@example.com" // optional
}
\`\`\`

### Response

\`\`\`json
{
  "ok": true,
  "iframeUrl": "\${cmsBase}/embed/sm_AbCdEfGh?token=eyJ...",
  "embedToken": "eyJ...",
  "expiresIn": 300,
  "integrationSessionId": "uuid",
  "video": {
    "title": "Lecture 1: Introduction",
    "durationSeconds": 1240,
    "posterUrl": null,
    "publicId": "sm_AbCdEfGh"
  }
}
\`\`\`

> **Important:** The \`iframeUrl\` expires in **5 minutes**. Generate it server-side on each page load — do NOT cache it or store it.

---

## 6. Code Examples

### Node.js / Express

\`\`\`javascript
// In your route handler — runs on the server, NOT in the browser
app.get('/course/:courseId/lesson/:lessonId', async (req, res) => {
  const lesson = await db.lessons.findById(req.params.lessonId);

  // Get a fresh embed URL from Syan CMS
  const response = await fetch(\`\${process.env.SYAN_CMS_BASE}/api/integrations/embed-url\`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': process.env.SYAN_API_KEY,
    },
    body: JSON.stringify({
      videoId:     lesson.syanVideoId,   // the Public ID you stored
      studentId:   req.user.id,
      courseId:    req.params.courseId,
      lessonId:    req.params.lessonId,
      studentName: req.user.name,
    }),
  });

  if (!response.ok) {
    return res.status(500).send('Could not load video');
  }

  const { iframeUrl } = await response.json();

  // Pass iframeUrl to your template
  res.render('lesson', { lesson, iframeUrl });
});
\`\`\`

### HTML Template (after getting iframeUrl from server)

\`\`\`html
<!-- Paste the iframeUrl from the server response here -->
<div class="video-container" style="position:relative; padding-bottom:56.25%; height:0;">
  <iframe
    src="<%= iframeUrl %>"
    style="position:absolute; top:0; left:0; width:100%; height:100%; border:none;"
    allowfullscreen
    allow="autoplay; fullscreen; picture-in-picture"
    referrerpolicy="strict-origin"
  ></iframe>
</div>
\`\`\`

### PHP (Laravel / plain PHP)

\`\`\`php
<?php
// In your controller
$response = Http::withHeaders([
    'X-Api-Key' => env('SYAN_API_KEY'),
])->post(env('SYAN_CMS_BASE') . '/api/integrations/embed-url', [
    'videoId'     => $lesson->syan_video_id,
    'studentId'   => auth()->id(),
    'courseId'    => $course->id,
    'lessonId'    => $lesson->id,
    'studentName' => auth()->user()->name,
]);

$iframeUrl = $response->json('iframeUrl');

// In your Blade template:
// <iframe src="{{ $iframeUrl }}" width="100%" height="450" allowfullscreen></iframe>
\`\`\`

### Python (Django / Flask)

\`\`\`python
import requests, os

def get_video_embed_url(video_id, student_id, course_id=None, lesson_id=None):
    resp = requests.post(
        os.environ['SYAN_CMS_BASE'] + '/api/integrations/embed-url',
        headers={'X-Api-Key': os.environ['SYAN_API_KEY']},
        json={
            'videoId':   video_id,
            'studentId': str(student_id),
            'courseId':  course_id,
            'lessonId':  lesson_id,
        },
        timeout=10
    )
    resp.raise_for_status()
    return resp.json()['iframeUrl']
\`\`\`

---

## 7. Error Handling

| HTTP Status | Code | Meaning |
|---|---|---|
| 401 | \`UNAUTHORIZED\` | No \`X-Api-Key\` header sent |
| 401 | \`INVALID_API_KEY\` | Key is wrong or revoked |
| 403 | \`INTEGRATION_CLIENT_DISABLED\` | Client was disabled in CMS admin |
| 403 | \`VIDEO_NOT_ALLOWED\` | This video is not accessible by your client |
| 404 | \`VIDEO_NOT_FOUND\` | Wrong \`videoId\`, or video is unpublished |
| 400 | \`VIDEO_NOT_READY\` | Video is still processing — try again later |
| 400 | \`VALIDATION_ERROR\` | Missing \`videoId\` or \`studentId\` |

Always check for \`"ok": true\` in the response before using \`iframeUrl\`.

---

## 8. Tracking Completion (Optional)

The embed player automatically tracks watch progress internally. If you want to receive a **completion event** in your LMS:

Listen for a \`postMessage\` from the iframe:

\`\`\`javascript
window.addEventListener('message', (event) => {
  // Only trust messages from the CMS
  if (!event.origin.startsWith('${cmsBase}')) return;

  const { type, data } = event.data || {};

  if (type === 'PLAYER_COMPLETE') {
    console.log('Student finished video:', data);
    // Mark lesson complete in your LMS
    markLessonComplete(data.publicId, data.userId);
  }

  if (type === 'PLAYER_PROGRESS') {
    console.log('Progress:', data.percent + '%', 'watched:', data.watchedSeconds + 's');
  }
});
\`\`\`

---

## 9. Security Rules

- **Never expose the API key to the browser.** The \`/api/integrations/embed-url\` call must be made server-to-server only.
- The \`iframeUrl\` is safe to put in your HTML — it contains a short-lived token (5 min), not the API key.
- If a key is compromised, revoke it in **Integrations → API Keys** and create a new one. Update your LMS env var.
- The iframe blocks top-level navigation — it cannot be opened directly as a page by students.

---

## 10. Quick Checklist

- [ ] CMS admin created an Integration Client
- [ ] CMS admin created an API Key and shared it securely
- [ ] LMS server has \`SYAN_API_KEY\` and \`SYAN_CMS_BASE\` env vars set
- [ ] Videos are uploaded to CMS and their Public IDs are stored in the LMS database
- [ ] Server-side code calls \`/api/integrations/embed-url\` on each video page load
- [ ] Frontend renders the iframe using the returned \`iframeUrl\`
- [ ] Error handling in place (check \`ok === true\` before using \`iframeUrl\`)

---

## 11. All Relevant API Endpoints

| Method | Endpoint | Description |
|---|---|---|
| \`POST\` | \`/api/integrations/embed-url\` | **Main endpoint** — get ready-to-use iframe URL |
| \`GET\` | \`/api/integrations/videos/:publicId\` | Get video metadata (title, duration, poster) |

---

## 12. Support

Contact the CMS admin to:
- Add new video IDs to the allowed list (if client is in "Selected Videos" mode)
- Rotate/revoke API keys
- View session logs (which students watched what, when)
- View analytics per video

CMS Admin Panel: \`${cmsBase}\`
`;
}

function generateHmacGuide(cmsBase: string): string {
  return `# Syan CMS — LMS Integration Guide (HMAC / Advanced Method)

> **Hand this document to your LMS developer.**  
> This is the advanced method — it requires HMAC cryptographic token signing on the LMS server.  
> For the simpler approach (no signing required), use the Simple API Key guide instead.

---

## 1. What Is This?

Syan CMS is a secure video hosting platform. Your LMS generates signed launch tokens on the server, then the player exchanges them for embed URLs. This method gives you more control but requires HMAC-SHA256 signing code on the LMS side.

---

## 2. Prerequisites (Admin Does This Once)

The **CMS admin** must:

1. Log in to the CMS at \`${cmsBase}\`
2. Go to **Integrations → Clients** → **Create Client**
   - Name: e.g. \`SyanRx LMS\`
   - Slug: e.g. \`syanrx-lms\`
   - Allowed Origins: \`https://syanrx.com, https://www.syanrx.com\`
3. Copy the **Client Key** (starts with \`syan_ck_...\`) from the client card
4. Share these with the developer:

| Item | Value |
|---|---|
| CMS Base URL | \`${cmsBase}\` |
| Client Key | \`syan_ck_...\` |
| Integration Master Secret | (from CMS server env: \`INTEGRATION_MASTER_SECRET\`) |

---

## 3. Environment Variables (LMS Server)

\`\`\`
SYAN_CLIENT_KEY=syan_ck_xxxxxxxxxxxxxxxxxxxx
SYAN_INTEGRATION_SECRET=<shared HMAC secret from CMS admin>
SYAN_CMS_BASE=${cmsBase}
\`\`\`

---

## 4. How HMAC Token Signing Works

The LMS server creates a JSON payload, base64url-encodes it, then signs it with HMAC-SHA256 using the shared secret. The result is a launch token the player can verify.

**Token structure:** \`<base64url-payload>.<hex-signature>\`

---

## 5. Code: Generating a Launch Token

### Node.js

\`\`\`javascript
const crypto = require('crypto');

const CLIENT_KEY = process.env.SYAN_CLIENT_KEY;
const SECRET = process.env.SYAN_INTEGRATION_SECRET;

function generateLaunchToken(publicId, userId, courseId = null) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: CLIENT_KEY,          // your client key — must match exactly
    aud: 'cms-player',        // must be exactly this string
    sub: String(userId),      // student's unique ID
    publicId: publicId,       // CMS video Public ID
    courseId: courseId,       // optional
    iat: now,
    exp: now + 540,           // token valid for 9 minutes
    jti: crypto.randomUUID(), // unique per token
  };

  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(payloadB64).digest('hex');
  return payloadB64 + '.' + sig;
}
\`\`\`

### PHP

\`\`\`php
<?php
function generateLaunchToken(string $publicId, string $userId, ?string $courseId = null): string {
    $now = time();
    $payload = [
        'iss'      => env('SYAN_CLIENT_KEY'),
        'aud'      => 'cms-player',
        'sub'      => $userId,
        'publicId' => $publicId,
        'courseId' => $courseId,
        'iat'      => $now,
        'exp'      => $now + 540,
        'jti'      => (string) Str::uuid(),
    ];
    $b64 = rtrim(strtr(base64_encode(json_encode($payload)), '+/', '-_'), '=');
    $sig = hash_hmac('sha256', $b64, env('SYAN_INTEGRATION_SECRET'));
    return $b64 . '.' . $sig;
}
\`\`\`

### Python

\`\`\`python
import hmac, hashlib, json, base64, uuid, time, os

def generate_launch_token(public_id, user_id, course_id=None):
    now = int(time.time())
    payload = {
        'iss': os.environ['SYAN_CLIENT_KEY'],
        'aud': 'cms-player',
        'sub': str(user_id),
        'publicId': public_id,
        'courseId': course_id,
        'iat': now,
        'exp': now + 540,
        'jti': str(uuid.uuid4()),
    }
    b64 = base64.urlsafe_b64encode(json.dumps(payload).encode()).rstrip(b'=').decode()
    sig = hmac.new(os.environ['SYAN_INTEGRATION_SECRET'].encode(), b64.encode(), hashlib.sha256).hexdigest()
    return b64 + '.' + sig
\`\`\`

---

## 6. Using the Token — Two Options

### Option A: Pass token to the JS SDK

\`\`\`html
<!-- In your LMS page template -->
<div id="player"></div>
<script src="${cmsBase}/sdk/player.js"></script>
<script>
  SyanPlayer.mount({
    element: '#player',
    publicId: 'sm_AbCdEfGh',              // CMS video Public ID
    launchToken: '<%= launchToken %>',     // token from your server
    cmsBase: '${cmsBase}',
    autoplay: false,
    controls: true,
    onComplete: function() { console.log('done'); },
    onError: function(e) { console.error(e); }
  });
</script>
\`\`\`

### Option B: Exchange token for iframe URL (server-side)

\`\`\`javascript
// Your server mints the embed URL
const response = await fetch(\`${cmsBase}/api/integrations/player/\${publicId}/mint\`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ launchToken }),
});
const { embedToken } = await response.json();
const iframeUrl = \`${cmsBase}/embed/\${publicId}?token=\${embedToken}\`;

// Then render:
// <iframe src="<%= iframeUrl %>" width="100%" height="450" allowfullscreen></iframe>
\`\`\`

---

## 7. Uploading Videos

1. Log in to CMS → **Video Library → Upload**
2. Upload MP4, wait for status **Ready**
3. Open the video → copy its **Public ID** (e.g. \`sm_AbCdEfGh\`)
4. Store the Public ID in your LMS database linked to the lesson

---

## 8. Error Handling

| HTTP Status | Meaning |
|---|---|
| 401 | Invalid or expired launch token |
| 403 | Video not allowed for this client |
| 404 | Video not found |
| 400 | Token already used (replay attack blocked) |

---

## 9. Security Rules

- **Never expose \`SYAN_INTEGRATION_SECRET\` to the browser.** Token signing must happen server-side only.
- Tokens expire in 9 minutes — do not pre-generate and cache them.
- The \`jti\` (unique ID) in each token must be different every time — use \`crypto.randomUUID()\`.

---

## 10. API Endpoints Reference

| Method | Endpoint | Description |
|---|---|---|
| \`POST\` | \`/api/integrations/player/:publicId/mint\` | Exchange launch token → embed token |
| \`POST\` | \`/api/integrations/player/:publicId/refresh\` | Refresh embed token before expiry |
| \`POST\` | \`/api/integrations/player/:publicId/ping\` | Report watch progress |
| \`POST\` | \`/api/integrations/player/:publicId/complete\` | Mark video complete |
| \`GET\` | \`/api/integrations/videos/:publicId\` | Get video metadata |

---

## 11. Quick Checklist

- [ ] CMS admin created an Integration Client and shared the Client Key
- [ ] CMS admin shared the \`INTEGRATION_MASTER_SECRET\`
- [ ] LMS server has \`SYAN_CLIENT_KEY\`, \`SYAN_INTEGRATION_SECRET\`, \`SYAN_CMS_BASE\` set
- [ ] Launch tokens are generated server-side (never in browser)
- [ ] Each token has a unique \`jti\` (UUID)
- [ ] Token expiry is set to 540 seconds (9 min) or less
- [ ] Videos uploaded to CMS with Public IDs stored in LMS database

---

## 12. Support

CMS Admin Panel: \`${cmsBase}\`
`;
}

function downloadMarkdown(content: string, filename: string) {
  const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

const PRODUCTION_CMS_BASE = "https://railway-cms-production.up.railway.app";

function getDocsCmsBase(): string {
  const origin = window.location.origin;
  // Use production domain in docs unless already on a real production host
  if (origin.includes("replit.dev") || origin.includes("localhost") || origin.includes("127.0.0.1")) {
    return PRODUCTION_CMS_BASE;
  }
  return origin;
}

function DownloadGuideButton() {
  const cmsBase = getDocsCmsBase();
  return (
    <div className="flex flex-col gap-2 items-end">
      <Button
        onClick={() => downloadMarkdown(generateGuide(cmsBase), "Syan_CMS_Simple_API_Guide.md")}
        variant="default"
        data-testid="button-download-guide-simple"
      >
        <Download className="h-4 w-4 mr-2" />
        Simple API Guide <span className="ml-1 text-xs opacity-75">(Recommended)</span>
      </Button>
      <Button
        onClick={() => downloadMarkdown(generateHmacGuide(cmsBase), "Syan_CMS_HMAC_Advanced_Guide.md")}
        variant="outline"
        data-testid="button-download-guide-hmac"
      >
        <Download className="h-4 w-4 mr-2" />
        HMAC Signing Guide <span className="ml-1 text-xs opacity-75">(Advanced)</span>
      </Button>
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const { toast } = useToast();
  return (
    <Button size="icon" variant="ghost" className="h-6 w-6 shrink-0" onClick={() => {
      navigator.clipboard.writeText(text);
      toast({ title: "Copied!" });
    }} data-testid="button-copy"><Copy className="h-3 w-3" /></Button>
  );
}

function ClientsTab() {
  const { toast } = useToast();
  const [showCreate, setShowCreate] = useState(false);
  const [showSecret, setShowSecret] = useState<{ secret: string; clientKey: string } | null>(null);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [description, setDescription] = useState("");
  const [allowedOrigins, setAllowedOrigins] = useState("");
  const [videoMode, setVideoMode] = useState("all");

  const { data: clients = [], isLoading } = useQuery<any[]>({
    queryKey: ["/api/admin/integrations/clients"],
  });

  const createMutation = useMutation({
    mutationFn: async (data: any) => {
      const res = await apiRequest("POST", "/api/admin/integrations/clients", data);
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/integrations/clients"] });
      setShowCreate(false);
      setShowSecret({ secret: data.rawSecret, clientKey: data.client.clientKey });
      setName(""); setSlug(""); setDescription(""); setAllowedOrigins(""); setVideoMode("all");
    },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => { await apiRequest("DELETE", `/api/admin/integrations/clients/${id}`); },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/admin/integrations/clients"] }),
  });

  const toggleMutation = useMutation({
    mutationFn: async ({ id, status }: { id: string; status: string }) => {
      await apiRequest("PATCH", `/api/admin/integrations/clients/${id}`, { status });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/admin/integrations/clients"] }),
  });

  const rotateMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest("POST", `/api/admin/integrations/clients/${id}/rotate-secret`);
      return res.json();
    },
    onSuccess: (data) => {
      setShowSecret({ secret: data.rawSecret, clientKey: "" });
      toast({ title: "Secret rotated" });
    },
  });

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <h3 className="text-lg font-semibold" data-testid="text-clients-title">Integration Clients</h3>
        <Button onClick={() => setShowCreate(true)} data-testid="button-create-client"><Plus className="h-4 w-4 mr-2" />Create Client</Button>
      </div>

      {isLoading && <p className="text-muted-foreground">Loading...</p>}

      <div className="grid gap-3">
        {clients.map((c: any) => (
          <Card key={c.id} data-testid={`card-client-${c.id}`}>
            <CardContent className="flex items-center justify-between py-4">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium" data-testid={`text-client-name-${c.id}`}>{c.name}</span>
                  <Badge variant={c.status === "active" ? "default" : "secondary"} data-testid={`badge-client-status-${c.id}`}>{c.status}</Badge>
                  <Badge variant="outline">{c.authMode}</Badge>
                </div>
                <div className="text-xs text-muted-foreground space-x-4">
                  <span>Slug: {c.slug}</span>
                  <span>Key: {c.clientKey?.slice(0, 20)}... <CopyButton text={c.clientKey} /></span>
                  <span>Origins: {(c.allowedOrigins as any[])?.length || 0}</span>
                  <span>Videos: {c.allowedVideoIdsMode}</span>
                </div>
              </div>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={() => toggleMutation.mutate({ id: c.id, status: c.status === "active" ? "disabled" : "active" })} data-testid={`button-toggle-${c.id}`}>
                  {c.status === "active" ? <XCircle className="h-4 w-4" /> : <PlayCircle className="h-4 w-4" />}
                </Button>
                <Button size="sm" variant="outline" onClick={() => rotateMutation.mutate(c.id)} data-testid={`button-rotate-${c.id}`}>
                  <RotateCw className="h-4 w-4" />
                </Button>
                <Button size="sm" variant="destructive" onClick={() => { if (confirm("Delete this client?")) deleteMutation.mutate(c.id); }} data-testid={`button-delete-${c.id}`}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
        {!isLoading && clients.length === 0 && <p className="text-muted-foreground text-sm text-center py-8">No integration clients yet. Create one to get started.</p>}
      </div>

      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create Integration Client</DialogTitle>
            <DialogDescription>Create a new LMS integration client. You'll receive a one-time visible secret.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div><Label>Name</Label><Input value={name} onChange={e => setName(e.target.value)} placeholder="My LMS" data-testid="input-client-name" /></div>
            <div><Label>Slug</Label><Input value={slug} onChange={e => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))} placeholder="my-lms" data-testid="input-client-slug" /></div>
            <div><Label>Description</Label><Textarea value={description} onChange={e => setDescription(e.target.value)} placeholder="Optional description" data-testid="input-client-description" /></div>
            <div><Label>Allowed Origins (comma-separated)</Label><Input value={allowedOrigins} onChange={e => setAllowedOrigins(e.target.value)} placeholder="https://syanrx.com" data-testid="input-allowed-origins" /></div>
            <div>
              <Label>Video Access Mode</Label>
              <Select value={videoMode} onValueChange={setVideoMode}>
                <SelectTrigger data-testid="select-video-mode"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Videos</SelectItem>
                  <SelectItem value="selected">Selected Videos Only</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreate(false)} data-testid="button-cancel-create">Cancel</Button>
            <Button onClick={() => createMutation.mutate({
              name, slug, description,
              allowedOrigins: allowedOrigins.split(",").map(s => s.trim()).filter(Boolean),
              allowedVideoIdsMode: videoMode,
              config: { strictOriginCheck: allowedOrigins.trim().length > 0 },
            })} disabled={!name || !slug || createMutation.isPending} data-testid="button-submit-create">
              {createMutation.isPending ? "Creating..." : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!showSecret} onOpenChange={() => setShowSecret(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Client Created Successfully</DialogTitle>
            <DialogDescription>Copy the secret below. It will NOT be shown again. Store it securely.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {showSecret?.clientKey && (
              <div>
                <Label className="text-xs text-muted-foreground">Client Key</Label>
                <div className="flex items-center gap-2 bg-muted p-2 rounded font-mono text-xs break-all" data-testid="text-client-key">
                  {showSecret.clientKey} <CopyButton text={showSecret.clientKey} />
                </div>
              </div>
            )}
            <div>
              <Label className="text-xs text-muted-foreground">Client Secret (one-time display)</Label>
              <div className="flex items-center gap-2 bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 p-2 rounded font-mono text-xs break-all" data-testid="text-client-secret">
                {showSecret?.secret} <CopyButton text={showSecret?.secret || ""} />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button onClick={() => setShowSecret(null)} data-testid="button-close-secret">I've copied the secret</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ApiKeysTab() {
  const { toast } = useToast();
  const [selectedClientId, setSelectedClientId] = useState("");
  const [newKeyLabel, setNewKeyLabel] = useState("");
  const [showNewKey, setShowNewKey] = useState<{ rawKey: string; label: string } | null>(null);

  const { data: clients = [] } = useQuery<any[]>({ queryKey: ["/api/admin/integrations/clients"] });

  const { data: keysRaw, isLoading } = useQuery<any[]>({
    queryKey: ["/api/admin/integrations/api-keys", selectedClientId],
    queryFn: async () => {
      if (!selectedClientId) return [];
      const res = await fetch(`/api/admin/integrations/clients/${selectedClientId}/api-keys`, { credentials: "include" });
      const json = await res.json();
      return Array.isArray(json) ? json : [];
    },
    enabled: !!selectedClientId,
  });
  const keys = Array.isArray(keysRaw) ? keysRaw : [];

  const createMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/admin/integrations/clients/${selectedClientId}/api-keys`, { label: newKeyLabel });
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/integrations/api-keys", selectedClientId] });
      setShowNewKey({ rawKey: data.rawKey, label: newKeyLabel });
      setNewKeyLabel("");
    },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const revokeMutation = useMutation({
    mutationFn: async (id: string) => { await apiRequest("DELETE", `/api/admin/integrations/api-keys/${id}`); },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/integrations/api-keys", selectedClientId] });
      toast({ title: "API key revoked" });
    },
  });

  const selectedClient = clients.find((c: any) => c.id === selectedClientId);
  const cmsBase = window.location.origin;

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold mb-1" data-testid="text-apikeys-title">Simple API Keys</h3>
        <p className="text-sm text-muted-foreground">One API key, one call — get a ready-to-use iframe URL. No token signing required on the LMS side.</p>
      </div>

      {/* How it works */}
      <Card className="border-primary/20 bg-primary/5">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2"><Zap className="h-4 w-4 text-primary" />How Simple API Works</CardTitle>
        </CardHeader>
        <CardContent className="text-sm space-y-1 text-muted-foreground">
          <p>1. Your LMS server calls <code className="bg-muted px-1 rounded text-xs">POST /api/integrations/embed-url</code> with the API key in the header</p>
          <p>2. You pass the video ID + student ID in the request body</p>
          <p>3. You get back a ready-to-use <code className="bg-muted px-1 rounded text-xs">iframeUrl</code></p>
          <p>4. Paste it into <code className="bg-muted px-1 rounded text-xs">&lt;iframe src="..."&gt;</code> — done</p>
        </CardContent>
      </Card>

      {/* Select client + create key */}
      <div className="grid grid-cols-2 gap-4">
        <div>
          <Label>Select Integration Client</Label>
          <Select value={selectedClientId} onValueChange={setSelectedClientId}>
            <SelectTrigger data-testid="select-apikey-client"><SelectValue placeholder="Choose a client..." /></SelectTrigger>
            <SelectContent>
              {clients.map((c: any) => (
                <SelectItem key={c.id} value={c.id}>{c.name} ({c.slug})</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {selectedClientId && (
          <div>
            <Label>New Key Label</Label>
            <div className="flex gap-2">
              <Input value={newKeyLabel} onChange={e => setNewKeyLabel(e.target.value)} placeholder="e.g. syanrx production" data-testid="input-apikey-label" />
              <Button onClick={() => createMutation.mutate()} disabled={!newKeyLabel || createMutation.isPending} data-testid="button-create-apikey">
                <Plus className="h-4 w-4 mr-1" />{createMutation.isPending ? "..." : "Create"}
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Keys list */}
      {selectedClientId && (
        <div>
          {isLoading && <p className="text-muted-foreground text-sm">Loading keys...</p>}
          <div className="space-y-2">
            {(keys as any[]).map((k: any) => (
              <div key={k.id} className="flex items-center justify-between border rounded p-3" data-testid={`row-apikey-${k.id}`}>
                <div className="space-y-0.5">
                  <div className="flex items-center gap-2">
                    <Key className="h-3 w-3 text-muted-foreground" />
                    <span className="font-medium text-sm">{k.label}</span>
                    <Badge variant={k.status === "active" ? "default" : "destructive"} className="text-xs">{k.status}</Badge>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Prefix: <code>{k.apiKeyPrefix}...</code>
                    {k.lastUsedAt && <span className="ml-3">Last used: {new Date(k.lastUsedAt).toLocaleString()}</span>}
                    <span className="ml-3">Created: {new Date(k.createdAt).toLocaleString()}</span>
                  </div>
                </div>
                {k.status === "active" && (
                  <Button size="sm" variant="destructive" onClick={() => { if (confirm("Revoke this API key? This cannot be undone.")) revokeMutation.mutate(k.id); }} data-testid={`button-revoke-apikey-${k.id}`}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </div>
            ))}
            {!isLoading && keys.length === 0 && <p className="text-muted-foreground text-sm text-center py-6">No API keys yet for this client. Create one above.</p>}
          </div>
        </div>
      )}

      {/* Code example */}
      {selectedClient && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">LMS Integration Code (Node.js)</CardTitle>
            <CardDescription className="text-xs">Your LMS server calls this — no token signing needed</CardDescription>
          </CardHeader>
          <CardContent>
            <pre className="bg-muted p-3 rounded text-xs overflow-x-auto whitespace-pre">{`// On your LMS server (Node.js / Express)
const response = await fetch('${cmsBase}/api/integrations/embed-url', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Api-Key': process.env.SYAN_API_KEY,   // your API key from above
  },
  body: JSON.stringify({
    videoId:     'v_abc123',          // CMS video public ID
    studentId:   req.user.id,         // your student's unique ID
    courseId:    'course_101',        // optional
    lessonId:    'lesson_5',          // optional
    studentName: req.user.name,       // optional — shown in CMS logs
  }),
});
const { iframeUrl, expiresIn } = await response.json();

// Then in your HTML template:
// <iframe src="${'${iframeUrl}'}" width="100%" height="450" allowfullscreen></iframe>`}</pre>
          </CardContent>
        </Card>
      )}

      {selectedClient && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">LMS Integration Code (PHP)</CardTitle>
          </CardHeader>
          <CardContent>
            <pre className="bg-muted p-3 rounded text-xs overflow-x-auto whitespace-pre">{`<?php
$response = file_get_contents('${cmsBase}/api/integrations/embed-url', false,
  stream_context_create(['http' => [
    'method'  => 'POST',
    'header'  => "Content-Type: application/json\\r\\nX-Api-Key: " . getenv('SYAN_API_KEY'),
    'content' => json_encode([
      'videoId'   => 'v_abc123',
      'studentId' => $user->id,
      'courseId'  => $course->id,
      'lessonId'  => $lesson->id,
    ]),
  ]])
);
$data = json_decode($response, true);
$iframeUrl = $data['iframeUrl'];

// In your template:
// <iframe src="<?= htmlspecialchars($iframeUrl) ?>" width="100%" height="450"></iframe>`}</pre>
          </CardContent>
        </Card>
      )}

      {/* New key display dialog */}
      <Dialog open={!!showNewKey} onOpenChange={() => setShowNewKey(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>API Key Created</DialogTitle>
            <DialogDescription>Copy this key now — it will NOT be shown again.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label className="text-xs text-muted-foreground">Label</Label>
              <p className="text-sm font-medium">{showNewKey?.label}</p>
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">API Key (copy now)</Label>
              <div className="flex items-center gap-2 bg-yellow-50 dark:bg-yellow-950 border border-yellow-300 dark:border-yellow-700 p-3 rounded font-mono text-xs break-all" data-testid="text-new-apikey">
                <span className="flex-1">{showNewKey?.rawKey}</span>
                <CopyButton text={showNewKey?.rawKey || ""} />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">Set this as <code>SYAN_API_KEY</code> in your LMS server environment variables.</p>
          </div>
          <DialogFooter>
            <Button onClick={() => setShowNewKey(null)} data-testid="button-close-apikey">I've copied the key</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function LogsTab() {
  const [filters, setFilters] = useState({ status: "", publicId: "", lmsUserId: "" });
  const { data, isLoading } = useQuery<{ logs: any[]; total: number }>({
    queryKey: ["/api/admin/integrations/logs", filters],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (filters.status) params.set("status", filters.status);
      if (filters.publicId) params.set("publicId", filters.publicId);
      if (filters.lmsUserId) params.set("lmsUserId", filters.lmsUserId);
      params.set("limit", "50");
      const res = await fetch(`/api/admin/integrations/logs?${params}`);
      return res.json();
    },
  });

  return (
    <div className="space-y-4">
      <h3 className="text-lg font-semibold" data-testid="text-logs-title">Launch Logs</h3>
      <div className="flex gap-2 flex-wrap">
        <Select value={filters.status || "all"} onValueChange={v => setFilters(p => ({ ...p, status: v === "all" ? "" : v }))}>
          <SelectTrigger className="w-36" data-testid="select-log-status"><SelectValue placeholder="Status" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            <SelectItem value="success">Success</SelectItem>
            <SelectItem value="failed">Failed</SelectItem>
            <SelectItem value="denied">Denied</SelectItem>
          </SelectContent>
        </Select>
        <Input className="w-40" placeholder="Public ID" value={filters.publicId} onChange={e => setFilters(p => ({ ...p, publicId: e.target.value }))} data-testid="input-log-public-id" />
        <Input className="w-40" placeholder="LMS User ID" value={filters.lmsUserId} onChange={e => setFilters(p => ({ ...p, lmsUserId: e.target.value }))} data-testid="input-log-user-id" />
      </div>
      {isLoading && <p className="text-muted-foreground">Loading...</p>}
      <div className="rounded border overflow-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="text-left p-2">Time</th>
              <th className="text-left p-2">Status</th>
              <th className="text-left p-2">Video</th>
              <th className="text-left p-2">LMS User</th>
              <th className="text-left p-2">Origin</th>
              <th className="text-left p-2">Reason</th>
            </tr>
          </thead>
          <tbody>
            {(data?.logs || []).map((l: any) => (
              <tr key={l.id} className="border-t" data-testid={`row-log-${l.id}`}>
                <td className="p-2 whitespace-nowrap text-xs">{new Date(l.createdAt).toLocaleString()}</td>
                <td className="p-2"><Badge variant={l.status === "success" ? "default" : "destructive"}>{l.status}</Badge></td>
                <td className="p-2 font-mono text-xs">{l.publicId}</td>
                <td className="p-2 text-xs">{l.lmsUserId}</td>
                <td className="p-2 text-xs">{l.origin || "-"}</td>
                <td className="p-2 text-xs text-muted-foreground">{l.failureReason || "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!isLoading && (!data?.logs || data.logs.length === 0) && (
          <p className="text-center text-muted-foreground py-6 text-sm">No launch logs yet</p>
        )}
      </div>
      {data?.total ? <p className="text-xs text-muted-foreground">Total: {data.total}</p> : null}
    </div>
  );
}

function SessionsTab() {
  const { toast } = useToast();
  const [filters, setFilters] = useState({ status: "", publicId: "" });
  const { data, isLoading } = useQuery<{ sessions: any[]; total: number }>({
    queryKey: ["/api/admin/integrations/sessions", filters],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (filters.status) params.set("status", filters.status);
      if (filters.publicId) params.set("publicId", filters.publicId);
      params.set("limit", "50");
      const res = await fetch(`/api/admin/integrations/sessions?${params}`);
      return res.json();
    },
  });

  const revokeMutation = useMutation({
    mutationFn: async (id: string) => { await apiRequest("POST", `/api/admin/integrations/sessions/${id}/revoke`); },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/integrations/sessions"] });
      toast({ title: "Session revoked" });
    },
  });

  return (
    <div className="space-y-4">
      <h3 className="text-lg font-semibold" data-testid="text-sessions-title">Playback Sessions</h3>
      <div className="flex gap-2">
        <Select value={filters.status || "all"} onValueChange={v => setFilters(p => ({ ...p, status: v === "all" ? "" : v }))}>
          <SelectTrigger className="w-36" data-testid="select-session-status"><SelectValue placeholder="Status" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="ended">Ended</SelectItem>
            <SelectItem value="revoked">Revoked</SelectItem>
          </SelectContent>
        </Select>
        <Input className="w-40" placeholder="Public ID" value={filters.publicId} onChange={e => setFilters(p => ({ ...p, publicId: e.target.value }))} data-testid="input-session-public-id" />
      </div>
      {isLoading && <p className="text-muted-foreground">Loading...</p>}
      <div className="rounded border overflow-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="text-left p-2">Started</th>
              <th className="text-left p-2">Status</th>
              <th className="text-left p-2">Auth</th>
              <th className="text-left p-2">Video</th>
              <th className="text-left p-2">LMS User</th>
              <th className="text-left p-2">Watch</th>
              <th className="text-left p-2">Complete</th>
              <th className="text-left p-2">Last Ping</th>
              <th className="text-left p-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {(data?.sessions || []).map((s: any) => {
              const meta = s.sessionMetadata || {};
              const authMode = meta.authMode === "api_key" ? "API Key" : meta.authMode === "lms_integration" ? "LMS Token" : "LMS";
              return (
                <tr key={s.id} className="border-t" data-testid={`row-session-${s.id}`}>
                  <td className="p-2 whitespace-nowrap text-xs">{new Date(s.startedAt).toLocaleString()}</td>
                  <td className="p-2">
                    <Badge variant={s.status === "active" ? "default" : s.status === "revoked" ? "destructive" : "secondary"} data-testid={`badge-status-${s.id}`}>{s.status}</Badge>
                  </td>
                  <td className="p-2"><Badge variant="outline" data-testid={`badge-auth-${s.id}`}>{authMode}</Badge></td>
                  <td className="p-2 font-mono text-xs">{s.publicId}</td>
                  <td className="p-2 text-xs">{s.lmsUserId}</td>
                  <td className="p-2 text-xs">{s.watchedSeconds}s</td>
                  <td className="p-2 text-xs">{s.completionPercent}%</td>
                  <td className="p-2 whitespace-nowrap text-xs">{s.lastPingAt ? new Date(s.lastPingAt).toLocaleString() : "-"}</td>
                  <td className="p-2">
                    {s.status === "active" && (
                      <Button size="sm" variant="destructive" onClick={() => revokeMutation.mutate(s.id)} data-testid={`button-revoke-${s.id}`}>Revoke</Button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!isLoading && (!data?.sessions || data.sessions.length === 0) && (
          <p className="text-center text-muted-foreground py-6 text-sm">No sessions yet</p>
        )}
      </div>
    </div>
  );
}

function DocsTab() {
  const { toast } = useToast();
  const [testClientId, setTestClientId] = useState("");
  const [testPublicId, setTestPublicId] = useState("");
  const [testUserId, setTestUserId] = useState("test-student-1");
  const [testToken, setTestToken] = useState("");

  const { data: clients = [] } = useQuery<any[]>({
    queryKey: ["/api/admin/integrations/clients"],
  });

  const generateMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/admin/integrations/test-token", {
        clientId: testClientId,
        publicId: testPublicId,
        userId: testUserId,
      });
      return res.json();
    },
    onSuccess: (data) => setTestToken(data.token),
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const cmsBase = window.location.origin;

  return (
    <div className="space-y-6">
      <h3 className="text-lg font-semibold" data-testid="text-docs-title">Docs & Test</h3>

      <Card className="border-primary/20 bg-primary/5">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2"><Zap className="h-4 w-4 text-primary" />Simple API (Recommended for syanrx.com)</CardTitle>
          <CardDescription className="text-xs">No HMAC signing. Just one API key + one POST call.</CardDescription>
        </CardHeader>
        <CardContent>
          <pre className="bg-muted p-3 rounded text-xs overflow-x-auto whitespace-pre">{`// LMS server — get an iframe URL in one call
const { iframeUrl } = await fetch('${cmsBase}/api/integrations/embed-url', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Api-Key': process.env.SYAN_API_KEY },
  body: JSON.stringify({ videoId: 'v_abc123', studentId: req.user.id }),
}).then(r => r.json());

// In your HTML:
// <iframe src="${'${iframeUrl}'}" width="100%" height="450" allowfullscreen></iframe>`}</pre>
          <p className="text-xs text-muted-foreground mt-2">Create API keys in the <strong>API Keys</strong> tab. Your LMS only needs one env var: <code>SYAN_API_KEY</code>.</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Test Token Generator (Advanced / HMAC mode)</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-3 gap-3">
            <div>
              <Label>Client</Label>
              <Select value={testClientId} onValueChange={setTestClientId}>
                <SelectTrigger data-testid="select-test-client"><SelectValue placeholder="Select client" /></SelectTrigger>
                <SelectContent>
                  {(clients as any[]).map((c: any) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div><Label>Video Public ID</Label><Input value={testPublicId} onChange={e => setTestPublicId(e.target.value)} placeholder="abc123" data-testid="input-test-public-id" /></div>
            <div><Label>LMS User ID</Label><Input value={testUserId} onChange={e => setTestUserId(e.target.value)} data-testid="input-test-user-id" /></div>
          </div>
          <Button onClick={() => generateMutation.mutate()} disabled={!testClientId || !testPublicId || generateMutation.isPending} data-testid="button-generate-test-token">Generate Test Token</Button>
          {testToken && (
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">Generated Token</Label>
              <div className="bg-muted p-2 rounded font-mono text-xs break-all flex items-start gap-2" data-testid="text-test-token">
                <span className="flex-1">{testToken}</span>
                <CopyButton text={testToken} />
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">API Endpoints</CardTitle></CardHeader>
        <CardContent>
          <div className="space-y-2 text-sm">
            <div className="flex items-center gap-2 p-2 bg-primary/5 rounded border border-primary/20">
              <Badge className="shrink-0">POST</Badge>
              <code className="text-xs">/api/integrations/embed-url</code>
              <span className="text-xs text-muted-foreground ml-auto">Simple mode — API key auth → iframe URL</span>
            </div>
            <div className="flex items-center gap-2"><Badge variant="outline" className="shrink-0">POST</Badge><code className="text-xs">/api/integrations/player/:publicId/mint</code><span className="text-xs text-muted-foreground ml-2">HMAC mode — exchange launch token</span></div>
            <div className="flex items-center gap-2"><Badge variant="outline" className="shrink-0">POST</Badge><code className="text-xs">/api/integrations/player/:publicId/refresh</code><span className="text-xs text-muted-foreground ml-2">Refresh embed token</span></div>
            <div className="flex items-center gap-2"><Badge variant="outline" className="shrink-0">POST</Badge><code className="text-xs">/api/integrations/player/:publicId/ping</code><span className="text-xs text-muted-foreground ml-2">Report playback progress</span></div>
            <div className="flex items-center gap-2"><Badge variant="outline" className="shrink-0">POST</Badge><code className="text-xs">/api/integrations/player/:publicId/events</code><span className="text-xs text-muted-foreground ml-2">Send player events</span></div>
            <div className="flex items-center gap-2"><Badge variant="outline" className="shrink-0">POST</Badge><code className="text-xs">/api/integrations/player/:publicId/complete</code><span className="text-xs text-muted-foreground ml-2">Mark completion</span></div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export default function IntegrationsPage() {
  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex items-start justify-between mb-6">
        <div className="flex items-center gap-3">
          <Shield className="h-6 w-6 text-primary" />
          <div>
            <h1 className="text-2xl font-bold" data-testid="text-integrations-heading">Integrations</h1>
            <p className="text-sm text-muted-foreground">Manage LMS integration clients, API keys, and view session logs</p>
          </div>
        </div>
        <DownloadGuideButton />
      </div>

      <Tabs defaultValue="apikeys">
        <TabsList className="mb-4" data-testid="tabs-integrations">
          <TabsTrigger value="apikeys" data-testid="tab-apikeys"><Key className="h-4 w-4 mr-1" />API Keys</TabsTrigger>
          <TabsTrigger value="clients" data-testid="tab-clients"><Shield className="h-4 w-4 mr-1" />Clients</TabsTrigger>
          <TabsTrigger value="logs" data-testid="tab-logs"><FileText className="h-4 w-4 mr-1" />Launch Logs</TabsTrigger>
          <TabsTrigger value="sessions" data-testid="tab-sessions"><Activity className="h-4 w-4 mr-1" />Sessions</TabsTrigger>
          <TabsTrigger value="docs" data-testid="tab-docs"><FileText className="h-4 w-4 mr-1" />Docs & Test</TabsTrigger>
        </TabsList>

        <TabsContent value="apikeys"><ApiKeysTab /></TabsContent>
        <TabsContent value="clients"><ClientsTab /></TabsContent>
        <TabsContent value="logs"><LogsTab /></TabsContent>
        <TabsContent value="sessions"><SessionsTab /></TabsContent>
        <TabsContent value="docs"><DocsTab /></TabsContent>
      </Tabs>
    </div>
  );
}
