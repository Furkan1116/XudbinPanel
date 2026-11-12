import fs from "node:fs";
import { resolveInside } from "../../lib/paths.js";
import { planBuild } from "./build.js";
import { checkDjango, isDjango } from "./django.js";
import { checkDocker } from "./docker.js";
import { checkNode, isNodeProject } from "./node.js";
import { checkIgnoreFiles, checkSecrets } from "./secrets.js";
import { LIMITS, normalize, SourceTree, type Limits } from "./tree.js";
import { format, type Note, type PreflightContext, type PreflightFinding, type PreflightGroup, type PreflightMode, type PreflightOutcome, type PreflightReport } from "./types.js";

export * from "./types.js";

/** Raporda en fazla bu kadar bulgu tutulur (kritikler önce). */
const MAX_FINDINGS = 150;
const LEVEL_ORDER = { critical: 0, warning: 1, info: 2 } as const;

function emptyReport(ctx: Pick<PreflightContext, "sourceType">, now: number): PreflightReport {
  return { v: 1, at: now, status: "done", source: { type: ctx.sourceType }, counts: { critical: 0, warning: 0, info: 0 }, findings: [], groups: [], notes: [], scanned: { files: 0, truncated: false, ms: 0 } };
}

/** Bulguları sıralar, sınırlar ve sayar. */
export function finalize(report: PreflightReport, findings: PreflightFinding[]): PreflightReport {
  const sorted = [...findings].sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]);
  const counts = { critical: 0, warning: 0, info: 0 };
  for (const f of sorted) counts[f.level]++;
  if (sorted.length > MAX_FINDINGS) report.notes.push({ text: "Raporda ilk {n} bulgu gösteriliyor.", vars: { n: MAX_FINDINGS } });
  return { ...report, counts, findings: sorted.slice(0, MAX_FINDINGS) };
}

/** Kontrol yapılmadı: imaj kaynağı (dosya yok) ya da benzeri. */
export function skippedReport(ctx: Pick<PreflightContext, "sourceType">, reason: string, now = Date.now()): PreflightReport {
  return { ...emptyReport(ctx, now), status: "skipped", notes: [{ text: reason }] };
}

/**
 * Kaynak klasörünü statik olarak kontrol eder. Saf işlev: yalnız `root` altındaki dosyaları okur; Docker'a, ağa,
 * veritabanına dokunmaz, kod çalıştırmaz. Beklenmeyen bir hata raporu "tamamlanamadı" yapar, istisna fırlatmaz.
 * `root` null ise (panelde yazılı compose dosyası) taranacak dosya yoktur.
 */
export function runPreflight(root: string | null, ctx: PreflightContext, opts: { now?: number; limits?: Limits } = {}): PreflightReport {
  const now = opts.now ?? Date.now();
  const started = Date.now();
  if (ctx.sourceType === "image") return skippedReport(ctx, "İmaj kaynağında kaynak dosya yok; yayın kontrolü atlandı.", now);
  const report = emptyReport(ctx, now);
  if (!root) {
    report.notes.push({ text: "Compose dosyası panelde yazılı; taranacak kaynak dosya yok." });
    return report;
  }
  try {
    const tree = SourceTree.scan(root, opts.limits ?? LIMITS);
    const contextDir = resolveInside(tree.root, ctx.buildContext || ".");
    const contextRel = contextDir ? normalize(contextDir.slice(tree.root.length)) : "";
    const builds = ctx.sourceType === "git" || ctx.sourceType === "upload";
    const findings: PreflightFinding[] = [...checkSecrets(tree, ctx, contextRel), ...checkIgnoreFiles(tree, ctx, contextRel, builds)];
    const groups: PreflightGroup[] = ["secrets"];
    const notes: Note[] = [];

    if (builds && contextDir && fs.existsSync(contextDir)) {
      const plan = planBuild(tree, contextDir, contextRel, ctx);
      if (!plan.frameworkId) notes.push({ text: "Proje türü tanınamadı; framework kontrolleri atlandı." });
      if (isDjango(tree, plan)) {
        groups.push("django");
        findings.push(...checkDjango(tree, plan, ctx, notes));
      }
      if (isNodeProject(tree, plan)) {
        groups.push("node");
        findings.push(...checkNode(tree, plan));
      }
      groups.push("docker");
      findings.push(...checkDocker(tree, plan, ctx, notes));
      // Dockerfile'daki "COPY . . ama .dockerignore yok" uyarısı varsa aynı şeyi söyleyen bilgi tekrarlanmaz.
    } else if (builds) notes.push({ text: "Derleme klasörü bulunamadı: {dir}", vars: { dir: ctx.buildContext } });
    else notes.push({ text: "Compose kaynağında yalnız gizli bilgi ve gereksiz dosya kontrolü yapılır." });

    if (tree.truncated) notes.push({ text: "Kaynak çok büyük; ilk {n} dosya tarandı.", vars: { n: tree.files.length } });
    if (tree.readLimited) notes.push({ text: "Okuma sınırına ulaşıldı; bazı dosyaların içeriğine bakılmadı." });
    report.notes.push(...notes);
    report.groups = groups;
    report.scanned = { files: tree.files.length, truncated: tree.truncated || tree.readLimited, ms: Date.now() - started };
    // Dockerfile'daki "COPY . . ama .dockerignore yok" uyarısı varsa aynı şeyi söyleyen bilgi tekrarlanmaz.
    const copyAll = findings.some((f) => f.id === "docker-copy-all");
    return finalize(report, copyAll ? findings.filter((f) => f.id !== "no-dockerignore") : findings);
  } catch (err) {
    console.error("Yayın kontrolü tamamlanamadı:", (err as Error).message);
    return { ...report, status: "error", error: "Kontrol beklenmeyen bir hatayla durdu; ayrıntı panel loglarında.", scanned: { files: 0, truncated: false, ms: Date.now() - started } };
  }
}

