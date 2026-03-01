import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useParams, Link } from "wouter";
import { useState, useEffect, useRef, useCallback } from "react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Slider } from "@/components/ui/slider";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  ArrowLeft, Eye, EyeOff, ExternalLink, Copy, CheckCircle, RefreshCw,
  Key, Shield, Droplets, Settings2, BarChart3, ScrollText, Code2,
  Plus, Trash2, AlertCircle, Video, Clock, Lock,
  Play, SkipBack, SkipForward, Volume2, Maximize, Sun, Gauge, Layers,
  RotateCcw, Zap, Upload, QrCode, Image, Film, Palette, AlignLeft,
  ChevronDown, HelpCircle, X, GripVertical, ToggleLeft,
} from "lucide-react";
import { formatDistanceToNow, format } from "date-fns";
import type { EmbedToken, VideoBanner } from "@shared/schema";
import { SecuritySettingsForm, defaultClientSecuritySettings, type ClientSecuritySettings } from "@/components/security-settings-form";
import QRCode from "qrcode";

function CopyButton({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <Button size="sm" variant="outline" onClick={copy} data-testid="button-copy">
      {copied ? <CheckCircle className="h-3.5 w-3.5 mr-1 text-emerald-500" /> : <Copy className="h-3.5 w-3.5 mr-1" />}
      {copied ? "Copied!" : (label || "Copy")}
    </Button>
  );
}

