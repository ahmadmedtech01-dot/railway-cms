import { Link, useLocation } from "wouter";
import {
  Sidebar, SidebarContent, SidebarGroup, SidebarGroupContent,
  SidebarGroupLabel, SidebarMenu, SidebarMenuButton, SidebarMenuItem,
  SidebarHeader, SidebarFooter, useSidebar,
} from "@/components/ui/sidebar";
import {
  LayoutDashboard, Library, Upload, Shield, Code2, Settings,
  ScrollText, LogOut, Video, ChevronRight, Zap,
} from "lucide-react";
import { useAuth, useLogout } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

const navItems = [
  { title: "Dashboard", url: "/", icon: LayoutDashboard },
  { title: "Video Library", url: "/library", icon: Library },
  { title: "Upload", url: "/upload", icon: Upload },
  { title: "Embed Manager", url: "/embeds", icon: Code2 },
  { title: "Global Security", url: "/security", icon: Shield },
  { title: "Audit Logs", url: "/audit", icon: ScrollText },
  { title: "System Settings", url: "/settings", icon: Settings },
];

export function AppSidebar() {
  const [location] = useLocation();
  const { user } = useAuth();
  const logout = useLogout();
  const { open } = useSidebar();

  return (
    <Sidebar>
      <SidebarHeader className="border-b border-sidebar-border px-4 py-4">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-md bg-primary">
            <Zap className="h-5 w-5 text-primary-foreground" />
          </div>
          {open && (
            <div>
              <p className="text-sm font-semibold text-sidebar-foreground leading-tight">Secure Video</p>
              <p className="text-xs text-muted-foreground">CMS Admin</p>
            </div>
          )}
        </div>
      </SidebarHeader>

      <SidebarContent className="py-2">
        <SidebarGroup>
          <SidebarGroupLabel>Navigation</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {navItems.map((item) => {
                const isActive = location === item.url || (item.url !== "/" && location.startsWith(item.url));
                return (
                  <SidebarMenuItem key={item.title}>
                    <SidebarMenuButton
                      asChild
                      data-active={isActive}
                      className="data-[active=true]:bg-sidebar-accent data-[active=true]:text-sidebar-accent-foreground"
                    >
                      <Link href={item.url}>
                        <item.icon className="h-4 w-4 shrink-0" />
                        <span>{item.title}</span>
                        {isActive && open && <ChevronRight className="ml-auto h-3 w-3 opacity-50" />}
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="border-t border-sidebar-border p-3">
        {open ? (
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted">
              <Shield className="h-4 w-4 text-muted-foreground" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium text-sidebar-foreground truncate">{user?.email}</p>
              <Badge variant="secondary" className="text-[10px] h-4 mt-0.5">Admin</Badge>
            </div>
            <Button
              size="icon"
              variant="ghost"
              onClick={() => logout.mutate()}
              data-testid="button-logout"
              title="Logout"
            >
              <LogOut className="h-4 w-4" />
            </Button>
          </div>
        ) : (
          <Button
            size="icon"
            variant="ghost"
            onClick={() => logout.mutate()}
            data-testid="button-logout-collapsed"
            title="Logout"
          >
            <LogOut className="h-4 w-4" />
          </Button>
        )}
      </SidebarFooter>
    </Sidebar>
  );
}
