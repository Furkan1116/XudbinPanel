import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Button, Dialog, Empty, Field, StatusBadge, Toggle, useAction } from "@/components/ui";
import { api, type App } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import { t } from "@/lib/i18n";

type Run = { id: number; status: string; exitCode: number | null; startedAt: number; finishedAt: number | null; trigger: string; output?: string };
type Job = { id: number; name: string; schedule: string; command: string; enabled: boolean; timeoutMin: number; lastRun: Run | null; nextRun: number | null };

const PRESETS = [
  { label: "Her 5 dakikada", value: "*/5 * * * *" },
  { label: "Saatte bir", value: "0 * * * *" },
  { label: "Her gece 03:00", value: "0 3 * * *" },
  { label: "Her pazartesi 09:00", value: "0 9 * * 1" },
  { label: "Ayın ilk günü", value: "0 0 1 * *" },
];

/** Uygulamanın imajıyla belirli aralıklarla çalışan komutlar (cron). */
export function CronJobs({ app }: { app: App }) {
  const { data } = useQuery({ queryKey: ["app", app.id, "cron"], queryFn: () => api.get<{ jobs: Job[] }>(`/apps/${app.id}/cron`), refetchInterval: 10_000 });
  const [edit, setEdit] = useState<Partial<Job> | null>(null);
  const [runsOf, setRunsOf] = useState<Job | null>(null);
  const runNow = useAction((id: number) => api.post(`/apps/${app.id}/cron/${id}/run`), { success: t("Görev başlatıldı"), invalidate: [["app", app.id, "cron"]] });
  const del = useAction((id: number) => api.del(`/apps/${app.id}/cron/${id}`), { success: t("Görev silindi"), invalidate: [["app", app.id, "cron"]] });
  const fmt = new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "short" });

  if (app.sourceType === "compose") return <Empty>{t("Zamanlanmış görevler Compose uygulamalarında desteklenmez; Compose dosyana ayrı bir servis olarak ekleyebilirsin.")}</Empty>;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-xl text-[14px] text-muted">{t("Komut, uygulamanın son imajıyla, aynı ortam değişkenleri ve kalıcı klasörlerle ayrı bir konteynerde çalışır. Ör. php artisan schedule:run, python manage.py clearsessions.")}</p>
        <Button variant="primary" onClick={() => setEdit({ schedule: "0 3 * * *", enabled: true, timeoutMin: 60 })}>{t("Görev ekle")}</Button>
      </div>
      {!data ? null : data.jobs.length === 0 ? (
        <Empty>{t("Henüz zamanlanmış görev yok.")}</Empty>
      ) : (
        <div className="panel divide-y divide-line">
          {data.jobs.map((j) => (
            <div key={j.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3">
              <div className="min-w-[16rem] flex-1">
                <div className="font-medium">{j.name} {!j.enabled && <span className="ml-1 text-[12px] text-faint">{t("kapalı")}</span>}</div>
                <div className="font-mono text-[12px] text-muted">{j.schedule} · {j.command}</div>
                <div className="text-[12px] text-faint">
                  {j.lastRun ? t("Son çalışma {ago}", { ago: timeAgo(j.lastRun.startedAt) }) : t("Henüz çalışmadı")}
                  {j.nextRun ? ` · ${t("Sonraki: {t}", { t: fmt.format(j.nextRun) })}` : ""}
                </div>
              </div>
              {j.lastRun && <StatusBadge status={j.lastRun.status} />}
              <div className="flex gap-1">
                <Button size="sm" variant="ghost" onClick={() => runNow.mutate(j.id)} disabled={j.lastRun?.status === "running"}>{t("Şimdi çalıştır")}</Button>
                <Button size="sm" variant="ghost" onClick={() => setRunsOf(j)}>{t("Çıktılar")}</Button>
                <Button size="sm" variant="ghost" onClick={() => setEdit(j)}>{t("Düzenle")}</Button>
                <Button size="sm" variant="ghost" onClick={() => del.mutate(j.id)}>{t("Sil")}</Button>
              </div>
            </div>
          ))}
        </div>
      )}
      {edit && <JobDialog app={app} job={edit} onClose={() => setEdit(null)} />}
      {runsOf && <RunsDialog app={app} job={runsOf} onClose={() => setRunsOf(null)} />}
    </div>
  );
}

