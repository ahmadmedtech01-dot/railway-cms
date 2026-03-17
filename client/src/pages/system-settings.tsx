import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, useEffect } from "react";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Settings, Cloud, Shield, Zap, AlertTriangle, CheckCircle, Eye, EyeOff,
  Save, Server, Database, Key, Video, RefreshCw, Plus, Trash2, Star, ChevronDown, ChevronUp, Copy,
} from "lucide-react";
import type { StorageConnection } from "@shared/schema";

const AWS_REGIONS = [
  "us-east-1", "us-east-2", "us-west-1", "us-west-2",
  "eu-west-1", "eu-west-2", "eu-central-1", "eu-north-1",
  "ap-southeast-1", "ap-southeast-2", "ap-northeast-1", "ap-south-1",
  "ca-central-1", "sa-east-1",
];

export default function SystemSettingsPage() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [showSecret, setShowSecret] = useState(false);
  const [formData, setFormData] = useState<Record<string, string>>({});
  const [killSwitch, setKillSwitch] = useState(false);

  const { data: settings = [], isLoading } = useQuery<{ key: string; value: string }[]>({
    queryKey: ["/api/settings"],
    queryFn: async () => {
      const response = await fetch("/api/settings");
      const data = await response.json().catch(() => []);
      return Array.isArray(data) ? data : [];
    },
  });

  useEffect(() => {
    if (settings.length > 0) {
      const obj: Record<string, string> = {};
      settings.forEach(s => { obj[s.key] = s.value || ""; });
      setFormData(obj);
      setKillSwitch(obj.global_kill_switch === "true");
    }
  }, [settings]);

  const save = useMutation({
    mutationFn: (data: Record<string, string>) => apiRequest("PUT", "/api/settings", data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/settings"] });
      toast({ title: "Settings saved successfully" });
    },
    onError: () => toast({ title: "Failed to save settings", variant: "destructive" }),
  });

  const handleChange = (key: string, value: string) => {
    setFormData(prev => ({ ...prev, [key]: value }));
  };

  const handleSaveS3 = () => {
    save.mutate({
      aws_access_key_id: formData.aws_access_key_id || "",
      aws_secret_access_key: formData.aws_secret_access_key || "",
      aws_region: formData.aws_region || "us-east-1",
      s3_bucket: formData.s3_bucket || "",
      s3_private_prefix: formData.s3_private_prefix || "raw/",
      s3_hls_prefix: formData.s3_hls_prefix || "hls/",
    });
  };

  const handleSaveGeneral = () => {
    save.mutate({
      signing_secret: formData.signing_secret || "",
      max_upload_size_mb: formData.max_upload_size_mb || "2048",
      ffmpeg_enabled: formData.ffmpeg_enabled || "true",
    });
  };

  const handleToggleKillSwitch = (val: boolean) => {
    setKillSwitch(val);
    save.mutate({ global_kill_switch: val ? "true" : "false" });
  };

  const s3Configured = !!(formData.aws_access_key_id && formData.s3_bucket && formData.aws_region);

  // Storage Connections state
  const { data: storageConns = [], refetch: refetchConns } = useQuery<StorageConnection[]>({
    queryKey: ["/api/storage-connections"],
    queryFn: async () => {
      const response = await fetch("/api/storage-connections");
      const data = await response.json().catch(() => []);
      return Array.isArray(data) ? data : [];
    },
  });

  const [showAddConn, setShowAddConn] = useState(false);
  const [connProvider, setConnProvider] = useState<"backblaze_b2" | "aws_s3" | "cloudflare_r2">("backblaze_b2");
  const [connName, setConnName] = useState("Backblaze B2 - mytestvideo");
  const [connBucket, setConnBucket] = useState("mytestvideo");
  const [connEndpoint, setConnEndpoint] = useState("https://s3.ca-east-006.backblazeb2.com");
  const [connRawPrefix, setConnRawPrefix] = useState("raw/");
  const [connHlsPrefix, setConnHlsPrefix] = useState("hls/");
  const [connTestResults, setConnTestResults] = useState<Record<string, { ok: boolean; message: string }>>({});
  const [connTestLoading, setConnTestLoading] = useState<Record<string, boolean>>({});
  const [showCorsTip, setShowCorsTip] = useState(false);

  const createConn = useMutation({
    mutationFn: (data: { name: string; provider: string; config: object }) =>
      apiRequest("POST", "/api/storage-connections", data).then(r => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/storage-connections"] });
      setShowAddConn(false);
      toast({ title: "Storage connection added" });
    },
    onError: () => toast({ title: "Failed to add connection", variant: "destructive" }),
  });

  const deleteConn = useMutation({
    mutationFn: (id: string) => apiRequest("DELETE", `/api/storage-connections/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/storage-connections"] }),
    onError: () => toast({ title: "Failed to delete connection", variant: "destructive" }),
  });

  const setActiveConn = useMutation({
    mutationFn: (id: string) => apiRequest("POST", `/api/storage-connections/${id}/set-active`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/storage-connections"] });
      toast({ title: "Active storage connection updated" });
    },
    onError: () => toast({ title: "Failed to set active connection", variant: "destructive" }),
  });

  const testConn = async (id: string) => {
    setConnTestLoading(prev => ({ ...prev, [id]: true }));
    setConnTestResults(prev => ({ ...prev, [id]: undefined as any }));
    try {
      const res = await fetch(`/api/storage-connections/${id}/test`, { method: "POST" });
      const data = await res.json();
      setConnTestResults(prev => ({ ...prev, [id]: data }));
    } catch (e: any) {
      setConnTestResults(prev => ({ ...prev, [id]: { ok: false, message: e.message } }));
    } finally {
      setConnTestLoading(prev => ({ ...prev, [id]: false }));
    }
  };

  const handleAddConn = () => {
    const config = (connProvider === "backblaze_b2" || connProvider === "cloudflare_r2")
      ? { endpoint: connEndpoint, bucket: connBucket, rawPrefix: connRawPrefix, hlsPrefix: connHlsPrefix }
      : { bucket: connBucket, rawPrefix: connRawPrefix, hlsPrefix: connHlsPrefix };
    createConn.mutate({ name: connName, provider: connProvider, config });
  };

  const B2_CORS_EXAMPLE = JSON.stringify([{
    corsRuleName: "cms-hls",
    allowedOrigins: ["https://YOUR_PLAYER_DOMAIN"],
    allowedHeaders: ["*"],
    allowedOperations: ["b2_download_file_by_name", "b2_download_file_by_id"],
    exposeHeaders: ["ETag", "Content-Range", "Accept-Ranges"],
    maxAgeSeconds: 3600,
  }], null, 2);

  const [vimeoHealth, setVimeoHealth] = useState<{ ok: boolean; name?: string; accountType?: string; error?: string; hint?: string; hints?: string[] } | null>(null);
  const [vimeoHealthLoading, setVimeoHealthLoading] = useState(false);

  const handleTestVimeo = async () => {
    setVimeoHealthLoading(true);
    setVimeoHealth(null);
    try {
      if (formData.vimeo_access_token) {
        await apiRequest("PUT", "/api/settings", { vimeo_access_token: formData.vimeo_access_token });
      }
      const res = await fetch("/api/integrations/vimeo/health");
      const data = await res.json();
      setVimeoHealth(data);
    } catch (e: any) {
      setVimeoHealth({ ok: false, error: e.message });
    } finally {
      setVimeoHealthLoading(false);
    }
  };

  const handleSaveVimeo = () => {
    save.mutate({ vimeo_access_token: formData.vimeo_access_token || "" });
  };

  if (isLoading) {
    return (
      <div className="p-6 space-y-4">
        {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-48 w-full" />)}
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6 max-w-3xl">
      <div>
        <h1 className="text-2xl font-bold text-foreground">System Settings</h1>
        <p className="text-sm text-muted-foreground mt-0.5">Configure AWS, storage, security, and global controls</p>
      </div>

      {/* Kill Switch */}
      <Card className={`border ${killSwitch ? "border-destructive" : "border-card-border"}`}>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Zap className={`h-4 w-4 ${killSwitch ? "text-destructive" : "text-muted-foreground"}`} />
            Global Kill Switch
            {killSwitch && <Badge variant="destructive" className="ml-auto">ACTIVE</Badge>}
          </CardTitle>
          <CardDescription>
            When ON, all video playback endpoints return 503. Use in emergencies.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-4 rounded-lg border border-border p-4">
            <AlertTriangle className={`h-5 w-5 shrink-0 ${killSwitch ? "text-destructive" : "text-muted-foreground"}`} />
            <div className="flex-1">
              <p className="text-sm font-medium text-foreground">Disable all video playback</p>
              <p className="text-xs text-muted-foreground">All embeds and share links will show "Service temporarily disabled"</p>
            </div>
            <Switch
              checked={killSwitch}
              onCheckedChange={handleToggleKillSwitch}
              data-testid="switch-kill-switch"
            />
          </div>
        </CardContent>
      </Card>

      {/* Storage Connections */}
      <Card className="border border-card-border">
        <CardHeader>
          <div className="flex items-start justify-between gap-2">
            <div>
              <CardTitle className="text-base flex items-center gap-2">
                <Server className="h-4 w-4" />
                Storage Connections
              </CardTitle>
              <CardDescription className="mt-1">
                Manage cloud storage providers for raw uploads and HLS output. The active connection is used for all new video uploads.
              </CardDescription>
            </div>
            <Button size="sm" variant="outline" onClick={() => setShowAddConn(v => !v)} data-testid="button-add-storage-conn">
              <Plus className="h-3.5 w-3.5 mr-1.5" />
              Add
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Existing connections */}
          {storageConns.length === 0 && !showAddConn && (
            <p className="text-xs text-muted-foreground">No storage connections configured. Add one to enable B2, R2, or S3 uploads.</p>
          )}
          {storageConns.map(conn => {
            const cfg = conn.config as any;
            const testResult = connTestResults[conn.id];
            const isTesting = connTestLoading[conn.id];
            return (
              <div key={conn.id} className={`rounded-lg border p-4 space-y-3 ${conn.isActive ? "border-primary/40 bg-primary/5" : "border-border"}`}>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium text-foreground">{conn.name}</span>
                  <Badge variant="outline" className="text-xs">
                    {conn.provider === "backblaze_b2" ? "Backblaze B2" : conn.provider === "cloudflare_r2" ? "Cloudflare R2" : "AWS S3"}
                  </Badge>
                  {conn.isActive && (
                    <Badge className="text-xs bg-primary/10 text-primary border-0">
                      <Star className="h-3 w-3 mr-1" />Active
                    </Badge>
                  )}
                  <div className="ml-auto flex gap-1.5">
                    {!conn.isActive && (
                      <Button size="sm" variant="outline" onClick={() => setActiveConn.mutate(conn.id)} disabled={setActiveConn.isPending} data-testid={`button-set-active-${conn.id}`}>
                        Set Active
                      </Button>
                    )}
                    <Button size="sm" variant="outline" onClick={() => testConn(conn.id)} disabled={isTesting} data-testid={`button-test-conn-${conn.id}`}>
                      <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${isTesting ? "animate-spin" : ""}`} />
                      {isTesting ? "Testing…" : "Test"}
                    </Button>
                    <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => deleteConn.mutate(conn.id)} data-testid={`button-delete-conn-${conn.id}`}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  {cfg.endpoint && <span>Endpoint: <span className="text-foreground font-mono text-[11px]">{cfg.endpoint}</span></span>}
                  <span>Bucket: <span className="text-foreground font-medium">{cfg.bucket || "—"}</span></span>
                  <span>Raw prefix: <code className="bg-muted px-1 rounded">{cfg.rawPrefix || "raw/"}</code></span>
                  <span>HLS prefix: <code className="bg-muted px-1 rounded">{cfg.hlsPrefix || "hls/"}</code></span>
                  {conn.provider === "backblaze_b2" && (
                    <span className="col-span-2 text-muted-foreground">Credentials: B2_KEY_ID + B2_APPLICATION_KEY from server environment (never shown here)</span>
                  )}
                  {conn.provider === "cloudflare_r2" && (
                    <span className="col-span-2 text-muted-foreground">Credentials: R2_ACCESS_KEY_ID + R2_SECRET_ACCESS_KEY from server environment (never shown here)</span>
                  )}
                </div>

                {testResult && (
                  <div className={`rounded-md border p-2 text-xs flex items-start gap-2 ${testResult.ok ? "border-green-500/30 bg-green-500/5" : "border-destructive/30 bg-destructive/5"}`}>
                    {testResult.ok
                      ? <CheckCircle className="h-3.5 w-3.5 text-green-500 shrink-0 mt-0.5" />
                      : <AlertTriangle className="h-3.5 w-3.5 text-destructive shrink-0 mt-0.5" />}
                    <span className={testResult.ok ? "text-green-600 dark:text-green-400" : "text-destructive"}>{testResult.message}</span>
                  </div>
                )}
              </div>
            );
          })}

          {/* Add connection form */}
          {showAddConn && (
            <div className="rounded-lg border border-dashed border-border p-4 space-y-4">
              <p className="text-sm font-medium text-foreground">Add Storage Connection</p>
              <div className="space-y-1.5">
                <Label>Provider</Label>
                <Select value={connProvider} onValueChange={(v: any) => {
                  setConnProvider(v);
                  if (v === "backblaze_b2") {
                    setConnName("Backblaze B2 - mytestvideo");
                    setConnBucket("mytestvideo");
                    setConnEndpoint("https://s3.ca-east-006.backblazeb2.com");
                  } else if (v === "cloudflare_r2") {
                    setConnName("Cloudflare R2 - my-bucket");
                    setConnBucket("my-bucket");
                    setConnEndpoint("https://<account-id>.r2.cloudflarestorage.com");
                  } else {
                    setConnName("AWS S3 - my-bucket");
                    setConnEndpoint("");
                  }
                }}>
                  <SelectTrigger data-testid="select-conn-provider">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="backblaze_b2">Backblaze B2 (S3 Compatible)</SelectItem>
                    <SelectItem value="cloudflare_r2">Cloudflare R2 (S3 Compatible)</SelectItem>
                    <SelectItem value="aws_s3">AWS S3</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Connection Name</Label>
                <Input value={connName} onChange={e => setConnName(e.target.value)} data-testid="input-conn-name" />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label>Bucket Name</Label>
                  <Input value={connBucket} onChange={e => setConnBucket(e.target.value)} placeholder="mytestvideo" data-testid="input-conn-bucket" />
                </div>
                {(connProvider === "backblaze_b2" || connProvider === "cloudflare_r2") && (
                  <div className="space-y-1.5">
                    <Label>S3 Endpoint</Label>
                    <Input value={connEndpoint} onChange={e => setConnEndpoint(e.target.value)} placeholder={connProvider === "cloudflare_r2" ? "https://<account-id>.r2.cloudflarestorage.com" : "https://s3.ca-east-006.backblazeb2.com"} data-testid="input-conn-endpoint" />
                  </div>
                )}
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label>Raw Prefix</Label>
                  <Input value={connRawPrefix} onChange={e => setConnRawPrefix(e.target.value)} placeholder="raw/" data-testid="input-conn-raw-prefix" />
                </div>
                <div className="space-y-1.5">
                  <Label>HLS Prefix</Label>
                  <Input value={connHlsPrefix} onChange={e => setConnHlsPrefix(e.target.value)} placeholder="hls/" data-testid="input-conn-hls-prefix" />
                </div>
              </div>
              {connProvider === "backblaze_b2" && (
                <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
                  <Key className="h-4 w-4 shrink-0 mt-0.5" />
                  <div>
                    <p className="font-medium text-foreground mb-0.5">B2 credentials are stored in server secrets (never in UI)</p>
                    <p>Set <code className="bg-background px-1 rounded">B2_KEY_ID</code> and <code className="bg-background px-1 rounded">B2_APPLICATION_KEY</code> in Replit Secrets. The Access Key ID is: <code className="bg-background px-1 rounded">a54c2d711411</code> (display only).</p>
                  </div>
                </div>
              )}
              {connProvider === "cloudflare_r2" && (
                <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
                  <Key className="h-4 w-4 shrink-0 mt-0.5" />
                  <div>
                    <p className="font-medium text-foreground mb-0.5">R2 credentials are stored in server secrets (never in UI)</p>
                    <p>Set <code className="bg-background px-1 rounded">R2_ACCESS_KEY_ID</code> and <code className="bg-background px-1 rounded">R2_SECRET_ACCESS_KEY</code> in Replit Secrets. Optionally set <code className="bg-background px-1 rounded">R2_ENDPOINT</code> and <code className="bg-background px-1 rounded">R2_REGION</code> (defaults to "auto").</p>
                  </div>
                </div>
              )}
              <div className="flex gap-2">
                <Button size="sm" onClick={handleAddConn} disabled={createConn.isPending} data-testid="button-save-conn">
                  <Save className="h-3.5 w-3.5 mr-1.5" />
                  {createConn.isPending ? "Saving…" : "Save Connection"}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setShowAddConn(false)}>Cancel</Button>
              </div>
            </div>
          )}

          {/* B2 CORS guidance */}
          {storageConns.some(c => c.provider === "backblaze_b2" || c.provider === "cloudflare_r2") && (
            <div className="rounded-lg border border-border bg-muted/30 p-3 space-y-2">
              <button
                className="flex items-center gap-2 text-xs font-medium text-foreground w-full text-left"
                onClick={() => setShowCorsTip(v => !v)}
              >
                {showCorsTip ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                B2 CORS Configuration (required for browser HLS playback)
              </button>
              {showCorsTip && (
                <div className="text-xs text-muted-foreground space-y-2">
                  <p>If serving HLS signed URLs directly from B2 to the browser, add these CORS rules to your B2 bucket via the Backblaze dashboard or API. Replace <code className="bg-background px-1 rounded">YOUR_PLAYER_DOMAIN</code> with your actual domain.</p>
                  <div className="relative">
                    <pre className="bg-background border border-border rounded-md p-3 text-[11px] font-mono overflow-x-auto whitespace-pre-wrap">{B2_CORS_EXAMPLE}</pre>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="absolute top-2 right-2 h-6 px-2 text-xs"
                      onClick={() => { navigator.clipboard.writeText(B2_CORS_EXAMPLE); toast({ title: "CORS JSON copied" }); }}
                    >
                      <Copy className="h-3 w-3 mr-1" />Copy
                    </Button>
                  </div>
                  <p className="text-muted-foreground">Go to Backblaze → Buckets → your bucket → CORS Rules → Edit, and paste the JSON above.</p>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* AWS / S3 Configuration */}
      <Card className="border border-card-border">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Cloud className="h-4 w-4" />
            AWS / S3 Storage (Legacy)
            {s3Configured
              ? <Badge className="ml-auto bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-0"><CheckCircle className="h-3 w-3 mr-1" />Configured</Badge>
              : <Badge variant="outline" className="ml-auto text-muted-foreground">Not Configured</Badge>
            }
          </CardTitle>
          <CardDescription>
            Configure your S3 bucket for video storage and HLS streaming. Required for video uploads.
            You can update these anytime — changes take effect immediately.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>AWS Access Key ID</Label>
              <Input
                type="text"
                value={formData.aws_access_key_id || ""}
                onChange={e => handleChange("aws_access_key_id", e.target.value)}
                placeholder="AKIAIOSFODNN7EXAMPLE"
                data-testid="input-aws-key"
              />
            </div>
            <div className="space-y-1.5">
              <Label>AWS Secret Access Key</Label>
              <div className="relative">
                <Input
                  type={showSecret ? "text" : "password"}
                  value={formData.aws_secret_access_key || ""}
                  onChange={e => handleChange("aws_secret_access_key", e.target.value)}
                  placeholder="wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
                  className="pr-9"
                  data-testid="input-aws-secret"
                />
                <button
                  type="button"
                  onClick={() => setShowSecret(!showSecret)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground"
                >
                  {showSecret ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>AWS Region</Label>
              <Select value={formData.aws_region || "us-east-1"} onValueChange={v => handleChange("aws_region", v)}>
                <SelectTrigger data-testid="select-aws-region">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {AWS_REGIONS.map(r => <SelectItem key={r} value={r}>{r}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>S3 Bucket Name</Label>
              <Input
                value={formData.s3_bucket || ""}
                onChange={e => handleChange("s3_bucket", e.target.value)}
                placeholder="my-video-bucket"
                data-testid="input-s3-bucket"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>Raw Upload Prefix</Label>
              <Input
                value={formData.s3_private_prefix || "raw/"}
                onChange={e => handleChange("s3_private_prefix", e.target.value)}
                placeholder="raw/"
              />
            </div>
            <div className="space-y-1.5">
              <Label>HLS Output Prefix</Label>
              <Input
                value={formData.s3_hls_prefix || "hls/"}
                onChange={e => handleChange("s3_hls_prefix", e.target.value)}
                placeholder="hls/"
              />
            </div>
          </div>
          <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
            <Server className="h-4 w-4 shrink-0 mt-0.5" />
            <div>
              <p>Your S3 bucket should be <strong className="text-foreground">private</strong> (no public access). The server generates short-lived signed URLs for secure playback.</p>
              <p className="mt-1">Currently supporting: S3 uploads, YouTube, Vimeo, Google Drive, OneDrive, and direct URL imports.</p>
            </div>
          </div>
          <Button onClick={handleSaveS3} disabled={save.isPending} data-testid="button-save-s3">
            <Save className="h-4 w-4 mr-1.5" />
            Save S3 Configuration
          </Button>
        </CardContent>
      </Card>

      {/* General / Security */}
      <Card className="border border-card-border">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Shield className="h-4 w-4" />
            Security & Processing
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label>Signing Secret</Label>
            <Input
              type="password"
              value={formData.signing_secret || ""}
              onChange={e => handleChange("signing_secret", e.target.value)}
              placeholder="Random secret for embed token signing"
              data-testid="input-signing-secret"
            />
            <p className="text-xs text-muted-foreground">Used to sign JWT embed tokens. Keep this secret and random (32+ chars).</p>
          </div>
          <div className="space-y-1.5">
            <Label>Max Upload Size (MB)</Label>
            <Input
              type="number"
              value={formData.max_upload_size_mb || "2048"}
              onChange={e => handleChange("max_upload_size_mb", e.target.value)}
              placeholder="2048"
            />
          </div>
          <div className="flex items-center justify-between gap-4 rounded-lg border border-border p-4">
            <div>
              <p className="text-sm font-medium text-foreground">ffmpeg Processing</p>
              <p className="text-xs text-muted-foreground">Enable server-side HLS transcoding via ffmpeg</p>
            </div>
            <Switch
              checked={formData.ffmpeg_enabled === "true"}
              onCheckedChange={val => handleChange("ffmpeg_enabled", val ? "true" : "false")}
              data-testid="switch-ffmpeg"
            />
          </div>
          <Button onClick={handleSaveGeneral} disabled={save.isPending} data-testid="button-save-general">
            <Save className="h-4 w-4 mr-1.5" />
            Save Settings
          </Button>
        </CardContent>
      </Card>

      {/* Vimeo Integration */}
      <Card className="border border-card-border">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Video className="h-4 w-4" />
            Vimeo Integration
          </CardTitle>
          <CardDescription>
            Configure a Vimeo Personal Access Token to allow the CMS to download and transcode your Vimeo videos to HLS.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label>Vimeo Personal Access Token</Label>
            <Input
              type="password"
              value={formData.vimeo_access_token || ""}
              onChange={e => handleChange("vimeo_access_token", e.target.value)}
              placeholder="Paste your Vimeo Personal Access Token here"
              data-testid="input-vimeo-token"
            />
            <p className="text-xs text-muted-foreground">
              Generate at <a href="https://developer.vimeo.com/apps" target="_blank" rel="noopener noreferrer" className="underline">developer.vimeo.com/apps</a>.
              Token must have scopes: <code className="bg-muted px-1 rounded">public</code>, <code className="bg-muted px-1 rounded">private</code>, <code className="bg-muted px-1 rounded">video_files</code>.
              The <strong>video_files</strong> scope requires a Vimeo Pro+ plan.
            </p>
          </div>

          {vimeoHealth && (
            <div className={`rounded-md border p-3 text-xs space-y-1 ${vimeoHealth.ok ? "border-green-500/30 bg-green-500/5" : "border-destructive/30 bg-destructive/5"}`}>
              {vimeoHealth.ok ? (
                <>
                  <div className="flex items-center gap-2">
                    <CheckCircle className="h-3.5 w-3.5 text-green-500" />
                    <span className="font-medium text-green-600 dark:text-green-400">Token is valid</span>
                  </div>
                  <p className="text-muted-foreground">Account: <span className="text-foreground font-medium">{vimeoHealth.name}</span> ({vimeoHealth.accountType})</p>
                  {vimeoHealth.hint && <p className="text-muted-foreground mt-1">{vimeoHealth.hint}</p>}
                </>
              ) : (
                <>
                  <div className="flex items-center gap-2">
                    <AlertTriangle className="h-3.5 w-3.5 text-destructive" />
                    <span className="font-medium text-destructive">Token check failed</span>
                  </div>
                  <p className="text-muted-foreground">{vimeoHealth.error}</p>
                  {(vimeoHealth.hints || []).map((h, i) => (
                    <p key={i} className="text-muted-foreground">• {h}</p>
                  ))}
                </>
              )}
            </div>
          )}

          <div className="flex gap-2">
            <Button onClick={handleSaveVimeo} disabled={save.isPending} variant="outline" data-testid="button-save-vimeo">
              <Save className="h-4 w-4 mr-1.5" />
              Save Token
            </Button>
            <Button onClick={handleTestVimeo} disabled={vimeoHealthLoading} variant="outline" data-testid="button-test-vimeo">
              <RefreshCw className={`h-4 w-4 mr-1.5 ${vimeoHealthLoading ? "animate-spin" : ""}`} />
              {vimeoHealthLoading ? "Testing…" : "Test Connection"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* About */}
      <Card className="border border-card-border">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Database className="h-4 w-4" />
            System Info
          </CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-2 gap-3 text-sm">
            {[
              { label: "Version", value: "1.0.0" },
              { label: "Database", value: "PostgreSQL" },
              { label: "S3 Status", value: s3Configured ? "Configured" : "Not configured" },
              { label: "ffmpeg", value: formData.ffmpeg_enabled === "true" ? "Enabled" : "Disabled" },
            ].map(item => (
              <div key={item.label}>
                <dt className="text-xs text-muted-foreground">{item.label}</dt>
                <dd className="font-medium text-foreground">{item.value}</dd>
              </div>
            ))}
          </dl>
        </CardContent>
      </Card>
    </div>
  );
}