/** Compose politikasının sorunlarını rapora ekler (yayında politika moddan bağımsız olarak uygulanır). */
export function withComposePolicy(report: PreflightReport, issues: string[] | null, opts: { strict: boolean }): PreflightReport {
  const notes = [...report.notes];
  if (issues === null) notes.push({ text: "Sunucu erişimi izni açık; Compose politikası uygulanmıyor." });
  else if (!issues.length) notes.push({ text: "Compose politikası: sunucuya erişim isteyen ayar bulunmadı." });
  const findings: PreflightFinding[] = (issues ?? []).slice(0, 30).map((issue, i) => ({
    id: `compose-policy-${i}`,
    group: "compose",
    level: opts.strict ? "warning" : "critical",
    title: "Compose sunucuya erişim istiyor",
    detail: opts.strict
      ? "{issue}. Bu ön denetim katıdır; yayında Compose'un yorumladığı hâl denetlenir."
      : "{issue}. Bu ayar ancak bir yönetici \"Sunucu erişimi\" iznini açarsa çalışır; yayın moddan bağımsız olarak durur.",
    fix: "Ayarı kaldır ya da bir yöneticiden uygulama ayarlarında \"Sunucu erişimi\" iznini açmasını iste.",
    vars: { issue },
  }));
  const groups = report.groups.includes("compose") ? report.groups : [...report.groups, "compose" as const];
  return finalize({ ...report, groups, notes }, [...report.findings, ...findings]);
}

export type Decision = { outcome: PreflightOutcome; block: boolean; lines: string[] };

/**
 * Yayının ne olacağı: `block` modunda kritik bulgu yayını durdurur; elle başlatılan yayında `skip` ile bilerek
 * geçilebilir, webhook yayınında geçiş yoktur. `warn` yalnız uyarır. Kontrol tamamlanamadıysa yayın sürer.
 */
export function decide(report: PreflightReport, mode: PreflightMode, opts: { trigger: string; skip: boolean }): Decision {
  const lines = summaryLines(report);
  if (report.status === "skipped") return { outcome: "skipped", block: false, lines };
  if (report.status === "error") return { outcome: "error", block: false, lines: [...lines, "Yayın kontrolü tamamlanamadı; yayın devam ediyor."] };
  const critical = report.counts.critical;
  if (!critical) return { outcome: report.counts.warning ? "warned" : "passed", block: false, lines };
  if (mode !== "block") return { outcome: "warned", block: false, lines: [...lines, "Mod \"yalnız uyar\": kritik bulgular yayını durdurmuyor."] };
  if (opts.skip && opts.trigger === "manual") return { outcome: "bypassed", block: false, lines: [...lines, format("Yayın kontrolü bilerek geçildi: {n} kritik bulguya rağmen yayın sürüyor.", { n: critical })] };
  return { outcome: "blocked", block: true, lines };
}

/** Yayın günlüğü için kısa özet: sayılar ve kritik/uyarı bulgularının başlıkları. */
export function summaryLines(report: PreflightReport): string[] {
  if (report.status === "skipped") return report.notes.map((n) => format(n.text, n.vars));
  if (report.status === "error") return [`Yayın kontrolü: ${report.error ?? "tamamlanamadı"}`];
  const { critical, warning, info } = report.counts;
  const head = critical + warning + info ? `Yayın kontrolü: ${critical} kritik, ${warning} uyarı, ${info} bilgi (statik sezgisel kontrol; güvenlik garantisi değildir).` : "Yayın kontrolü: sorun bulunmadı (statik sezgisel kontrol; güvenlik garantisi değildir).";
  const shown = report.findings.filter((f) => f.level !== "info").slice(0, 12);
  const label = { critical: "kritik", warning: "uyarı", info: "bilgi" };
  const lines = [head, ...shown.map((f) => `  [${label[f.level]}] ${format(f.title, f.vars)}${f.file && !f.title.includes("{file}") ? ` (${f.file}${f.line ? `:${f.line}` : ""})` : f.line ? ` (satır ${f.line})` : ""}`)];
  const rest = critical + warning - shown.length;
  if (rest > 0) lines.push(`  ... ve ${rest} bulgu daha (uygulama sayfasında)`);
  return lines;
}

export const BLOCK_MESSAGE = {
  manual: "Yayın kontrolü {n} kritik bulgu buldu; yayın durduruldu, eski sürüm yayında. Bulguları düzelt ya da deploy kaydındaki \"Yine de yayınla\" ile bilerek geç.",
  webhook: "Yayın kontrolü {n} kritik bulgu buldu; otomatik yayın durduruldu, eski sürüm yayında. Bulguları düzeltip yeniden push et ya da uygulama sayfasından \"Yine de yayınla\" ile elle yayınla.",
};