function SettingRow({ label, description, children }: { label: string; description?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-3 border-b border-border last:border-0">
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-foreground">{label}</p>
        {description && <p className="text-xs text-muted-foreground mt-0.5">{description}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}


function SaveBar({ dirty, onSave, isPending }: { dirty: boolean; onSave: () => void; isPending: boolean }) {
  if (!dirty) return null;
  return (
    <div className="flex items-center justify-between gap-3 mt-4 p-3 rounded-lg bg-amber-500/10 border border-amber-500/30">
      <p className="text-sm text-amber-700 dark:text-amber-400 font-medium">You have unsaved changes</p>
      <Button size="sm" onClick={onSave} disabled={isPending} data-testid="button-save-settings">
        {isPending ? "Saving…" : "Save Settings"}
      </Button>
    </div>
  );
}

interface PlayerSettings {
  allowSpeed?: boolean;
  allowQuality?: boolean;
  allowFullscreen?: boolean;
  allowSkip?: boolean;
  allowBrightness?: boolean;
  resumeEnabled?: boolean;
  autoplayAllowed?: boolean;
  startTime?: number;
  endTime?: number;
}

function PlayerPreview({ ps }: { ps: PlayerSettings }) {
  const [fakeProgress] = useState(38);

  return (
    <div className="sticky top-4">
      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">Live Preview</p>
      <div
        className="relative w-full rounded-xl overflow-hidden shadow-2xl border border-white/10"
        style={{ aspectRatio: "16/9", background: "linear-gradient(135deg, #0f0f0f 0%, #1a1a2e 50%, #0f0f0f 100%)" }}
        data-testid="player-preview"
      >
        {/* Fake video content */}
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="flex flex-col items-center gap-2 opacity-30">
            <Video className="h-12 w-12 text-white" />
            <span className="text-white text-xs">Preview</span>
          </div>
        </div>

        {/* Autoplay badge */}
        {ps.autoplayAllowed && (
          <div className="absolute top-3 left-3 flex items-center gap-1 bg-black/60 backdrop-blur-sm rounded px-2 py-0.5">
            <Zap className="h-3 w-3 text-yellow-400" />
            <span className="text-[10px] text-yellow-300 font-medium">Autoplay</span>
          </div>
        )}

        {/* Resume badge */}
        {ps.resumeEnabled && (
          <div className="absolute top-3 right-3 flex items-center gap-1 bg-black/60 backdrop-blur-sm rounded px-2 py-0.5">
            <RotateCcw className="h-3 w-3 text-blue-400" />
            <span className="text-[10px] text-blue-300 font-medium">Resume</span>
          </div>
        )}

        {/* Control bar */}
        <div
          className="absolute bottom-0 left-0 right-0 px-3 pt-6 pb-2.5"
          style={{ background: "linear-gradient(to top, rgba(0,0,0,0.85) 0%, transparent 100%)" }}
        >
          {/* Progress bar */}
          <div className="mb-2.5 relative">
            <div className="h-1 w-full rounded-full bg-white/20 overflow-hidden cursor-pointer">
              <div
                className="h-full rounded-full bg-white transition-all"
                style={{ width: `${fakeProgress}%`, opacity: ps.allowSkip ? 1 : 0.4 }}
              />
            </div>
            {ps.allowSkip && (
              <div
                className="absolute top-1/2 -translate-y-1/2 h-3 w-3 bg-white rounded-full shadow-md"
                style={{ left: `calc(${fakeProgress}% - 6px)` }}
              />
            )}
          </div>

          {/* Controls row */}
          <div className="flex items-center gap-1.5">
            {/* Always: play */}
            <button className="text-white/90 hover:text-white p-0.5">
              <Play className="h-4 w-4 fill-current" />
            </button>

            {/* Skip back/forward */}
            {ps.allowSkip && (
              <>
                <button className="text-white/70 hover:text-white p-0.5">
                  <SkipBack className="h-3.5 w-3.5" />
                </button>
                <button className="text-white/70 hover:text-white p-0.5">
                  <SkipForward className="h-3.5 w-3.5" />
                </button>
              </>
            )}

            {/* Time */}
            <span className="text-white/60 text-[10px] ml-0.5 tabular-nums">1:32 / 4:07</span>

            {/* Spacer */}
            <div className="flex-1" />

            {/* Brightness */}
            {ps.allowBrightness && (
              <button className="text-white/70 hover:text-white p-0.5" title="Brightness">
                <Sun className="h-3.5 w-3.5" />
              </button>
            )}

            {/* Speed */}
            {ps.allowSpeed && (
              <div className="flex items-center gap-0.5 text-white/70 hover:text-white cursor-pointer p-0.5">
                <Gauge className="h-3.5 w-3.5" />
                <span className="text-[10px] font-medium">1×</span>
              </div>
            )}

            {/* Quality */}
            {ps.allowQuality && (
              <div className="flex items-center gap-0.5 text-white/70 hover:text-white cursor-pointer p-0.5">
                <Layers className="h-3.5 w-3.5" />
                <span className="text-[10px] font-medium">Auto</span>
              </div>
            )}

            {/* Volume */}
            <button className="text-white/70 hover:text-white p-0.5">
              <Volume2 className="h-3.5 w-3.5" />
            </button>

            {/* Fullscreen */}
            {ps.allowFullscreen && (
              <button className="text-white/70 hover:text-white p-0.5">
                <Maximize className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Feature legend */}
      <div className="mt-3 flex flex-wrap gap-1.5">
        {[
          { key: "allowSkip", label: "Seek & Skip", color: "bg-blue-500/15 text-blue-400 border-blue-500/20" },
          { key: "allowSpeed", label: "Speed", color: "bg-purple-500/15 text-purple-400 border-purple-500/20" },
          { key: "allowQuality", label: "Quality", color: "bg-amber-500/15 text-amber-400 border-amber-500/20" },
          { key: "allowBrightness", label: "Brightness", color: "bg-yellow-500/15 text-yellow-400 border-yellow-500/20" },
          { key: "allowFullscreen", label: "Fullscreen", color: "bg-emerald-500/15 text-emerald-400 border-emerald-500/20" },
          { key: "autoplayAllowed", label: "Autoplay", color: "bg-red-500/15 text-red-400 border-red-500/20" },
          { key: "resumeEnabled", label: "Resume", color: "bg-cyan-500/15 text-cyan-400 border-cyan-500/20" },
        ].map(f => (
          <span
            key={f.key}
            className={`text-[10px] px-2 py-0.5 rounded border font-medium transition-opacity ${f.color} ${ps[f.key as keyof PlayerSettings] ? "opacity-100" : "opacity-30"}`}
          >
            {f.label}
          </span>
        ))}
      </div>
    </div>
  );
}

export default function VideoDetailPage() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const { toast } = useToast();

  const [tokenLabel, setTokenLabel] = useState("Embed Token");
  const [tokenDomain, setTokenDomain] = useState("");
  const [tokenTtl, setTokenTtl] = useState("24");
  const [tokenDialogOpen, setTokenDialogOpen] = useState(false);
  const [domainInput, setDomainInput] = useState("");
  const [baseUrl, setBaseUrl] = useState(() => window.location.origin);
  const [localPs, setLocalPs] = useState<PlayerSettings>({});
  const [localWs, setLocalWs] = useState<Record<string, any>>({});
  const [logoUploading, setLogoUploading] = useState(false);
  const [thumbnailUploading, setThumbnailUploading] = useState(false);
  const thumbnailInputRef = useRef<HTMLInputElement>(null);
  const [localSs, setLocalSs] = useState<Record<string, any>>({});
  const [localCss, setLocalCss] = useState<ClientSecuritySettings>({ ...defaultClientSecuritySettings });
  const [localUseGlobal, setLocalUseGlobal] = useState(true);
  const [previewToken, setPreviewToken] = useState("");
  const [previewKey, setPreviewKey] = useState(0);

  // Brand / Player settings (extended player settings)
  const [localBrandPs, setLocalBrandPs] = useState<Record<string, any>>({});
  const [qrDataUrl, setQrDataUrl] = useState<string>("");
  const [banners, setBanners] = useState<VideoBanner[]>([]);
  const [bannerDialogOpen, setBannerDialogOpen] = useState(false);
  const [editingBanner, setEditingBanner] = useState<Partial<VideoBanner> | null>(null);
  const [assetUploading, setAssetUploading] = useState<Record<string, boolean>>({});
  const [assetPreviews, setAssetPreviews] = useState<Record<string, string>>({});

  const { data: bannersData, refetch: refetchBanners } = useQuery<VideoBanner[]>({
    queryKey: ["/api/videos", id, "banners"],
    queryFn: () => fetch(`/api/videos/${id}/banners`, { credentials: "include" }).then(r => r.json()),
    enabled: !!id,
  });

  useEffect(() => { if (bannersData) setBanners(bannersData); }, [bannersData]);

  const { data: videoData, isLoading } = useQuery({
    queryKey: ["/api/videos", id],
    queryFn: () => fetch(`/api/videos/${id}`).then(r => r.json()),
    refetchInterval: (query) => {
      const data = query.state.data as any;
      return data?.status === "processing" || data?.status === "uploading" ? 3000 : false;
    },
  });

  const { data: tokens = [], refetch: refetchTokens } = useQuery<EmbedToken[]>({
    queryKey: ["/api/videos", id, "tokens"],
    queryFn: () => fetch(`/api/videos/${id}/tokens`).then(r => r.json()),
  });

  const { data: analytics } = useQuery({
    queryKey: ["/api/videos", id, "analytics"],
    queryFn: () => fetch(`/api/videos/${id}/analytics`).then(r => r.json()),
    enabled: !!videoData,
  });

  const updateVideo = useMutation({
    mutationFn: (data: any) => apiRequest("PUT", `/api/videos/${id}`, data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["/api/videos", id] }); toast({ title: "Saved" }); },
    onError: () => toast({ title: "Save failed", variant: "destructive" }),
  });

  const refreshPreview = () => {
    if (!id) return;
    fetch(`/api/videos/${id}/admin-preview-token`, { credentials: "include" })
      .then(r => r.json()).then(d => { if (d.token) { setPreviewToken(d.token); setPreviewKey(k => k + 1); } }).catch(() => {});
  };

  const updatePlayer = useMutation({
    mutationFn: (data: any) => apiRequest("PUT", `/api/videos/${id}/player-settings`, data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["/api/videos", id] }); toast({ title: "Player settings saved" }); refreshPreview(); },
  });

  const updateBrandSettings = useMutation({
    mutationFn: (data: any) => apiRequest("PATCH", `/api/videos/${id}/player-settings`, data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["/api/videos", id] }); toast({ title: "Brand settings saved" }); refreshPreview(); },
    onError: () => toast({ title: "Save failed", variant: "destructive" }),
  });

  const createBannerMut = useMutation({
    mutationFn: (data: Partial<VideoBanner>) => apiRequest("POST", `/api/videos/${id}/banners`, data),
    onSuccess: () => { refetchBanners(); setBannerDialogOpen(false); setEditingBanner(null); toast({ title: "Banner added" }); },
    onError: () => toast({ title: "Failed to add banner", variant: "destructive" }),
  });

  const updateBannerMut = useMutation({
    mutationFn: ({ bannerId, data }: { bannerId: string; data: Partial<VideoBanner> }) =>
      apiRequest("PATCH", `/api/videos/${id}/banners/${bannerId}`, data),
    onSuccess: () => { refetchBanners(); setBannerDialogOpen(false); setEditingBanner(null); toast({ title: "Banner updated" }); },
    onError: () => toast({ title: "Failed to update banner", variant: "destructive" }),
  });

  const deleteBannerMut = useMutation({
    mutationFn: (bannerId: string) => apiRequest("DELETE", `/api/videos/${id}/banners/${bannerId}`),
    onSuccess: () => { refetchBanners(); toast({ title: "Banner deleted" }); },
  });

  const toggleBannerMut = useMutation({
    mutationFn: ({ bannerId, enabled }: { bannerId: string; enabled: boolean }) =>
      apiRequest("PATCH", `/api/videos/${id}/banners/${bannerId}`, { enabled }),
    onSuccess: () => refetchBanners(),
  });

  const uploadPlayerAsset = async (assetType: string, file: File): Promise<{ assetId: string; previewUrl: string } | null> => {
    setAssetUploading(p => ({ ...p, [assetType]: true }));
    try {
      const fd = new FormData();
      fd.append("file", file);
      const resp = await fetch(`/api/videos/${id}/player-assets/${assetType}`, {
        method: "POST", body: fd, credentials: "include",
      });
      if (!resp.ok) throw new Error((await resp.json()).message || "Upload failed");
      const data = await resp.json();
      setAssetPreviews(p => ({ ...p, [assetType]: data.previewUrl }));
      qc.invalidateQueries({ queryKey: ["/api/videos", id] });
      toast({ title: `${assetType.charAt(0).toUpperCase() + assetType.slice(1)} uploaded` });
      return data;
    } catch (err: any) {
      toast({ title: "Upload failed", description: err.message, variant: "destructive" });
      return null;
    } finally {
      setAssetUploading(p => ({ ...p, [assetType]: false }));
    }
  };

  const updateWatermark = useMutation({
    mutationFn: (data: any) => apiRequest("PUT", `/api/videos/${id}/watermark-settings`, data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["/api/videos", id] }); toast({ title: "Watermark settings saved" }); refreshPreview(); },
  });

  const updateSecurity = useMutation({
    mutationFn: (data: any) => apiRequest("PUT", `/api/videos/${id}/security-settings`, data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["/api/videos", id] }); toast({ title: "Security settings saved" }); refreshPreview(); },
  });

  const { data: clientSecData } = useQuery<ClientSecuritySettings | null>({
    queryKey: ["/api/security/video", id],
    queryFn: () => fetch(`/api/security/video/${id}`).then(r => r.json()),
    enabled: !!id,
  });

  const { data: useGlobalData } = useQuery<{ useGlobal: boolean }>({
    queryKey: ["/api/security/video", id, "use-global"],
    queryFn: () => fetch(`/api/security/video/${id}/use-global`).then(r => r.json()),
    enabled: !!id,
  });

  useEffect(() => {
    if (useGlobalData !== undefined) setLocalUseGlobal(useGlobalData.useGlobal ?? true);
  }, [useGlobalData]);

  useEffect(() => {
    if (clientSecData && !localUseGlobal) {
      setLocalCss({ ...defaultClientSecuritySettings, ...clientSecData });
    }
  }, [clientSecData, localUseGlobal]);

  const saveClientSecurity = useMutation({
    mutationFn: () => apiRequest("POST", `/api/security/video/${id}`, localCss),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/security/video", id] });
      toast({ title: "Client protection settings saved" });
    },
    onError: () => toast({ title: "Save failed", variant: "destructive" }),
  });

  const toggleUseGlobal = useMutation({
    mutationFn: (val: boolean) => apiRequest("POST", `/api/security/video/${id}/use-global`, { useGlobal: val }),
    onSuccess: (_data, val) => {
      setLocalUseGlobal(val);
      qc.invalidateQueries({ queryKey: ["/api/security/video", id, "use-global"] });
      toast({ title: val ? "Now using global settings" : "Now using individual settings" });
    },
    onError: () => toast({ title: "Update failed", variant: "destructive" }),
  });

  const createToken = useMutation({
    mutationFn: () => apiRequest("POST", `/api/videos/${id}/tokens`, {
      label: tokenLabel, allowedDomain: tokenDomain || null, ttlHours: parseInt(tokenTtl),
    }),
    onSuccess: () => {
      refetchTokens();
      setTokenDialogOpen(false);
      setTokenLabel("Embed Token");
      setTokenDomain("");
      toast({ title: "Token created" });
    },
    onError: () => toast({ title: "Failed to create token", variant: "destructive" }),
  });

  const revokeToken = useMutation({
    mutationFn: (tokenId: string) => apiRequest("POST", `/api/tokens/${tokenId}/revoke`),
    onSuccess: () => { refetchTokens(); toast({ title: "Token revoked" }); },
  });

  const deleteToken = useMutation({
    mutationFn: (tokenId: string) => apiRequest("DELETE", `/api/tokens/${tokenId}`),
    onSuccess: () => { refetchTokens(); toast({ title: "Token deleted" }); },
  });

  const toggle = useMutation({
    mutationFn: () => apiRequest("POST", `/api/videos/${id}/toggle-availability`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/videos", id] }),
  });

  const buildHls = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/videos/${id}/build-hls-from-source`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Failed to start HLS build");
      return data;
    },
    onSuccess: (data) => {
      toast({ title: "HLS build started", description: data.message });
      qc.invalidateQueries({ queryKey: ["/api/videos", id] });
    },
    onError: (e: Error) => {
      toast({ title: "Failed to start HLS build", description: e.message, variant: "destructive" });
    },
  });

  const retranscodeMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/videos/${id}/retranscode`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Failed to start re-transcode");
      return data;
    },
    onSuccess: (data) => {
      toast({ title: "Re-transcode started", description: data.message });
      qc.invalidateQueries({ queryKey: ["/api/videos", id] });
    },
    onError: (e: Error) => {
      toast({ title: "Re-transcode failed", description: e.message, variant: "destructive" });
    },
  });

  // Must be before early returns — hooks cannot be called conditionally
  useEffect(() => {
    if (videoData?.playerSettings) {
      setLocalPs(videoData.playerSettings);
      setLocalBrandPs(videoData.playerSettings);
    }
    if (videoData?.watermarkSettings) setLocalWs(videoData.watermarkSettings);
    if (videoData?.securitySettings) setLocalSs(videoData.securitySettings);
  }, [videoData?.playerSettings, videoData?.watermarkSettings, videoData?.securitySettings]);

  // Generate QR preview whenever qrUrl changes
  useEffect(() => {
    const url = localBrandPs.qrUrl;
    if (url && /^https?:\/\//.test(url)) {
      QRCode.toDataURL(url, { margin: 1, width: 128 }).then(setQrDataUrl).catch(() => setQrDataUrl(""));
    } else {
      setQrDataUrl("");
    }
  }, [localBrandPs.qrUrl]);

  // Load asset preview URLs from saved settings
  useEffect(() => {
    const ps = videoData?.playerSettings;
    if (!ps) return;
    const assetTypes: [string, string | null | undefined][] = [
      ["logo", ps.logoAssetId],
      ["overlay", ps.overlayAssetId],
      ["intro", ps.introAssetId],
      ["outro", ps.outroAssetId],
    ];
    for (const [type, assetId] of assetTypes) {
      if (assetId && !assetPreviews[type]) {
        setAssetPreviews(p => ({ ...p, [type]: `/api/assets/${assetId}/view` }));
      }
    }
  }, [videoData?.playerSettings]);

  useEffect(() => {
    if (!id) return;
    fetch(`/api/videos/${id}/admin-preview-token`, { credentials: "include" })
      .then(r => r.json()).then(d => { if (d.token) setPreviewToken(d.token); }).catch(() => {});
  }, [id]);

  if (isLoading) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!videoData || videoData.message) {
    return (
      <div className="p-6 flex flex-col items-center py-16">
        <AlertCircle className="h-10 w-10 text-muted-foreground mb-3" />
        <p className="text-foreground font-medium">Video not found</p>
        <Button asChild variant="outline" className="mt-4"><Link href="/library">Back to Library</Link></Button>
      </div>
    );
  }

  const video = videoData;

  // derivedStatus: "needs_hls" when video claims ready but HLS has never been generated
  const isDirectM3u8 = video.sourceType === "direct_url" && video.sourceUrl && /\.m3u8/i.test(video.sourceUrl);
  const hasHls = !!video.hlsS3Prefix || isDirectM3u8;
  const derivedStatus: string = (video.status === "ready" && !hasHls) ? "needs_hls" : video.status;

  const ps = video.playerSettings || {};
  const ws = video.watermarkSettings || {};
  const ss = video.securitySettings || {};
  const firstToken = tokens.find(t => !t.revoked);
  const embedSrc = `${baseUrl}/embed/${video.publicId}`;
  const shareLink = firstToken
    ? `${baseUrl}/v/${video.publicId}?token=${firstToken.token}`
    : `${baseUrl}/v/${video.publicId}`;

  const iframeCode = `<iframe
  id="secure-video-player"
  src="${embedSrc}"
  width="100%"
  height="500"
  allow="fullscreen"
  referrerpolicy="no-referrer-when-downgrade"
  sandbox="allow-scripts allow-same-origin allow-presentation"
  frameborder="0">
</iframe>`;

  const postMessageCode = `// Send this after the iframe loads — replace the token with a signed LMS launch token
const iframe = document.getElementById('secure-video-player');
iframe.addEventListener('load', () => {
  iframe.contentWindow.postMessage(
    { type: 'LMS_LAUNCH_TOKEN', token: '<YOUR_SIGNED_LMS_LAUNCH_TOKEN>' },
    '${baseUrl}'
  );
});`;

  return (
    <>
    <div className="p-6 max-w-[1400px]">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap mb-5">
        <div className="flex items-center gap-3">
          <Button size="icon" variant="ghost" asChild><Link href="/library"><ArrowLeft className="h-4 w-4" /></Link></Button>
          <div>
            <h1 className="text-xl font-bold text-foreground">{video.title}</h1>
            <div className="flex items-center gap-2 mt-0.5 flex-wrap">
              <Badge
                variant={derivedStatus === "ready" ? "default" : "secondary"}
                className={`text-xs capitalize ${derivedStatus === "needs_hls" ? "bg-orange-500/15 text-orange-700 dark:text-orange-400 border-orange-500/30" : derivedStatus === "error" ? "bg-destructive/10 text-destructive" : ""}`}
                data-testid="badge-status"
              >
                {derivedStatus === "needs_hls" ? "Needs HLS" : derivedStatus}
              </Badge>
              <Badge variant={video.available ? "outline" : "destructive"} className="text-xs">
                {video.available ? "Available" : "Hidden"}
              </Badge>
              {(video as any).encryptionKid && (
                <Badge variant="outline" className="text-xs bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/30" data-testid="badge-encryption">
                  <Lock className="h-3 w-3 mr-1" />AES-128
                </Badge>
              )}
              <span className="text-xs text-muted-foreground">{video.publicId}</span>
            </div>
          </div>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" asChild>
            <a href={`/embed/${video.publicId}`} target="_blank" rel="noopener noreferrer">
              <ExternalLink className="h-3.5 w-3.5 mr-1" />Open Player
            </a>
          </Button>
          <Button size="sm" variant={video.available ? "outline" : "default"} onClick={() => toggle.mutate()}>
            {video.available ? <><EyeOff className="h-3.5 w-3.5 mr-1" />Hide</> : <><Eye className="h-3.5 w-3.5 mr-1" />Show</>}
          </Button>
        </div>
      </div>

      <div>
        <div>
      <Tabs defaultValue="overview">
        <TabsList className="flex-wrap h-auto gap-1">
          <TabsTrigger value="overview" data-testid="tab-overview"><Video className="h-3.5 w-3.5 mr-1" />Overview</TabsTrigger>
          <TabsTrigger value="player" data-testid="tab-player"><Settings2 className="h-3.5 w-3.5 mr-1" />Player</TabsTrigger>
          <TabsTrigger value="watermark" data-testid="tab-watermark"><Droplets className="h-3.5 w-3.5 mr-1" />Watermark</TabsTrigger>
          <TabsTrigger value="security" data-testid="tab-security"><Shield className="h-3.5 w-3.5 mr-1" />Security</TabsTrigger>
          <TabsTrigger value="embed" data-testid="tab-embed"><Code2 className="h-3.5 w-3.5 mr-1" />Embed & Share</TabsTrigger>
          <TabsTrigger value="analytics" data-testid="tab-analytics"><BarChart3 className="h-3.5 w-3.5 mr-1" />Analytics</TabsTrigger>
          <TabsTrigger value="audit" data-testid="tab-audit"><ScrollText className="h-3.5 w-3.5 mr-1" />Tokens</TabsTrigger>
        </TabsList>

        {/* Overview */}
        <TabsContent value="overview" className="mt-4 space-y-4">
          {/* Processing state */}
          {derivedStatus === "processing" && (
            <Card className="border border-amber-500/30 bg-amber-500/5">
              <CardContent className="pt-5">
                <div className="flex items-center gap-3">
                  <div className="h-5 w-5 shrink-0 animate-spin rounded-full border-2 border-amber-500 border-t-transparent" />
                  <div>
                    <p className="text-sm font-medium text-amber-700 dark:text-amber-400">Video is being processed</p>
                    {(video as any).processingProgress ? (
                      <p className="text-xs text-muted-foreground mt-0.5" data-testid="text-processing-progress">
                        {(video as any).processingProgress.stage === "uploading"
                          ? "Transcoding complete — uploading segments to storage..."
                          : `Transcoding: ${(video as any).processingProgress.time || "starting..."} encoded at ${(video as any).processingProgress.speed || "0x"} speed. This page refreshes automatically.`}
                      </p>
                    ) : (
                      <div className="mt-1">
                        <p className="text-xs text-muted-foreground">Processing may be stalled. You can restart it below.</p>
                        <Button
                          size="sm"
                          variant="outline"
                          className="mt-2 text-amber-700 border-amber-500/50 hover:bg-amber-500/10"
                          data-testid="button-restart-processing"
                          onClick={async () => {
                            try {
                              await apiRequest("POST", `/api/videos/${video.id}/retranscode`);
                              queryClient.invalidateQueries({ queryKey: ["/api/videos", video.id] });
                              toast({ title: "Processing restarted" });
                            } catch (e: any) {
                              toast({ title: "Failed to restart", description: e.message, variant: "destructive" });
                            }
                          }}
                        >
                          Restart Processing
                        </Button>
                      </div>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Needs HLS state */}
          {derivedStatus === "needs_hls" && (
            <Card className="border border-orange-500/30 bg-orange-500/5">
              <CardContent className="pt-5">
                <div className="flex items-start gap-3">
                  <AlertCircle className="h-5 w-5 shrink-0 text-orange-600 dark:text-orange-400 mt-0.5" />
                  <div className="flex-1">
                    <p className="text-sm font-medium text-orange-700 dark:text-orange-400">HLS not yet generated</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {video.sourceType === "vimeo" || video.sourceType === "vimeo_ingest"
                        ? "This Vimeo video has not been ingested into CMS storage yet. Click below to download and convert it via the Vimeo API (requires VIMEO_ACCESS_TOKEN)."
                        : "This video has not been converted to HLS yet. Click below to start conversion."}
                    </p>
                    <Button
                      size="sm"
                      className="mt-3"
                      onClick={() => buildHls.mutate()}
                      disabled={buildHls.isPending}
                      data-testid="button-build-hls"
                    >
                      <Zap className="h-3.5 w-3.5 mr-1.5" />
                      {buildHls.isPending ? "Starting…" : "Build HLS from Source"}
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Error state */}
          {derivedStatus === "error" && (() => {
            const errCode = (video as any).lastErrorCode as string | undefined;
            const errHints: string[] = (video as any).lastErrorHints || [];
            const isVimeoError = errCode === "VIMEO_NO_DOWNLOAD_LINKS" || errCode === "VIMEO_UNAUTHORIZED" || errCode === "VIMEO_NOT_FOUND";
            return (
              <Card className="border border-destructive/30 bg-destructive/5">
                <CardContent className="pt-5 pb-4">
                  <div className="flex items-start gap-3">
                    <AlertCircle className="h-5 w-5 shrink-0 text-destructive mt-0.5" />
                    <div className="flex-1 space-y-3">
                      <div>
                        <p className="text-sm font-medium text-destructive">
                          {errCode === "VIMEO_NO_DOWNLOAD_LINKS" ? "Vimeo file links not available" :
                           errCode === "VIMEO_UNAUTHORIZED" ? "Vimeo token error" :
                           errCode === "VIMEO_NOT_FOUND" ? "Vimeo video not found" :
                           "Processing failed"}
                        </p>
                        <p className="text-xs text-muted-foreground mt-1">
                          {(video as any).lastError || "An error occurred during video processing."}
                        </p>
                      </div>

                      {errHints.length > 0 && (
                        <div className="rounded-md border border-destructive/20 bg-background/50 p-3">
                          <p className="text-xs font-medium text-foreground mb-2">How to fix:</p>
                          <ul className="space-y-1">
                            {errHints.map((hint, i) => (
                              <li key={i} className="flex gap-2 text-xs text-muted-foreground">
                                <span className="shrink-0 text-destructive">•</span>
                                <span>{hint}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}

                      {!isVimeoError && errHints.length === 0 && video.sourceType === "vimeo" && (
                        <p className="text-xs text-muted-foreground">
                          Vimeo may be restricting file links due to plan, privacy settings, or token permissions.
                          Best solution: upload the original file to CMS for secure playback.
                        </p>
                      )}

                      <div className="flex flex-wrap gap-2">
                        {errCode === "VIMEO_NO_DOWNLOAD_LINKS" && (
                          <Button size="sm" asChild data-testid="button-upload-instead">
                            <Link href="/upload">Upload file directly to CMS</Link>
                          </Button>
                        )}
                        {errCode === "VIMEO_UNAUTHORIZED" && (
                          <Button size="sm" asChild data-testid="button-go-settings">
                            <Link href="/settings">Update Vimeo Token in Settings</Link>
                          </Button>
                        )}
                        {(video.sourceType === "vimeo" || video.sourceType === "vimeo_ingest") && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => buildHls.mutate()}
                            disabled={buildHls.isPending}
                            data-testid="button-retry-build-hls"
                          >
                            <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
                            {buildHls.isPending ? "Retrying…" : "Retry Import"}
                          </Button>
                        )}
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })()}

          {/* Video preview link (only when truly ready and HLS exists) */}
          {derivedStatus === "ready" && (
            <Card className="border border-card-border">
              <CardHeader className="pb-2"><CardTitle className="text-base">Video Preview</CardTitle></CardHeader>
              <CardContent>
                <a
                  href={`/embed/${video.publicId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 text-sm text-primary hover:underline"
                  data-testid="link-open-player"
                >
                  <ExternalLink className="h-4 w-4" />Open player in new tab
                </a>
              </CardContent>
            </Card>
          )}

          {derivedStatus === "ready" && !(video as any).encryptionKid && (
            <Card className="border border-amber-500/30 bg-amber-500/5">
              <CardContent className="pt-5">
                <div className="flex items-start gap-3">
                  <Shield className="h-5 w-5 text-amber-600 mt-0.5 shrink-0" />
                  <div className="flex-1">
                    <p className="text-sm font-medium text-foreground">AES-128 Encryption Not Applied</p>
                    <p className="text-xs text-muted-foreground mt-1">This video was transcoded before encryption was enabled. Re-transcode to apply AES-128 segment encryption for maximum protection.</p>
                    <Button
                      size="sm"
                      className="mt-3"
                      disabled={retranscodeMutation.isPending}
                      onClick={() => retranscodeMutation.mutate()}
                      data-testid="button-retranscode"
                    >
                      {retranscodeMutation.isPending ? <><RefreshCw className="h-3 w-3 mr-1 animate-spin" />Re-transcoding...</> : <><Lock className="h-3 w-3 mr-1" />Re-transcode with AES-128</>}
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          <Card className="border border-card-border">
            <CardHeader><CardTitle className="text-base">Video Information</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1.5">
                <Label>Title</Label>
                <Input defaultValue={video.title} onBlur={e => updateVideo.mutate({ title: e.target.value })} />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label>Author</Label>
                  <Input defaultValue={video.author} onBlur={e => updateVideo.mutate({ author: e.target.value })} />
                </div>
                <div className="space-y-1.5">
                  <Label>Source</Label>
                  <div className="flex items-center h-9">
                    {video.sourceType === "vimeo_ingest" ? (
                      <Badge variant="secondary" className="bg-blue-500/10 text-blue-700 dark:text-blue-400 border-blue-500/20">
                        Vimeo (Imported)
                      </Badge>
                    ) : video.sourceType === "upload" ? (
                      <Badge variant="secondary" className="bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/20">
                        Direct Upload
                      </Badge>
                    ) : video.sourceType === "direct_url" ? (
                      <Badge variant="secondary" className="bg-purple-500/10 text-purple-700 dark:text-purple-400 border-purple-500/20">
                        Direct URL / HLS
                      </Badge>
                    ) : video.sourceType === "youtube_blocked" ? (
                      <Badge variant="destructive" className="bg-red-500/10 text-red-700 dark:text-red-400 border-red-500/20">
                        YouTube (Blocked)
                      </Badge>
                    ) : (
                      <span className="text-sm text-muted-foreground capitalize">{video.sourceType}</span>
                    )}
                  </div>
                </div>
              </div>
              {video.sourceType === "vimeo_ingest" && video.sourceUrl && (
                <div className="rounded-lg border border-blue-500/20 bg-blue-500/5 px-3 py-2 text-xs">
                  <span className="text-muted-foreground">Vimeo source: </span>
                  <span className="font-mono text-blue-700 dark:text-blue-400">{video.sourceUrl}</span>
                  <span className="ml-2 text-muted-foreground">(reference only — video plays from our HLS)</span>
                </div>
              )}
              {video.sourceType !== "vimeo_ingest" && video.sourceUrl && (
                <div className="space-y-1.5">
                  <Label>Source URL</Label>
                  <Input defaultValue={video.sourceUrl} onBlur={e => updateVideo.mutate({ sourceUrl: e.target.value })} />
                </div>
              )}
              <div className="space-y-1.5">
                <Label>Description</Label>
                <Textarea defaultValue={video.description} onBlur={e => updateVideo.mutate({ description: e.target.value })} rows={3} />
              </div>
            </CardContent>
          </Card>

          {/* Thumbnail */}
          <Card className="border border-card-border">
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="text-base flex items-center gap-1.5">
                  Thumbnail
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <HelpCircle className="h-3.5 w-3.5 text-muted-foreground cursor-help" />
                    </TooltipTrigger>
                    <TooltipContent>Recommended: 1280×720 (16:9), PNG/JPG/WebP, max 10 MB. Shows in library and as video poster.</TooltipContent>
                  </Tooltip>
                </CardTitle>
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="outline" disabled={thumbnailUploading}
                    onClick={() => thumbnailInputRef.current?.click()}
                    data-testid="button-upload-thumbnail">
                    {thumbnailUploading ? <><RefreshCw className="h-3 w-3 mr-1 animate-spin" />Uploading…</> : video.thumbnailUrl ? <><RefreshCw className="h-3 w-3 mr-1" />Replace</> : <><Upload className="h-3 w-3 mr-1" />Upload</>}
                  </Button>
                  {video.thumbnailUrl && (
                    <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive"
                      disabled={thumbnailUploading}
                      onClick={async () => {
                        try {
                          await apiRequest("DELETE", `/api/videos/${video.id}/thumbnail`);
                          queryClient.invalidateQueries({ queryKey: ["/api/videos", id] });
                          toast({ title: "Thumbnail removed" });
                        } catch (e: any) {
                          toast({ title: "Failed to remove", description: e.message, variant: "destructive" });
                        }
                      }}
                      data-testid="button-remove-thumbnail">
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <input
                ref={thumbnailInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                className="hidden"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  e.target.value = "";
                  setThumbnailUploading(true);
                  try {
                    const form = new FormData();
                    form.append("thumbnail", file);
                    const res = await fetch(`/api/videos/${video.id}/thumbnail`, {
                      method: "POST",
                      credentials: "include",
                      body: form,
                    });
                    const data = await res.json();
                    if (!res.ok) throw new Error(data.message || "Upload failed");
                    queryClient.invalidateQueries({ queryKey: ["/api/videos", id] });
                    toast({ title: "Thumbnail uploaded" });
                  } catch (err: any) {
                    toast({ title: "Upload failed", description: err.message, variant: "destructive" });
                  } finally {
                    setThumbnailUploading(false);
                  }
                }}
              />
              <div
                className="relative rounded-lg overflow-hidden bg-muted border border-card-border"
                style={{ aspectRatio: "16/9", maxWidth: 480 }}
                data-testid="thumbnail-preview-container"
              >
                {video.thumbnailUrl ? (
                  <img
                    src={video.thumbnailUrl}
                    alt="Video thumbnail"
                    className="w-full h-full object-cover"
                    data-testid="img-thumbnail"
                  />
                ) : (
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-muted-foreground">
                    <Image className="h-10 w-10 opacity-30" />
                    <p className="text-xs">No thumbnail — click Upload to add one</p>
                  </div>
                )}
                {thumbnailUploading && (
                  <div className="absolute inset-0 flex items-center justify-center bg-black/60">
                    <div className="h-8 w-8 animate-spin rounded-full border-2 border-white border-t-transparent" />
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          <Card className="border border-card-border">
            <CardHeader><CardTitle className="text-base">Video Details</CardTitle></CardHeader>
            <CardContent>
              <dl className="grid grid-cols-2 gap-3 text-sm">
                {[
                  { label: "Public ID", value: video.publicId },
                  { label: "Status", value: video.status },
                  {
                    label: "Source Type",
                    value: video.sourceType === "vimeo_ingest" ? "Vimeo (Imported)"
                      : video.sourceType === "upload" ? "Direct Upload"
                      : video.sourceType === "direct_url" ? "Direct URL / HLS"
                      : video.sourceType === "youtube_blocked" ? "YouTube (Blocked)"
                      : video.sourceType
                  },
                  { label: "Available", value: video.available ? "Yes" : "No" },
                  { label: "Created", value: format(new Date(video.createdAt), "PPP") },
                  { label: "Qualities", value: (video.qualities || []).map((q: number) => `${q}p`).join(", ") || "—" },
                ].map(item => (
                  <div key={item.label}>
                    <dt className="text-muted-foreground text-xs">{item.label}</dt>
                    <dd className="font-medium text-foreground capitalize">{item.value}</dd>
                  </div>
                ))}
              </dl>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Player Settings */}
        <TabsContent value="player" className="mt-4">
          <div className="grid grid-cols-1 xl:grid-cols-[1fr_420px] gap-5 items-start">

            {/* LEFT: Live Preview — sticky on desktop */}
            <div className="space-y-3 xl:sticky xl:top-4 xl:self-start">
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold text-foreground">Live Preview</span>
                <Button size="sm" variant="ghost" className="h-7 px-2 text-xs gap-1" onClick={refreshPreview} data-testid="button-refresh-preview">
                  <RefreshCw className="h-3 w-3" />Refresh
                </Button>
              </div>
              {derivedStatus === "needs_hls" ? (
                <Card className="border border-orange-500/30 bg-orange-500/5">
                  <CardContent className="pt-5 pb-4">
                    <div className="flex items-start gap-2">
                      <AlertCircle className="h-4 w-4 shrink-0 text-orange-600 dark:text-orange-400 mt-0.5" />
                      <div>
                        <p className="text-sm font-medium text-orange-700 dark:text-orange-400">HLS not available</p>
                        <p className="text-xs text-muted-foreground mt-0.5">Build HLS from source to enable preview.</p>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ) : (
                <Card className="border border-card-border overflow-hidden bg-black">
                  <div className="relative" style={{ paddingBottom: "56.25%" }}>
                    {previewToken ? (
                      <iframe
                        key={previewKey}
                        src={`/embed/${video.publicId}?token=${previewToken}`}
                        className="absolute inset-0 w-full h-full border-0"
                        allow="autoplay; fullscreen"
                        title="Video Preview"
                        data-testid="player-preview"
                      />
                    ) : (
                      <div className="absolute inset-0 flex items-center justify-center bg-black/80">
                        <div className="h-6 w-6 animate-spin rounded-full border-2 border-white border-t-transparent" />
                      </div>
                    )}
                  </div>
                </Card>
              )}
              <p className="text-xs text-muted-foreground text-center">Preview reflects saved settings. Click Refresh after saving changes.</p>

              {/* Active overlays summary */}
              <div className="flex flex-wrap gap-1.5 mt-1">
                {localBrandPs.logoEnabled && <Badge variant="outline" className="text-xs bg-purple-500/10 text-purple-700 dark:text-purple-400 border-purple-500/20"><Image className="h-2.5 w-2.5 mr-1" />Logo</Badge>}
                {localBrandPs.overlayEnabled && <Badge variant="outline" className="text-xs bg-blue-500/10 text-blue-700 dark:text-blue-400 border-blue-500/20"><Layers className="h-2.5 w-2.5 mr-1" />Overlay</Badge>}
                {localBrandPs.qrEnabled && <Badge variant="outline" className="text-xs bg-green-500/10 text-green-700 dark:text-green-400 border-green-500/20"><QrCode className="h-2.5 w-2.5 mr-1" />QR Code</Badge>}
                {localBrandPs.introAssetId && <Badge variant="outline" className="text-xs bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/20"><Film className="h-2.5 w-2.5 mr-1" />Intro</Badge>}
                {localBrandPs.outroAssetId && <Badge variant="outline" className="text-xs bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/20"><Film className="h-2.5 w-2.5 mr-1" />Outro</Badge>}
                {banners.filter(b => b.enabled).length > 0 && <Badge variant="outline" className="text-xs bg-cyan-500/10 text-cyan-700 dark:text-cyan-400 border-cyan-500/20"><AlignLeft className="h-2.5 w-2.5 mr-1" />{banners.filter(b => b.enabled).length} Banner{banners.filter(b => b.enabled).length > 1 ? "s" : ""}</Badge>}
              </div>
            </div>

            {/* RIGHT: Settings Accordion Panel */}
            <div className="space-y-1">
              <TooltipProvider>
              <Accordion type="multiple" defaultValue={["controls"]} className="space-y-1">

                {/* Player Controls */}
                <AccordionItem value="controls" className="border border-card-border rounded-lg px-4">
                  <AccordionTrigger className="text-sm font-medium hover:no-underline py-3">
                    <div className="flex items-center gap-2"><Settings2 className="h-4 w-4 text-muted-foreground" />Player Controls</div>
                  </AccordionTrigger>
                  <AccordionContent className="pb-4">
                    {[
                      { key: "allowSpeed", label: "Speed Control", desc: "Allow playback speed adjustment (0.5x–3x)" },
                      { key: "allowQuality", label: "Quality Selection", desc: "Allow viewer to switch between quality levels" },
                      { key: "allowFullscreen", label: "Fullscreen", desc: "Allow fullscreen mode" },
                      { key: "allowSkip", label: "Seek / Skip", desc: "Allow seeking and ±10s skip buttons" },
                      { key: "allowBrightness", label: "Brightness Control", desc: "Allow brightness adjustment via CSS filter" },
                      { key: "resumeEnabled", label: "Resume Playback", desc: "Resume from last watched position" },
                      { key: "autoplayAllowed", label: "Autoplay", desc: "Attempt autoplay on embed load (muted)" },
                    ].map(s => (
                      <SettingRow key={s.key} label={s.label} description={s.desc}>
                        <Switch
                          checked={!!localPs[s.key as keyof PlayerSettings]}
                          onCheckedChange={val => setLocalPs(prev => ({ ...prev, [s.key]: val }))}
                          data-testid={`switch-${s.key}`}
                        />
                      </SettingRow>
                    ))}
                    <div className="mt-3 grid grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <Label className="text-xs">Start Time (sec)</Label>
                        <Input type="number" min={0} defaultValue={ps.startTime || 0}
                          onChange={e => setLocalPs(prev => ({ ...prev, startTime: parseInt(e.target.value) || 0 }))} />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs">End Time (0 = full)</Label>
                        <Input type="number" min={0} defaultValue={ps.endTime || 0}
                          onChange={e => setLocalPs(prev => ({ ...prev, endTime: parseInt(e.target.value) || 0 }))} />
                      </div>
                    </div>
                    <SaveBar
                      dirty={JSON.stringify(localPs) !== JSON.stringify(ps)}
                      onSave={() => updatePlayer.mutate(localPs)}
                      isPending={updatePlayer.isPending}
                    />
                  </AccordionContent>
                </AccordionItem>

                {/* Logo */}
                <AccordionItem value="logo" className="border border-card-border rounded-lg px-4">
                  <AccordionTrigger className="text-sm font-medium hover:no-underline py-3">
                    <div className="flex items-center gap-2">
                      <Image className="h-4 w-4 text-muted-foreground" />Logo
                      <Tooltip><TooltipTrigger asChild><HelpCircle className="h-3 w-3 text-muted-foreground" /></TooltipTrigger><TooltipContent>Recommended: 200×200px, transparent PNG, max 20MB</TooltipContent></Tooltip>
                      {localBrandPs.logoEnabled && <Badge className="ml-1 text-[10px] h-4 px-1.5 bg-purple-500/20 text-purple-700 dark:text-purple-300 border-0">ON</Badge>}
                    </div>
                  </AccordionTrigger>
                  <AccordionContent className="pb-4 space-y-3">
                    <SettingRow label="Enable Logo" description="Show logo overlay on the player">
                      <Switch checked={!!localBrandPs.logoEnabled} onCheckedChange={val => setLocalBrandPs(p => ({ ...p, logoEnabled: val }))} data-testid="switch-player-logo-enabled" />
                    </SettingRow>
                    <div>
                      <Label className="text-xs mb-2 block">Upload Logo Image</Label>
                      <div className="flex items-center gap-2">
                        {assetPreviews.logo && (
                          <img src={assetPreviews.logo} alt="Logo" className="h-12 w-12 rounded border object-contain bg-muted" />
                        )}
                        <label className="flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-dashed border-border text-xs text-muted-foreground cursor-pointer hover:bg-muted/50 transition-colors">
                          {assetUploading.logo ? <RefreshCw className="h-3 w-3 animate-spin" /> : <Upload className="h-3 w-3" />}
                          {assetPreviews.logo ? "Replace" : "+ Add Logo"}
                          <input type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" className="hidden" disabled={assetUploading.logo}
                            onChange={async e => { const f = e.target.files?.[0]; if (f) await uploadPlayerAsset("logo", f); }} />
                        </label>
                      </div>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">Placement</Label>
                      <div className="grid grid-cols-4 gap-1">
                        {["top-left","top-right","bottom-left","bottom-right"].map(pos => (
                          <button key={pos}
                            className={`p-2 rounded border text-[10px] transition-colors ${localBrandPs.logoPlacement === pos ? "border-primary bg-primary/10 text-primary" : "border-border hover:bg-muted/50"}`}
                            onClick={() => setLocalBrandPs(p => ({ ...p, logoPlacement: pos }))}
                          >
                            {pos.replace("top-","T-").replace("bottom-","B-")}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">Size: {localBrandPs.logoSizePercent ?? 12}%</Label>
                      <Slider value={[localBrandPs.logoSizePercent ?? 12]} min={3} max={30} step={1}
                        onValueChange={([v]) => setLocalBrandPs(p => ({ ...p, logoSizePercent: v }))} />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">Opacity: {Math.round((localBrandPs.logoOpacity ?? 0.9) * 100)}%</Label>
                      <Slider value={[(localBrandPs.logoOpacity ?? 0.9) * 100]} min={10} max={100} step={5}
                        onValueChange={([v]) => setLocalBrandPs(p => ({ ...p, logoOpacity: v / 100 }))} />
                    </div>
                    <Button size="sm" className="w-full" onClick={() => updateBrandSettings.mutate(localBrandPs)} disabled={updateBrandSettings.isPending}>
                      {updateBrandSettings.isPending ? "Saving…" : "Save Logo Settings"}
                    </Button>
                  </AccordionContent>
                </AccordionItem>

                {/* Overlay */}
                <AccordionItem value="overlay" className="border border-card-border rounded-lg px-4">
                  <AccordionTrigger className="text-sm font-medium hover:no-underline py-3">
                    <div className="flex items-center gap-2">
                      <Layers className="h-4 w-4 text-muted-foreground" />Overlay
                      <Tooltip><TooltipTrigger asChild><HelpCircle className="h-3 w-3 text-muted-foreground" /></TooltipTrigger><TooltipContent>Recommended: 1280×720px, transparent PNG, max 20MB</TooltipContent></Tooltip>
                      {localBrandPs.overlayEnabled && <Badge className="ml-1 text-[10px] h-4 px-1.5 bg-blue-500/20 text-blue-700 dark:text-blue-300 border-0">ON</Badge>}
                    </div>
                  </AccordionTrigger>
                  <AccordionContent className="pb-4 space-y-3">
                    <SettingRow label="Enable Overlay" description="Show a full or partial image overlay on the video">
                      <Switch checked={!!localBrandPs.overlayEnabled} onCheckedChange={val => setLocalBrandPs(p => ({ ...p, overlayEnabled: val }))} data-testid="switch-overlay-enabled" />
                    </SettingRow>
                    <div>
                      <Label className="text-xs mb-2 block">Upload Overlay Image</Label>
                      <div className="flex items-center gap-2">
                        {assetPreviews.overlay && (
                          <img src={assetPreviews.overlay} alt="Overlay" className="h-12 w-20 rounded border object-contain bg-muted" />
                        )}
                        <label className="flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-dashed border-border text-xs text-muted-foreground cursor-pointer hover:bg-muted/50 transition-colors">
                          {assetUploading.overlay ? <RefreshCw className="h-3 w-3 animate-spin" /> : <Upload className="h-3 w-3" />}
                          {assetPreviews.overlay ? "Replace" : "+ Add Overlay"}
                          <input type="file" accept="image/*" className="hidden" disabled={assetUploading.overlay}
                            onChange={async e => { const f = e.target.files?.[0]; if (f) await uploadPlayerAsset("overlay", f); }} />
                        </label>
                      </div>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">Mode</Label>
                      <Select value={localBrandPs.overlayMode ?? "full"} onValueChange={val => setLocalBrandPs(p => ({ ...p, overlayMode: val }))}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {["full","top","bottom","left","right"].map(m => (
                            <SelectItem key={m} value={m}>{m.charAt(0).toUpperCase() + m.slice(1)}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">Opacity: {Math.round((localBrandPs.overlayOpacity ?? 0.6) * 100)}%</Label>
                      <Slider value={[(localBrandPs.overlayOpacity ?? 0.6) * 100]} min={0} max={100} step={5}
                        onValueChange={([v]) => setLocalBrandPs(p => ({ ...p, overlayOpacity: v / 100 }))} />
                    </div>
                    <Button size="sm" className="w-full" onClick={() => updateBrandSettings.mutate(localBrandPs)} disabled={updateBrandSettings.isPending}>
                      {updateBrandSettings.isPending ? "Saving…" : "Save Overlay Settings"}
                    </Button>
                  </AccordionContent>
                </AccordionItem>

                {/* QR Code */}
                <AccordionItem value="qr" className="border border-card-border rounded-lg px-4">
                  <AccordionTrigger className="text-sm font-medium hover:no-underline py-3">
                    <div className="flex items-center gap-2">
                      <QrCode className="h-4 w-4 text-muted-foreground" />QR Code
                      {localBrandPs.qrEnabled && <Badge className="ml-1 text-[10px] h-4 px-1.5 bg-green-500/20 text-green-700 dark:text-green-300 border-0">ON</Badge>}
                    </div>
                  </AccordionTrigger>
                  <AccordionContent className="pb-4 space-y-3">
                    <SettingRow label="Enable QR Code" description="Show a QR code overlay on the player">
                      <Switch checked={!!localBrandPs.qrEnabled} onCheckedChange={val => setLocalBrandPs(p => ({ ...p, qrEnabled: val }))} data-testid="switch-qr-enabled" />
                    </SettingRow>
                    {qrDataUrl && (
                      <div className="rounded-lg p-3 flex items-center gap-3" style={{ background: localBrandPs.qrBgEnabled ? `rgba(0,0,0,${localBrandPs.qrBgOpacity ?? 0.5})` : "transparent" }}>
                        <img src={qrDataUrl} alt="QR Preview" className="h-14 w-14 rounded" />
                        <div>
                          <p className="text-sm font-medium text-foreground line-clamp-1">{localBrandPs.qrTitle || "Untitled"}</p>
                          <p className="text-xs text-muted-foreground line-clamp-1">{localBrandPs.qrUrl}</p>
                        </div>
                      </div>
                    )}
                    <div className="space-y-1">
                      <Label className="text-xs">Title</Label>
                      <Input value={localBrandPs.qrTitle ?? ""} placeholder="Scan to visit" onChange={e => setLocalBrandPs(p => ({ ...p, qrTitle: e.target.value }))} data-testid="input-qr-title" />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">URL</Label>
                      <Input value={localBrandPs.qrUrl ?? ""} placeholder="https://website.com" onChange={e => setLocalBrandPs(p => ({ ...p, qrUrl: e.target.value }))} data-testid="input-qr-url" />
                      {localBrandPs.qrUrl && !/^https?:\/\//.test(localBrandPs.qrUrl) && (
                        <p className="text-xs text-destructive">URL must start with http:// or https://</p>
                      )}
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">Placement</Label>
                      <div className="grid grid-cols-4 gap-1">
                        {["top-left","top-right","bottom-left","bottom-right"].map(pos => (
                          <button key={pos}
                            className={`p-2 rounded border text-[10px] transition-colors ${localBrandPs.qrPlacement === pos ? "border-primary bg-primary/10 text-primary" : "border-border hover:bg-muted/50"}`}
                            onClick={() => setLocalBrandPs(p => ({ ...p, qrPlacement: pos }))}
                          >
                            {pos.replace("top-","T-").replace("bottom-","B-")}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">Size: {localBrandPs.qrSizePercent ?? 14}%</Label>
                      <Slider value={[localBrandPs.qrSizePercent ?? 14]} min={5} max={35} step={1}
                        onValueChange={([v]) => setLocalBrandPs(p => ({ ...p, qrSizePercent: v }))} />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">Opacity: {Math.round((localBrandPs.qrOpacity ?? 1) * 100)}%</Label>
                      <Slider value={[(localBrandPs.qrOpacity ?? 1) * 100]} min={20} max={100} step={5}
                        onValueChange={([v]) => setLocalBrandPs(p => ({ ...p, qrOpacity: v / 100 }))} />
                    </div>
                    <SettingRow label="Background Card" description="Show a semi-transparent background behind the QR">
                      <Switch checked={!!localBrandPs.qrBgEnabled} onCheckedChange={val => setLocalBrandPs(p => ({ ...p, qrBgEnabled: val }))} />
                    </SettingRow>
                    <Button size="sm" className="w-full"
                      onClick={() => { if (localBrandPs.qrUrl && !/^https?:\/\//.test(localBrandPs.qrUrl)) { toast({ title: "Invalid URL", description: "URL must start with http:// or https://", variant: "destructive" }); return; } updateBrandSettings.mutate(localBrandPs); }}
                      disabled={updateBrandSettings.isPending}>
                      {updateBrandSettings.isPending ? "Saving…" : "Create / Save QR Code"}
                    </Button>
                  </AccordionContent>
                </AccordionItem>

                {/* Video Clips */}
                <AccordionItem value="clips" className="border border-card-border rounded-lg px-4">
                  <AccordionTrigger className="text-sm font-medium hover:no-underline py-3">
                    <div className="flex items-center gap-2">
                      <Film className="h-4 w-4 text-muted-foreground" />Video Clips
                      <Tooltip><TooltipTrigger asChild><HelpCircle className="h-3 w-3 text-muted-foreground" /></TooltipTrigger><TooltipContent>MP4 files only, max 200MB each</TooltipContent></Tooltip>
                      {(localBrandPs.introAssetId || localBrandPs.outroAssetId) && <Badge className="ml-1 text-[10px] h-4 px-1.5 bg-amber-500/20 text-amber-700 dark:text-amber-300 border-0">SET</Badge>}
                    </div>
                  </AccordionTrigger>
                  <AccordionContent className="pb-4 space-y-4">
                    <div className="grid grid-cols-2 gap-3">
                      {/* Intro */}
                      <div className="space-y-2">
                        <Label className="text-xs">Intro Video</Label>
                        <label className={`flex flex-col items-center justify-center gap-1.5 p-4 rounded-lg border-2 border-dashed cursor-pointer transition-colors text-center ${assetPreviews.intro ? "border-amber-500/40 bg-amber-500/5" : "border-border hover:bg-muted/50"}`}>
                          {assetUploading.intro ? <RefreshCw className="h-5 w-5 animate-spin text-muted-foreground" /> : <Film className="h-5 w-5 text-muted-foreground" />}
                          <span className="text-[10px] text-muted-foreground">{assetPreviews.intro ? "Intro uploaded ✓" : "+ Intro video"}</span>
                          <input type="file" accept="video/mp4,video/quicktime,video/webm" className="hidden" disabled={assetUploading.intro}
                            onChange={async e => { const f = e.target.files?.[0]; if (f) { const r = await uploadPlayerAsset("intro", f); if (r) setLocalBrandPs(p => ({ ...p, introAssetId: r.assetId })); } }} />
                        </label>
                        {assetPreviews.intro && (
                          <Button size="sm" variant="ghost" className="w-full h-6 text-xs text-muted-foreground"
                            onClick={() => { setAssetPreviews(p => ({ ...p, intro: "" })); setLocalBrandPs(p => ({ ...p, introAssetId: undefined })); }}>
                            <X className="h-3 w-3 mr-1" />Remove
                          </Button>
                        )}
                      </div>
                      {/* Outro */}
                      <div className="space-y-2">
                        <Label className="text-xs">Outro Video</Label>
                        <label className={`flex flex-col items-center justify-center gap-1.5 p-4 rounded-lg border-2 border-dashed cursor-pointer transition-colors text-center ${assetPreviews.outro ? "border-amber-500/40 bg-amber-500/5" : "border-border hover:bg-muted/50"}`}>
                          {assetUploading.outro ? <RefreshCw className="h-5 w-5 animate-spin text-muted-foreground" /> : <Film className="h-5 w-5 text-muted-foreground" />}
                          <span className="text-[10px] text-muted-foreground">{assetPreviews.outro ? "Outro uploaded ✓" : "+ Outro video"}</span>
                          <input type="file" accept="video/mp4,video/quicktime,video/webm" className="hidden" disabled={assetUploading.outro}
                            onChange={async e => { const f = e.target.files?.[0]; if (f) { const r = await uploadPlayerAsset("outro", f); if (r) setLocalBrandPs(p => ({ ...p, outroAssetId: r.assetId })); } }} />
                        </label>
                        {assetPreviews.outro && (
                          <Button size="sm" variant="ghost" className="w-full h-6 text-xs text-muted-foreground"
                            onClick={() => { setAssetPreviews(p => ({ ...p, outro: "" })); setLocalBrandPs(p => ({ ...p, outroAssetId: undefined })); }}>
                            <X className="h-3 w-3 mr-1" />Remove
                          </Button>
                        )}
                      </div>
                    </div>
                    <SettingRow label="Loop" description="Loop the video after it ends">
                      <Switch checked={!!localBrandPs.loopEnabled} onCheckedChange={val => setLocalBrandPs(p => ({ ...p, loopEnabled: val }))} />
                    </SettingRow>
                    {localBrandPs.loopEnabled && (
                      <div className="space-y-1">
                        <Label className="text-xs">Loop Mode</Label>
                        <Select value={localBrandPs.loopMode ?? "main-only"} onValueChange={val => setLocalBrandPs(p => ({ ...p, loopMode: val }))}>
                          <SelectTrigger><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="main-only">Main video only</SelectItem>
                            <SelectItem value="all">Full sequence (Intro → Main → Outro)</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    )}
                    <Button size="sm" className="w-full" onClick={() => updateBrandSettings.mutate(localBrandPs)} disabled={updateBrandSettings.isPending}>
                      {updateBrandSettings.isPending ? "Saving…" : "Save Clip Settings"}
                    </Button>
                  </AccordionContent>
                </AccordionItem>

                {/* Banners */}
                <AccordionItem value="banners" className="border border-card-border rounded-lg px-4">
                  <AccordionTrigger className="text-sm font-medium hover:no-underline py-3">
                    <div className="flex items-center gap-2">
                      <AlignLeft className="h-4 w-4 text-muted-foreground" />Banners & Tickers
                      {banners.length > 0 && <Badge className="ml-1 text-[10px] h-4 px-1.5 bg-cyan-500/20 text-cyan-700 dark:text-cyan-300 border-0">{banners.length}</Badge>}
                    </div>
                  </AccordionTrigger>
                  <AccordionContent className="pb-4 space-y-3">
                    {banners.length === 0 ? (
                      <p className="text-xs text-muted-foreground text-center py-4">No banners yet. Add one below.</p>
                    ) : (
                      <div className="space-y-2">
                        {banners.map(banner => (
                          <div key={banner.id} className={`flex items-start gap-2 p-2.5 rounded-lg border transition-colors ${banner.enabled ? "border-card-border bg-card" : "border-border/50 bg-muted/30 opacity-60"}`}>
                            <div className="flex-1 min-w-0">
                              <p className="text-xs font-medium text-foreground truncate">{banner.text}</p>
                              <div className="flex items-center gap-1.5 mt-0.5">
                                <Badge variant="outline" className="text-[10px] h-4 px-1">{banner.type}</Badge>
                                <Badge variant="outline" className="text-[10px] h-4 px-1">{banner.position}</Badge>
                              </div>
                            </div>
                            <div className="flex items-center gap-1 shrink-0">
                              <Button size="sm" variant="ghost" className="h-6 px-1.5 text-xs"
                                onClick={() => toggleBannerMut.mutate({ bannerId: banner.id, enabled: !banner.enabled })}
                                data-testid={`button-toggle-banner-${banner.id}`}>
                                {banner.enabled ? "Hide" : "On"}
                              </Button>
                              <Button size="sm" variant="ghost" className="h-6 px-1.5 text-xs"
                                onClick={() => { setEditingBanner({ ...banner }); setBannerDialogOpen(true); }}>
                                Edit
                              </Button>
                              <Button size="sm" variant="ghost" className="h-6 px-1.5 text-destructive hover:text-destructive"
                                onClick={() => deleteBannerMut.mutate(banner.id)}
                                data-testid={`button-delete-banner-${banner.id}`}>
                                <X className="h-3 w-3" />
                              </Button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                    <Button size="sm" variant="outline" className="w-full" onClick={() => { setEditingBanner({ type: "ticker", position: "bottom", speed: 18, backgroundColor: "#0b3a66", textColor: "#ffffff", fontSize: 18, opacity: 1, paddingY: 10, paddingX: 16, enabled: true, text: "" }); setBannerDialogOpen(true); }}>
                      <Plus className="h-3.5 w-3.5 mr-1" />Add Banner
                    </Button>
                  </AccordionContent>
                </AccordionItem>

                {/* Style */}
                <AccordionItem value="style" className="border border-card-border rounded-lg px-4">
                  <AccordionTrigger className="text-sm font-medium hover:no-underline py-3">
                    <div className="flex items-center gap-2">
                      <Palette className="h-4 w-4 text-muted-foreground" />Style
                    </div>
                  </AccordionTrigger>
                  <AccordionContent className="pb-4 space-y-4">
                    <div className="space-y-2">
                      <Label className="text-xs">Brand Color</Label>
                      <div className="flex items-center gap-2">
                        <input type="color" value={localBrandPs.brandColor ?? "#ffc42c"}
                          onChange={e => setLocalBrandPs(p => ({ ...p, brandColor: e.target.value }))}
                          className="h-8 w-8 rounded border cursor-pointer" data-testid="input-brand-color" />
                        <Input value={localBrandPs.brandColor ?? "#ffc42c"}
                          onChange={e => setLocalBrandPs(p => ({ ...p, brandColor: e.target.value }))}
                          className="font-mono text-xs" placeholder="#ffc42c" />
                      </div>
                    </div>
                    <div className="space-y-2">
                      <Label className="text-xs">Theme</Label>
                      <div className="grid grid-cols-4 gap-1.5">
                        {["bubble","classic","minimal","block"].map(t => (
                          <button key={t}
                            className={`py-1.5 rounded-md border text-xs font-medium transition-colors ${localBrandPs.theme === t ? "border-primary bg-primary text-primary-foreground" : "border-border hover:bg-muted/50"}`}
                            onClick={() => setLocalBrandPs(p => ({ ...p, theme: t }))}
                            data-testid={`button-theme-${t}`}
                          >
                            {t.charAt(0).toUpperCase() + t.slice(1)}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">Font</Label>
                      <Select value={localBrandPs.fontFamily ?? "system"} onValueChange={val => setLocalBrandPs(p => ({ ...p, fontFamily: val }))}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="system">Use default theme font</SelectItem>
                          <SelectItem value="Inter">Inter</SelectItem>
                          <SelectItem value="Roboto">Roboto</SelectItem>
                          <SelectItem value="Montserrat">Montserrat</SelectItem>
                          <SelectItem value="Poppins">Poppins</SelectItem>
                          <SelectItem value="Lato">Lato</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <SettingRow label="Show Display Name" description="Show a name label over the video">
                      <Switch checked={!!localBrandPs.showDisplayNames} onCheckedChange={val => setLocalBrandPs(p => ({ ...p, showDisplayNames: val }))} data-testid="switch-show-display-names" />
                    </SettingRow>
                    {localBrandPs.showDisplayNames && (
                      <div className="space-y-3 pl-1 border-l-2 border-muted ml-1">
                        <div className="space-y-1">
                          <Label className="text-xs">Display Name Text</Label>
                          <Input value={localBrandPs.displayNameText ?? ""} placeholder="e.g. John Smith" maxLength={60}
                            onChange={e => setLocalBrandPs(p => ({ ...p, displayNameText: e.target.value }))} data-testid="input-display-name-text" />
                          <p className="text-xs text-muted-foreground">{(localBrandPs.displayNameText ?? "").length}/60</p>
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs">Position</Label>
                          <div className="grid grid-cols-2 gap-1.5">
                            {["bottom-left","bottom-right"].map(pos => (
                              <button key={pos} onClick={() => setLocalBrandPs(p => ({ ...p, displayNamePosition: pos }))}
                                className={`py-1 rounded border text-xs transition-colors ${(localBrandPs.displayNamePosition ?? "bottom-left") === pos ? "border-primary bg-primary/10 text-primary" : "border-border hover:bg-muted/50"}`}
                              >{pos === "bottom-left" ? "↙ Bottom Left" : "↘ Bottom Right"}</button>
                            ))}
                          </div>
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs">Font Size: {localBrandPs.displayNameFontSize ?? 18}px</Label>
                          <Slider value={[localBrandPs.displayNameFontSize ?? 18]} min={10} max={36} step={1}
                            onValueChange={([v]) => setLocalBrandPs(p => ({ ...p, displayNameFontSize: v }))} />
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs">Text Color</Label>
                          <div className="flex items-center gap-2">
                            <input type="color" value={localBrandPs.displayNameTextColor ?? "#ffffff"}
                              onChange={e => setLocalBrandPs(p => ({ ...p, displayNameTextColor: e.target.value }))}
                              className="h-8 w-8 rounded border cursor-pointer" />
                            <Input value={localBrandPs.displayNameTextColor ?? "#ffffff"} className="font-mono text-xs"
                              onChange={e => setLocalBrandPs(p => ({ ...p, displayNameTextColor: e.target.value }))} />
                          </div>
                        </div>
                        <SettingRow label="Background" description="Show background behind text">
                          <Switch checked={localBrandPs.displayNameBgEnabled !== false}
                            onCheckedChange={val => setLocalBrandPs(p => ({ ...p, displayNameBgEnabled: val }))} />
                        </SettingRow>
                        {localBrandPs.displayNameBgEnabled !== false && (
                          <div className="space-y-2">
                            <div className="space-y-1">
                              <Label className="text-xs">Background Color</Label>
                              <div className="flex items-center gap-2">
                                <input type="color" value={localBrandPs.displayNameBgColor ?? "#000000"}
                                  onChange={e => setLocalBrandPs(p => ({ ...p, displayNameBgColor: e.target.value }))}
                                  className="h-8 w-8 rounded border cursor-pointer" />
                                <Input value={localBrandPs.displayNameBgColor ?? "#000000"} className="font-mono text-xs"
                                  onChange={e => setLocalBrandPs(p => ({ ...p, displayNameBgColor: e.target.value }))} />
                              </div>
                            </div>
                            <div className="space-y-1">
                              <Label className="text-xs">Background Opacity: {Math.round((localBrandPs.displayNameBgOpacity ?? 0.35) * 100)}%</Label>
                              <Slider value={[Math.round((localBrandPs.displayNameBgOpacity ?? 0.35) * 100)]} min={0} max={100} step={5}
                                onValueChange={([v]) => setLocalBrandPs(p => ({ ...p, displayNameBgOpacity: v / 100 }))} />
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                    <SettingRow label="Show Headline" description="Show a headline label over the video">
                      <Switch checked={!!localBrandPs.showHeadlines} onCheckedChange={val => setLocalBrandPs(p => ({ ...p, showHeadlines: val }))} data-testid="switch-show-headlines" />
                    </SettingRow>
                    {localBrandPs.showHeadlines && (
                      <div className="space-y-3 pl-1 border-l-2 border-muted ml-1">
                        <div className="space-y-1">
                          <Label className="text-xs">Headline Text</Label>
                          <Input value={localBrandPs.headlineText ?? ""} placeholder="e.g. Session 3: Advanced Topics" maxLength={120}
                            onChange={e => setLocalBrandPs(p => ({ ...p, headlineText: e.target.value }))} data-testid="input-headline-text" />
                          <p className="text-xs text-muted-foreground">{(localBrandPs.headlineText ?? "").length}/120</p>
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs">Position</Label>
                          <div className="grid grid-cols-2 gap-1.5">
                            {["bottom-left","bottom-right"].map(pos => (
                              <button key={pos} onClick={() => setLocalBrandPs(p => ({ ...p, headlinePosition: pos }))}
                                className={`py-1 rounded border text-xs transition-colors ${(localBrandPs.headlinePosition ?? "bottom-left") === pos ? "border-primary bg-primary/10 text-primary" : "border-border hover:bg-muted/50"}`}
                              >{pos === "bottom-left" ? "↙ Bottom Left" : "↘ Bottom Right"}</button>
                            ))}
                          </div>
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs">Font Size: {localBrandPs.headlineFontSize ?? 18}px</Label>
                          <Slider value={[localBrandPs.headlineFontSize ?? 18]} min={10} max={36} step={1}
                            onValueChange={([v]) => setLocalBrandPs(p => ({ ...p, headlineFontSize: v }))} />
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs">Text Color</Label>
                          <div className="flex items-center gap-2">
                            <input type="color" value={localBrandPs.headlineTextColor ?? "#ffffff"}
                              onChange={e => setLocalBrandPs(p => ({ ...p, headlineTextColor: e.target.value }))}
                              className="h-8 w-8 rounded border cursor-pointer" />
                            <Input value={localBrandPs.headlineTextColor ?? "#ffffff"} className="font-mono text-xs"
                              onChange={e => setLocalBrandPs(p => ({ ...p, headlineTextColor: e.target.value }))} />
                          </div>
                        </div>
                        <SettingRow label="Background" description="Show background behind text">
                          <Switch checked={localBrandPs.headlineBgEnabled !== false}
                            onCheckedChange={val => setLocalBrandPs(p => ({ ...p, headlineBgEnabled: val }))} />
                        </SettingRow>
                        {localBrandPs.headlineBgEnabled !== false && (
                          <div className="space-y-2">
                            <div className="space-y-1">
                              <Label className="text-xs">Background Color</Label>
                              <div className="flex items-center gap-2">
                                <input type="color" value={localBrandPs.headlineBgColor ?? "#000000"}
                                  onChange={e => setLocalBrandPs(p => ({ ...p, headlineBgColor: e.target.value }))}
                                  className="h-8 w-8 rounded border cursor-pointer" />
                                <Input value={localBrandPs.headlineBgColor ?? "#000000"} className="font-mono text-xs"
                                  onChange={e => setLocalBrandPs(p => ({ ...p, headlineBgColor: e.target.value }))} />
                              </div>
                            </div>
                            <div className="space-y-1">
                              <Label className="text-xs">Background Opacity: {Math.round((localBrandPs.headlineBgOpacity ?? 0.35) * 100)}%</Label>
                              <Slider value={[Math.round((localBrandPs.headlineBgOpacity ?? 0.35) * 100)]} min={0} max={100} step={5}
                                onValueChange={([v]) => setLocalBrandPs(p => ({ ...p, headlineBgOpacity: v / 100 }))} />
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                    <Button size="sm" className="w-full" onClick={() => updateBrandSettings.mutate(localBrandPs)} disabled={updateBrandSettings.isPending}>
                      {updateBrandSettings.isPending ? "Saving…" : "Save Style Settings"}
                    </Button>
                  </AccordionContent>
                </AccordionItem>

              </Accordion>
              </TooltipProvider>
            </div>
          </div>
        </TabsContent>

        {/* Banner Dialog */}
        <Dialog open={bannerDialogOpen} onOpenChange={open => { if (!open) { setBannerDialogOpen(false); setEditingBanner(null); } }}>
          <DialogContent className="max-w-md">
            <DialogHeader><DialogTitle>{editingBanner?.id ? "Edit Banner" : "Add Banner"}</DialogTitle></DialogHeader>
            {editingBanner && (
              <div className="space-y-4 py-2">
                <div className="space-y-1.5">
                  <Label>Banner Text</Label>
                  <Textarea value={editingBanner.text ?? ""} placeholder="Enter banner text..." rows={2}
                    onChange={e => setEditingBanner(p => ({ ...p!, text: e.target.value }))} data-testid="input-banner-text" />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label className="text-xs">Type</Label>
                    <Select value={editingBanner.type ?? "ticker"} onValueChange={val => setEditingBanner(p => ({ ...p!, type: val }))}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="ticker">Ticker (scrolling)</SelectItem>
                        <SelectItem value="banner">Banner (static)</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">Position</Label>
                    <Select value={editingBanner.position ?? "bottom"} onValueChange={val => setEditingBanner(p => ({ ...p!, position: val }))}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="bottom">Bottom</SelectItem>
                        <SelectItem value="top">Top</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                {editingBanner.type === "ticker" && (
                  <div className="space-y-1.5">
                    <Label className="text-xs">Speed: {editingBanner.speed ?? 18}px/s</Label>
                    <Slider value={[editingBanner.speed ?? 18]} min={5} max={60} step={1}
                      onValueChange={([v]) => setEditingBanner(p => ({ ...p!, speed: v }))} />
                  </div>
                )}
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label className="text-xs">Background</Label>
                    <div className="flex gap-1.5">
                      <input type="color" value={editingBanner.backgroundColor ?? "#0b3a66"}
                        onChange={e => setEditingBanner(p => ({ ...p!, backgroundColor: e.target.value }))}
                        className="h-9 w-9 rounded border cursor-pointer shrink-0" />
                      <Input value={editingBanner.backgroundColor ?? "#0b3a66"} className="font-mono text-xs"
                        onChange={e => setEditingBanner(p => ({ ...p!, backgroundColor: e.target.value }))} />
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">Text Color</Label>
                    <div className="flex gap-1.5">
                      <input type="color" value={editingBanner.textColor ?? "#ffffff"}
                        onChange={e => setEditingBanner(p => ({ ...p!, textColor: e.target.value }))}
                        className="h-9 w-9 rounded border cursor-pointer shrink-0" />
                      <Input value={editingBanner.textColor ?? "#ffffff"} className="font-mono text-xs"
                        onChange={e => setEditingBanner(p => ({ ...p!, textColor: e.target.value }))} />
                    </div>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label className="text-xs">Font Size: {editingBanner.fontSize ?? 18}px</Label>
                    <Slider value={[editingBanner.fontSize ?? 18]} min={10} max={40} step={1}
                      onValueChange={([v]) => setEditingBanner(p => ({ ...p!, fontSize: v }))} />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">Opacity: {Math.round((editingBanner.opacity ?? 1) * 100)}%</Label>
                    <Slider value={[(editingBanner.opacity ?? 1) * 100]} min={20} max={100} step={5}
                      onValueChange={([v]) => setEditingBanner(p => ({ ...p!, opacity: v / 100 }))} />
                  </div>
                </div>
                {/* Preview */}
                <div className="rounded overflow-hidden" style={{ padding: `${editingBanner.paddingY ?? 10}px ${editingBanner.paddingX ?? 16}px`, backgroundColor: editingBanner.backgroundColor ?? "#0b3a66", opacity: editingBanner.opacity ?? 1 }}>
                  <p style={{ color: editingBanner.textColor ?? "#ffffff", fontSize: `${editingBanner.fontSize ?? 18}px`, margin: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {editingBanner.text || "Banner preview"}
                  </p>
                </div>
              </div>
            )}
            <DialogFooter>
              <Button variant="outline" onClick={() => { setBannerDialogOpen(false); setEditingBanner(null); }}>Cancel</Button>
              <Button
                disabled={!editingBanner?.text?.trim() || createBannerMut.isPending || updateBannerMut.isPending}
                onClick={() => {
                  if (!editingBanner?.text?.trim()) return;
                  if (editingBanner.id) {
                    updateBannerMut.mutate({ bannerId: editingBanner.id, data: editingBanner });
                  } else {
                    createBannerMut.mutate({ videoId: id!, ...editingBanner });
                  }
                }}
                data-testid="button-save-banner"
              >
                {(createBannerMut.isPending || updateBannerMut.isPending) ? "Saving…" : (editingBanner?.id ? "Update" : "Add")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Watermark Settings */}
        <TabsContent value="watermark" className="mt-4 space-y-4">
          <Card className="border border-card-border">
            <CardHeader><CardTitle className="text-base">Logo Watermark</CardTitle></CardHeader>
            <CardContent>
              <SettingRow label="Enable Logo" description="Show a logo image overlay on the player">
                <Switch checked={!!localWs.logoEnabled} onCheckedChange={val => setLocalWs(p => ({ ...p, logoEnabled: val }))} data-testid="switch-logo-enabled" />
              </SettingRow>
              {localWs.logoEnabled && (
                <div className="mt-4 space-y-4">
                  <div className="space-y-1.5">
                    <Label>Upload Logo Image</Label>
                    <div className="flex items-center gap-2">
                      <Input
                        type="file"
                        accept="image/*"
                        data-testid="input-logo-upload"
                        disabled={logoUploading}
                        onChange={async (e) => {
                          const file = e.target.files?.[0];
                          if (!file) return;
                          setLogoUploading(true);
                          try {
                            const fd = new FormData();
                            fd.append("file", file);
                            const resp = await fetch("/api/assets/logo/upload", { method: "POST", body: fd, credentials: "include" });
                            if (!resp.ok) throw new Error((await resp.json()).message || "Upload failed");
                            const data = await resp.json();
                            setLocalWs(p => ({ ...p, logoUrl: data.previewUrl }));
                            toast({ title: "Logo uploaded", description: file.name });
                          } catch (err: any) {
                            toast({ title: "Upload failed", description: err.message, variant: "destructive" });
                          } finally {
                            setLogoUploading(false);
                          }
                        }}
                      />
                      {logoUploading && <RefreshCw className="h-4 w-4 animate-spin text-muted-foreground" />}
                    </div>
                    {localWs.logoUrl && (
                      <div className="mt-2 flex items-center gap-3">
                        <img src={localWs.logoUrl} alt="Logo preview" className="h-10 max-w-[120px] object-contain rounded border" />
                        <span className="text-xs text-muted-foreground truncate max-w-[200px]">{localWs.logoUrl}</span>
                      </div>
                    )}
                  </div>
                  <div className="space-y-1.5">
                    <Label>Or Enter Logo URL</Label>
                    <Input value={localWs.logoUrl || ""} placeholder="https://..." onChange={e => setLocalWs(p => ({ ...p, logoUrl: e.target.value }))} data-testid="input-logo-url" />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Position</Label>
                    <Select value={localWs.logoPosition || "top-right"} onValueChange={val => setLocalWs(p => ({ ...p, logoPosition: val }))}>
                      <SelectTrigger data-testid="select-logo-position"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {["top-left","top-right","bottom-left","bottom-right","center"].map(pos => (
                          <SelectItem key={pos} value={pos}>{pos}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>Opacity: {Math.round((localWs.logoOpacity ?? 0.8) * 100)}%</Label>
                    <Slider value={[(localWs.logoOpacity ?? 0.8) * 100]} min={10} max={100} step={5}
                      onValueChange={([v]) => setLocalWs(p => ({ ...p, logoOpacity: v / 100 }))} />
                  </div>
                </div>
              )}
              <SaveBar dirty={JSON.stringify(localWs) !== JSON.stringify(ws)} onSave={() => updateWatermark.mutate(localWs)} isPending={updateWatermark.isPending} />
            </CardContent>
          </Card>

          <Card className="border border-card-border">
            <CardHeader><CardTitle className="text-base">Scrolling Ticker</CardTitle></CardHeader>
            <CardContent>
              <SettingRow label="Enable Ticker" description="Show a scrolling text banner">
                <Switch checked={!!localWs.tickerEnabled} onCheckedChange={val => setLocalWs(p => ({ ...p, tickerEnabled: val }))} data-testid="switch-ticker-enabled" />
              </SettingRow>
              {localWs.tickerEnabled && (
                <div className="mt-4 space-y-4">
                  <div className="space-y-1.5">
                    <Label>Ticker Text</Label>
                    <Input value={localWs.tickerText || ""} placeholder="Use {DOMAIN} {VIDEO_ID} {SESSION_CODE} {TIME}"
                      onChange={e => setLocalWs(p => ({ ...p, tickerText: e.target.value }))} data-testid="input-ticker-text" />
                    <p className="text-xs text-muted-foreground">Variables: {"{DOMAIN}"} {"{VIDEO_ID}"} {"{SESSION_CODE}"} {"{TIME}"}</p>
                  </div>
                  <div className="space-y-2">
                    <Label>Speed: {localWs.tickerSpeed || 50}px/s</Label>
                    <Slider value={[localWs.tickerSpeed || 50]} min={10} max={200} step={10}
                      onValueChange={([v]) => setLocalWs(p => ({ ...p, tickerSpeed: v }))} />
                  </div>
                  <div className="space-y-2">
                    <Label>Opacity: {Math.round((localWs.tickerOpacity ?? 0.7) * 100)}%</Label>
                    <Slider value={[(localWs.tickerOpacity ?? 0.7) * 100]} min={10} max={100} step={5}
                      onValueChange={([v]) => setLocalWs(p => ({ ...p, tickerOpacity: v / 100 }))} />
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <Label>Text Color</Label>
                      <div className="flex items-center gap-2">
                        <input type="color" value={localWs.tickerTextColor || "#FFFFFF"} onChange={e => setLocalWs(p => ({ ...p, tickerTextColor: e.target.value }))} className="w-8 h-8 rounded border cursor-pointer" data-testid="input-ticker-text-color" />
                        <Input value={localWs.tickerTextColor || "#FFFFFF"} onChange={e => setLocalWs(p => ({ ...p, tickerTextColor: e.target.value }))} className="font-mono text-xs" />
                      </div>
                    </div>
                    <div className="space-y-1.5">
                      <Label>Background Color</Label>
                      <div className="flex items-center gap-2">
                        <input type="color" value={localWs.tickerBgColor || "#000000"} onChange={e => setLocalWs(p => ({ ...p, tickerBgColor: e.target.value }))} className="w-8 h-8 rounded border cursor-pointer" data-testid="input-ticker-bg-color" />
                        <Input value={localWs.tickerBgColor || "#000000"} onChange={e => setLocalWs(p => ({ ...p, tickerBgColor: e.target.value }))} className="font-mono text-xs" />
                      </div>
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label>Font Size: {localWs.tickerFontSizePx || 14}px</Label>
                    <Slider value={[localWs.tickerFontSizePx || 14]} min={8} max={32} step={1}
                      onValueChange={([v]) => setLocalWs(p => ({ ...p, tickerFontSizePx: v }))} />
                  </div>
                </div>
              )}
              <SaveBar dirty={JSON.stringify(localWs) !== JSON.stringify(ws)} onSave={() => updateWatermark.mutate(localWs)} isPending={updateWatermark.isPending} />
            </CardContent>
          </Card>

          <Card className="border border-card-border">
            <CardHeader><CardTitle className="text-base">Author Name Overlay</CardTitle></CardHeader>
            <CardContent>
              <SettingRow label="Enable Author Overlay" description="Show author name on the top-right corner of the video">
                <Switch checked={!!localWs.authorEnabled} onCheckedChange={val => setLocalWs(p => ({ ...p, authorEnabled: val }))} data-testid="switch-author-enabled" />
              </SettingRow>
              {localWs.authorEnabled && (
                <div className="mt-4 space-y-4">
                  <div className="space-y-1.5">
                    <Label>Author Name</Label>
                    <Input value={localWs.authorName || video?.author || ""} placeholder="Author name"
                      onChange={e => setLocalWs(p => ({ ...p, authorName: e.target.value }))} data-testid="input-author-name" />
                    <p className="text-xs text-muted-foreground">Leave blank to use the video&apos;s author field</p>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <Label>Text Color</Label>
                      <div className="flex items-center gap-2">
                        <input type="color" value={localWs.authorTextColor || "#FFFFFF"} onChange={e => setLocalWs(p => ({ ...p, authorTextColor: e.target.value }))} className="w-8 h-8 rounded border cursor-pointer" data-testid="input-author-text-color" />
                        <Input value={localWs.authorTextColor || "#FFFFFF"} onChange={e => setLocalWs(p => ({ ...p, authorTextColor: e.target.value }))} className="font-mono text-xs" />
                      </div>
                    </div>
                    <div className="space-y-1.5">
                      <Label>Background Color</Label>
                      <div className="flex items-center gap-2">
                        <input type="color" value={(localWs.authorBgColor && localWs.authorBgColor !== "transparent") ? localWs.authorBgColor : "#000000"} onChange={e => setLocalWs(p => ({ ...p, authorBgColor: e.target.value }))} className="w-8 h-8 rounded border cursor-pointer" data-testid="input-author-bg-color" />
                        <Input value={localWs.authorBgColor || "transparent"} onChange={e => setLocalWs(p => ({ ...p, authorBgColor: e.target.value }))} className="font-mono text-xs" placeholder="transparent" />
                      </div>
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label>Font Size: {localWs.authorFontSizePx || 14}px</Label>
                    <Slider value={[localWs.authorFontSizePx || 14]} min={8} max={32} step={1}
                      onValueChange={([v]) => setLocalWs(p => ({ ...p, authorFontSizePx: v }))} />
                  </div>
                  <div className="space-y-2">
                    <Label>Opacity: {Math.round((localWs.authorOpacity ?? 0.8) * 100)}%</Label>
                    <Slider value={[(localWs.authorOpacity ?? 0.8) * 100]} min={0} max={100} step={5}
                      onValueChange={([v]) => setLocalWs(p => ({ ...p, authorOpacity: v / 100 }))} />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Text Style</Label>
                    <Select value={localWs.authorTextStyle || "normal"} onValueChange={val => setLocalWs(p => ({ ...p, authorTextStyle: val }))}>
                      <SelectTrigger data-testid="select-author-text-style"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="normal">Normal</SelectItem>
                        <SelectItem value="bold">Bold</SelectItem>
                        <SelectItem value="italic">Italic</SelectItem>
                        <SelectItem value="bold_italic">Bold Italic</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              )}
              <SaveBar dirty={JSON.stringify(localWs) !== JSON.stringify(ws)} onSave={() => updateWatermark.mutate(localWs)} isPending={updateWatermark.isPending} />
            </CardContent>
          </Card>

          <Card className="border border-card-border">
            <CardHeader><CardTitle className="text-base">Pop-up Watermark</CardTitle></CardHeader>
            <CardContent>
              <SettingRow label="Enable Pop Watermark" description="Show periodic pop-up text overlays">
                <Switch checked={!!localWs.popEnabled} onCheckedChange={val => setLocalWs(p => ({ ...p, popEnabled: val }))} data-testid="switch-pop-enabled" />
              </SettingRow>
              {localWs.popEnabled && (
                <div className="mt-4 space-y-4">
                  <div className="space-y-1.5">
                    <Label>Pop Text</Label>
                    <Input defaultValue={localWs.popText || "{DOMAIN}"} placeholder="{DOMAIN}"
                      onChange={e => setLocalWs(p => ({ ...p, popText: e.target.value }))} />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Position Mode</Label>
                    <Select value={localWs.popMode || "random"} onValueChange={val => setLocalWs(p => ({ ...p, popMode: val }))}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="random">Random (corners + center)</SelectItem>
                        <SelectItem value="corners">Corners only</SelectItem>
                        <SelectItem value="center">Center only</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <Label>Interval (seconds)</Label>
                      <Input type="number" min={5} defaultValue={localWs.popInterval || 30}
                        onChange={e => setLocalWs(p => ({ ...p, popInterval: parseInt(e.target.value) || 30 }))} />
                    </div>
                    <div className="space-y-1.5">
                      <Label>Duration (seconds)</Label>
                      <Input type="number" min={1} defaultValue={localWs.popDuration || 3}
                        onChange={e => setLocalWs(p => ({ ...p, popDuration: parseInt(e.target.value) || 3 }))} />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label>Opacity: {Math.round((localWs.popOpacity ?? 0.8) * 100)}%</Label>
                    <Slider value={[(localWs.popOpacity ?? 0.8) * 100]} min={10} max={100} step={5}
                      onValueChange={([v]) => setLocalWs(p => ({ ...p, popOpacity: v / 100 }))} />
                  </div>
                </div>
              )}
              <SaveBar dirty={JSON.stringify(localWs) !== JSON.stringify(ws)} onSave={() => updateWatermark.mutate(localWs)} isPending={updateWatermark.isPending} />
            </CardContent>
          </Card>
        </TabsContent>

        {/* Security */}
        <TabsContent value="security" className="mt-4 space-y-4">
          {/* Use Global toggle */}
          <Card className="border border-card-border">
            <CardContent className="py-3 px-4">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="text-sm font-medium text-foreground">Use Global Security Settings</p>
                  <p className="text-xs text-muted-foreground mt-0.5">Apply the global client protection policy to this video</p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {localUseGlobal && (
                    <Badge variant="secondary" className="text-xs" data-testid="badge-using-global">Using Global Settings</Badge>
                  )}
                  <Switch
                    checked={localUseGlobal}
                    onCheckedChange={val => toggleUseGlobal.mutate(val)}
                    disabled={toggleUseGlobal.isPending}
                    data-testid="switch-use-global-security"
                  />
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="border border-card-border">
            <CardHeader><CardTitle className="text-base">Access & Token Security</CardTitle></CardHeader>
            <CardContent>
              {[
                { key: "tokenRequired", label: "Require Token", desc: "All playback requires a valid embed token" },
                { key: "signedUrls", label: "Signed HLS URLs", desc: "Use time-limited signed URLs for HLS segments" },
                { key: "hotlinkProtection", label: "Hotlink Protection", desc: "Check Referer/Origin headers on requests" },
                { key: "referrerStrict", label: "Strict Referrer Check", desc: "Block requests with missing referer header" },
                { key: "rateLimitEnabled", label: "Rate Limiting", desc: "Limit requests per token/IP" },
              ].map(s => (
                <SettingRow key={s.key} label={s.label} description={s.desc}>
                  <Switch checked={!!localSs[s.key]} onCheckedChange={val => setLocalSs(p => ({ ...p, [s.key]: val }))} data-testid={`switch-${s.key}`} />
                </SettingRow>
              ))}
              <div className="mt-4 grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label>Signed URL TTL (seconds)</Label>
                  <Input type="number" min={10} defaultValue={localSs.signedUrlTtl || 120} onChange={e => setLocalSs(p => ({ ...p, signedUrlTtl: parseInt(e.target.value) || 120 }))} />
                </div>
                <div className="space-y-1.5">
                  <Label>Token TTL (seconds)</Label>
                  <Input type="number" min={60} defaultValue={localSs.tokenTtl || 86400} onChange={e => setLocalSs(p => ({ ...p, tokenTtl: parseInt(e.target.value) || 86400 }))} />
                </div>
                <div className="space-y-1.5">
                  <Label>Concurrent Session Limit</Label>
                  <Input type="number" min={1} defaultValue={localSs.concurrentLimit || 5} onChange={e => setLocalSs(p => ({ ...p, concurrentLimit: parseInt(e.target.value) || 5 }))} />
                </div>
              </div>
              <SaveBar dirty={JSON.stringify(localSs) !== JSON.stringify(ss)} onSave={() => updateSecurity.mutate(localSs)} isPending={updateSecurity.isPending} />
            </CardContent>
          </Card>

          <Card className="border border-card-border">
            <CardHeader>
              <CardTitle className="text-base">Domain Whitelist</CardTitle>
              <CardDescription>Only allow playback from specific domains</CardDescription>
            </CardHeader>
            <CardContent>
              <SettingRow label="Enable Domain Whitelist" description="Block playback from domains not in the list">
                <Switch checked={!!localSs.domainWhitelistEnabled} onCheckedChange={val => setLocalSs(p => ({ ...p, domainWhitelistEnabled: val }))} />
              </SettingRow>
              {localSs.domainWhitelistEnabled && (
                <div className="mt-4 space-y-3">
                  <div className="flex gap-2">
                    <Input
                      value={domainInput}
                      onChange={e => setDomainInput(e.target.value)}
                      placeholder="example.com"
                      onKeyDown={e => {
                        if (e.key === "Enter" && domainInput.trim()) {
                          setLocalSs(p => ({ ...p, allowedDomains: [...(p.allowedDomains || []), domainInput.trim()] }));
                          setDomainInput("");
                        }
                      }}
                    />
                    <Button variant="outline" onClick={() => {
                      if (domainInput.trim()) {
                        setLocalSs(p => ({ ...p, allowedDomains: [...(p.allowedDomains || []), domainInput.trim()] }));
                        setDomainInput("");
                      }
                    }}>Add</Button>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {(localSs.allowedDomains || []).map((domain: string) => (
                      <Badge key={domain} variant="secondary" className="gap-1.5">
                        {domain}
                        <button onClick={() => setLocalSs(p => ({ ...p, allowedDomains: p.allowedDomains.filter((d: string) => d !== domain) }))} className="hover:text-destructive">×</button>
                      </Badge>
                    ))}
                    {!(localSs.allowedDomains?.length) && <p className="text-sm text-muted-foreground">No domains added yet</p>}
                  </div>
                </div>
              )}
              <SaveBar dirty={JSON.stringify(localSs) !== JSON.stringify(ss)} onSave={() => updateSecurity.mutate(localSs)} isPending={updateSecurity.isPending} />
            </CardContent>
          </Card>

          {/* Client Protection Settings */}
          <Card className="border border-card-border">
            <CardHeader>
              <div className="flex items-center justify-between gap-2">
                <div>
                  <CardTitle className="text-base">Client Protection</CardTitle>
                  <CardDescription className="mt-0.5">
                    {localUseGlobal ? "Showing read-only global defaults — toggle above to override per video" : "Custom protection settings for this video"}
                  </CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <SecuritySettingsForm
                value={localUseGlobal ? (clientSecData ? { ...defaultClientSecuritySettings, ...clientSecData } : defaultClientSecuritySettings) : localCss}
                onChange={v => setLocalCss(v)}
                disabled={localUseGlobal}
                showSaveButton={!localUseGlobal}
                onSave={() => saveClientSecurity.mutate()}
                isPending={saveClientSecurity.isPending}
              />
            </CardContent>
          </Card>
        </TabsContent>

        {/* Embed & Share */}
        <TabsContent value="embed" className="mt-4 space-y-4">
          <Card className="border border-card-border">
            <CardHeader className="flex flex-row items-center justify-between gap-2">
              <div>
                <CardTitle className="text-base">Embed Codes</CardTitle>
                <CardDescription>Use these in external websites</CardDescription>
              </div>
              <Button size="sm" onClick={() => setTokenDialogOpen(true)} data-testid="button-create-token">
                <Plus className="h-3.5 w-3.5 mr-1" />New Token
              </Button>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="rounded-lg border border-blue-500/20 bg-blue-500/5 p-3 text-sm text-blue-700 dark:text-blue-300">
                <p className="font-medium mb-1">Secure LMS Embedding</p>
                <p className="opacity-80 text-xs">This player uses postMessage authorization — the token is never exposed in the URL. Your LMS must send a signed launch token to the iframe after it loads.</p>
              </div>

              <div className="space-y-2">
                <Label>iFrame Embed Code</Label>
                <div className="relative">
                  <pre className="rounded-md bg-muted p-3 text-xs overflow-x-auto border border-border whitespace-pre-wrap break-all">{iframeCode}</pre>
                </div>
                <CopyButton text={iframeCode} label="Copy iFrame" />
              </div>

              <div className="space-y-2">
                <Label>LMS Authorization Snippet (JavaScript)</Label>
                <div className="relative">
                  <pre className="rounded-md bg-muted p-3 text-xs overflow-x-auto border border-border whitespace-pre-wrap break-all font-mono">{postMessageCode}</pre>
                </div>
                <CopyButton text={postMessageCode} label="Copy JS Snippet" />
                <p className="text-xs text-muted-foreground">Generate a signed LMS launch token on your server using <code className="bg-muted px-1 rounded">LMS_HMAC_SECRET</code> and send it via postMessage.</p>
              </div>

              <div className="space-y-2">
                <Label>Masked Share Link</Label>
                <div className="flex items-center gap-2">
                  <Input value={shareLink} readOnly className="font-mono text-xs" />
                  <CopyButton text={shareLink} />
                </div>
              </div>

              <div className="space-y-2">
                <Label>Public Video ID</Label>
                <div className="flex items-center gap-2">
                  <Input value={video.publicId} readOnly className="font-mono text-sm" />
                  <CopyButton text={video.publicId} />
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Analytics */}
        <TabsContent value="analytics" className="mt-4">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
            {[
              { label: "Total Plays", value: analytics?.totalPlays ?? 0 },
              { label: "Unique Domains", value: analytics?.uniqueDomains ?? 0 },
              { label: "Total Watch Time", value: analytics?.totalWatchSeconds ? `${Math.round(analytics.totalWatchSeconds / 60)}m` : "0m" },
            ].map(stat => (
              <Card key={stat.label} className="border border-card-border">
                <CardContent className="p-4">
                  <p className="text-xs text-muted-foreground">{stat.label}</p>
                  <p className="text-2xl font-bold text-foreground mt-1">{stat.value}</p>
                </CardContent>
              </Card>
            ))}
          </div>

          {analytics?.recentSessions?.length > 0 && (
            <Card className="border border-card-border">
              <CardHeader><CardTitle className="text-base">Recent Sessions</CardTitle></CardHeader>
              <CardContent>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border">
                        <th className="text-left py-2 text-xs text-muted-foreground font-medium">Domain</th>
                        <th className="text-left py-2 text-xs text-muted-foreground font-medium">IP</th>
                        <th className="text-left py-2 text-xs text-muted-foreground font-medium">Watch Time</th>
                        <th className="text-left py-2 text-xs text-muted-foreground font-medium">Started</th>
                      </tr>
                    </thead>
                    <tbody>
                      {analytics.recentSessions.map((s: any) => (
                        <tr key={s.id} className="border-b border-border last:border-0">
                          <td className="py-2 text-foreground">{s.domain || "—"}</td>
                          <td className="py-2 text-muted-foreground">{s.ip || "—"}</td>
                          <td className="py-2 text-foreground">{s.secondsWatched || 0}s</td>
                          <td className="py-2 text-muted-foreground text-xs">{formatDistanceToNow(new Date(s.startedAt), { addSuffix: true })}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* Tokens */}
        <TabsContent value="audit" className="mt-4">
          <Card className="border border-card-border">
            <CardHeader className="flex flex-row items-center justify-between gap-2">
              <CardTitle className="text-base">Embed Tokens</CardTitle>
              <Button size="sm" onClick={() => setTokenDialogOpen(true)}>
                <Plus className="h-3.5 w-3.5 mr-1" />New Token
              </Button>
            </CardHeader>
            <CardContent>
              {tokens.length === 0 ? (
                <div className="flex flex-col items-center py-8">
                  <Key className="h-8 w-8 text-muted-foreground mb-2" />
                  <p className="text-sm text-muted-foreground">No tokens yet. Create one to generate embed codes.</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {tokens.map(token => {
                    const expired = token.expiresAt && new Date(token.expiresAt) < new Date();
                    return (
                      <div key={token.id} className={`flex items-center gap-3 rounded-md border p-3 ${token.revoked ? "border-border opacity-60" : "border-border"}`} data-testid={`token-${token.id}`}>
                        <Key className="h-4 w-4 text-muted-foreground shrink-0" />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-sm font-medium text-foreground">{token.label || "Token"}</span>
                            {token.revoked && <Badge variant="destructive" className="text-xs">Revoked</Badge>}
                            {expired && !token.revoked && <Badge variant="outline" className="text-xs">Expired</Badge>}
                            {!token.revoked && !expired && <Badge variant="secondary" className="text-xs">Active</Badge>}
                          </div>
                          <p className="text-xs text-muted-foreground mt-0.5">
                            {token.allowedDomain && `Domain: ${token.allowedDomain} · `}
                            {token.expiresAt ? `Expires ${formatDistanceToNow(new Date(token.expiresAt), { addSuffix: true })}` : "No expiry"}
                          </p>
                          <p className="text-xs font-mono text-muted-foreground mt-1 truncate max-w-sm">{token.token}</p>
                        </div>
                        <div className="flex gap-2 shrink-0">
                          <CopyButton text={token.token} />
                          {!token.revoked && (
                            <Button size="sm" variant="outline" onClick={() => revokeToken.mutate(token.id)}>Revoke</Button>
                          )}
                          <Button size="icon" variant="ghost" onClick={() => deleteToken.mutate(token.id)}>
                            <Trash2 className="h-4 w-4 text-muted-foreground" />
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
        </div>{/* end flex-1 left column */}

      </div>{/* end flex row */}
    </div>{/* end page container */}

    {/* Token creation dialog rendered at top-level so it works from any tab */}
    <Dialog open={tokenDialogOpen} onOpenChange={setTokenDialogOpen}>
      <DialogContent>
        <DialogHeader><DialogTitle>Create Embed Token</DialogTitle></DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label>Label</Label>
            <Input value={tokenLabel} onChange={e => setTokenLabel(e.target.value)} placeholder="Website Name" data-testid="input-token-label" />
          </div>
          <div className="space-y-1.5">
            <Label>Allowed Domain (optional)</Label>
            <Input value={tokenDomain} onChange={e => setTokenDomain(e.target.value)} placeholder="example.com" data-testid="input-token-domain" />
          </div>
          <div className="space-y-1.5">
            <Label>Expires In (hours)</Label>
            <Select value={tokenTtl} onValueChange={setTokenTtl}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="1">1 hour</SelectItem>
                <SelectItem value="24">24 hours</SelectItem>
                <SelectItem value="168">7 days</SelectItem>
                <SelectItem value="720">30 days</SelectItem>
                <SelectItem value="8760">1 year</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setTokenDialogOpen(false)}>Cancel</Button>
          <Button onClick={() => createToken.mutate()} disabled={createToken.isPending} data-testid="button-confirm-create-token">
            {createToken.isPending ? "Creating…" : "Create Token"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </>
  );
}
