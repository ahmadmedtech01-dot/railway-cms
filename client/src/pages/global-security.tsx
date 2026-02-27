import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, useEffect } from "react";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Shield } from "lucide-react";
import { SecuritySettingsForm, defaultClientSecuritySettings, type ClientSecuritySettings } from "@/components/security-settings-form";

export default function GlobalSecurityPage() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [local, setLocal] = useState<ClientSecuritySettings>({ ...defaultClientSecuritySettings });
  const [dirty, setDirty] = useState(false);

  const { data, isLoading } = useQuery<ClientSecuritySettings>({
    queryKey: ["/api/security/global"],
    queryFn: () => fetch("/api/security/global").then(r => r.json()),
  });

  useEffect(() => {
    if (data) {
      setLocal({ ...defaultClientSecuritySettings, ...data });
      setDirty(false);
    }
  }, [data]);

  const handleChange = (v: ClientSecuritySettings) => {
    setLocal(v);
    setDirty(true);
  };

  const save = useMutation({
    mutationFn: () => apiRequest("POST", "/api/security/global", local),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/security/global"] });
      setDirty(false);
      toast({ title: "Global security settings saved" });
    },
    onError: () => toast({ title: "Save failed", variant: "destructive" }),
  });

  return (
    <div className="p-6 max-w-2xl mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
          <Shield className="h-5 w-5 text-primary" />
        </div>
        <div>
          <h1 className="text-xl font-semibold text-foreground">Global Security</h1>
          <p className="text-sm text-muted-foreground">Default client protection applied to all videos unless overridden</p>
        </div>
      </div>

      <Card className="border border-card-border">
        <CardHeader>
          <CardTitle className="text-base">Client Protection Settings</CardTitle>
          <CardDescription>
            These settings are applied to every video that uses global defaults.
            Individual videos can override these by disabling "Use Global Settings."
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-3">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="h-12 rounded-md bg-muted animate-pulse" />
              ))}
            </div>
          ) : (
            <SecuritySettingsForm
              value={local}
              onChange={handleChange}
              showSaveButton={dirty}
              onSave={() => save.mutate()}
              isPending={save.isPending}
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
