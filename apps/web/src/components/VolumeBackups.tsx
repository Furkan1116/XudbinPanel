import { useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { useState } from "react";
import { Button, ConfirmDialog, Section, StatusBadge, Toggle, useAction } from "@/components/ui";
import { api, type App } from "@/lib/api";
import { dateTime, formatBytes, timeAgo } from "@/lib/format";
import { t } from "@/lib/i18n";

type Backup = { id: number; volume: string; file: string; size: number; status: string; error: string | null; remote: number; remoteError: string | null; trigger: string; createdAt: number };
type Data = { volumes: string[]; backups: Backup[]; intervalH: number; keep: number; lastAt: number | null };

/** Uygulamanın kalıcı klasörlerinin (volume) yedekleri. */
export function VolumeBackups({ app }: { app: App }) {
  const { data } = useQuery({
    queryKey: ["app", app.id, "volume-backups"],
    queryFn: () => api.get<Data>(`/apps/${app.id}/volume-backups`),
    refetchInterval: (q) => (q.state.data?.backups.some((b) => b.status === "running") ? 2000 : 15_000),
  });
  const [schedule, setSchedule] = useState<{ on: boolean; hours: string; keep: string } | null>(null);
  const [restore, setRestore] = useState<Backup | null>(null);
  const now = useAction(() => api.post(`/apps/${app.id}/volume-backups`), { success: t("Yedekleme başladı"), invalidate: [["app", app.id, "volume-backups"]] });
  const doRestore = useAction((b: Backup) => api.post(`/apps/${app.id}/volume-backups/${b.id}/restore`), { success: t("Yedek geri yüklendi"), onSuccess: () => setRestore(null) });
  const del = useAction((b: Backup) => api.del(`/apps/${app.id}/volume-backups/${b.id}`), { success: t("Yedek silindi"), invalidate: [["app", app.id, "volume-backups"]] });
  if (!data || data.volumes.length === 0) return null;
  const s = schedule ?? { on: data.intervalH > 0, hours: String(data.intervalH || 24), keep: String(data.keep) };
  const save = () =>
    api
      .patch(`/apps/${app.id}`, { volumeBackupIntervalH: s.on ? Number(s.hours) || 24 : 0, volumeBackupKeep: Number(s.keep) || 7 })
      .then(() => setSchedule(null));

  return (
    <Section
      title={t("Kalıcı klasör yedekleri")}
      description={t("Volume'lar: {list}. Uygulama çalışırken alınır; veritabanı dosyası içeren klasörlerde tutarlılık için veritabanı yedeğini tercih et.", { list: data.volumes.join(", ") })}
      actions={<Button onClick={() => now.mutate()} loading={now.isPending}>{t("Şimdi yedekle")}</Button>}
    >
      <div className="panel space-y-3 p-5">
        <Toggle checked={s.on} onChange={(v) => setSchedule({ ...s, on: v })} label={t("Otomatik yedekleme")} description={data.lastAt ? t("Son yedek {ago} alındı.", { ago: timeAgo(data.lastAt) }) : t("Henüz yedek alınmadı.")} />
        {s.on && (
          <div className="ml-12 flex flex-wrap items-center gap-2 text-[14px]">
            <input className="input w-20" inputMode="numeric" value={s.hours} onChange={(e) => setSchedule({ ...s, hours: e.target.value.replace(/\D/g, "") })} />
            <span className="text-muted">{t("saatte bir, son")}</span>
            <input className="input w-20" inputMode="numeric" value={s.keep} onChange={(e) => setSchedule({ ...s, keep: e.target.value.replace(/\D/g, "") })} />
            <span className="text-muted">{t("yedek saklansın")}</span>
          </div>
        )}
        {schedule && (
          <div className="flex justify-end">
            <Button onClick={save}>{t("Planı kaydet")}</Button>
          </div>
        )}
      </div>
      {data.backups.length > 0 && (
        <div className="panel mt-4 divide-y divide-line">
          {data.backups.map((b) => (
            <div key={b.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3">
              <div className="min-w-[16rem] flex-1">
                <div className="truncate font-mono text-[13px]">{b.volume}</div>
                <div className="text-[12px] text-faint">
                  {dateTime(b.createdAt)}
                  {b.status === "success" ? `, ${formatBytes(b.size)}` : ""}
                  {b.remote ? `, ${t("uzak depolamada")} ✓` : ""}
                </div>
                {(b.error || b.remoteError) && <div className="text-[12px] text-accent">{b.error ?? b.remoteError}</div>}
              </div>
              <StatusBadge status={b.status} />
              {b.status === "success" && (
                <div className="flex gap-1">
                  <a href={`/api/apps/${app.id}/volume-backups/${b.id}/download`} className="inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[13px] text-muted hover:bg-surface-2 hover:text-fg">
                    <Download className="size-4" /> {t("İndir")}
                  </a>
                  <Button size="sm" variant="ghost" onClick={() => setRestore(b)}>{t("Geri yükle")}</Button>
                  <Button size="sm" variant="ghost" onClick={() => del.mutate(b)}>{t("Sil")}</Button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      <ConfirmDialog
        open={Boolean(restore)}
        onClose={() => setRestore(null)}
        title={t("Klasör yedekten geri yüklensin mi?")}
        description={t("Uygulama birkaç saniye durdurulur; {v} klasörünün şu anki içeriği silinip yedektekiyle değiştirilir.", { v: restore?.volume ?? "" })}
        confirmLabel={t("Geri yükle")}
        loading={doRestore.isPending}
        onConfirm={() => restore && doRestore.mutate(restore)}
      />
    </Section>
  );
}
