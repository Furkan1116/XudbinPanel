import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { config } from "../../config.js";
import { decrypt, randomAlnum } from "../../lib/crypto.js";
import { removeEscapingSymlinks, resolveInside } from "../../lib/paths.js";
import { composeHostAccessIssues } from "../compose-policy.js";
import { effectiveEnv, shallowClone, type AppRow } from "../deploy.js";
import { appTokenAllowed, gitTokenFor } from "../github-app.js";
import { extractZip, latestAppUpload } from "../uploads.js";
import { contextFor, preflightMode, saveAppReport, uploadTime } from "./gate.js";
import { runPreflight, skippedReport, withComposePolicy, type PreflightReport } from "./index.js";

/**
 * "Kontrol et" düğmesi: yayınlamadan kaynağı geçici bir klasöre alır (git: son commit, yükleme: son zip), kontrol eder
 * ve uygulamanın son raporu olarak saklar. Aynı uygulama için aynı anda tek kontrol çalışır.
 */

export class PreflightCheckError extends Error {}

const running = new Set<number>();

/** Sığ klonun HEAD commit'i (git çalıştırmadan .git'ten okunur). */
export function headCommit(repo: string): string | null {
  try {
    const head = fs.readFileSync(path.join(repo, ".git", "HEAD"), "utf8").trim();
    if (/^[0-9a-f]{40}$/.test(head)) return head.slice(0, 7);
    const ref = head.match(/^ref: (refs\/[\w./-]+)$/)?.[1];
    if (!ref) return null;
    const loose = resolveInside(path.join(repo, ".git"), ref);
    const sha = loose && fs.existsSync(loose) ? fs.readFileSync(loose, "utf8").trim() : (fs.readFileSync(path.join(repo, ".git", "packed-refs"), "utf8").match(new RegExp(`^([0-9a-f]{40}) ${ref.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}$`, "m"))?.[1] ?? "");
    return /^[0-9a-f]{40}$/.test(sha) ? sha.slice(0, 7) : null;
  } catch {
    return null;
  }
}

/** Panelde yazılı ya da depodaki compose dosyasının katı (statik) politika ön denetimi. */
function staticPolicy(app: AppRow, repo: string | null): string[] | null {
  if (app.host_access) return null;
  let text = app.compose_file ?? "";
  if (repo) {
    const file = resolveInside(repo, app.dockerfile_path || "docker-compose.yml");
    text = file && fs.existsSync(file) && fs.statSync(file).size < 1024 * 1024 ? fs.readFileSync(file, "utf8") : "";
  }
  try {
    return composeHostAccessIssues(YAML.parse(text) ?? {});
  } catch {
    return ["Compose dosyası okunamadı"];
  }
}

async function fetchSource(app: AppRow, dest: string): Promise<{ root: string; commit?: string | null; uploadedAt?: number | null }> {
  if (app.source_type === "upload") {
    const zip = latestAppUpload(app.slug);
    if (!zip) throw new PreflightCheckError("Yüklenmiş dosya yok; önce proje dosyalarını yükle.");
    return { root: await extractZip(zip, dest), uploadedAt: uploadTime(zip) };
  }
  if (!app.git_url) throw new PreflightCheckError("Git adresi tanımlı değil.");
  const token = await gitTokenFor(app.git_url, decrypt(app.git_token), appTokenAllowed(app));
  try {
    await shallowClone(app.git_url, app.git_branch, token, dest);
  } catch (err) {
    throw new PreflightCheckError((err as Error).message.startsWith("Repo klonlanamadı") ? (err as Error).message : "Repo klonlanamadı. Adres, dal ve erişim token'ını kontrol et.");
  }
  removeEscapingSymlinks(dest);
  return { root: dest, commit: headCommit(dest) };
}

export async function checkAppNow(app: AppRow): Promise<PreflightReport> {
  if (running.has(app.id)) throw new PreflightCheckError("Bu uygulama için bir kontrol zaten sürüyor.");
  running.add(app.id);
  const dest = path.join(config.dataDir, "builds", `preflight-${randomAlnum(10)}`);
  try {
    let report: PreflightReport;
    if (app.source_type === "image") report = skippedReport({ sourceType: "image" }, "İmaj kaynağında kaynak dosya yok; yayın kontrolü atlandı.");
    else if (app.source_type === "compose" && !app.git_url) report = withComposePolicy(runPreflight(null, contextFor(app)), staticPolicy(app, null), { strict: true });
    else {
      const src = await fetchSource(app, dest);
      const checked = runPreflight(src.root, contextFor(app, effectiveEnv(app).DJANGO_SETTINGS_MODULE));
      report = { ...checked, source: { ...checked.source, commit: src.commit, uploadedAt: src.uploadedAt } };
      if (app.source_type === "compose") report = withComposePolicy(report, staticPolicy(app, src.root), { strict: true });
    }
    report = { ...report, mode: preflightMode(app) };
    saveAppReport(app.id, report);
    return report;
  } finally {
    running.delete(app.id);
    fs.rmSync(dest, { recursive: true, force: true });
  }
}
