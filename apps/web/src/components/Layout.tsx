import { Globe, LayoutDashboard, LogOut, Rocket, Settings, ShieldCheck } from "lucide-react";
import type { ReactNode } from "react";
import { NavLink } from "react-router";
import { useAuthStatus, useLogout } from "@/lib/auth";
import { Logo } from "./Logo";

const NAV = [
  { to: "/", label: "Genel Bakış", icon: LayoutDashboard },
  { label: "Uygulamalar", icon: Rocket, soon: true },
  { label: "Domainler", icon: Globe, soon: true },
  { label: "Güvenlik", icon: ShieldCheck, soon: true },
  { label: "Ayarlar", icon: Settings, soon: true },
] as const;

export function Layout({ children }: { children: ReactNode }) {
  const { data } = useAuthStatus();
  const logout = useLogout();
  const user = data?.user;

  return (
    <div className="flex min-h-dvh flex-col md:flex-row">
      <aside className="flex shrink-0 flex-col border-line bg-surface/60 md:sticky md:top-0 md:h-dvh md:w-60 md:border-r">
        <div className="flex items-center justify-between px-4 py-4 md:px-5 md:py-5">
          <Logo />
          <button className="btn-ghost px-2 py-2 md:hidden" onClick={() => logout.mutate()} aria-label="Çıkış yap">
            <LogOut className="size-4" />
          </button>
        </div>

        <nav className="flex gap-1 overflow-x-auto px-3 pb-3 md:flex-1 md:flex-col md:pb-0">
          {NAV.map((item) =>
            "to" in item ? (
              <NavLink
                key={item.label}
                to={item.to}
                end
                className={({ isActive }) =>
                  `flex shrink-0 items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition ${
                    isActive ? "bg-surface-2 text-fg" : "text-muted hover:bg-surface-2 hover:text-fg"
                  }`
                }
              >
                <item.icon className="size-4" />
                {item.label}
              </NavLink>
            ) : (
              <span key={item.label} className="flex shrink-0 cursor-default items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-faint">
                <item.icon className="size-4" />
                {item.label}
                <span className="ml-auto rounded-md border border-line px-1.5 py-0.5 text-[10px] uppercase tracking-wide">Yakında</span>
              </span>
            ),
          )}
        </nav>

        {user && (
          <div className="hidden border-t border-line p-3 md:block">
            <div className="flex items-center gap-3 rounded-lg px-2 py-2">
              <div className="grid size-8 place-items-center rounded-full bg-accent-dim text-xs font-semibold text-accent">
                {user.name.slice(0, 1).toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{user.name}</div>
                <div className="truncate text-xs text-faint">{user.email}</div>
              </div>
              <button className="btn-ghost p-2" onClick={() => logout.mutate()} aria-label="Çıkış yap" title="Çıkış yap">
                <LogOut className="size-4" />
              </button>
            </div>
          </div>
        )}
      </aside>

      <main className="min-w-0 flex-1 px-4 py-6 md:px-10 md:py-10">{children}</main>
    </div>
  );
}
