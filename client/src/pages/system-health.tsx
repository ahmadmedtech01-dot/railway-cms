import { useQuery } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  CheckCircle2, XCircle, AlertTriangle, RefreshCw, Database,
  Cloud, Shield, Key, Zap, Video, Globe, Clock, Activity,
  Server, Lock,
} from "lucide-react";

interface HealthCheck {
  key: string;
  name: string;
  status: "ok" | "warn" | "error";
  message: string;
  detail?: any;
  latencyMs?: number;
}

interface HealthReport {
  checkedAt: string;
  overall: "healthy" | "degraded" | "error";
  checks: HealthCheck[];
  recentErrors: Array<{ id: string; action: string; meta?: any; ip?: string; createdAt: string }>;
}

const CHECK_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  database: Database,
  storage: Cloud,
  worker: Globe,
  vimeo: Video,
  kill_switch: Zap,
  signing_secret: Key,
  lms_secret: Lock,
  integration_secret: Shield,
  bunny_secrets: Cloud,
};

function StatusIcon({ status, className }: { status: "ok" | "warn" | "error"; className?: string }) {
  if (status === "ok") return <CheckCircle2 className={`text-emerald-500 ${className}`} />;
  if (status === "warn") return <AlertTriangle className={`text-amber-500 ${className}`} />;
  return <XCircle className={`text-red-500 ${className}`} />;
}

function StatusBadge({ status }: { status: "ok" | "warn" | "error" }) {
  if (status === "ok") return <Badge className="bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30 hover:bg-emerald-500/20">Healthy</Badge>;
  if (status === "warn") return <Badge className="bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30 hover:bg-amber-500/20">Warning</Badge>;
  return <Badge className="bg-red-500/15 text-red-600 dark:text-red-400 border-red-500/30 hover:bg-red-500/20">Error</Badge>;
}

function OverallBanner({ overall }: { overall: "healthy" | "degraded" | "error" }) {
  if (overall === "healthy") return (
    <div className="flex items-center gap-3 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-3">
      <CheckCircle2 className="h-5 w-5 text-emerald-500 shrink-0" />
      <div>
        <p className="font-semibold text-emerald-700 dark:text-emerald-400">All systems operational</p>
        <p className="text-sm text-emerald-600 dark:text-emerald-500">Every check passed with no issues detected.</p>
      </div>
    </div>
  );
  if (overall === "degraded") return (
    <div className="flex items-center gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3">
      <AlertTriangle className="h-5 w-5 text-amber-500 shrink-0" />
      <div>
        <p className="font-semibold text-amber-700 dark:text-amber-400">System degraded</p>
        <p className="text-sm text-amber-600 dark:text-amber-500">Some checks returned warnings. Review the items below.</p>
      </div>
    </div>
  );
  return (
    <div className="flex items-center gap-3 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3">
      <XCircle className="h-5 w-5 text-red-500 shrink-0" />
      <div>
        <p className="font-semibold text-red-700 dark:text-red-400">System error detected</p>
        <p className="text-sm text-red-600 dark:text-red-500">One or more critical checks failed. Immediate attention required.</p>
      </div>
    </div>
  );
}

function CheckCard({ check }: { check: HealthCheck }) {
  const Icon = CHECK_ICONS[check.key] || Server;
  const borderColor = check.status === "ok"
    ? "border-l-emerald-500"
    : check.status === "warn"
    ? "border-l-amber-500"
    : "border-l-red-500";

  return (
    <Card className={`border-l-4 ${borderColor}`} data-testid={`card-health-${check.key}`}>
      <CardContent className="pt-4 pb-4">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 shrink-0">
            <Icon className="h-4 w-4 text-muted-foreground" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-medium">{check.name}</span>
              <StatusBadge status={check.status} />
              {check.latencyMs !== undefined && (
                <span className="text-xs text-muted-foreground ml-auto">{check.latencyMs}ms</span>
              )}
            </div>
            <p className="text-sm text-muted-foreground mt-1 leading-snug">{check.message}</p>
          </div>
          <StatusIcon status={check.status} className="h-4 w-4 shrink-0 mt-0.5" />
        </div>
      </CardContent>
    </Card>
  );
}

