import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Video, Shield, Code2, Activity, Plus, ArrowRight,
  CheckCircle, Clock, AlertCircle, TrendingUp,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";

function StatCard({ title, value, icon: Icon, sub, color }: any) {
  return (
    <Card className="border border-card-border">
      <CardContent className="p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1">
            <p className="text-sm text-muted-foreground font-medium">{title}</p>
            <p className="text-3xl font-bold text-foreground mt-1">{value ?? "—"}</p>
            {sub && <p className="text-xs text-muted-foreground mt-1">{sub}</p>}
          </div>
          <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-md ${color}`}>
            <Icon className="h-5 w-5 text-white" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

const actionLabels: Record<string, string> = {
  video_created: "Video uploaded",
  video_updated: "Video updated",
  video_deleted: "Video deleted",
  video_availability_toggled: "Availability changed",
  token_created: "Embed token created",
  token_revoked: "Token revoked",
  player_settings_updated: "Player settings updated",
  watermark_settings_updated: "Watermark settings updated",
  security_settings_updated: "Security settings updated",
  settings_updated: "System settings updated",
};

export default function DashboardPage() {
  const { data: stats, isLoading } = useQuery({
    queryKey: ["/api/dashboard"],
    refetchInterval: 30000,
  });

  const s = stats as any;

  return (
    <div className="p-6 space-y-6 max-w-6xl">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Dashboard</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Overview of your video CMS</p>
        </div>
        <Button asChild data-testid="button-upload-video">
          <Link href="/upload">
            <Plus className="h-4 w-4 mr-1.5" />
            Upload Video
          </Link>
        </Button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {isLoading ? (
          Array.from({ length: 4 }).map((_, i) => (
            <Card key={i} className="border border-card-border">
              <CardContent className="p-5">
                <Skeleton className="h-4 w-24 mb-2" />
                <Skeleton className="h-8 w-12" />
              </CardContent>
            </Card>
          ))
        ) : (
          <>
            <StatCard
              title="Total Videos"
              value={s?.totalVideos ?? 0}
              icon={Video}
              sub={`${s?.readyVideos ?? 0} ready`}
              color="bg-blue-500"
            />
            <StatCard
              title="Processing"
              value={s?.processingVideos ?? 0}
              icon={Clock}
              sub="In progress"
              color="bg-amber-500"
            />
            <StatCard
              title="Embed Tokens"
              value={s?.totalTokens ?? 0}
              icon={Code2}
              sub={`${s?.activeTokens ?? 0} active`}
              color="bg-purple-500"
            />
            <StatCard
              title="Security"
              value={s?.activeTokens ?? 0}
              icon={Shield}
              sub="Active sessions"
              color="bg-emerald-500"
            />
          </>
        )}
      </div>

      {/* Quick Actions + Recent Activity */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card className="border border-card-border">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Quick Actions</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {[
              { label: "Upload a new video", href: "/upload", icon: Plus, desc: "Add video to your library" },
              { label: "View video library", href: "/library", icon: Video, desc: "Manage all videos" },
              { label: "Manage embed tokens", href: "/embeds", icon: Code2, desc: "View and revoke tokens" },
              { label: "Configure system", href: "/settings", icon: Shield, desc: "AWS, S3, kill switch" },
            ].map((a) => (
              <Link key={a.href} href={a.href}>
                <div className="flex items-center gap-3 rounded-md p-3 cursor-pointer hover-elevate border border-border">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted">
                    <a.icon className="h-4 w-4 text-muted-foreground" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-foreground">{a.label}</p>
                    <p className="text-xs text-muted-foreground">{a.desc}</p>
                  </div>
                  <ArrowRight className="h-4 w-4 text-muted-foreground shrink-0" />
                </div>
              </Link>
            ))}
          </CardContent>
        </Card>

        <Card className="border border-card-border">
          <CardHeader className="pb-3 flex flex-row items-center justify-between gap-2">
            <CardTitle className="text-base">Recent Activity</CardTitle>
            <Button size="sm" variant="ghost" asChild>
              <Link href="/audit">View all</Link>
            </Button>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="space-y-3">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Skeleton key={i} className="h-10 w-full" />
                ))}
              </div>
            ) : s?.recentActivity?.length === 0 ? (
              <div className="flex flex-col items-center py-8 text-center">
                <Activity className="h-8 w-8 text-muted-foreground mb-2" />
                <p className="text-sm text-muted-foreground">No activity yet</p>
              </div>
            ) : (
              <div className="space-y-2">
                {s?.recentActivity?.map((log: any) => (
                  <div key={log.id} className="flex items-center gap-3 py-2 border-b border-border last:border-0">
                    <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-muted">
                      <Activity className="h-3.5 w-3.5 text-muted-foreground" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium text-foreground truncate">
                        {actionLabels[log.action] || log.action}
                      </p>
                      <p className="text-[11px] text-muted-foreground">
                        {formatDistanceToNow(new Date(log.createdAt), { addSuffix: true })}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Status Indicators */}
      <Card className="border border-card-border">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <TrendingUp className="h-4 w-4" />
            System Status
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-3">
            {[
              { label: "API", status: "online" },
              { label: "Database", status: "online" },
              { label: "Auth", status: "online" },
            ].map((s) => (
              <div key={s.label} className="flex items-center gap-2 rounded-md border border-border px-3 py-2">
                <div className="h-2 w-2 rounded-full bg-emerald-500" />
                <span className="text-xs font-medium text-foreground">{s.label}</span>
                <Badge variant="secondary" className="text-[10px] h-4">Online</Badge>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
