import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { Plus, Copy, RotateCw, Eye, Trash2, Shield, Activity, FileText, PlayCircle, XCircle } from "lucide-react";

function CopyButton({ text }: { text: string }) {
  const { toast } = useToast();
  return (
    <Button size="icon" variant="ghost" className="h-6 w-6" onClick={() => {
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
            <div><Label>Allowed Origins (comma-separated)</Label><Input value={allowedOrigins} onChange={e => setAllowedOrigins(e.target.value)} placeholder="https://lms.example.com" data-testid="input-allowed-origins" /></div>
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
              <th className="text-left p-2">Video</th>
              <th className="text-left p-2">LMS User</th>
              <th className="text-left p-2">Watch</th>
              <th className="text-left p-2">Complete</th>
              <th className="text-left p-2">Last Ping</th>
              <th className="text-left p-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {(data?.sessions || []).map((s: any) => (
              <tr key={s.id} className="border-t" data-testid={`row-session-${s.id}`}>
                <td className="p-2 whitespace-nowrap text-xs">{new Date(s.startedAt).toLocaleString()}</td>
                <td className="p-2"><Badge variant={s.status === "active" ? "default" : s.status === "revoked" ? "destructive" : "secondary"}>{s.status}</Badge></td>
                <td className="p-2 font-mono text-xs">{s.publicId}</td>
                <td className="p-2 text-xs">{s.lmsUserId}</td>
                <td className="p-2 text-xs">{s.watchedSeconds}s</td>
                <td className="p-2 text-xs">{s.completionPercent}%</td>
                <td className="p-2 whitespace-nowrap text-xs">{new Date(s.lastPingAt).toLocaleString()}</td>
                <td className="p-2">
                  {s.status === "active" && (
                    <Button size="sm" variant="destructive" onClick={() => revokeMutation.mutate(s.id)} data-testid={`button-revoke-${s.id}`}>Revoke</Button>
                  )}
                </td>
              </tr>
            ))}
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
      <h3 className="text-lg font-semibold" data-testid="text-docs-title">Integration Docs & Test</h3>

      <Card>
        <CardHeader><CardTitle className="text-base">Test Token Generator</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-3 gap-3">
            <div>
              <Label>Client</Label>
              <Select value={testClientId} onValueChange={setTestClientId}>
                <SelectTrigger data-testid="select-test-client"><SelectValue placeholder="Select client" /></SelectTrigger>
                <SelectContent>
                  {clients.map((c: any) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
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
        <CardHeader><CardTitle className="text-base">HMAC Signing (Node.js)</CardTitle></CardHeader>
        <CardContent>
          <pre className="bg-muted p-3 rounded text-xs overflow-x-auto whitespace-pre">{`const crypto = require('crypto');

const INTEGRATION_MASTER_SECRET = process.env.INTEGRATION_MASTER_SECRET;

function generateLaunchToken(clientKey, publicId, userId) {
  const payload = {
    iss: clientKey,           // your client key from CMS admin
    aud: 'cms-player',        // must be exactly this
    sub: userId,              // student/user ID in your LMS
    publicId: publicId,       // CMS video public ID
    exp: Math.floor(Date.now() / 1000) + 540,
    iat: Math.floor(Date.now() / 1000),
    jti: crypto.randomUUID(),
  };

  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', INTEGRATION_MASTER_SECRET)
                     .update(payloadB64).digest('hex');
  return payloadB64 + '.' + sig;
}`}</pre>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">JS SDK Integration</CardTitle></CardHeader>
        <CardContent>
          <pre className="bg-muted p-3 rounded text-xs overflow-x-auto whitespace-pre">{`<div id="player"></div>
<script src="${cmsBase}/sdk/player.js"><\/script>
<script>
  SyanPlayer.mount({
    element: '#player',
    publicId: 'YOUR_VIDEO_ID',
    launchToken: 'SIGNED_TOKEN_FROM_BACKEND',
    cmsBase: '${cmsBase}',
    autoplay: false,
    controls: true,
    onReady: function() { console.log('Player ready'); },
    onComplete: function() { console.log('Video completed'); },
    onError: function(e) { console.error('Error:', e); }
  });
<\/script>`}</pre>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">React Integration</CardTitle></CardHeader>
        <CardContent>
          <pre className="bg-muted p-3 rounded text-xs overflow-x-auto whitespace-pre">{`import SyanVideoPlayer from './SyanVideoPlayer';

<SyanVideoPlayer
  publicId="YOUR_VIDEO_ID"
  launchToken={token}
  cmsBase="${cmsBase}"
  controls
  autoplay={false}
  onComplete={() => console.log('done')}
/>`}</pre>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">iframe Integration</CardTitle></CardHeader>
        <CardContent>
          <pre className="bg-muted p-3 rounded text-xs overflow-x-auto whitespace-pre">{`<iframe
  src="${cmsBase}/api/integrations/embed/YOUR_VIDEO_ID?launchToken=SIGNED_TOKEN"
  allow="autoplay; fullscreen"
  allowfullscreen
  style="width:100%;height:400px;border:none;"
></iframe>`}</pre>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">API Endpoints</CardTitle></CardHeader>
        <CardContent>
          <div className="space-y-2 text-sm">
            <div><Badge variant="outline" className="mr-2">POST</Badge><code>/api/integrations/player/:publicId/mint</code> — Mint playback token</div>
            <div><Badge variant="outline" className="mr-2">POST</Badge><code>/api/integrations/player/:publicId/refresh</code> — Refresh embed token</div>
            <div><Badge variant="outline" className="mr-2">POST</Badge><code>/api/integrations/player/:publicId/ping</code> — Report playback progress</div>
            <div><Badge variant="outline" className="mr-2">POST</Badge><code>/api/integrations/player/:publicId/events</code> — Send player events</div>
            <div><Badge variant="outline" className="mr-2">POST</Badge><code>/api/integrations/player/:publicId/complete</code> — Mark completion</div>
            <div><Badge variant="outline" className="mr-2">GET</Badge><code>/api/integrations/videos/:publicId</code> — Video metadata</div>
            <div><Badge variant="outline" className="mr-2">GET</Badge><code>/api/integrations/player/:publicId/config</code> — Player config</div>
            <div><Badge variant="outline" className="mr-2">GET</Badge><code>/api/integrations/embed/:publicId</code> — iframe embed page</div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export default function IntegrationsPage() {
  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <Shield className="h-6 w-6 text-primary" />
        <div>
          <h1 className="text-2xl font-bold" data-testid="text-integrations-heading">Integrations</h1>
          <p className="text-sm text-muted-foreground">Manage LMS integration clients, view logs, and test connections</p>
        </div>
      </div>

      <Tabs defaultValue="clients">
        <TabsList className="mb-4" data-testid="tabs-integrations">
          <TabsTrigger value="clients" data-testid="tab-clients"><Shield className="h-4 w-4 mr-1" />Clients</TabsTrigger>
          <TabsTrigger value="logs" data-testid="tab-logs"><FileText className="h-4 w-4 mr-1" />Launch Logs</TabsTrigger>
          <TabsTrigger value="sessions" data-testid="tab-sessions"><Activity className="h-4 w-4 mr-1" />Sessions</TabsTrigger>
          <TabsTrigger value="docs" data-testid="tab-docs"><FileText className="h-4 w-4 mr-1" />Docs & Test</TabsTrigger>
        </TabsList>

        <TabsContent value="clients"><ClientsTab /></TabsContent>
        <TabsContent value="logs"><LogsTab /></TabsContent>
        <TabsContent value="sessions"><SessionsTab /></TabsContent>
        <TabsContent value="docs"><DocsTab /></TabsContent>
      </Tabs>
    </div>
  );
}