export default function SystemHealthPage() {
  const [isRefreshing, setIsRefreshing] = useState(false);

  const { data, isLoading, dataUpdatedAt } = useQuery<HealthReport>({
    queryKey: ["/api/admin/health"],
    staleTime: 0,
    refetchInterval: 60_000,
  });

  async function runCheck() {
    setIsRefreshing(true);
    await queryClient.invalidateQueries({ queryKey: ["/api/admin/health"] });
    await queryClient.refetchQueries({ queryKey: ["/api/admin/health"] });
    setIsRefreshing(false);
  }

  const okCount = data?.checks.filter(c => c.status === "ok").length ?? 0;
  const warnCount = data?.checks.filter(c => c.status === "warn").length ?? 0;
  const errorCount = data?.checks.filter(c => c.status === "error").length ?? 0;

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Activity className="h-6 w-6 text-primary" />
            System Health
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Live status of all connected systems and environment configuration
          </p>
        </div>
        <div className="flex items-center gap-3">
          {dataUpdatedAt > 0 && (
            <span className="text-xs text-muted-foreground flex items-center gap-1">
              <Clock className="h-3 w-3" />
              Last checked {new Date(dataUpdatedAt).toLocaleTimeString()}
            </span>
          )}
          <Button
            onClick={runCheck}
            disabled={isLoading || isRefreshing}
            variant="outline"
            size="sm"
            data-testid="button-run-health-check"
          >
            <RefreshCw className={`h-4 w-4 mr-2 ${(isLoading || isRefreshing) ? "animate-spin" : ""}`} />
            {isLoading || isRefreshing ? "Checking…" : "Run Check"}
          </Button>
        </div>
      </div>

      {/* Loading skeleton */}
      {isLoading && !data && (
        <div className="space-y-3">
          {Array.from({ length: 7 }).map((_, i) => (
            <div key={i} className="h-16 rounded-lg bg-muted animate-pulse" />
          ))}
        </div>
      )}

      {data && (
        <>
          {/* Overall banner */}
          <OverallBanner overall={data.overall} />

          {/* Summary counts */}
          <div className="grid grid-cols-3 gap-3">
            <Card>
              <CardContent className="pt-4 pb-4 flex items-center gap-3">
                <CheckCircle2 className="h-8 w-8 text-emerald-500" />
                <div>
                  <p className="text-2xl font-bold">{okCount}</p>
                  <p className="text-xs text-muted-foreground">Healthy</p>
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-4 pb-4 flex items-center gap-3">
                <AlertTriangle className="h-8 w-8 text-amber-500" />
                <div>
                  <p className="text-2xl font-bold">{warnCount}</p>
                  <p className="text-xs text-muted-foreground">Warnings</p>
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-4 pb-4 flex items-center gap-3">
                <XCircle className="h-8 w-8 text-red-500" />
                <div>
                  <p className="text-2xl font-bold">{errorCount}</p>
                  <p className="text-xs text-muted-foreground">Errors</p>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Check cards */}
          <div>
            <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
              System Checks
            </h2>
            <div className="grid gap-2.5 sm:grid-cols-2">
              {data.checks.map(check => (
                <CheckCard key={check.key} check={check} />
              ))}
            </div>
          </div>

          {/* Recent errors */}
          {data.recentErrors.length > 0 && (
            <div>
              <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
                Recent System Errors
              </h2>
              <Card>
                <CardContent className="p-0">
                  <div className="divide-y divide-border">
                    {data.recentErrors.map((err, i) => (
                      <div key={err.id ?? i} className="flex items-start gap-3 px-4 py-3" data-testid={`row-error-${i}`}>
                        <XCircle className="h-4 w-4 text-red-400 mt-0.5 shrink-0" />
                        <div className="flex-1 min-w-0">
                          <span className="text-sm font-mono text-foreground">{err.action}</span>
                          {err.meta && Object.keys(err.meta).length > 0 && (
                            <p className="text-xs text-muted-foreground mt-0.5 truncate">
                              {JSON.stringify(err.meta)}
                            </p>
                          )}
                        </div>
                        <span className="text-xs text-muted-foreground shrink-0">
                          {new Date(err.createdAt).toLocaleString()}
                        </span>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            </div>
          )}

          {data.recentErrors.length === 0 && (
            <div>
              <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
                Recent System Errors
              </h2>
              <Card>
                <CardContent className="py-8 flex flex-col items-center gap-2 text-muted-foreground">
                  <CheckCircle2 className="h-8 w-8 text-emerald-400" />
                  <p className="text-sm">No recent errors in audit log</p>
                </CardContent>
              </Card>
            </div>
          )}

          {/* Check timestamp */}
          <p className="text-xs text-muted-foreground text-center pt-2">
            Checks run at {new Date(data.checkedAt).toLocaleString()} · Auto-refreshes every 60 seconds
          </p>
        </>
      )}
    </div>
  );
}
