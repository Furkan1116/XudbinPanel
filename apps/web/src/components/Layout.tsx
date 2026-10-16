import { ChartLine, FolderKanban, LayoutGrid, LogOut, Server, Settings, ShieldCheck } from "lucide-react";
import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, NavLink } from "react-router";
import { api } from "@/lib/api";
import { useAuthStatus, useLogout } from "@/lib/auth";
import { Logo } from "./Logo";
import { LangSwitch } from "./LangSwitch";
import { ThemeSwitch } from "./ThemeSwitch";
import { t } from "@/lib/i18n";

const NAV = [
  { to: "/", label: t("Genel bakış"), icon: LayoutGrid, end: true },
  { to: "/projects", label: t("Projeler"), icon: FolderKanban },
  { to: "/analytics", label: t("Analitik"), icon: ChartLine },
  { to: "/servers", label: t("Sunucular"), icon: Server, admin: true },
  { to: "/security", label: t("Güvenlik"), icon: ShieldCheck, admin: true },
  { to: "/settings", label: t("Ayarlar"), icon: Settings },
];

export function Layout({ children }: { children: ReactNode }) {
  const { data } = useAuthStatus();
  const logout = useLogout();
  const user = data?.user;

  return (
    <div className="flex min-h-dvh flex-col md:flex-row">
      <aside className="flex shrink-0 flex-col border-b border-line md:sticky md:top-0 md:h-dvh md:w-56 md:border-r md:border-b-0">
        <div className="flex items-center justify-between px-4 pt-4 pb-3 md:px-5 md:pt-6 md:pb-6">
          <Logo />
          <div className="flex items-center gap-1 md:hidden">
            <LangSwitch />
            <ThemeSwitch />
            <button className="btn-ghost p-2" onClick={() => logout.mutate()} aria-label={t("Çıkış yap")}>
              <LogOut className="size-4" />
            </button>
          </div>
        </div>

        <nav className="flex gap-0.5 overflow-x-auto px-2 pb-2 md:flex-1 md:flex-col md:px-3 md:pb-0">
          {NAV.filter((item) => !item.admin || user?.role === "admin").map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                `relative flex shrink-0 items-center gap-2.5 rounded-md px-3 py-2 text-[14px] transition-colors ${
                  isActive
                    ? "bg-surface-2 font-medium text-fg md:before:absolute md:before:inset-y-2 md:before:-left-3 md:before:w-[3px] md:before:rounded-full md:before:bg-accent"
                    : "text-muted hover:bg-surface-2 hover:text-fg"
                }`
              }
            >
              <item.icon className="size-4" strokeWidth={1.8} />
              {item.label}
            </NavLink>
          ))}
        </nav>

        {user?.role === "admin" && <UpdateBadge />}
        {user && (
          <div className="hidden space-y-3 border-t border-line px-5 py-4 md:block">
            <div className="flex items-center gap-2">
              <ThemeSwitch />
              <LangSwitch />
            </div>
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <div className="truncate text-[14px] font-medium">{user.name}</div>
                <div className="truncate text-[13px] text-faint">{user.email}</div>
              </div>
              <button className="btn-ghost -mr-2 p-2" onClick={() => logout.mutate()} aria-label={t("Çıkış yap")} title={t("Çıkış yap")}>
                <LogOut className="size-4" />
              </button>
            </div>
          </div>
        )}
      </aside>

      <main className="min-w-0 flex-1 px-4 py-6 md:px-10 md:py-9">
        <div className="mx-auto max-w-5xl">{children}</div>
      </main>
    </div>
  );
}

/** Yeni Xudbin sürümü varsa yöneticiye kenar çubuğunda küçük bir bağlantı. */
function UpdateBadge() {
  const { data } = useQuery({ queryKey: ["update"], queryFn: () => api.get<{ updateAvailable: boolean; latest: string | null }>("/settings/update"), staleTime: 3_600_000 });
  if (!data?.updateAvailable) return null;
  return (
    <Link to="/settings?tab=panel" className="mx-3 mb-3 hidden items-center gap-2 rounded-md border border-accent/30 bg-accent/10 px-3 py-2 text-[13px] text-fg hover:bg-accent/15 md:flex">
      <span className="size-1.5 rounded-full bg-accent" />
      {t("Xudbin {v} yayında", { v: data.latest ?? "" })}
    </Link>
  );
}
