import { Switch, Route, Redirect, useLocation } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/app-sidebar";
import { ThemeProvider, useTheme } from "@/components/theme-provider";
import { Button } from "@/components/ui/button";
import { Moon, Sun } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import LoginPage from "@/pages/login";
import RegisterPage from "@/pages/register";
import DashboardPage from "@/pages/dashboard";
import LibraryPage from "@/pages/library";
import UploadPage from "@/pages/upload";
import VideoDetailPage from "@/pages/video-detail";
import EmbedManagerPage from "@/pages/embed-manager";
import SystemSettingsPage from "@/pages/system-settings";
import AuditLogsPage from "@/pages/audit-logs";
import GlobalSecurityPage from "@/pages/global-security";
import IntegrationsPage from "@/pages/integrations";
import EmbedPlayerPage from "@/pages/embed-player";
import SharePlayerPage from "@/pages/share-player";
import NotFound from "@/pages/not-found";

function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  return (
    <Button
      size="icon"
      variant="ghost"
      onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
      data-testid="button-theme-toggle"
    >
      {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </Button>
  );
}

function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <SidebarProvider style={{ "--sidebar-width": "15rem", "--sidebar-width-icon": "3.5rem" } as React.CSSProperties}>
      <div className="flex h-screen w-full bg-background overflow-hidden">
        <AppSidebar />
        <div className="flex flex-col flex-1 min-w-0">
          <header className="flex items-center justify-between px-4 py-2 border-b border-border bg-card shrink-0">
            <SidebarTrigger data-testid="button-sidebar-toggle" />
            <ThemeToggle />
          </header>
          <main className="flex-1 overflow-y-auto">
            {children}
          </main>
        </div>
      </div>
    </SidebarProvider>
  );
}

function ProtectedRoute({ component: Component }: { component: React.ComponentType }) {
  const { user, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          <p className="text-sm text-muted-foreground">Loading...</p>
        </div>
      </div>
    );
  }

  if (!user) {
    return <Redirect to="/login" />;
  }

  return (
    <AdminLayout>
      <Component />
    </AdminLayout>
  );
}

function Router() {
  return (
    <Switch>
      <Route path="/login" component={LoginPage} />
      <Route path="/register" component={RegisterPage} />
      <Route path="/embed/:publicId" component={EmbedPlayerPage} />
      <Route path="/v/:publicId" component={SharePlayerPage} />
      <Route path="/" component={() => <ProtectedRoute component={DashboardPage} />} />
      <Route path="/library" component={() => <ProtectedRoute component={LibraryPage} />} />
      <Route path="/upload" component={() => <ProtectedRoute component={UploadPage} />} />
      <Route path="/videos/:id" component={() => <ProtectedRoute component={VideoDetailPage} />} />
      <Route path="/embeds" component={() => <ProtectedRoute component={EmbedManagerPage} />} />
      <Route path="/settings" component={() => <ProtectedRoute component={SystemSettingsPage} />} />
      <Route path="/security" component={() => <ProtectedRoute component={GlobalSecurityPage} />} />
      <Route path="/audit" component={() => <ProtectedRoute component={AuditLogsPage} />} />
      <Route path="/integrations" component={() => <ProtectedRoute component={IntegrationsPage} />} />
      <Route component={NotFound} />
    </Switch>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <ThemeProvider>
          <Router />
          <Toaster />
        </ThemeProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}
