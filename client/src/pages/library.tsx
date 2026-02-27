import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
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
} from "lucide-react";
import { useState } from "react";
import { formatDistanceToNow } from "date-fns";
import type { Video as VideoType } from "@shared/schema";

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

export default function LibraryPage() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  const { data: videos = [], isLoading } = useQuery<VideoType[]>({
    queryKey: ["/api/videos"],
    refetchInterval: 10000,
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

  const filtered = videos.filter(v =>
    v.title.toLowerCase().includes(search.toLowerCase()) ||
    (v.author || "").toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="p-6 space-y-5 max-w-6xl">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Video Library</h1>
          <p className="text-sm text-muted-foreground mt-0.5">{videos.length} videos total</p>
        </div>
        <Button asChild data-testid="button-add-video">
          <Link href="/upload"><Plus className="h-4 w-4 mr-1.5" />Add Video</Link>
        </Button>
      </div>

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
            {search ? "Try a different search term" : "Upload your first video to get started"}
          </p>
          {!search && (
            <Button asChild><Link href="/upload"><Plus className="h-4 w-4 mr-1.5" />Upload Video</Link></Button>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map(video => {
            const derived = getDerivedStatus(video);
            const status = statusConfig[derived] || statusConfig.error;
            const StatusIcon = status.icon;
            return (
              <Card key={video.id} className="border border-card-border hover-elevate" data-testid={`card-video-${video.id}`}>
                <CardContent className="p-4">
                  <div className="flex items-center gap-4 flex-wrap">
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
                      </div>
                    </div>

                    {/* Actions */}
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
                        <DropdownMenuContent align="end">
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
                          <DropdownMenuItem
                            className="text-destructive"
                            onClick={() => setDeleteTarget(video.id)}
                          >
                            <Trash2 className="h-4 w-4 mr-2" />Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

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
    </div>
  );
}
