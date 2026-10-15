import { useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { LogViewer } from "@/components/LogViewer";
import { Button, ConfirmDialog, CopyField, Field, Notice, PageHeader, PageLoading, Section, StatusBadge, Tabs, Toggle, useAction } from "@/components/ui";
import { api, type Backup, type Database } from "@/lib/api";
import { dateTime, formatBytes, timeAgo } from "@/lib/format";
import { t } from "@/lib/i18n";

type Tab = "connection" | "backups" | "logs" | "settings";

export function DatabaseDetailPage() {
  const id = Number(useParams().id);
  const [params, setParams] = useSearchParams();
  const tab = (params.get("tab") as Tab) || "connection";
  const { data } = useQuery({
    queryKey: ["database", id],
    queryFn: () => api.get<{ database: Database; backups: Backup[] }>(`/databases/${id}`),
    refetchInterval: (q) => (q.state.data?.database.status === "starting" || q.state.data?.backups.some((b) => b.verifyStatus === "running") ? 2000 : 10_000),
  });
  const act = useAction((a: "start" | "stop" | "restart") => api.post(`/databases/${id}/${a}`), { success: t("İşlem tamamlandı"), invalidate: [["database", id]] });
  if (!data) return <PageLoading />;
  const d = data.database;

  return (
    <>
      <PageHeader
        back={{ to: `/projects/${d.projectId}`, label: t("Proje") }}
        title={d.name}
        description={
          <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
            <StatusBadge status={d.status} />
            <span>{d.engineLabel} {d.version}</span>
            <span>{d.server.name}</span>
          </span>
        }
        actions={
          d.status === "stopped" ? (
            <Button onClick={() => act.mutate("start")} loading={act.isPending}>{t("Başlat")}</Button>
          ) : (
            <>
              <Button variant="ghost" onClick={() => act.mutate("restart")} loading={act.isPending && act.variables === "restart"}>{t("Yeniden başlat")}</Button>
              <Button variant="ghost" onClick={() => act.mutate("stop")} loading={act.isPending && act.variables === "stop"}>{t("Durdur")}</Button>
            </>
          )
        }
      />
      <Tabs
        value={tab}
        onChange={(t) => setParams({ tab: t }, { replace: true })}
        tabs={[
          { id: "connection", label: t("Bağlantı") },
          { id: "backups", label: t("Yedekler") },
          { id: "logs", label: t("Loglar") },
          { id: "settings", label: t("Ayarlar") },
        ]}
      />
      {tab === "connection" && <Connection d={d} />}
      {tab === "backups" && <Backups d={d} backups={data.backups} />}
      {tab === "logs" && <LogViewer url={`/api/databases/${id}/logs/stream`} />}
      {tab === "settings" && <Settings d={d} />}
    </>
  );
}

function Connection({ d }: { d: Database }) {
  return (
    <div className="space-y-8">
      <Section title={t("Uygulamalardan bağlan")} description={t("Aynı sunucudaki uygulamalar bu adresi kullanır. Uygulamanın ortam değişkenlerine ekle.")}>
        <CopyField value={d.internalUrl} secret />
      </Section>
      {d.externalUrl ? (
        <Section title={t("Dışarıdan bağlan")} description={t("Sunucunun {port} portu açık. Yalnız ihtiyaç varsa kullan; şifreyi kimseyle paylaşma.", { port: d.externalPort ?? "" })}>
          <CopyField value={d.externalUrl} secret />
        </Section>
      ) : (
        <Notice tone="info" title={t("Dışarıya kapalı")}>{t("Veritabanına internetten erişilemez. Gerekirse Ayarlar'dan bir port aç.")}</Notice>
      )}
      <dl className="grid gap-x-8 gap-y-3 text-[14px] sm:grid-cols-2">
        {[
          [t("Sunucu adı"), d.internalHost],
          [t("Port"), String(d.internalPort)],
          [t("Veritabanı"), d.dbName],
          [t("Kullanıcı"), d.engine === "redis" ? "default" : d.dbUser],
        ].map(([k, v]) => (
          <div key={k} className="flex justify-between gap-4 border-b border-line pb-3">
            <dt className="text-muted">{k}</dt>
            <dd className="font-mono text-[13px]">{v}</dd>
          </div>
        ))}
      </dl>
      <Field label={t("Şifre")}>
        <CopyField value={d.password} secret />
      </Field>
    </div>
  );
}

function Backups({ d, backups }: { d: Database; backups: Backup[] }) {
  const [restore, setRestore] = useState<Backup | null>(null);
  const [schedule, setSchedule] = useState({ on: d.backupIntervalH > 0, hours: String(d.backupIntervalH || 24), keep: String(d.backupKeep) });
  const create = useAction(() => api.post(`/databases/${d.id}/backups`), { success: t("Yedek alındı"), invalidate: [["database", d.id]] });
  const doRestore = useAction((b: Backup) => api.post(`/databases/${d.id}/backups/${b.id}/restore`), { success: t("Yedek geri yüklendi"), onSuccess: () => setRestore(null) });
  const del = useAction((b: Backup) => api.del(`/databases/${d.id}/backups/${b.id}`), { success: t("Yedek silindi"), invalidate: [["database", d.id]] });
  const verify = useAction((b: Backup) => api.post(`/databases/${d.id}/backups/${b.id}/verify`), { success: t("Doğrulama başladı"), invalidate: [["database", d.id]] });
  const saveSchedule = useAction(
    () => api.patch(`/databases/${d.id}`, { backupIntervalH: schedule.on ? Number(schedule.hours) || 24 : 0, backupKeep: Number(schedule.keep) || 7 }),
    { success: t("Yedekleme planı kaydedildi"), invalidate: [["database", d.id]] },
  );

  return (
    <div className="space-y-8">
      <div className="panel space-y-4 p-5">
        <Toggle checked={schedule.on} onChange={(v) => setSchedule({ ...schedule, on: v })} label={t("Otomatik yedekleme")} description={d.lastBackupAt ? t("Son yedek {ago} alındı.", { ago: timeAgo(d.lastBackupAt) }) : t("Henüz yedek alınmadı.")} />
        {schedule.on && (
          <div className="ml-12 flex flex-wrap items-center gap-2 text-[14px]">
            <input className="input w-20" inputMode="numeric" value={schedule.hours} onChange={(e) => setSchedule({ ...schedule, hours: e.target.value.replace(/\D/g, "") })} />
            <span className="text-muted">{t("saatte bir, son")}</span>
            <input className="input w-20" inputMode="numeric" value={schedule.keep} onChange={(e) => setSchedule({ ...schedule, keep: e.target.value.replace(/\D/g, "") })} />
            <span className="text-muted">{t("yedek saklansın")}</span>
          </div>
        )}
        <div className="flex justify-end">
          <Button onClick={() => saveSchedule.mutate()} loading={saveSchedule.isPending}>{t("Planı kaydet")}</Button>
        </div>
      </div>

      <Section title={t("Yedekler")} description={t("Yedekler panelin sunucusunda, uzak depolama tanımlıysa orada da saklanır. \"Doğrula\" yedeği geçici bir veritabanına geri yükleyip dener.")} actions={<Button variant="primary" onClick={() => create.mutate()} loading={create.isPending} disabled={d.status !== "running"}>{t("Şimdi yedekle")}</Button>}>
        {backups.length === 0 ? (
          <div className="panel px-5 py-6 text-[14px] text-muted">{t("Henüz yedek yok.")}</div>
        ) : (
          <div className="panel divide-y divide-line">
            {backups.map((b) => (
              <div key={b.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3">
                <div className="min-w-[16rem] flex-1">
                  <div className="truncate font-mono text-[13px]">{b.file}</div>
                  <div className="text-[13px] text-faint">{dateTime(b.createdAt)}{b.status === "success" ? `, ${formatBytes(b.size)}` : ""}</div>
                  {b.error && <div className="text-[13px] text-accent">{b.error}</div>}
                  {b.status === "success" && (
                    <div className="mt-0.5 flex flex-wrap gap-x-3 text-[12px]">
                      {b.remote ? <span className="text-muted">{t("Uzak depolamada")} ✓</span> : b.remoteError ? <span className="text-accent">{t("Uzağa yüklenemedi")}: {b.remoteError}</span> : null}
                      {b.verifyStatus === "running" && <span className="text-muted">{t("Doğrulanıyor...")}</span>}
                      {b.verifyStatus === "success" && <span className="text-muted">{t("Doğrulandı")} ✓ {b.verifyNote}{b.verifiedAt ? `, ${timeAgo(b.verifiedAt)}` : ""}</span>}
                      {b.verifyStatus === "failed" && <span className="text-accent">{t("Doğrulama başarısız")}: {b.verifyNote}</span>}
                    </div>
                  )}
                </div>
                <StatusBadge status={b.status} />
                {b.status === "success" && (
                  <div className="flex gap-1">
                    <a href={`/api/databases/${d.id}/backups/${b.id}/download`} className="inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[13px] text-muted hover:bg-surface-2 hover:text-fg">
                      <Download className="size-4" /> {t("İndir")}
                    </a>
                    <Button size="sm" variant="ghost" disabled={b.verifyStatus === "running"} onClick={() => verify.mutate(b)}>{t("Doğrula")}</Button>
                    {d.engine !== "redis" && <Button size="sm" variant="ghost" onClick={() => setRestore(b)}>{t("Geri yükle")}</Button>}
                    <Button size="sm" variant="ghost" onClick={() => del.mutate(b)}>{t("Sil")}</Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </Section>
      <ConfirmDialog
        open={Boolean(restore)}
        onClose={() => setRestore(null)}
        title={t("Yedek geri yüklensin mi?")}
        description={t("Veritabanındaki mevcut veriler bu yedektekilerle değiştirilir. Önce şimdiki halin yedeğini almanı öneririz.")}
        confirmLabel={t("Geri yükle")}
        loading={doRestore.isPending}
        onConfirm={() => restore && doRestore.mutate(restore)}
      />
    </div>
  );
}

function Settings({ d }: { d: Database }) {
  const navigate = useNavigate();
  const [port, setPort] = useState(d.externalPort ? String(d.externalPort) : "");
  const [confirm, setConfirm] = useState(false);
  const [withData, setWithData] = useState(false);
  const save = useAction(() => api.patch(`/databases/${d.id}`, { externalPort: port ? Number(port) : null }), { success: t("Kaydedildi, veritabanı yeniden başlatıldı"), invalidate: [["database", d.id]] });
  const del = useAction(() => api.del(`/databases/${d.id}${withData ? "?withData=1" : ""}`), { success: t("Veritabanı silindi"), onSuccess: () => navigate(`/projects/${d.projectId}`) });
  return (
    <>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
        className="panel space-y-4 p-5"
      >
        <Field label={t("Dışarıya açık port")} hint={t("Boş bırakırsan veritabanı yalnız sunucu içinden erişilebilir. Değiştirmek konteyneri yeniden başlatır.")}>
          <input className="input max-w-40" inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ""))} />
        </Field>
        <div className="flex justify-end">
          <Button type="submit" variant="primary" loading={save.isPending}>{t("Kaydet")}</Button>
        </div>
      </form>
      <Section title={t("Veritabanını sil")}>
        <Button variant="danger" onClick={() => setConfirm(true)}>{t("Veritabanını sil")}</Button>
      </Section>
      <ConfirmDialog open={confirm} onClose={() => setConfirm(false)} title={t("Veritabanı silinsin mi?")} description={t("Konteyner ve paneldeki yedekler silinir.")} typeToConfirm={d.name} confirmLabel={t("Sil")} loading={del.isPending} onConfirm={() => del.mutate()}>
        <div className="mb-5">
          <Toggle checked={withData} onChange={setWithData} label={t("Verileri de sil")} description={t("Kapalıysa veri volume'u sunucuda kalır; aynı adla yeniden oluşturmak veriyi geri getirmez ama elle kurtarılabilir.")} />
        </div>
      </ConfirmDialog>
    </>
  );
}
