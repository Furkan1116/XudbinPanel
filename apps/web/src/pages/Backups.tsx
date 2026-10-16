import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { Button, Empty, PageHeader, PageLoading, Section, useAction } from "@/components/ui";
import { api } from "@/lib/api";
import { formatBytes, timeAgo } from "@/lib/format";
import { t } from "@/lib/i18n";
import { ENGINE_LABEL } from "./Databases";

type DbRow = {
  id: number;
  name: string;
  engine: string;
  projectName: string;
  intervalH: number;
  keep: number;
  lastAt: number | null;
  lastStatus: string | null;
  lastError: string | null;
  lastSize: number | null;
  offsite: number | null;
  verifyStatus: string | null;
  count: number;
};
type VolRow = { id: number; name: string; projectName: string; intervalH: number; keep: number; lastAt: number | null; lastStatus: string | null; lastError: string | null; lastSize: number | null; count: number; volumeCount: number };
type Panel = { status: string; error: string | null; size: number; offsite: number; createdAt: number } | null;

type Health = "ok" | "warn" | "bad" | "off";
function health(r: { intervalH: number; lastAt: number | null; lastStatus: string | null }): Health {
  if (r.lastStatus === "failed") return "bad";
  if (!r.intervalH) return "off";
  // Planlanan aralığın iki katından uzun süredir yedek alınmadıysa gecikmiş sayılır.
  if (!r.lastAt || Date.now() - r.lastAt > r.intervalH * 2 * 3_600_000) return "warn";
  return "ok";
}
const DOT: Record<Health, string> = { ok: "bg-ok", warn: "bg-warn", bad: "bg-accent", off: "bg-line-strong" };

function every(h: number) {
  if (!h) return t("Otomatik yedek kapalı");
  if (h % 24 === 0) return h === 24 ? t("Her gün") : t("{n} günde bir", { n: h / 24 });
  return t("{n} saatte bir", { n: h });
}

function Last({ r }: { r: { lastAt: number | null; lastStatus: string | null; lastError: string | null; lastSize: number | null } }) {
  if (r.lastStatus === "failed") return <span className="text-accent" title={r.lastError ?? ""}>{t("Son yedek başarısız")}</span>;
  if (r.lastStatus === "running") return <span className="text-warn">{t("Yedek alınıyor...")}</span>;
  if (!r.lastAt) return <span className="text-faint">{t("Henüz yedek yok")}</span>;
  return (
    <span className="text-muted">
      {timeAgo(r.lastAt)}
      {r.lastSize ? ` · ${formatBytes(r.lastSize)}` : ""}
    </span>
  );
}

