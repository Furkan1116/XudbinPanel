import path from "node:path";
import { db } from "../../db.js";
import type { AppRow } from "../deploy.js";
import { BLOCK_MESSAGE, decide, format, runPreflight, skippedReport, summaryLines, withComposePolicy, type PreflightContext, type PreflightMode, type PreflightReport } from "./index.js";

/**
 * Yayın kontrolünün deploy ve veritabanı bağlantısı: uygulamanın modunu okur, raporu yayınla birlikte ve uygulamanın
 * "son raporu" olarak saklar, kritik bulguda yayını durdurur. Kontrolün kendisi index.ts'deki saf işlevlerdedir.
 */

/** Kritik bulgu yüzünden durdurulan yayın (Deploy Doktoru bu hatayı teşhis etmeye çalışmaz). */
export class PreflightBlockedError extends Error {}

export const PREFLIGHT_MODES = ["block", "warn", "off"] as const;

export function preflightMode(app: Pick<AppRow, "preflight_mode">): PreflightMode {
  return (PREFLIGHT_MODES as readonly string[]).includes(app.preflight_mode) ? (app.preflight_mode as PreflightMode) : "block";
}

/** Uygulama kaydından kontrol bağlamı. Ortamdan yalnız DJANGO_SETTINGS_MODULE adı geçer, başka değer alınmaz. */
export function contextFor(app: AppRow, settingsModule?: string): PreflightContext {
  let buildOptions: PreflightContext["buildOptions"] = {};
  try {
    buildOptions = JSON.parse(app.build_options || "{}");
  } catch {}
  return {
    sourceType: app.source_type,
    framework: app.framework || "auto",
    buildOptions,
    buildContext: app.build_context || ".",
    dockerfilePath: app.dockerfile_path || "Dockerfile",
    port: app.port,
    command: app.command,
    settingsModule: settingsModule && /^[\w.]+$/.test(settingsModule) ? settingsModule : undefined,
  };
}

/** Yükleme dosyasının adı yüklendiği an (storeAppUpload: <ms>.zip). */
export function uploadTime(zip: string | null) {
  const ms = Number(path.basename(zip ?? "").replace(/\.zip$/, ""));
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

export function saveAppReport(appId: number, report: PreflightReport) {
  db.prepare("UPDATE apps SET preflight_report = ? WHERE id = ?").run(JSON.stringify(report), appId);
}

function saveDeploymentReport(deploymentId: number, appId: number, report: PreflightReport) {
  const json = JSON.stringify(report);
  db.prepare("UPDATE deployments SET preflight = ? WHERE id = ?").run(json, deploymentId);
  db.prepare("UPDATE apps SET preflight_report = ? WHERE id = ?").run(json, appId);
}

export function parseReport(raw: string | null): PreflightReport | null {
  if (!raw) return null;
  try {
    const r = JSON.parse(raw) as PreflightReport;
    return r?.v === 1 ? r : null;
  } catch {
    return null;
  }
}

type DeployInput = {
  app: AppRow;
  deploymentId: number;
  trigger: string;
  skip: boolean;
  /** Kaynak klasörü; panelde yazılı compose için null. */
  root: string | null;
  source: { commit?: string | null; uploadedAt?: number | null };
  settingsModule?: string;
  log: (line: string) => void;
};

/**
 * Yayının başında, derlemeden önce çalışır. Kritik bulgu ve `block` modunda PreflightBlockedError fırlatır;
 * kontrolün kendi hatası yayını durdurmaz (rapora "tamamlanamadı" olarak girer).
 */
export function preflightForDeploy(input: DeployInput): PreflightReport | null {
  const mode = preflightMode(input.app);
  if (mode === "off") {
    input.log("Yayın kontrolü bu uygulamada kapalı (uygulama sayfasından açılabilir).");
    return null;
  }
  const checked = runPreflight(input.root, contextFor(input.app, input.settingsModule));
  const decision = decide(checked, mode, { trigger: input.trigger, skip: input.skip });
  decision.lines.forEach((l) => input.log(l));
  const report: PreflightReport = { ...checked, source: { ...checked.source, ...input.source }, mode, outcome: decision.outcome, deploymentId: input.deploymentId };
  saveDeploymentReport(input.deploymentId, input.app.id, report);
  if (decision.block) throw new PreflightBlockedError(format(BLOCK_MESSAGE[input.trigger === "webhook" ? "webhook" : "manual"], { n: report.counts.critical }));
  return report;
}

/** İmaj kaynağı: taranacak dosya yok; bu açıkça günlüğe ve rapora yazılır. */
export function preflightSkipped(app: AppRow, deploymentId: number, log: (line: string) => void) {
  if (preflightMode(app) === "off") return;
  const report: PreflightReport = { ...skippedReport({ sourceType: "image" }, "İmaj kaynağında kaynak dosya yok; yayın kontrolü atlandı."), mode: preflightMode(app), outcome: "skipped", deploymentId };
  summaryLines(report).forEach((l) => log(l));
  saveDeploymentReport(deploymentId, app.id, report);
}

/** Compose politikasının yayındaki sonucunu (sorun yoksa da; null: sunucu erişimi açık) yayının raporuna ekler. */
export function recordComposePolicy(deploymentId: number, appId: number, issues: string[] | null) {
  const report = parseReport((db.prepare("SELECT preflight FROM deployments WHERE id = ?").get(deploymentId) as { preflight: string | null } | undefined)?.preflight ?? null);
  if (!report) return;
  const merged = withComposePolicy(report, issues, { strict: false });
  saveDeploymentReport(deploymentId, appId, { ...merged, mode: report.mode, outcome: report.outcome, deploymentId });
}
