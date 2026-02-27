import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Key, Copy, Shield, ExternalLink, CheckCircle, Search, Trash2 } from "lucide-react";
import { useState } from "react";
import { formatDistanceToNow } from "date-fns";
import type { EmbedToken } from "@shared/schema";

export default function EmbedManagerPage() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const { data: tokens = [], isLoading } = useQuery<EmbedToken[]>({
    queryKey: ["/api/tokens"],
    queryFn: () => fetch("/api/tokens").then(r => r.json()),
  });

  const revoke = useMutation({
    mutationFn: (id: string) => apiRequest("POST", `/api/tokens/${id}/revoke`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["/api/tokens"] }); toast({ title: "Token revoked" }); },
  });

  const remove = useMutation({
    mutationFn: (id: string) => apiRequest("DELETE", `/api/tokens/${id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["/api/tokens"] }); toast({ title: "Token deleted" }); },
  });

  const copyToken = (id: string, token: string) => {
    navigator.clipboard.writeText(token);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const activeTokens = tokens.filter(t => !t.revoked && (!t.expiresAt || new Date(t.expiresAt) > new Date()));
  const filtered = tokens.filter(t =>
    (t.label || "").toLowerCase().includes(search.toLowerCase()) ||
    (t.allowedDomain || "").toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="p-6 space-y-5 max-w-5xl">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Embed Manager</h1>
          <p className="text-sm text-muted-foreground mt-0.5">{activeTokens.length} active tokens across all videos</p>
        </div>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-3 gap-4">
        {[
          { label: "Total Tokens", value: tokens.length, color: "bg-blue-500/10 text-blue-600 dark:text-blue-400" },
          { label: "Active", value: activeTokens.length, color: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" },
          { label: "Revoked", value: tokens.filter(t => t.revoked).length, color: "bg-red-500/10 text-red-600 dark:text-red-400" },
        ].map(s => (
          <Card key={s.label} className="border border-card-border">
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground">{s.label}</p>
              <p className={`text-2xl font-bold mt-1 ${s.color.split(" ")[1]} ${s.color.split(" ")[2]}`}>{s.value}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search by label or domain..." className="pl-9" />
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-20 w-full rounded-lg" />)}
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center py-16">
          <Key className="h-12 w-12 text-muted-foreground mb-3" />
          <h3 className="text-base font-medium text-foreground">No tokens found</h3>
          <p className="text-sm text-muted-foreground mt-1">Create tokens from the Video Detail → Embed & Share tab</p>
          <Button asChild variant="outline" className="mt-4"><Link href="/library">Go to Library</Link></Button>
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map(token => {
            const expired = token.expiresAt && new Date(token.expiresAt) < new Date();
            const isActive = !token.revoked && !expired;
            return (
              <Card key={token.id} className={`border ${token.revoked ? "border-border opacity-70" : "border-card-border"}`} data-testid={`token-card-${token.id}`}>
                <CardContent className="p-4">
                  <div className="flex items-start gap-3 flex-wrap">
                    <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-md ${isActive ? "bg-emerald-500/10" : "bg-muted"}`}>
                      {isActive ? <Shield className="h-4 w-4 text-emerald-600 dark:text-emerald-400" /> : <Key className="h-4 w-4 text-muted-foreground" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-semibold text-foreground">{token.label || "Unnamed Token"}</span>
                        {token.revoked && <Badge variant="destructive" className="text-xs">Revoked</Badge>}
                        {expired && !token.revoked && <Badge variant="outline" className="text-xs">Expired</Badge>}
                        {isActive && <Badge variant="secondary" className="text-xs">Active</Badge>}
                      </div>
                      <div className="flex flex-wrap gap-3 mt-1">
                        {token.allowedDomain && (
                          <span className="text-xs text-muted-foreground">Domain: <span className="text-foreground">{token.allowedDomain}</span></span>
                        )}
                        <span className="text-xs text-muted-foreground">
                          {token.expiresAt ? `Expires ${formatDistanceToNow(new Date(token.expiresAt), { addSuffix: true })}` : "No expiry"}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          Created {formatDistanceToNow(new Date(token.createdAt), { addSuffix: true })}
                        </span>
                      </div>
                      <p className="text-xs font-mono text-muted-foreground mt-1 truncate max-w-sm">{token.token.slice(0, 40)}...</p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => copyToken(token.id, token.token)}
                        data-testid={`button-copy-token-${token.id}`}
                      >
                        {copiedId === token.id
                          ? <><CheckCircle className="h-3.5 w-3.5 mr-1 text-emerald-500" />Copied!</>
                          : <><Copy className="h-3.5 w-3.5 mr-1" />Copy</>
                        }
                      </Button>
                      {!token.revoked && (
                        <Button size="sm" variant="outline" onClick={() => revoke.mutate(token.id)} data-testid={`button-revoke-${token.id}`}>
                          Revoke
                        </Button>
                      )}
                      <Button size="icon" variant="ghost" onClick={() => remove.mutate(token.id)} data-testid={`button-delete-token-${token.id}`}>
                        <Trash2 className="h-4 w-4 text-muted-foreground" />
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
