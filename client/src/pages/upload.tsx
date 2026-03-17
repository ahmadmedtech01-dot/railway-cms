import { useState, useRef, useEffect } from "react";
import { useLocation } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Upload, Link as LinkIcon, X, CloudUpload, CheckCircle, AlertCircle, Info, Video, HardDrive } from "lucide-react";
import type { StorageConnection } from "@shared/schema";

const QUALITY_OPTIONS = [
  { value: 240, label: "240p" },
  { value: 360, label: "360p" },
  { value: 480, label: "480p" },
  { value: 720, label: "720p (HD)" },
  { value: 1080, label: "1080p (Full HD)" },
];

function extractVimeoIdFE(input: string): string | null {
  const iframeMatch = input.match(/player\.vimeo\.com\/video\/(\d+)/i);
  if (iframeMatch) return iframeMatch[1];
  const urlMatch = input.match(/vimeo\.com\/(?:video\/)?(\d+)/i);
  if (urlMatch) return urlMatch[1];
  return null;
}

function detectUrlType(input: string): { type: "youtube" | "vimeo" | "m3u8" | "mp4" | "direct" | ""; label: string; description: string; blocked: boolean } {
  const raw = input.trim();
  if (!raw) return { type: "", label: "", description: "", blocked: false };

  // Vimeo iframe HTML or player.vimeo.com URL
  const vimeoId = extractVimeoIdFE(raw);
  if (vimeoId) {
    return { type: "vimeo", label: "Vimeo — Will Be Ingested", description: "We will import this video into your CMS using the Vimeo API and convert it to our secure HLS player. The Vimeo player iframe will NOT be used. Requires VIMEO_ACCESS_TOKEN and a Vimeo plan that allows file downloads.", blocked: false };
  }

  // YouTube (URL or iframe)
  if (/(?:youtube\.com|youtu\.be|youtube-nocookie\.com)/i.test(raw)) {
    return { type: "youtube", label: "YouTube — Not Supported", description: "YouTube links and embeds cannot be played in our custom player. Please upload the video file or provide a direct HLS/MP4 URL you own.", blocked: true };
  }

  if (/\.m3u8(\?|$)/i.test(raw)) {
    return { type: "m3u8", label: "Direct HLS Stream", description: "This .m3u8 URL will be used as-is in our player. It will be ready immediately.", blocked: false };
  }
  if (/\.mp4(\?|$)/i.test(raw)) {
    return { type: "mp4", label: "Direct MP4 — Will Transcode", description: "We will download this MP4 and convert it to HLS. This may take a few minutes.", blocked: false };
  }
  return { type: "direct", label: "Media URL — Will Transcode", description: "We will attempt to download and transcode this URL to HLS.", blocked: false };
}

