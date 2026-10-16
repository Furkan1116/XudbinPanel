import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Database } from "lucide-react";
import { Link } from "react-router";
import { Empty, PageHeader, PageLoading, StatusBadge } from "@/components/ui";
import { api } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import { t } from "@/lib/i18n";

type Row = {
  id: number;
  name: string;
  engine: string;
  version: string;
  status: string;
  externalPort: number | null;
  backupIntervalH: number;
  lastBackupAt: number | null;
  lastBackupStatus: string | null;
  lastVerifyStatus: string | null;
  projectId: number;
  projectName: string;
  serverName: string;
};

export const ENGINE_LABEL: Record<string, string> = { postgres: "PostgreSQL", mysql: "MySQL", mariadb: "MariaDB", mongo: "MongoDB", redis: "Redis" };

/** Tüm projelerdeki veritabanları: motor, durum, dış erişim ve yedek durumu tek listede. */
export function DatabasesPage() {
  const { data } = useQuery({ queryKey: ["overview", "databases"], queryFn: () => api.get<{ databases: Row[] }>("/overview/databases"), refetchInterval: 15_000 });
  if (!data) return <PageLoading />;
  const noBackup = data.databases.filter((d) => !d.backupIntervalH && d.engine !== "redis").length;
  return (
    <>
      <PageHeader
        title={t("Veritabanları")}
        description={
          data.databases.length
            ? noBackup
              ? t("{n} veritabanı, {m} tanesinde otomatik yedek kapalı.", { n: data.databases.length, m: noBackup })
              : t("{n} veritabanı, hepsinde otomatik yedek açık.", { n: data.databases.length })
            : t("Tüm projelerdeki veritabanları burada görünür.")
        }
      />
      {data.databases.length ? (
        <div className="panel divide-y divide-line">
          {data.databases.map((d) => (
            <Link key={d.id} to={`/databases/${d.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-surface-2/50 sm:px-5">
              <span className="grid size-9 shrink-0 place-items-center rounded-md bg-surface-2 text-muted">
                <Database className="size-4" strokeWidth={1.8} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[14px] font-medium">{d.name}</div>
                <div className="truncate text-[13px] text-faint">
                  {ENGINE_LABEL[d.engine] ?? d.engine} {d.version} · {d.projectName} · {d.serverName}
                  {d.externalPort ? ` · ${t("dış port {p}", { p: d.externalPort })}` : ""}
                </div>
              </div>
              <div className="hidden shrink-0 text-right text-[13px] sm:block">
                {d.engine === "redis" ? (
                  <span className="text-faint">{t("Önbellek")}</span>
                ) : !d.backupIntervalH ? (
                  <span className="text-warn">{t("Otomatik yedek kapalı")}</span>
                ) : d.lastBackupStatus === "failed" ? (
                  <span className="text-accent">{t("Son yedek başarısız")}</span>
                ) : d.lastBackupAt ? (
                  <span className="text-muted">
                    {t("Yedek: {when}", { when: timeAgo(d.lastBackupAt) })}
                    {d.lastVerifyStatus === "ok" ? ` · ${t("doğrulandı")}` : ""}
                  </span>
                ) : (
                  <span className="text-faint">{t("Henüz yedek yok")}</span>
                )}
              </div>
              <StatusBadge status={d.status} />
              <ChevronRight className="hidden size-4 text-faint sm:block" />
            </Link>
          ))}
        </div>
      ) : (
        <Empty action={<Link to="/projects" className="btn-primary">{t("Projelere git")}</Link>}>{t("Henüz veritabanı yok. Bir projenin içinden PostgreSQL, MySQL, MariaDB, MongoDB veya Redis ekleyebilirsin.")}</Empty>
      )}
    </>
  );
}
