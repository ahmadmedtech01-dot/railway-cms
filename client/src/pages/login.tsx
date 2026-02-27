import { useState } from "react";
import { Link, useLocation } from "wouter";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { Zap, Lock, Mail, Eye, EyeOff } from "lucide-react";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPass, setShowPass] = useState(false);
  const [, setLocation] = useLocation();
  const qc = useQueryClient();
  const { toast } = useToast();

  const login = useMutation({
    mutationFn: () => apiRequest("POST", "/api/auth/login", { email, password }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/auth/me"] });
      setLocation("/");
    },
    onError: (e: any) => {
      toast({ title: "Login failed", description: e.message || "Invalid credentials", variant: "destructive" });
    },
  });

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="w-full max-w-md space-y-6">
        {/* Logo */}
        <div className="flex flex-col items-center gap-3 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-xl bg-primary shadow-lg">
            <Zap className="h-7 w-7 text-primary-foreground" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-foreground">Secure Video CMS</h1>
            <p className="text-sm text-muted-foreground mt-1">Admin Portal</p>
          </div>
        </div>

        <Card className="border border-card-border shadow-md">
          <CardHeader className="pb-4">
            <CardTitle className="text-lg">Sign in</CardTitle>
            <CardDescription>Enter your admin credentials to continue</CardDescription>
          </CardHeader>
          <CardContent>
            <form
              onSubmit={(e) => { e.preventDefault(); login.mutate(); }}
              className="space-y-4"
            >
              <div className="space-y-1.5">
                <Label htmlFor="email">Email</Label>
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    id="email"
                    type="email"
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    placeholder="admin@example.com"
                    className="pl-9"
                    data-testid="input-email"
                    required
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="password">Password</Label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    id="password"
                    type={showPass ? "text" : "password"}
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    placeholder="••••••••"
                    className="pl-9 pr-9"
                    data-testid="input-password"
                    required
                  />
                  <button
                    type="button"
                    onClick={() => setShowPass(!showPass)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground"
                    tabIndex={-1}
                  >
                    {showPass ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>

              <Button
                type="submit"
                className="w-full"
                disabled={login.isPending}
                data-testid="button-login"
              >
                {login.isPending ? "Signing in..." : "Sign in"}
              </Button>
            </form>
          </CardContent>
        </Card>

        <p className="text-center text-sm text-muted-foreground">
          Don't have an account?{" "}
          <Link href="/register" className="text-primary hover:underline font-medium" data-testid="link-register">
            Create account
          </Link>
        </p>
      </div>
    </div>
  );
}
