import { useQuery } from "@tanstack/react-query";
import { Play } from "lucide-react";
import { Link } from "react-router";
import { Button, Empty, PageHeader, PageLoading, StatusBadge, useAction } from "@/components/ui";
import { api } from "@/lib/api";
import { duration, timeAgo } from "@/lib/format";
import { locale, t } from "@/lib/i18n";

type Job = {
  id: number;
  name: string;
  schedule: string;
  command: string;
  enabled: boolean;
  lastRunAt: number | null;
  lastStatus: string | null;
  lastExitCode: number | null;
  lastDurationMs: number | null;
  nextRunAt: number | null;
  appId: number;
  appName: string;
  projectName: string;
};

/** Tüm uygulamaların zamanlanmış görevleri: son sonuç, sonraki çalışma, elle çalıştırma. */
export function SchedulesPage() {
  const { data } = useQuery({ queryKey: ["overview", "schedules"], queryFn: () => api.get<{ jobs: Job[]; timezone: string }>("/overview/schedules"), refetchInterval: 15_000 });
  const run = useAction((j: Job) => api.post(`/apps/${j.appId}/cron/${j.id}/run`, {}), { success: t("Görev başlatıldı"), invalidate: [["overview", "schedules"]] });
  if (!data) return <PageLoading />;
  const failing = data.jobs.filter((j) => j.lastStatus === "failed").length;
  const fmt = new Intl.DateTimeFormat(locale(), { timeZone: data.timezone, weekday: "short", hour: "2-digit", minute: "2-digit" });

  return (
    <>
      <PageHeader
        title={t("Zamanlanmış görevler")}
        description={
          data.jobs.length
            ? failing
              ? t("{n} görev, {m} tanesinin son çalışması başarısız.", { n: data.jobs.length, m: failing })
              : t("{n} görev. Saat dilimi: {tz}", { n: data.jobs.length, tz: data.timezone })
            : t("Uygulamaların cron görevleri burada görünür.")
        }
      />
      {data.jobs.length ? (
        <div className="panel divide-y divide-line">
          {data.jobs.map((j) => (
            <div key={j.id} className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-4 py-3 sm:px-5">
              <div className="min-w-0 basis-full sm:flex-1 sm:basis-0">
                <div className="flex items-baseline gap-2">
                  <span className="truncate text-[14px] font-medium">{j.name}</span>
                  <code className="shrink-0 rounded bg-surface-2 px-1.5 text-[12px] whitespace-nowrap text-muted">{j.schedule}</code>
                </div>
                <div className="truncate text-[12px] text-faint">
                  <Link to={`/apps/${j.appId}?tab=cron`} className="hover:text-fg">{j.appName}</Link> · {j.projectName} · <span className="font-mono">{j.command}</span>
                </div>
              </div>
              <div className="text-[13px] sm:text-right">
                {j.lastStatus ? <StatusBadge status={j.lastStatus} /> : <span className="text-faint">{t("Hiç çalışmadı")}</span>}
                <div className="text-[12px] text-faint">
                  {j.lastRunAt ? `${timeAgo(j.lastRunAt)}${j.lastDurationMs !== null ? ` · ${duration(0, j.lastDurationMs)}` : ""}` : ""}
                </div>
              </div>
              <div className="flex-1 text-[12px] text-muted sm:w-32 sm:flex-none sm:text-right">
                {j.enabled ? (j.nextRunAt ? t("Sonraki: {when}", { when: fmt.format(j.nextRunAt) }) : "–") : t("Kapalı")}
              </div>
              <Button size="sm" variant="ghost" aria-label={t("Şimdi çalıştır")} title={t("Şimdi çalıştır")} loading={run.isPending && run.variables?.id === j.id} onClick={() => run.mutate(j)}>
                <Play className="size-3.5" />
              </Button>
            </div>
          ))}
        </div>
      ) : (
        <Empty action={<Link to="/projects" className="btn-primary">{t("Projelere git")}</Link>}>
          {t("Henüz zamanlanmış görev yok. Bir uygulamanın \"Zamanlanmış görevler\" sekmesinden ekleyebilirsin (ör. her gece rapor üret, eski kayıtları temizle).")}
        </Empty>
      )}
    </>
  );
}
