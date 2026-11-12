import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FileSearch } from "lucide-react";
import { useState } from "react";
import { useSearchParams } from "react-router";
import { Button, ConfirmDialog, Notice, useAction } from "@/components/ui";
import { api, type App, type Deployment, type PreflightFinding, type PreflightGroup, type PreflightLevel, type PreflightMode, type PreflightReport, type PreflightVars } from "@/lib/api";
import { dateTime, timeAgo } from "@/lib/format";
import { t } from "@/lib/i18n";

/**
 * Yayın kontrolü: derlemeden önce kaynak dosyalara bakan statik, sezgisel kontrol. Güvenlik garantisi değildir;
 * arayüz bunu açıkça söyler ve "güvenli" gibi bir ifade kullanmaz.
 */

const LEVEL_LABEL: Record<PreflightLevel, () => string> = {
  critical: () => t("Kritik"),
  warning: () => t("Uyarı"),
  info: () => t("Bilgi"),
};
const LEVEL_CLASS: Record<PreflightLevel, string> = {
  critical: "bg-accent/15 text-accent",
  warning: "bg-warn/15 text-warn",
  info: "bg-surface-2 text-faint",
};
const GROUP_LABEL: Record<PreflightGroup, () => string> = {
  secrets: () => t("Gizli bilgi ve gereksiz dosyalar"),
  django: () => t("Django"),
  node: () => t("Node.js ve Next.js"),
  docker: () => t("Dockerfile ve port"),
  compose: () => t("Compose politikası"),
};
const GROUP_ORDER: PreflightGroup[] = ["secrets", "django", "node", "docker", "compose"];
const MODE_LABEL: Record<PreflightMode, () => string> = {
  block: () => t("Kritik bulguda yayını durdur"),
  warn: () => t("Yalnız uyar"),
  off: () => t("Kapalı"),
};

/** Sunucunun Türkçe kaynak metnini çevirir; değişkenlerdeki sabit metinler (ör. "Paneldeki başlatma komutu") de çevrilir. */
export function tr(text: string, vars?: PreflightVars) {
  if (!vars) return t(text);
  return t(text, Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, typeof v === "string" ? t(v) : v])));
}

