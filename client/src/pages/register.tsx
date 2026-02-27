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

export default function RegisterPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPass, setShowPass] = useState(false);
  const [, setLocation] = useLocation();
  const qc = useQueryClient();
  const { toast } = useToast();

  const register = useMutation({
    mutationFn: () => apiRequest("POST", "/api/auth/register", { email, password }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/auth/me"] });
      setLocation("/");
    },
    onError: (e: any) => {
      toast({ title: "Registration failed", description: e.message || "Could not create account", variant: "destructive" });
    },
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirm) {
      toast({ title: "Passwords do not match", variant: "destructive" });
      return;
    }
    register.mutate();
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="w-full max-w-md space-y-6">
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
            <CardTitle className="text-lg">Create account</CardTitle>
            <CardDescription>Register a new admin account</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
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
                    data-testid="input-register-email"
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
                    placeholder="Min. 8 characters"
                    className="pl-9 pr-9"
                    data-testid="input-register-password"
                    required
                    minLength={8}
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

              <div className="space-y-1.5">
                <Label htmlFor="confirm">Confirm password</Label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    id="confirm"
                    type={showPass ? "text" : "password"}
                    value={confirm}
                    onChange={e => setConfirm(e.target.value)}
                    placeholder="Re-enter password"
                    className="pl-9"
                    data-testid="input-register-confirm"
                    required
                  />
                </div>
              </div>

              <Button
                type="submit"
                className="w-full"
                disabled={register.isPending}
                data-testid="button-register"
              >
                {register.isPending ? "Creating account..." : "Create account"}
              </Button>
            </form>
          </CardContent>
        </Card>

        <p className="text-center text-sm text-muted-foreground">
          Already have an account?{" "}
          <Link href="/login" className="text-primary hover:underline font-medium" data-testid="link-signin">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
