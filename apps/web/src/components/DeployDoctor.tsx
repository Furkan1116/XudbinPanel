import { Stethoscope } from "lucide-react";
import { useState } from "react";
import { Button, useAction } from "@/components/ui";
import { api, type App, type Deployment, type Finding } from "@/lib/api";
import { t } from "@/lib/i18n";

type DiagnoseResult = { probe: { status: number | null; statusLine: string; error?: string } | null; healthy?: boolean; findings: Finding[] };

/** Son deploy'un teşhisi ve çalışan uygulama için "Teşhis et" düğmesi. */
export function DeployDoctor({ app, last }: { app: App; last: Deployment }) {
  const [result, setResult] = useState<DiagnoseResult | null>(null);
  const check = useAction(() => api.get<DiagnoseResult>(`/apps/${app.id}/diagnose`), { onSuccess: setResult });
  const fix = useAction((f: NonNullable<Finding["fix"]>) => api.post(`/apps/${app.id}/env/merge`, { env: f.env ?? {}, buildOptions: f.buildOptions, deploy: true }), {
    success: t("Düzeltme uygulandı, yeniden deploy başladı"),
    invalidate: [["app", app.id]],
    onSuccess: () => setResult(null),
  });

  const fromDeploy = last.status === "failed" ? (last.diagnosis ?? []) : [];
  const findings = result ? result.findings : fromDeploy;
  const canCheck = app.sourceType !== "compose" && Boolean(app.container);
  if (!findings.length && !canCheck && !result) return null;

  return (
    <div className="panel px-5 py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Stethoscope className="size-4 text-muted" />
          <h3 className="font-medium">{t("Deploy Doktoru")}</h3>
        </div>
        {canCheck && (
          <Button size="sm" variant="ghost" loading={check.isPending} onClick={() => check.mutate()}>
            {t("Teşhis et")}
          </Button>
        )}
      </div>

      {result?.probe && (
        <p className={`mt-2 text-[13px] ${result.healthy ? "text-muted" : "text-accent"}`}>
          {result.probe.status !== null
            ? `${t("Uygulama yanıtı")}: ${result.probe.statusLine}`
            : `${t("Uygulama HTTP isteğine yanıt vermedi")}${result.probe.error ? ` (${result.probe.error})` : ""}`}
        </p>
      )}
      {!findings.length && (
        <p className="mt-2 text-[13px] text-muted">
          {result ? (result.healthy ? t("Bilinen bir sorun bulunamadı, uygulama sağlıklı yanıt veriyor.") : t("Bilinen bir sorun tanınamadı; ayrıntılar uygulama loglarında.")) : t("Uygulama hata veriyorsa teşhis için tıkla: gerçek alan adıyla istek atılır ve loglar taranır.")}
        </p>
      )}
      {findings.length > 0 && (
        <ul className="mt-3 space-y-3">
          {findings.map((f) => (
            <li key={f.id} className="rounded-md border border-line bg-surface-2/50 p-3">
              <div className="text-[14px] font-medium">{f.title}</div>
              <p className="mt-1 text-[13px] leading-relaxed text-muted">{f.detail}</p>
              {f.fix && (
                <Button size="sm" variant="primary" className="mt-2" loading={fix.isPending} onClick={() => fix.mutate(f.fix!)}>
                  {f.fix.label}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