function LevelBadge({ level }: { level: PreflightLevel }) {
  return <span className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[12px] ${LEVEL_CLASS[level]}`}>{LEVEL_LABEL[level]()}</span>;
}

/** "2 kritik, 3 uyarı, 1 bilgi" ya da "Sorun bulunmadı". */
export function countsText(c: { critical: number; warning: number; info: number }) {
  if (!c.critical && !c.warning && !c.info) return t("Sorun bulunmadı");
  return t("{c} kritik, {w} uyarı, {i} bilgi", { c: c.critical, w: c.warning, i: c.info });
}

function sourceText(r: PreflightReport) {
  if (r.source.commit) return t("commit {sha}", { sha: r.source.commit });
  if (r.source.uploadedAt) return t("{date} yüklemesi", { date: dateTime(r.source.uploadedAt) });
  return null;
}

function FindingItem({ f }: { f: PreflightFinding }) {
  const where = f.file ? `${f.file}${f.line ? `:${f.line}` : ""}` : null;
  return (
    <li className="rounded-md border border-line bg-surface-2/50 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 text-[14px] font-medium break-words">{tr(f.title, f.vars)}</div>
        <LevelBadge level={f.level} />
      </div>
      <p className="mt-1 text-[13px] leading-relaxed text-muted">{tr(f.detail, f.vars)}</p>
      {where && <div className="mt-1.5 font-mono text-[12px] break-all text-faint">{where}</div>}
      {f.fix && (
        <p className="mt-1.5 text-[13px] leading-relaxed">
          <span className="text-muted">{t("Nasıl düzeltilir")}: </span>
          {tr(f.fix, f.vars)}
        </p>
      )}
    </li>
  );
}

/** Gruplara ayrılmış bulgular ve kontrolün notları. */
export function PreflightFindings({ report }: { report: PreflightReport }) {
  const groups = GROUP_ORDER.filter((g) => report.findings.some((f) => f.group === g));
  return (
    <div className="space-y-4">
      {report.status === "error" && <Notice tone="warn" title={t("Kontrol tamamlanamadı")}>{t("Yayın bu yüzden durdurulmaz. Ayrıntı panel loglarında.")}</Notice>}
      {groups.map((g) => (
        <div key={g}>
          <h4 className="mb-2 text-[13px] font-medium text-muted">{GROUP_LABEL[g]()}</h4>
          <ul className="space-y-2">
            {report.findings.filter((f) => f.group === g).map((f, i) => (
              <FindingItem key={`${f.id}-${f.file ?? ""}-${i}`} f={f} />
            ))}
          </ul>
        </div>
      ))}
      {report.notes.length > 0 && (
        <ul className="space-y-1 text-[13px] text-faint">
          {report.notes.map((n, i) => (
            <li key={i}>{tr(n.text, n.vars)}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

type PreflightState = { mode: PreflightMode; report: PreflightReport | null };

/** Uygulama sayfasındaki "Yayın kontrolü" bölümü: son rapor, "Kontrol et" ve mod seçimi. */
export function PreflightCard({ app }: { app: App }) {
  const qc = useQueryClient();
  const key = ["app", app.id, "preflight"];
  const state = useQuery({ queryKey: key, queryFn: () => api.get<PreflightState>(`/apps/${app.id}/preflight`) });
  const check = useAction(() => api.post<PreflightState>(`/apps/${app.id}/preflight`), { onSuccess: (r) => qc.setQueryData(key, r) });
  const setMode = useAction((mode: PreflightMode) => api.patch(`/apps/${app.id}`, { preflightMode: mode }), { success: t("Kaydedildi"), invalidate: [["app", app.id], key] });
  const canWrite = !app.secretsHidden;
  const report = state.data?.report ?? null;

  if (app.sourceType === "image") {
    return (
      <div className="panel px-5 py-4">
        <Header />
        <p className="mt-2 text-[13px] text-muted">{t("İmaj kaynağında kaynak dosya yok; yayın kontrolü yapılmaz.")}</p>
      </div>
    );
  }

  return (
    <div className="panel px-5 py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Header />
        <div className="flex flex-wrap items-center gap-2">
          {canWrite ? (
            <select className="input w-auto text-[13px]" aria-label={t("Yayın kontrolü modu")} value={app.preflightMode} disabled={setMode.isPending} onChange={(e) => setMode.mutate(e.target.value as PreflightMode)}>
              {(["block", "warn", "off"] as const).map((m) => (
                <option key={m} value={m}>{MODE_LABEL[m]()}</option>
              ))}
            </select>
          ) : (
            <span className="text-[13px] text-muted">{MODE_LABEL[app.preflightMode]()}</span>
          )}
          {canWrite && (
            <Button size="sm" loading={check.isPending} onClick={() => check.mutate()}>
              {t("Kontrol et")}
            </Button>
          )}
        </div>
      </div>
      <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-muted">
        {t("Her yayının başında, derlemeden önce kaynak dosyalara bakar: gizli bilgi, gereksiz dosyalar, Django, Node.js ve Dockerfile ayarları. Statik ve sezgisel bir kontroldür; kod çalıştırmaz, güvenlik garantisi vermez.")}
      </p>
      {app.preflightMode === "off" && <p className="mt-2 text-[13px] text-warn">{t("Kontrol kapalı; yayınlar kontrol edilmeden başlar.")}</p>}

      {report ? (
        <div className="mt-4">
          <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[14px]">
            <span className={report.counts.critical ? "font-medium text-accent" : "font-medium"}>{report.status === "skipped" ? t("Kontrol atlandı") : countsText(report.counts)}</span>
            <span className="text-[13px] text-faint" title={dateTime(report.at)}>
              {[timeAgo(report.at), sourceText(report), report.deploymentId ? t("deploy #{id}", { id: report.deploymentId }) : t("elle kontrol")].filter(Boolean).join(" · ")}
            </span>
          </div>
          <PreflightFindings report={report} />
        </div>
      ) : (
        state.data && <p className="mt-3 text-[13px] text-muted">{t("Henüz kontrol yapılmadı. Bir sonraki yayında kendiliğinden çalışır; şimdi görmek için \"Kontrol et\"e bas.")}</p>
      )}
    </div>
  );
}

function Header() {
  return (
    <div className="flex items-center gap-2">
      <FileSearch className="size-4 text-muted" />
      <h3 className="font-medium">{t("Yayın kontrolü")}</h3>
    </div>
  );
}

/** Yayın kaydındaki kontrol sonucu: durdurduysa nedeni ve "Yine de yayınla" (onaylı). */
export function DeploymentPreflight({ app, dep }: { app: App; dep: Deployment }) {
  const [, setParams] = useSearchParams();
  const [confirm, setConfirm] = useState(false);
  const outcome = dep.preflight?.outcome;
  const show = outcome === "blocked" || outcome === "bypassed" || Boolean(dep.preflight?.counts.critical);
  const full = useQuery({ queryKey: ["deployment", dep.id, "preflight"], queryFn: () => api.get<{ report: PreflightReport | null }>(`/deployments/${dep.id}/preflight`), enabled: show });
  const force = useAction(() => api.post<{ deploymentId: number }>(`/apps/${app.id}/deploy`, { skipPreflight: true }), {
    success: t("Yayın başladı; kontrol bilerek geçildi"),
    invalidate: [["app", app.id]],
    onSuccess: (r) => {
      setConfirm(false);
      setParams({ tab: "deployments", d: String(r.deploymentId) }, { replace: true });
    },
  });
  if (!show || !dep.preflight) return null;
  const report = full.data?.report;
  // Başka bir yayın sürerken yeni yayın sıraya girer; düğme o sırada gösterilmez.
  const idle = app.status !== "deploying";

  if (outcome === "bypassed") {
    return (
      <div className="mb-3">
        <Notice tone="warn" title={t("Yayın kontrolü bilerek geçildi")}>{t("{n} kritik bulguya rağmen yayınlandı. Bulgular uygulamanın Genel sekmesindeki Yayın kontrolü bölümünde.", { n: dep.preflight.counts.critical })}</Notice>
      </div>
    );
  }
  if (outcome !== "blocked") {
    return (
      <div className="mb-3">
        <Notice tone="info" title={t("Yayın kontrolü: {counts}", { counts: countsText(dep.preflight.counts) })}>{t("Mod \"yalnız uyar\" olduğu için yayın durmadı.")}</Notice>
      </div>
    );
  }
  return (
    <div className="mb-3 panel border-l-[3px] border-l-accent px-5 py-4">
      <div className="text-[15px] font-medium">{t("Yayın kontrolü yayını durdurdu")}</div>
      <p className="mt-1 text-[14px] leading-relaxed text-muted">
        {t("{n} kritik bulgu var; derleme başlamadı, eski sürüm yayında. Bulguları düzeltip yeniden yayınla ya da riskini bilerek geç.", { n: dep.preflight.counts.critical })}
      </p>
      {report && (
        <div className="mt-3">
          <PreflightFindings report={{ ...report, findings: report.findings.filter((f) => f.level === "critical"), notes: [] }} />
        </div>
      )}
      {!app.secretsHidden && idle && (
        <Button variant="danger" size="sm" className="mt-3" onClick={() => setConfirm(true)}>
          {t("Yine de yayınla")}
        </Button>
      )}
      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title={t("Kritik bulgulara rağmen yayınlansın mı?")}
        description={t("Yayın kontrolü bu sefer bulgular yüzünden durmaz. Bu karar işlem kaydına ve yayın günlüğüne yazılır. Git kaynağında dalın son commit'i yayınlanır.")}
        confirmLabel={t("Yine de yayınla")}
        loading={force.isPending}
        onConfirm={() => force.mutate()}
      />
    </div>
  );
}
