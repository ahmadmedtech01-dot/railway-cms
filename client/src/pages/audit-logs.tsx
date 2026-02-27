import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { ScrollText, Activity, Search } from "lucide-react";
import { useState } from "react";
import { formatDistanceToNow, format } from "date-fns";
import type { AuditLog } from "@shared/schema";

const actionConfig: Record<string, { label: string; color: string }> = {
  video_created: { label: "Video Created", color: "bg-blue-500/10 text-blue-600 dark:text-blue-400" },
  video_updated: { label: "Video Updated", color: "bg-slate-500/10 text-slate-600 dark:text-slate-400" },
  video_deleted: { label: "Video Deleted", color: "bg-red-500/10 text-red-600 dark:text-red-400" },
  video_availability_toggled: { label: "Availability Changed", color: "bg-amber-500/10 text-amber-600 dark:text-amber-400" },
  token_created: { label: "Token Created", color: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" },
  token_revoked: { label: "Token Revoked", color: "bg-red-500/10 text-red-600 dark:text-red-400" },
  player_settings_updated: { label: "Player Settings", color: "bg-purple-500/10 text-purple-600 dark:text-purple-400" },
  watermark_settings_updated: { label: "Watermark Settings", color: "bg-purple-500/10 text-purple-600 dark:text-purple-400" },
  security_settings_updated: { label: "Security Settings", color: "bg-orange-500/10 text-orange-600 dark:text-orange-400" },
  settings_updated: { label: "System Settings", color: "bg-slate-500/10 text-slate-600 dark:text-slate-400" },
};

export default function AuditLogsPage() {
  const [search, setSearch] = useState("");
  const { data: logs = [], isLoading } = useQuery<AuditLog[]>({
    queryKey: ["/api/audit"],
    queryFn: () => fetch("/api/audit").then(r => r.json()),
    refetchInterval: 30000,
  });

  const filtered = logs.filter(l =>
    l.action.toLowerCase().includes(search.toLowerCase()) ||
    JSON.stringify(l.meta || {}).toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="p-6 space-y-5 max-w-4xl">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Audit Logs</h1>
        <p className="text-sm text-muted-foreground mt-0.5">All admin actions recorded here</p>
      </div>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="Filter by action or metadata..." className="pl-9" />
      </div>

      <Card className="border border-card-border">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <ScrollText className="h-4 w-4" />
            Activity Log
            <Badge variant="secondary" className="ml-auto">{logs.length} entries</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-3">
              {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-14 w-full" />)}
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center py-12">
              <Activity className="h-10 w-10 text-muted-foreground mb-3" />
              <p className="text-sm text-muted-foreground">No logs found</p>
            </div>
          ) : (
            <div className="space-y-1">
              {filtered.map(log => {
                const cfg = actionConfig[log.action] || { label: log.action, color: "bg-muted text-muted-foreground" };
                return (
                  <div key={log.id} className="flex items-start gap-3 py-3 border-b border-border last:border-0" data-testid={`log-${log.id}`}>
                    <div className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-xs font-bold ${cfg.color}`}>
                      <Activity className="h-3.5 w-3.5" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium text-foreground">{cfg.label}</span>
                        {log.ip && <span className="text-xs text-muted-foreground">from {log.ip}</span>}
                      </div>
                      {log.meta && Object.keys(log.meta as object).length > 0 && (
                        <p className="text-xs text-muted-foreground mt-0.5 truncate">
                          {Object.entries(log.meta as object).map(([k, v]) => `${k}: ${v}`).join(" · ")}
                        </p>
                      )}
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-xs text-muted-foreground whitespace-nowrap">
                        {formatDistanceToNow(new Date(log.createdAt), { addSuffix: true })}
                      </p>
                      <p className="text-[10px] text-muted-foreground mt-0.5">
                        {format(new Date(log.createdAt), "MMM d, HH:mm")}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
