import { useInfiniteQuery } from "@tanstack/react-query";
import { ChevronRight, GitCommitHorizontal } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { FrameworkLogo } from "@/components/FrameworkLogo";
import { Button, Empty, PageHeader, PageLoading, StatusBadge } from "@/components/ui";
import { api } from "@/lib/api";
import { duration, timeAgo } from "@/lib/format";
import { t } from "@/lib/i18n";

type Row = {
  id: number;
  status: string;
  trigger: string;
  title: string;
  commitSha: string | null;
  startedAt: number;
  finishedAt: number | null;
  appId: number;
  appName: string;
  framework: string | null;
  projectId: number;
  projectName: string;
  serverName: string;
};
type Page = { deployments: Row[]; last7d: Record<string, number> };

const FILTERS = [
  { id: "", label: t("Tümü") },
  { id: "running", label: t("Sürüyor") },
  { id: "failed", label: t("Başarısız") },
  { id: "success", label: t("Başarılı") },
] as const;

const TRIGGER: Record<string, string> = { manual: t("Elle"), webhook: t("Git push"), rollback: t("Geri dönüş") };

/** Tüm projelerdeki deploylar: canlı durum, filtre, sonsuz kaydırma. */
export function DeploymentsPage() {
  const [status, setStatus] = useState("");
  const q = useInfiniteQuery({
    queryKey: ["overview", "deployments", status],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => api.get<Page>(`/overview/deployments?limit=50${status ? `&status=${status}` : ""}${pageParam ? `&before=${pageParam}` : ""}`),
    getNextPageParam: (last) => (last.deployments.length === 50 ? last.deployments[49]!.id : undefined),
    refetchInterval: 5000,
  });
  if (!q.data) return <PageLoading />;
  const rows = q.data.pages.flatMap((p) => p.deployments);
  const week = q.data.pages[0]!.last7d;
  const total = Object.values(week).reduce((a, b) => a + b, 0);

  return (
    <>
      <PageHeader
        title={t("Dağıtımlar")}
        description={
          total
            ? t("Son 7 günde {n} deploy: {ok} başarılı, {fail} başarısız.", { n: total, ok: week.success ?? 0, fail: week.failed ?? 0 })
            : t("Tüm projelerdeki deploylar burada görünür.")
        }
      />
      <div className="mb-4 flex flex-wrap gap-1.5">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            onClick={() => setStatus(f.id)}
            className={`rounded-full border px-3 py-1 text-[13px] ${status === f.id ? "border-line-strong bg-surface-2 font-medium text-fg" : "border-line text-muted hover:text-fg"}`}
          >
            {f.label}
          </button>
        ))}
      </div>
      {rows.length ? (
        <div className="panel divide-y divide-line">
          {rows.map((d) => (
            <Link key={d.id} to={`/apps/${d.appId}?tab=deployments&d=${d.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-surface-2/50 sm:px-5">
              <FrameworkLogo id={d.framework ?? "auto"} />
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-baseline gap-2">
                  <span className="truncate text-[14px] font-medium">{d.appName}</span>
                  <span className="hidden truncate text-[12px] text-faint sm:inline">{d.projectName} · {d.serverName}</span>
                </div>
                <div className="flex min-w-0 items-center gap-1.5 text-[13px] text-faint">
                  {d.commitSha && (
                    <span className="inline-flex shrink-0 items-center gap-1 font-mono text-[12px]">
                      <GitCommitHorizontal className="size-3.5" />
                      {d.commitSha.slice(0, 7)}
                    </span>
                  )}
                  <span className="truncate">{d.title || TRIGGER[d.trigger] || d.trigger}</span>
                </div>
              </div>
              <div className="shrink-0 text-right">
                <StatusBadge status={d.status} />
                <div className="text-[12px] text-faint">
                  {timeAgo(d.startedAt)} · {duration(d.startedAt, d.finishedAt)}
                </div>
              </div>
              <ChevronRight className="hidden size-4 text-faint sm:block" />
            </Link>
          ))}
        </div>
      ) : (
        <Empty action={<Link to="/projects" className="btn-primary">{t("Projelere git")}</Link>}>
          {status ? t("Bu filtreyle eşleşen deploy yok.") : t("Henüz deploy yok. Bir proje oluşturup ilk uygulamanı ekle.")}
        </Empty>
      )}
      {q.hasNextPage && (
        <div className="mt-4 flex justify-center">
          <Button variant="ghost" loading={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>{t("Daha fazla göster")}</Button>
        </div>
      )}
    </>
  );
}