/** Tüm yedeklerin durumu tek ekranda: veritabanları, kalıcı klasörler ve panelin kendisi. */
export function BackupsPage() {
  const { data } = useQuery({ queryKey: ["overview", "backups"], queryFn: () => api.get<{ databases: DbRow[]; volumes: VolRow[]; panel?: Panel }>("/overview/backups"), refetchInterval: 15_000 });
  const dbNow = useAction((id: number) => api.post(`/databases/${id}/backups`, {}), { success: t("Yedekleme başladı"), invalidate: [["overview", "backups"]] });
  const volNow = useAction((id: number) => api.post(`/apps/${id}/volume-backups`, {}), { success: t("Yedekleme başladı"), invalidate: [["overview", "backups"]] });
  const panelNow = useAction(() => api.post("/settings/backup/panel", {}), { success: t("Panel yedeği alındı"), invalidate: [["overview", "backups"]] });
  if (!data) return <PageLoading />;
  const dbs = data.databases.filter((d) => d.engine !== "redis");
  const all = [...dbs, ...data.volumes];
  const problems = all.filter((r) => ["bad", "warn", "off"].includes(health(r))).length;

  return (
    <>
      <PageHeader
        title={t("Yedekler")}
        description={
          all.length
            ? problems
              ? t("{n} kaynaktan {m} tanesinin yedeği eksik veya başarısız.", { n: all.length, m: problems })
              : t("{n} kaynağın hepsi düzenli yedekleniyor.", { n: all.length })
            : t("Veritabanlarının ve kalıcı klasörlerin yedekleri burada görünür.")
        }
      />

      <Section title={t("Veritabanları")}>
        {dbs.length ? (
          <div className="panel divide-y divide-line">
            {dbs.map((d) => (
              <div key={d.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 sm:px-5">
                <span className={`hidden size-2 shrink-0 rounded-full sm:block ${DOT[health(d)]}`} />
                <div className="min-w-0 basis-full sm:flex-1 sm:basis-0">
                  <Link to={`/databases/${d.id}?tab=backups`} className="flex items-center gap-2 truncate text-[14px] font-medium hover:underline">
                    <span className={`size-2 shrink-0 rounded-full sm:hidden ${DOT[health(d)]}`} />
                    {d.name}
                  </Link>
                  <div className="truncate text-[12px] text-faint">
                    {ENGINE_LABEL[d.engine] ?? d.engine} · {d.projectName} · {every(d.intervalH)}
                    {d.intervalH ? ` · ${t("son {n} saklanır", { n: d.keep })}` : ""}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-x-3 text-[13px]">
                  <Last r={d} />
                  {d.offsite ? <span className="text-faint">{t("uzak depoda")}</span> : null}
                  {d.verifyStatus === "ok" && <span className="text-ok">{t("doğrulandı")}</span>}
                  {d.verifyStatus === "failed" && <span className="text-accent">{t("doğrulanamadı")}</span>}
                </div>
                <Button size="sm" variant="ghost" loading={dbNow.isPending && dbNow.variables === d.id} onClick={() => dbNow.mutate(d.id)}>{t("Şimdi yedekle")}</Button>
              </div>
            ))}
          </div>
        ) : (
          <Empty>{t("Yedeklenecek veritabanı yok.")}</Empty>
        )}
      </Section>

      <Section title={t("Kalıcı klasörler")} description={t("Uygulamaların yüklenen dosyaları ve verileri (volume).")}>
        {data.volumes.length ? (
          <div className="panel divide-y divide-line">
            {data.volumes.map((v) => (
              <div key={v.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 sm:px-5">
                <span className={`hidden size-2 shrink-0 rounded-full sm:block ${DOT[health(v)]}`} />
                <div className="min-w-0 basis-full sm:flex-1 sm:basis-0">
                  <Link to={`/apps/${v.id}?tab=settings`} className="flex items-center gap-2 truncate text-[14px] font-medium hover:underline">
                    <span className={`size-2 shrink-0 rounded-full sm:hidden ${DOT[health(v)]}`} />
                    {v.name}
                  </Link>
                  <div className="truncate text-[12px] text-faint">
                    {v.projectName} · {t("{n} klasör", { n: v.volumeCount })} · {every(v.intervalH)}
                  </div>
                </div>
                <div className="text-[13px]">
                  <Last r={v} />
                </div>
                <Button size="sm" variant="ghost" loading={volNow.isPending && volNow.variables === v.id} onClick={() => volNow.mutate(v.id)}>{t("Şimdi yedekle")}</Button>
              </div>
            ))}
          </div>
        ) : (
          <Empty>{t("Kalıcı klasörü olan uygulama yok.")}</Empty>
        )}
      </Section>

      {data.panel !== undefined && (
        <Section title={t("Panel")} description={t("Panelin kendi verisi ve şifreleme anahtarı; sunucu giderse yeni kurulumda geri yüklenir.")}>
          <div className="panel flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 sm:px-5">
            <span className={`size-2 shrink-0 rounded-full ${!data.panel ? "bg-warn" : data.panel.status === "failed" ? "bg-accent" : "bg-ok"}`} />
            <div className="min-w-0 flex-1 text-[14px]">
              {!data.panel ? (
                <span className="text-warn">{t("Henüz panel yedeği yok")}</span>
              ) : data.panel.status === "failed" ? (
                <span className="text-accent">{t("Son panel yedeği başarısız")}</span>
              ) : (
                <span>
                  {t("Son yedek {when}", { when: timeAgo(data.panel.createdAt) })}
                  <span className="text-faint"> · {formatBytes(data.panel.size)}{data.panel.offsite ? ` · ${t("uzak depoda")}` : ""}</span>
                </span>
              )}
            </div>
            <Link to="/settings?tab=backup" className="text-[13px] text-muted hover:text-fg">{t("Ayarlar")}</Link>
            <Button size="sm" variant="ghost" loading={panelNow.isPending} onClick={() => panelNow.mutate()}>{t("Şimdi yedekle")}</Button>
          </div>
        </Section>
      )}
    </>
  );
}
