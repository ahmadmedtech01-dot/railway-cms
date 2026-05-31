import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
  DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import {
  Plus, Search, MoreVertical, Play, Settings, Eye, EyeOff, Trash2,
  Video, Clock, AlertCircle, CheckCircle, Upload, RefreshCw, Zap,
  Tag, FolderOpen, Download, Pencil, X, CheckSquare, Square, Loader2,
} from "lucide-react";
import { useState } from "react";
import { formatDistanceToNow } from "date-fns";
import type { Video as VideoType, VideoCategory } from "@shared/schema";

const statusConfig: Record<string, { label: string; color: string; icon: any }> = {
  uploading: { label: "Uploading", color: "bg-blue-500/10 text-blue-600 dark:text-blue-400", icon: Upload },
  processing: { label: "Processing", color: "bg-amber-500/10 text-amber-600 dark:text-amber-400", icon: RefreshCw },
  ready: { label: "Ready", color: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400", icon: CheckCircle },
  needs_hls: { label: "Needs HLS", color: "bg-orange-500/10 text-orange-600 dark:text-orange-400", icon: Zap },
  error: { label: "Error", color: "bg-red-500/10 text-red-600 dark:text-red-400", icon: AlertCircle },
};

function getDerivedStatus(video: any): string {
  if (video.status === "ready") {
    const isDirectM3u8 = video.sourceType === "direct_url" && video.sourceUrl && /\.m3u8/i.test(video.sourceUrl);
    if (!video.hlsS3Prefix && !isDirectM3u8) return "needs_hls";
  }
  return video.status;
}

const PRESET_COLORS = [
  "#6366f1", "#8b5cf6", "#ec4899", "#ef4444",
  "#f97316", "#eab308", "#22c55e", "#14b8a6",
  "#0ea5e9", "#64748b",
];

function CategoryDot({ color }: { color: string }) {
  return <span className="inline-block w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: color }} />;
}

interface DownloadDialogProps {
  video: VideoType | null;
  onClose: () => void;
}

function DownloadDialog({ video, onClose }: DownloadDialogProps) {
  const { toast } = useToast();
  const [loading, setLoading] = useState(false);

  if (!video) return null;

  const qualities = (video.qualities || []).slice().sort((a, b) => b - a);

  async function handleDownload() {
    setLoading(true);
    try {
      const data = await apiRequest("GET", `/api/videos/${video!.id}/download`) as any;
      const a = document.createElement("a");
      a.href = data.url;
      a.download = data.filename;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      toast({ title: "Download started", description: data.filename });
      onClose();
    } catch (e: any) {
      toast({ title: "Download failed", description: e.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Download className="h-4 w-4" /> Download Video
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <p className="text-sm font-medium text-foreground">{video.title}</p>
            {video.author && <p className="text-xs text-muted-foreground mt-0.5">{video.author}</p>}
          </div>
          {qualities.length > 0 ? (
            <div>
              <p className="text-xs text-muted-foreground mb-1.5">Processed qualities available:</p>
              <div className="flex flex-wrap gap-1.5">
                {qualities.map(q => (
                  <span key={q} className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-muted text-foreground border border-border">
                    {q}p
                  </span>
                ))}
              </div>
            </div>
          ) : null}
          <p className="text-xs text-muted-foreground leading-relaxed">
            Downloads the original source file as uploaded. A secure download link (valid 1 hour) will be generated.
          </p>
          {!video.rawS3Key && (
            <p className="text-xs text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/20 rounded px-3 py-2 border border-amber-200 dark:border-amber-800">
              No source file is stored for this video (direct URL or Vimeo import).
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={handleDownload} disabled={loading || !video.rawS3Key}>
            {loading ? <><Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />Generating...</> : <><Download className="h-3.5 w-3.5 mr-1.5" />Download Source</>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface BulkDownloadDialogProps {
  videos: VideoType[];
  onClose: () => void;
}

function BulkDownloadDialog({ videos, onClose }: BulkDownloadDialogProps) {
  const { toast } = useToast();
  const [loadingId, setLoadingId] = useState<string | null>(null);

  async function handleOne(video: VideoType) {
    setLoadingId(video.id);
    try {
      const data = await apiRequest("GET", `/api/videos/${video.id}/download`) as any;
      const a = document.createElement("a");
      a.href = data.url;
      a.download = data.filename;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } catch (e: any) {
      toast({ title: `Failed: ${video.title}`, description: e.message, variant: "destructive" });
    } finally {
      setLoadingId(null);
    }
  }

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Download className="h-4 w-4" /> Download {videos.length} Video{videos.length !== 1 ? "s" : ""}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
          {videos.map(video => (
            <div key={video.id} className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground truncate">{video.title}</p>
                {(video.qualities || []).length > 0 && (
                  <p className="text-xs text-muted-foreground">{(video.qualities || []).slice().sort((a,b)=>b-a).map(q=>`${q}p`).join(", ")}</p>
                )}
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={() => handleOne(video)}
                disabled={loadingId === video.id || !video.rawS3Key}
                className="shrink-0"
              >
                {loadingId === video.id
                  ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  : <Download className="h-3.5 w-3.5" />
                }
              </Button>
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface CategoryManagerProps {
  categories: VideoCategory[];
  onClose: () => void;
}

function CategoryManager({ categories, onClose }: CategoryManagerProps) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState(PRESET_COLORS[0]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editColor, setEditColor] = useState("");

  const create = useMutation({
    mutationFn: (data: { name: string; color: string }) =>
      apiRequest("POST", "/api/admin/categories", data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/admin/categories"] });
      setNewName("");
      toast({ title: "Category created" });
    },
    onError: () => toast({ title: "Failed to create category", variant: "destructive" }),
  });

  const update = useMutation({
    mutationFn: ({ id, ...data }: { id: string; name: string; color: string }) =>
      apiRequest("PUT", `/api/admin/categories/${id}`, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/admin/categories"] });
      qc.invalidateQueries({ queryKey: ["/api/videos"] });
      setEditingId(null);
      toast({ title: "Category updated" });
    },
    onError: () => toast({ title: "Failed to update category", variant: "destructive" }),
  });

  const remove = useMutation({
    mutationFn: (id: string) => apiRequest("DELETE", `/api/admin/categories/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/admin/categories"] });
      qc.invalidateQueries({ queryKey: ["/api/videos"] });
      toast({ title: "Category deleted" });
    },
    onError: () => toast({ title: "Failed to delete category", variant: "destructive" }),
  });

  function startEdit(cat: VideoCategory) {
    setEditingId(cat.id);
    setEditName(cat.name);
    setEditColor(cat.color);
  }

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Tag className="h-4 w-4" /> Manage Categories</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          {/* Create new */}
          <div className="space-y-2">
            <Label className="text-xs font-medium">New Category</Label>
            <div className="flex gap-2">
              <Input
                placeholder="Category name..."
                value={newName}
                onChange={e => setNewName(e.target.value)}
                onKeyDown={e => e.key === "Enter" && newName.trim() && create.mutate({ name: newName, color: newColor })}
                className="flex-1"
                data-testid="input-new-category"
              />
              <Button
                size="sm"
                onClick={() => create.mutate({ name: newName, color: newColor })}
                disabled={!newName.trim() || create.isPending}
              >
                {create.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
              </Button>
            </div>
            <div className="flex gap-1.5 flex-wrap">
              {PRESET_COLORS.map(c => (
                <button
                  key={c}
                  className={`w-6 h-6 rounded-full border-2 transition-all ${newColor === c ? "border-foreground scale-110" : "border-transparent"}`}
                  style={{ backgroundColor: c }}
                  onClick={() => setNewColor(c)}
                  data-testid={`button-color-${c}`}
                />
              ))}
            </div>
          </div>

          {/* Existing categories */}
          <div className="space-y-1.5 max-h-56 overflow-y-auto">
            {categories.length === 0 && (
              <p className="text-xs text-muted-foreground text-center py-4">No categories yet</p>
            )}
            {categories.map(cat => (
              <div key={cat.id} className="flex items-center gap-2 rounded-md border border-border px-3 py-2">
                {editingId === cat.id ? (
                  <>
                    <Input
                      value={editName}
                      onChange={e => setEditName(e.target.value)}
                      className="flex-1 h-7 text-sm"
                      autoFocus
                    />
                    <div className="flex gap-1">
                      {PRESET_COLORS.map(c => (
                        <button
                          key={c}
                          className={`w-4 h-4 rounded-full border transition-all ${editColor === c ? "border-foreground scale-110" : "border-transparent"}`}
                          style={{ backgroundColor: c }}
                          onClick={() => setEditColor(c)}
                        />
                      ))}
                    </div>
                    <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => update.mutate({ id: cat.id, name: editName, color: editColor })}>
                      <CheckCircle className="h-3.5 w-3.5 text-emerald-500" />
                    </Button>
                    <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setEditingId(null)}>
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </>
                ) : (
                  <>
                    <CategoryDot color={cat.color} />
                    <span className="flex-1 text-sm font-medium text-foreground">{cat.name}</span>
                    <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => startEdit(cat)} data-testid={`button-edit-cat-${cat.id}`}>
                      <Pencil className="h-3 w-3" />
                    </Button>
                    <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive hover:text-destructive" onClick={() => remove.mutate(cat.id)} data-testid={`button-delete-cat-${cat.id}`}>
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </>
                )}
              </div>
            ))}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function LibraryPage() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [activeCategoryId, setActiveCategoryId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [showCategoryManager, setShowCategoryManager] = useState(false);
  const [downloadTarget, setDownloadTarget] = useState<VideoType | null>(null);
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showBulkDownload, setShowBulkDownload] = useState(false);
  const [assignCategory, setAssignCategory] = useState<{ videoId: string; current: string | null } | null>(null);

  const { data: videos = [], isLoading } = useQuery<VideoType[]>({
    queryKey: ["/api/videos"],
    refetchInterval: 10000,
  });

  const { data: categories = [] } = useQuery<VideoCategory[]>({
    queryKey: ["/api/admin/categories"],
  });

  const toggle = useMutation({
    mutationFn: (id: string) => apiRequest("POST", `/api/videos/${id}/toggle-availability`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/videos"] }),
    onError: () => toast({ title: "Failed to toggle availability", variant: "destructive" }),
  });

  const remove = useMutation({
    mutationFn: (id: string) => apiRequest("DELETE", `/api/videos/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/videos"] });
      toast({ title: "Video deleted" });
    },
    onError: () => toast({ title: "Failed to delete video", variant: "destructive" }),
  });

  const setCategory = useMutation({
    mutationFn: ({ videoId, categoryId }: { videoId: string; categoryId: string | null }) =>
      apiRequest("PUT", `/api/videos/${videoId}`, { categoryId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/videos"] });
      setAssignCategory(null);
    },
    onError: () => toast({ title: "Failed to assign category", variant: "destructive" }),
  });

  const filtered = videos.filter(v => {
    const matchSearch = v.title.toLowerCase().includes(search.toLowerCase()) ||
      (v.author || "").toLowerCase().includes(search.toLowerCase());
    const matchCat = activeCategoryId === null
      ? true
      : activeCategoryId === "__none"
        ? !v.categoryId
        : v.categoryId === activeCategoryId;
    return matchSearch && matchCat;
  });

  const categoryMap = Object.fromEntries(categories.map(c => [c.id, c]));

  function toggleSelect(id: string) {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function exitSelectMode() {
    setSelectMode(false);
    setSelected(new Set());
  }

  const selectedVideos = videos.filter(v => selected.has(v.id));

  return (
    <div className="p-6 space-y-5 max-w-6xl">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Video Library</h1>
          <p className="text-sm text-muted-foreground mt-0.5">{videos.length} videos total</p>
        </div>
        <div className="flex items-center gap-2">
          {selectMode ? (
            <>
              <span className="text-sm text-muted-foreground">{selected.size} selected</span>
              <Button
                size="sm"
                variant="outline"
                disabled={selected.size === 0}
                onClick={() => { setShowBulkDownload(true); }}
                data-testid="button-bulk-download"
              >
                <Download className="h-3.5 w-3.5 mr-1.5" />Download Selected
              </Button>
              <Button size="sm" variant="ghost" onClick={exitSelectMode}>
                <X className="h-3.5 w-3.5 mr-1" />Cancel
              </Button>
            </>
          ) : (
            <>
              <Button size="sm" variant="outline" onClick={() => setShowCategoryManager(true)} data-testid="button-manage-categories">
                <Tag className="h-3.5 w-3.5 mr-1.5" />Categories
              </Button>
              <Button size="sm" variant="outline" onClick={() => setSelectMode(true)} data-testid="button-select-mode">
                <CheckSquare className="h-3.5 w-3.5 mr-1.5" />Select
              </Button>
              <Button asChild data-testid="button-add-video">
                <Link href="/upload"><Plus className="h-4 w-4 mr-1.5" />Add Video</Link>
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Search + category filter */}
      <div className="space-y-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search videos..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="pl-9"
            data-testid="input-search"
          />
        </div>

        {/* Category pills */}
        {(categories.length > 0 || true) && (
          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={() => setActiveCategoryId(null)}
              className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium border transition-colors ${
                activeCategoryId === null
                  ? "bg-foreground text-background border-foreground"
                  : "bg-transparent text-muted-foreground border-border hover:border-foreground hover:text-foreground"
              }`}
              data-testid="filter-cat-all"
            >
              All
            </button>
            {categories.map(cat => (
              <button
                key={cat.id}
                onClick={() => setActiveCategoryId(activeCategoryId === cat.id ? null : cat.id)}
                className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium border transition-colors ${
                  activeCategoryId === cat.id
                    ? "border-foreground text-foreground bg-foreground/5"
                    : "bg-transparent text-muted-foreground border-border hover:border-foreground hover:text-foreground"
                }`}
                data-testid={`filter-cat-${cat.id}`}
              >
                <CategoryDot color={cat.color} />
                {cat.name}
              </button>
            ))}
            <button
              onClick={() => setActiveCategoryId(activeCategoryId === "__none" ? null : "__none")}
              className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium border transition-colors ${
                activeCategoryId === "__none"
                  ? "border-foreground text-foreground bg-foreground/5"
                  : "bg-transparent text-muted-foreground border-border hover:border-foreground hover:text-foreground"
              }`}
              data-testid="filter-cat-none"
            >
              Uncategorized
            </button>
          </div>
        )}
      </div>

      {/* Video list */}
      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <Card key={i} className="border border-card-border">
              <CardContent className="p-4">
                <div className="flex items-center gap-4">
                  <Skeleton className="h-16 w-24 rounded-md shrink-0" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-4 w-48" />
                    <Skeleton className="h-3 w-32" />
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center py-16 text-center">
          <Video className="h-12 w-12 text-muted-foreground mb-3" />
          <h3 className="text-base font-medium text-foreground">No videos found</h3>
          <p className="text-sm text-muted-foreground mt-1 mb-4">
            {search ? "Try a different search term" : activeCategoryId ? "No videos in this category" : "Upload your first video to get started"}
          </p>
          {!search && !activeCategoryId && (
            <Button asChild><Link href="/upload"><Plus className="h-4 w-4 mr-1.5" />Upload Video</Link></Button>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map(video => {
            const derived = getDerivedStatus(video);
            const status = statusConfig[derived] || statusConfig.error;
            const StatusIcon = status.icon;
            const cat = video.categoryId ? categoryMap[video.categoryId] : null;
            const isSelected = selected.has(video.id);
            return (
              <Card
                key={video.id}
                className={`border hover-elevate transition-all ${isSelected ? "border-primary ring-1 ring-primary" : "border-card-border"}`}
                data-testid={`card-video-${video.id}`}
              >
                <CardContent className="p-4">
                  <div className="flex items-center gap-4 flex-wrap">
                    {/* Select checkbox */}
                    {selectMode && (
                      <button
                        onClick={() => toggleSelect(video.id)}
                        className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
                        data-testid={`checkbox-video-${video.id}`}
                      >
                        {isSelected
                          ? <CheckSquare className="h-5 w-5 text-primary" />
                          : <Square className="h-5 w-5" />
                        }
                      </button>
                    )}

                    {/* Thumbnail */}
                    <div className="flex h-16 w-24 shrink-0 items-center justify-center rounded-md bg-muted overflow-hidden">
                      {video.thumbnailUrl ? (
                        <img src={video.thumbnailUrl} alt={video.title} className="h-full w-full object-cover" />
                      ) : (
                        <Video className="h-6 w-6 text-muted-foreground" />
                      )}
                    </div>

                    {/* Info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <h3 className="font-medium text-foreground truncate">{video.title}</h3>
                        {!video.available && (
                          <Badge variant="outline" className="text-xs shrink-0">Hidden</Badge>
                        )}
                        {cat && (
                          <span
                            className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium border border-border"
                            style={{ color: cat.color }}
                          >
                            <CategoryDot color={cat.color} />
                            {cat.name}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-3 mt-1 flex-wrap">
                        <span className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium ${status.color}`}>
                          <StatusIcon className="h-3 w-3" />
                          {status.label}
                        </span>
                        {video.author && <span className="text-xs text-muted-foreground">{video.author}</span>}
                        <span className="text-xs text-muted-foreground capitalize">{video.sourceType}</span>
                        <span className="text-xs text-muted-foreground">
                          {formatDistanceToNow(new Date(video.createdAt), { addSuffix: true })}
                        </span>
                        {(video.qualities || []).length > 0 && (
                          <span className="text-xs text-muted-foreground">
                            {(video.qualities || []).slice().sort((a,b)=>b-a).map(q=>`${q}p`).join(", ")}
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Actions */}
                    {!selectMode && (
                      <div className="flex items-center gap-2 shrink-0">
                        <Button size="sm" variant="outline" asChild data-testid={`button-edit-${video.id}`}>
                          <Link href={`/videos/${video.id}`}>
                            <Settings className="h-3.5 w-3.5 mr-1" />Manage
                          </Link>
                        </Button>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button size="icon" variant="ghost" data-testid={`button-menu-${video.id}`}>
                              <MoreVertical className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-52">
                            <DropdownMenuItem asChild>
                              <Link href={`/embed/${video.publicId}`}>
                                <Play className="h-4 w-4 mr-2" />Preview Player
                              </Link>
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => toggle.mutate(video.id)}>
                              {video.available ? (
                                <><EyeOff className="h-4 w-4 mr-2" />Hide Video</>
                              ) : (
                                <><Eye className="h-4 w-4 mr-2" />Show Video</>
                              )}
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Category</DropdownMenuLabel>
                            <DropdownMenuItem onClick={() => setAssignCategory({ videoId: video.id, current: video.categoryId || null })}>
                              <FolderOpen className="h-4 w-4 mr-2" />
                              {cat ? `Change from "${cat.name}"` : "Assign Category"}
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              onClick={() => setDownloadTarget(video)}
                              disabled={!video.rawS3Key}
                              data-testid={`button-download-${video.id}`}
                            >
                              <Download className="h-4 w-4 mr-2" />Download
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              className="text-destructive"
                              onClick={() => setDeleteTarget(video.id)}
                            >
                              <Trash2 className="h-4 w-4 mr-2" />Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Assign category dialog */}
      {assignCategory && (
        <Dialog open onOpenChange={() => setAssignCategory(null)}>
          <DialogContent className="sm:max-w-xs">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2"><FolderOpen className="h-4 w-4" /> Assign Category</DialogTitle>
            </DialogHeader>
            <div className="space-y-1.5">
              <button
                className={`w-full flex items-center gap-2 rounded-md px-3 py-2 text-sm text-left hover:bg-muted transition-colors ${!assignCategory.current ? "font-medium" : ""}`}
                onClick={() => setCategory.mutate({ videoId: assignCategory.videoId, categoryId: null })}
              >
                <span className="inline-block w-2.5 h-2.5 rounded-full bg-muted-foreground/30 shrink-0" />
                None (Uncategorized)
              </button>
              {categories.map(cat => (
                <button
                  key={cat.id}
                  className={`w-full flex items-center gap-2 rounded-md px-3 py-2 text-sm text-left hover:bg-muted transition-colors ${assignCategory.current === cat.id ? "font-medium" : ""}`}
                  onClick={() => setCategory.mutate({ videoId: assignCategory.videoId, categoryId: cat.id })}
                >
                  <CategoryDot color={cat.color} />
                  {cat.name}
                  {assignCategory.current === cat.id && <CheckCircle className="h-3.5 w-3.5 ml-auto text-emerald-500" />}
                </button>
              ))}
              {categories.length === 0 && (
                <p className="text-xs text-muted-foreground text-center py-3">
                  No categories yet. Create some first.
                </p>
              )}
            </div>
          </DialogContent>
        </Dialog>
      )}

      {/* Delete confirm */}
      <AlertDialog open={!!deleteTarget} onOpenChange={() => setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete video?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the video and all its settings, tokens, and analytics data.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground"
              onClick={() => { if (deleteTarget) { remove.mutate(deleteTarget); setDeleteTarget(null); } }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Category manager */}
      {showCategoryManager && (
        <CategoryManager categories={categories} onClose={() => setShowCategoryManager(false)} />
      )}

      {/* Download single */}
      {downloadTarget && (
        <DownloadDialog video={downloadTarget} onClose={() => setDownloadTarget(null)} />
      )}

      {/* Bulk download */}
      {showBulkDownload && (
        <BulkDownloadDialog
          videos={selectedVideos}
          onClose={() => { setShowBulkDownload(false); exitSelectMode(); }}
        />
      )}
    </div>
  );
}