function JobDialog({ app, job, onClose }: { app: App; job: Partial<Job>; onClose: () => void }) {
  const [f, setF] = useState({ name: job.name ?? "", schedule: job.schedule ?? "0 3 * * *", command: job.command ?? "", enabled: job.enabled ?? true, timeoutMin: String(job.timeoutMin ?? 60) });
  const save = useAction(
    () => {
      const payload = { name: f.name, schedule: f.schedule, command: f.command, enabled: f.enabled, timeoutMin: Number(f.timeoutMin) || 60 };
      return job.id ? api.put(`/apps/${app.id}/cron/${job.id}`, payload) : api.post(`/apps/${app.id}/cron`, payload);
    },
    { success: t("Görev kaydedildi"), invalidate: [["app", app.id, "cron"]], onSuccess: onClose },
  );
  return (
    <Dialog open onClose={onClose} title={job.id ? t("Görevi düzenle") : t("Zamanlanmış görev ekle")}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <Field label={t("Ad")}>
          <input className="input" required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder={t("ör. Gece temizliği")} />
        </Field>
        <Field label={t("Ne zaman")} hint={t("Cron biçimi: dakika saat gün ay haftanın-günü. Panelin saat dilimine göre çalışır.")}>
          <input className="input font-mono" required value={f.schedule} onChange={(e) => setF({ ...f, schedule: e.target.value })} />
          <div className="mt-2 flex flex-wrap gap-1">
            {PRESETS.map((p) => (
              <button key={p.value} type="button" onClick={() => setF({ ...f, schedule: p.value })} className={`rounded border px-2 py-0.5 text-[12px] ${f.schedule === p.value ? "border-accent text-fg" : "border-line-strong text-muted hover:text-fg"}`}>
                {t(p.label)}
              </button>
            ))}
          </div>
        </Field>
        <Field label={t("Komut")}>
          <input className="input font-mono text-[13px]" required value={f.command} onChange={(e) => setF({ ...f, command: e.target.value })} placeholder="python manage.py clearsessions" />
        </Field>
        <div className="grid gap-3 sm:grid-cols-[8rem_1fr] sm:items-end">
          <Field label={t("Zaman aşımı (dk)")}>
            <input className="input" inputMode="numeric" value={f.timeoutMin} onChange={(e) => setF({ ...f, timeoutMin: e.target.value.replace(/\D/g, "") })} />
          </Field>
          <Toggle checked={f.enabled} onChange={(v) => setF({ ...f, enabled: v })} label={t("Etkin")} />
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>{t("Vazgeç")}</Button>
          <Button type="submit" variant="primary" loading={save.isPending}>{t("Kaydet")}</Button>
        </div>
      </form>
    </Dialog>
  );
}

function RunsDialog({ app, job, onClose }: { app: App; job: Job; onClose: () => void }) {
  const { data } = useQuery({ queryKey: ["app", app.id, "cron", job.id, "runs"], queryFn: () => api.get<{ runs: Run[] }>(`/apps/${app.id}/cron/${job.id}/runs`), refetchInterval: 5000 });
  const fmt = new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "medium" });
  return (
    <Dialog open onClose={onClose} title={t("{name}: son çalışmalar", { name: job.name })} wide>
      <div className="max-h-[60vh] space-y-3 overflow-y-auto">
        {!data?.runs.length && <p className="text-[14px] text-muted">{t("Henüz çalışmadı.")}</p>}
        {data?.runs.map((r) => (
          <details key={r.id} className="panel" open={r === data.runs[0]}>
            <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-2 px-4 py-2 text-[13px]">
              <span>{fmt.format(r.startedAt)} · {r.trigger === "manual" ? t("elle") : t("zamanlanmış")}{r.exitCode !== null ? ` · ${t("çıkış kodu {c}", { c: r.exitCode })}` : ""}</span>
              <StatusBadge status={r.status} />
            </summary>
            <pre className="max-h-72 overflow-auto border-t border-line px-4 py-3 font-mono text-[12px] whitespace-pre-wrap">{r.output || t("(çıktı yok)")}</pre>
          </details>
        ))}
      </div>
    </Dialog>
  );
}
