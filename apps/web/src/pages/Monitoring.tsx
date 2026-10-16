import { useQuery } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import { Link } from "react-router";
import { ServerMeters } from "@/components/ServerMeters";
import { Empty, Notice, PageHeader, PageLoading, Section } from "@/components/ui";
import { api, type ServerOverview } from "@/lib/api";
import { useAuthStatus } from "@/lib/auth";
import { formatUptime, timeAgo } from "@/lib/format";
import { t } from "@/lib/i18n";

type AppRow = {
  id: number;
  name: string;
  status: string;
  projectName: string;
  url: string | null;
  monitored: boolean;
  down: boolean;
  downSince: number | null;
  up24h: number | null;
  up7d: number | null;
  lastMs: number | null;
  avgMs: number | null;
  bars: (number | null)[];
};
type Incident = { appId: number; appName: string; startedAt: number; endedAt: number | null; reason: string | null };

const pct = (r: number | null) => (r === null ? "–" : `%${(r * 100).toFixed(r === 1 ? 0 : 2)}`);

/** Erişilebilirlik ve sunucu kaynakları tek ekranda: çöken siteler en üstte. */
export function MonitoringPage() {
  const admin = useAuthStatus().data?.user?.role === "admin";
  const { data } = useQuery({ queryKey: ["overview", "monitoring"], queryFn: () => api.get<{ apps: AppRow[]; incidents: Incident[] }>("/overview/monitoring"), refetchInterval: 30_000 });
  const servers = useQuery({ queryKey: ["servers", "overview"], queryFn: () => api.get<{ servers: ServerOverview[] }>("/servers/overview"), refetchInterval: 10_000, enabled: admin });
  if (!data) return <PageLoading />;
  const down = data.apps.filter((a) => a.down);
  const monitored = data.apps.filter((a) => a.monitored);
  const sorted = [...data.apps].sort((a, b) => Number(b.down) - Number(a.down) || Number(b.monitored) - Number(a.monitored) || (a.up24h ?? 2) - (b.up24h ?? 2));

  return (
    <>
      <PageHeader
        title={t("İzleme")}
        description={
          monitored.length
            ? down.length
              ? t("{n} site şu an erişilemiyor.", { n: down.length })
              : t("İzlenen {n} sitenin hepsi çalışıyor.", { n: monitored.length })
            : t("Siteler dakikada bir denenir; çökme ve düzelmede bildirim gönderilir.")
        }
      />
      {down.length > 0 && (
        <div className="mb-6 space-y-2">
          {down.map((a) => (
            <Notice key={a.id} tone="danger" title={t("{name} erişilemiyor", { name: a.name })}>
              {a.downSince ? t("{when} beri. ", { when: formatUptime((Date.now() - a.downSince) / 1000) }) : ""}
              <Link to={`/apps/${a.id}`} className="underline">{t("Uygulamaya git")}</Link>
            </Notice>
          ))}
        </div>
      )}

      <Section title={t("Siteler")} description={t("Son 24 saat, saat saat. Kırmızı dilimlerde en az bir kontrol başarısız oldu.")}>
        {data.apps.length ? (
          <div className="panel divide-y divide-line">
            {sorted.map((a) => (
              <div key={a.id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:gap-4 sm:px-5">
                <div className="flex min-w-0 items-center gap-2.5 sm:w-56 sm:shrink-0">
                  <span className={`size-2 shrink-0 rounded-full ${!a.monitored ? "bg-line-strong" : a.down ? "bg-accent" : "bg-ok"}`} />
                  <div className="min-w-0">
                    <Link to={`/apps/${a.id}`} className="block truncate text-[14px] font-medium hover:underline">{a.name}</Link>
                    <div className="flex items-center gap-1 truncate text-[12px] text-faint">
                      {a.projectName}
                      {a.url && (
                        <a href={a.url} target="_blank" rel="noreferrer" className="hover:text-fg" aria-label={t("Siteyi aç")}>
                          <ExternalLink className="size-3" />
                        </a>
                      )}
                    </div>
                  </div>
                </div>
                {a.monitored ? (
                  <>
                    <div className="flex h-6 min-w-0 flex-1 items-stretch gap-[2px]" aria-label={t("Son 24 saat")}>
                      {a.bars.map((b, i) => (
                        <span
                          key={i}
                          title={b === null ? t("Veri yok") : pct(b)}
                          className={`flex-1 rounded-[2px] ${b === null ? "bg-surface-2" : b >= 0.999 ? "bg-ok/70" : b >= 0.9 ? "bg-warn/80" : "bg-accent/80"}`}
                        />
                      ))}
                    </div>
                    <div className="flex shrink-0 gap-4 text-[13px] tabular-nums sm:w-56 sm:justify-end">
                      <span title={t("Son 24 saat")}>{pct(a.up24h)}</span>
                      <span className="text-faint" title={t("Son 7 gün")}>7g {pct(a.up7d)}</span>
                      <span className="text-faint" title={t("Ortalama yanıt süresi")}>{a.avgMs !== null ? `${a.avgMs} ms` : "–"}</span>
                    </div>
                  </>
                ) : (
                  <div className="flex-1 text-[13px] text-faint">
                    {a.status !== "running" ? t("Çalışmıyor; izlenmiyor.") : !a.url ? t("Alan adı yok; izlenmiyor.") : t("İzleme bu uygulamada kapalı.")}
                  </div>
                )}
              </div>
            ))}
          </div>
        ) : (
          <Empty action={<Link to="/projects" className="btn-primary">{t("Projelere git")}</Link>}>{t("Henüz izlenecek bir site yok.")}</Empty>
        )}
      </Section>

      {data.incidents.length > 0 && (
        <Section title={t("Kesintiler")}>
          <div className="panel divide-y divide-line">
            {data.incidents.map((i, idx) => (
              <div key={idx} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5 text-[13px] sm:px-5">
                <Link to={`/apps/${i.appId}`} className="font-medium hover:underline">{i.appName}</Link>
                <span className="text-muted">{timeAgo(i.startedAt)}</span>
                <span className={i.endedAt ? "text-muted" : "text-accent"}>
                  {i.endedAt ? t("{d} sürdü", { d: formatUptime((i.endedAt - i.startedAt) / 1000) }) : t("Sürüyor")}
                </span>
                {i.reason && <span className="min-w-0 flex-1 truncate text-faint">{i.reason}</span>}
              </div>
            ))}
          </div>
        </Section>
      )}

      {admin && servers.data && (
        <Section title={t("Sunucu kaynakları")}>
          <div className="grid gap-3 md:grid-cols-2">
            {servers.data.servers.map((s) => (
              <Link key={s.id} to={`/servers/${s.id}`} className="panel block p-4 hover:border-line-strong">
                <div className="mb-3 text-[14px] font-medium">{s.name}</div>
                {s.stats ? <ServerMeters stats={s.stats} /> : <p className="text-[13px] text-muted">{s.statsError ?? t("Bilgi alınamadı")}</p>}
              </Link>
            ))}
          </div>
        </Section>
      )}
    </>
  );
}