export default function UploadPage() {
  const [, setLocation] = useLocation();
  const qc = useQueryClient();
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [author, setAuthor] = useState("");
  const [tags, setTags] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [qualities, setQualities] = useState<number[]>([720]);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadState, setUploadState] = useState<"idle" | "uploading" | "processing" | "done" | "error">("idle");
  const [sourceUrl, setSourceUrl] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [selectedConnectionId, setSelectedConnectionId] = useState<string>("");

  const { data: storageConnections = [] } = useQuery<StorageConnection[]>({
    queryKey: ["/api/storage-connections"],
  });

  useEffect(() => {
    if (storageConnections.length > 0 && !selectedConnectionId) {
      const active = storageConnections.find(c => c.isActive) ?? storageConnections[0];
      setSelectedConnectionId(active.id);
    }
  }, [storageConnections, selectedConnectionId]);

  const urlInfo = detectUrlType(sourceUrl);

  const importMutation = useMutation({
    mutationFn: async (data: any) => {
      const res = await apiRequest("POST", "/api/videos/import", data);
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/videos"] });
    },
  });

  const createVideoMutation = useMutation({
    mutationFn: async (data: any) => {
      const res = await apiRequest("POST", "/api/videos", data);
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/videos"] });
    },
  });

  const toggleQuality = (q: number) => {
    setQualities(prev =>
      prev.includes(q) ? prev.filter(x => x !== q) : [...prev, q]
    );
  };

  const handleFileSelect = (f: File) => {
    if (!f.type.startsWith("video/")) {
      toast({ title: "Invalid file", description: "Please select a video file", variant: "destructive" });
      return;
    }
    setSelectedFile(f);
  };

  const handleUpload = async () => {
    if (!title.trim()) {
      toast({ title: "Title required", variant: "destructive" });
      return;
    }
    if (!selectedFile) {
      toast({ title: "Please select a file", variant: "destructive" });
      return;
    }

    setUploadState("uploading");
    setUploadProgress(0);

    try {
      const video = await createVideoMutation.mutateAsync({
        title,
        description,
        author,
        tags: tags ? tags.split(",").map(t => t.trim()).filter(Boolean) : [],
        sourceType: "upload",
      });

      const formData = new FormData();
      formData.append("file", selectedFile);
      formData.append("qualities", JSON.stringify(qualities));
      if (selectedConnectionId) formData.append("connectionId", selectedConnectionId);

      const xhr = new XMLHttpRequest();
      xhr.upload.addEventListener("progress", (e) => {
        if (e.lengthComputable) {
          setUploadProgress(Math.round((e.loaded / e.total) * 100));
        }
      });

      await new Promise<void>((resolve, reject) => {
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) resolve();
          else reject(new Error(xhr.responseText));
        };
        xhr.onerror = () => reject(new Error("Upload failed"));
        xhr.open("POST", `/api/videos/${video.id}/upload`);
        xhr.send(formData);
      });

      setUploadState("processing");
      toast({ title: "Upload complete!", description: "Video is being processed into HLS streams." });
      setTimeout(() => {
        qc.invalidateQueries({ queryKey: ["/api/videos"] });
        setLocation(`/videos/${video.id}`);
      }, 2000);
    } catch (e: any) {
      setUploadState("error");
      toast({ title: "Upload failed", description: e.message, variant: "destructive" });
    }
  };

  const handleImport = async () => {
    if (!title.trim()) { toast({ title: "Title required", variant: "destructive" }); return; }
    if (!sourceUrl.trim()) { toast({ title: "URL required", variant: "destructive" }); return; }
    if (urlInfo.blocked) { toast({ title: "URL not supported", description: urlInfo.description, variant: "destructive" }); return; }
    try {
      const result = await importMutation.mutateAsync({
        title, description, author,
        tags: tags ? tags.split(",").map(t => t.trim()).filter(Boolean) : [],
        sourceUrl,
      });
      qc.invalidateQueries({ queryKey: ["/api/videos"] });
      toast({ title: result.status === "processing" ? "Ingestion started!" : "Video imported!", description: result.status === "processing" ? "Your video is being downloaded and converted. Check the video page for progress." : undefined });
      setLocation(`/videos/${result.videoId}`);
    } catch (e: any) {
      toast({ title: "Import failed", description: e.message, variant: "destructive" });
    }
  };

  return (
    <div className="p-6 space-y-6 max-w-3xl">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Add Video</h1>
        <p className="text-sm text-muted-foreground mt-0.5">Upload from your device or import from a URL</p>
      </div>

      {/* Metadata */}
      <Card className="border border-card-border">
        <CardHeader className="pb-4">
          <CardTitle className="text-base">Video Details</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="title">Title *</Label>
            <Input id="title" value={title} onChange={e => setTitle(e.target.value)} placeholder="My awesome video" data-testid="input-title" />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="author">Author</Label>
              <Input id="author" value={author} onChange={e => setAuthor(e.target.value)} placeholder="Author name" data-testid="input-author" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tags">Tags (comma-separated)</Label>
              <Input id="tags" value={tags} onChange={e => setTags(e.target.value)} placeholder="tutorial, demo" data-testid="input-tags" />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="description">Description</Label>
            <Textarea id="description" value={description} onChange={e => setDescription(e.target.value)} placeholder="Video description..." rows={3} data-testid="input-description" />
          </div>
        </CardContent>
      </Card>

      {/* Storage Destination */}
      {storageConnections.length > 0 && (
        <Card className="border border-card-border">
          <CardHeader className="pb-4">
            <div className="flex items-center gap-2">
              <HardDrive className="h-4 w-4 text-muted-foreground" />
              <CardTitle className="text-base">Storage Destination</CardTitle>
            </div>
            <CardDescription className="text-xs mt-0.5">Choose where the uploaded video will be stored</CardDescription>
          </CardHeader>
          <CardContent>
            <Select value={selectedConnectionId} onValueChange={setSelectedConnectionId} data-testid="select-storage-connection">
              <SelectTrigger className="w-full" data-testid="trigger-storage-connection">
                <SelectValue placeholder="Select storage destination" />
              </SelectTrigger>
              <SelectContent>
                {storageConnections.map(conn => (
                  <SelectItem key={conn.id} value={conn.id} data-testid={`option-connection-${conn.id}`}>
                    <span className="flex items-center gap-2">
                      {conn.name}
                      {conn.isActive && (
                        <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4">Active</Badge>
                      )}
                      <span className="text-xs text-muted-foreground capitalize">
                        ({conn.provider === "backblaze_b2" ? "Backblaze B2" : conn.provider === "cloudflare_r2" ? "Cloudflare R2" : "Amazon S3"})
                      </span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </CardContent>
        </Card>
      )}

      {/* Source */}
      <Card className="border border-card-border">
        <CardHeader className="pb-4">
          <CardTitle className="text-base">Video Source</CardTitle>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="upload">
            <TabsList className="mb-4">
              <TabsTrigger value="upload" data-testid="tab-upload"><Upload className="h-3.5 w-3.5 mr-1.5" />Upload File</TabsTrigger>
              <TabsTrigger value="import" data-testid="tab-import"><LinkIcon className="h-3.5 w-3.5 mr-1.5" />Import URL</TabsTrigger>
            </TabsList>

            <TabsContent value="upload" className="space-y-4">
              {/* Dropzone */}
              <div
                onDragOver={e => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={e => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files[0]; if (f) handleFileSelect(f); }}
                onClick={() => fileInputRef.current?.click()}
                className={`flex flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed p-10 cursor-pointer transition-colors
                  ${dragOver ? "border-primary bg-primary/5" : "border-border hover:border-primary/50 hover:bg-muted/50"}`}
                data-testid="dropzone-upload"
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="video/*"
                  className="hidden"
                  onChange={e => e.target.files?.[0] && handleFileSelect(e.target.files[0])}
                />
                <CloudUpload className="h-10 w-10 text-muted-foreground" />
                {selectedFile ? (
                  <div className="text-center">
                    <p className="text-sm font-medium text-foreground">{selectedFile.name}</p>
                    <p className="text-xs text-muted-foreground">{(selectedFile.size / 1024 / 1024).toFixed(1)} MB</p>
                  </div>
                ) : (
                  <div className="text-center">
                    <p className="text-sm font-medium text-foreground">Drop video here or click to browse</p>
                    <p className="text-xs text-muted-foreground mt-1">Supports MP4, MOV, AVI, MKV, WebM — up to 4GB</p>
                  </div>
                )}
              </div>

              {selectedFile && (
                <Button variant="ghost" size="sm" onClick={() => setSelectedFile(null)}>
                  <X className="h-4 w-4 mr-1" />Remove file
                </Button>
              )}

              {/* Quality Selection */}
              <div className="space-y-2">
                <Label>Output Qualities (HLS variants)</Label>
                <div className="flex flex-wrap gap-2">
                  {QUALITY_OPTIONS.map(q => (
                    <label key={q.value} className="flex items-center gap-1.5 cursor-pointer">
                      <Checkbox
                        checked={qualities.includes(q.value)}
                        onCheckedChange={() => toggleQuality(q.value)}
                        data-testid={`checkbox-quality-${q.value}`}
                      />
                      <span className="text-sm text-foreground">{q.label}</span>
                    </label>
                  ))}
                </div>
              </div>

              {/* Upload Progress */}
              {uploadState !== "idle" && (
                <div className="space-y-2 rounded-lg border border-border p-4">
                  {uploadState === "uploading" && (
                    <>
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-medium text-foreground">Uploading...</span>
                        <span className="text-sm text-muted-foreground">{uploadProgress}%</span>
                      </div>
                      <Progress value={uploadProgress} />
                    </>
                  )}
                  {uploadState === "processing" && (
                    <div className="flex items-center gap-2 text-amber-600 dark:text-amber-400">
                      <div className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
                      <span className="text-sm">Processing HLS streams — this may take a few minutes...</span>
                    </div>
                  )}
                  {uploadState === "done" && (
                    <div className="flex items-center gap-2 text-emerald-600">
                      <CheckCircle className="h-4 w-4" />
                      <span className="text-sm">Done! Redirecting...</span>
                    </div>
                  )}
                  {uploadState === "error" && (
                    <div className="flex items-center gap-2 text-destructive">
                      <AlertCircle className="h-4 w-4" />
                      <span className="text-sm">Upload failed. Please try again.</span>
                    </div>
                  )}
                </div>
              )}

              <Button
                onClick={handleUpload}
                disabled={!selectedFile || uploadState === "uploading" || uploadState === "processing"}
                className="w-full"
                data-testid="button-start-upload"
              >
                <Upload className="h-4 w-4 mr-1.5" />
                {uploadState === "uploading" ? "Uploading..." : uploadState === "processing" ? "Processing..." : "Start Upload"}
              </Button>
            </TabsContent>

            <TabsContent value="import" className="space-y-4">
              <div className="space-y-1.5">
                <Label>Video URL or Vimeo Embed Code</Label>
                <Textarea
                  value={sourceUrl}
                  onChange={e => setSourceUrl(e.target.value)}
                  placeholder={`Paste a Vimeo URL, Vimeo embed code (<iframe ...>), direct .mp4 URL, or .m3u8 playlist URL`}
                  rows={3}
                  className="font-mono text-xs"
                  data-testid="input-source-url"
                />
                <p className="text-xs text-muted-foreground">
                  Note: Vimeo embed code will NOT play in Vimeo's player. We will import the video into your CMS and play it via our secure custom player with your watermark and security settings applied.
                </p>
              </div>

              {/* URL type detection feedback */}
              {urlInfo.type && (
                <div className={`flex gap-2.5 rounded-lg border p-3 text-sm ${
                  urlInfo.blocked
                    ? "border-destructive/50 bg-destructive/10 text-destructive dark:text-red-400"
                    : urlInfo.type === "m3u8"
                    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                    : "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-400"
                }`} data-testid="url-detection-banner">
                  {urlInfo.blocked
                    ? <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                    : urlInfo.type === "m3u8"
                    ? <CheckCircle className="h-4 w-4 mt-0.5 shrink-0" />
                    : <Info className="h-4 w-4 mt-0.5 shrink-0" />
                  }
                  <div>
                    <p className="font-medium">{urlInfo.label}</p>
                    <p className="opacity-80 text-xs mt-0.5">{urlInfo.description}</p>
                  </div>
                </div>
              )}

              {!urlInfo.type && (
                <div className="rounded-lg border border-border bg-muted/40 p-3">
                  <p className="text-xs text-muted-foreground">
                    Supported: Vimeo URLs or embed code (requires Vimeo API access token + plan with file downloads), direct .mp4 or .m3u8 URLs.
                    YouTube is not supported — please upload the file directly.
                  </p>
                </div>
              )}

              <Button
                onClick={handleImport}
                disabled={importMutation.isPending || urlInfo.blocked}
                className="w-full"
                data-testid="button-import"
              >
                <LinkIcon className="h-4 w-4 mr-1.5" />
                {importMutation.isPending ? "Importing..." : "Import Video"}
              </Button>
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </div>
  );
}
