import { useQuery } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import { Link } from "react-router";
import { ResourceChart } from "@/components/ResourceChart";
import { ServerMeters } from "@/components/ServerMeters";
import { Empty, Notice, PageHeader, PageLoading, Section, StatusBadge } from "@/components/ui";
import { useAuthStatus } from "@/lib/auth";
import { api, type Deployment, type ServerOverview } from "@/lib/api";
import { duration, formatUptime, timeAgo } from "@/lib/format";
import { t } from "@/lib/i18n";

type RecentDeployment = Deployment & { appId: number; appName: string };
type SecuritySummary = { byKind: { kind: string; n: number }[]; blockedCount: number };

export function DashboardPage() {
  // Sunucu ayrıntıları yalnız yöneticiye açık; üye yalnız deploy ve uptime özetini görür.
  const admin = useAuthStatus().data?.user?.role === "admin";
  const servers = useQuery({ queryKey: ["servers", "overview"], queryFn: () => api.get<{ servers: ServerOverview[] }>("/servers/overview"), refetchInterval: 5000, enabled: admin });
  const deployments = useQuery({ queryKey: ["deployments", "recent"], queryFn: () => api.get<{ deployments: RecentDeployment[] }>("/deployments"), refetchInterval: 5000 });
  const security = useQuery({ queryKey: ["security", "summary", 24], queryFn: () => api.get<SecuritySummary>("/security/summary?hours=24"), refetchInterval: 30_000 });
  const down = useQuery({ queryKey: ["analytics", "down"], queryFn: () => api.get<{ down: { appId: number; name: string; since: number; reason: string }[] }>("/analytics/down"), refetchInterval: 30_000 });

  if (admin && !servers.data) return <PageLoading />;
  const serverList = servers.data?.servers ?? [];
  const local = serverList.find((s) => s.kind === "local");
  const attacks = security.data?.byKind.reduce((sum, k) => sum + k.n, 0) ?? 0;

  return (
    <>
      <PageHeader title={t("Genel bakış")} description={admin ? t("{n} sunucu yönetiliyor", { n: serverList.length }) : undefined} />

      {down.data && down.data.down.length > 0 && (
        <div className="mb-6">
          <Notice tone="danger" title={t("{n} site şu an erişilemiyor", { n: down.data.down.length })}>
            <ul className="mt-1 space-y-0.5">
              {down.data.down.map((d) => (
                <li key={d.appId}>
                  <Link to={`/apps/${d.appId}`} className="font-medium hover:underline">{d.name}</Link>{" "}
                  <span className="text-muted">· {d.reason} · {timeAgo(d.since)}</span>
                </li>
              ))}
            </ul>
          </Notice>
        </div>
      )}

      {local?.stats?.history && (
        <section className="panel px-5 pt-4 pb-5" aria-label={t("Panel sunucusunun kaynak kullanımı")}>
          <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-[15px] font-medium">{local.name}</h2>
            <span className="text-[13px] text-faint">{t("{d} önce açıldı", { d: formatUptime(local.stats.uptime) })}</span>
          </div>
          <ResourceChart history={local.stats.history} />
        </section>
      )}

      {admin && <Section title={t("Sunucular")} actions={<Link to="/servers" className="text-[14px] text-muted hover:text-fg">{t("Tümü")}</Link>} className="!mt-9">
        <div className="grid gap-3 md:grid-cols-2">
          {serverList.map((s) => (
            <Link key={s.id} to={`/servers/${s.id}`} className="panel block px-5 py-4 transition-colors hover:border-line-strong">
              <div className="mb-4 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate font-medium">{s.name}</div>
                  <div className="truncate text-[13px] text-faint">{s.kind === "local" ? t("Panelin çalıştığı sunucu") : `${s.username}@${s.host}`}</div>
                </div>
                <StatusBadge status={s.status} />
              </div>
              {s.stats ? (
                <ServerMeters stats={s.stats} />
              ) : (
                <p className="text-[13px] text-muted">{s.status !== "ready" && s.kind === "ssh" ? t("Kurulum tamamlanınca kaynak kullanımı görünecek.") : (s.statsError ?? t("Bilgi alınamadı"))}</p>
              )}
            </Link>
          ))}
        </div>
      </Section>}

      <div className="mt-9 grid gap-9 lg:grid-cols-[1fr_18rem]">
        <Section title={t("Son deploylar")} className="!mt-0">
          {deployments.data?.deployments.length ? (
            <div className="panel divide-y divide-line">
              {deployments.data.deployments.map((d) => (
                <Link key={d.id} to={`/apps/${d.appId}?tab=deployments&d=${d.id}`} className="flex items-center gap-3 px-5 py-3 hover:bg-surface-2/50">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[14px] font-medium">{d.appName}</div>
                    <div className="truncate text-[13px] text-faint">{d.title || (d.trigger === "webhook" ? t("Git push") : t("Elle başlatıldı"))}</div>
                  </div>
                  <div className="text-right">
                    <StatusBadge status={d.status} />
                    <div className="text-[12px] text-faint">{timeAgo(d.startedAt)}, {duration(d.startedAt, d.finishedAt)}</div>
                  </div>
                  <ChevronRight className="size-4 text-faint" />
                </Link>
              ))}
            </div>
          ) : (
            <Empty action={<Link to="/projects" className="btn-primary">{t("Projelere git")}</Link>}>{t("Henüz deploy yok. Bir proje oluşturup ilk uygulamanı ekle.")}</Empty>
          )}
        </Section>

        <Section title={t("Son 24 saat")} className="!mt-0">
          <Link to="/security" className="panel block px-5 py-4 hover:border-line-strong">
            <div className="text-[32px] leading-none font-medium tracking-[-0.02em] tabular-nums">{attacks}</div>
            <div className="mt-1.5 text-[14px] text-muted">{t("engellenen istek")}</div>
            <div className="mt-4 border-t border-line pt-3 text-[13px] text-muted">
              {t("{n} IP şu an banlı", { n: security.data?.blockedCount ?? 0 })}
            </div>
          </Link>
        </Section>
      </div>
    </>
  );
}
