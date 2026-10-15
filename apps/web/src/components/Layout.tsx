import { Globe, LayoutGrid, LogOut, Rocket, Settings, ShieldCheck } from "lucide-react";
import type { ReactNode } from "react";
import { NavLink } from "react-router";
import { useAuthStatus, useLogout } from "@/lib/auth";
import { Logo } from "./Logo";
import { ThemeSwitch } from "./ThemeSwitch";

const NAV = [
  { to: "/", label: "Genel bakış", icon: LayoutGrid },
  { label: "Uygulamalar", icon: Rocket },
  { label: "Domainler", icon: Globe },
  { label: "Güvenlik", icon: ShieldCheck },
  { label: "Ayarlar", icon: Settings },
] as const;

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
            <ThemeSwitch />
            <button className="btn-ghost p-2" onClick={() => logout.mutate()} aria-label="Çıkış yap">
              <LogOut className="size-4" />
            </button>
          </div>
        </div>

        <nav className="flex gap-0.5 overflow-x-auto px-2 pb-2 md:flex-1 md:flex-col md:px-3 md:pb-0">
          {NAV.map((item) =>
            "to" in item ? (
              <NavLink
                key={item.label}
                to={item.to}
                end
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
            ) : (
              <span
                key={item.label}
                title="Bu bölüm henüz hazır değil"
                className="flex shrink-0 cursor-default items-center gap-2.5 px-3 py-2 text-[14px] text-faint"
              >
                <item.icon className="size-4" strokeWidth={1.8} />
                {item.label}
                <span className="ml-auto text-[12px]">yakında</span>
              </span>
            ),
          )}
        </nav>

        {user && (
          <div className="hidden space-y-3 border-t border-line px-5 py-4 md:block">
            <ThemeSwitch />
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <div className="truncate text-[14px] font-medium">{user.name}</div>
                <div className="truncate text-[13px] text-faint">{user.email}</div>
              </div>
              <button className="btn-ghost -mr-2 p-2" onClick={() => logout.mutate()} aria-label="Çıkış yap" title="Çıkış yap">
                <LogOut className="size-4" />
              </button>
            </div>
          </div>
        )}
      </aside>

      <main className="min-w-0 flex-1 px-4 py-6 md:px-10 md:py-9">{children}</main>
    </div>
  );
}
