"use client";

import { usePathname } from "next/navigation";
import { FileClock, KeyRound, LayoutDashboard, LogOut, RefreshCw, Server, Settings } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { apiSend } from "@/lib/client";
import { cn } from "cn";

const NAV = [
  { href: "/", label: "仪表盘", icon: LayoutDashboard },
  { href: "/upstreams", label: "上游", icon: Server },
  { href: "/keys", label: "下游 Key", icon: KeyRound },
  { href: "/logs", label: "请求日志", icon: FileClock },
  { href: "/settings", label: "设置", icon: Settings },
];

export function AdminShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [busy, setBusy] = useState(false);

  const reloadConfig = async () => {
    setBusy(true);
    try {
      const res = await apiSend<{ upstreams: number; keys: number }>("/api/admin/actions", "POST", { action: "reload" });
      toast.success(`已重载配置：${res.upstreams} 个上游 / ${res.keys} 个 key`);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const logout = async () => {
    await apiSend("/api/admin/logout", "POST").catch(() => undefined);
    // 退出要清掉整个前端状态，客户端路由做不到，所以整页跳转。
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.href = "/login";
  };

  return (
    <div className="flex min-h-screen">
      <aside className="flex w-56 shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground">
        <div className="flex h-14 items-center gap-2 border-b px-4">
          <span className="text-sm font-semibold tracking-tight">AI Proxy</span>
        </div>
        <nav className="flex flex-1 flex-col gap-1 p-2">
          {NAV.map((item) => {
            const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
            const Icon = item.icon;
            return (
              <a
                key={item.href}
                href={item.href}
                className={cn(
                  "flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm transition-colors",
                  active ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground" : "hover:bg-sidebar-accent/60",
                )}
              >
                <Icon className="size-4" />
                {item.label}
              </a>
            );
          })}
        </nav>
        <div className="flex flex-col gap-1 border-t p-2">
          <Button variant="ghost" size="sm" className="justify-start" onClick={reloadConfig} disabled={busy}>
            <RefreshCw className={cn("size-4", busy && "animate-spin")} />
            重载配置
          </Button>
          <Button variant="ghost" size="sm" className="justify-start" onClick={logout}>
            <LogOut className="size-4" />
            退出登录
          </Button>
        </div>
      </aside>
      <main className="flex-1 overflow-x-hidden bg-background">
        <div className="mx-auto w-full max-w-6xl px-6 py-6">{children}</div>
      </main>
    </div>
  );
}