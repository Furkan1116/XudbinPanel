import { config } from "../config.js";
import { db } from "../db.js";
import { getSettings } from "../lib/settings.js";
import { dockerFor, pullImage, withTimeout } from "./docker.js";
import { getServer } from "./servers.js";
import { notify } from "./notify.js";

/**
 * Uygulama imajlarını Trivy ile bilinen açıklara (CVE) karşı tarar. Tarama, imajın bulunduğu sunucuda
 * kısa ömürlü bir Trivy konteyneriyle yapılır; açık veritabanı bir volume'da önbelleğe alınır.
 */
export type ScanSummary = {
  critical: number;
  high: number;
  fixable: number;
  top: { id: string; pkg: string; installed: string; fixed: string | null; severity: string; title: string }[];
};

type TrivyReport = {
  Results?: {
    Target: string;
    Vulnerabilities?: { VulnerabilityID: string; PkgName: string; InstalledVersion: string; FixedVersion?: string; Severity: string; Title?: string }[];
  }[];
};

export function summarize(report: TrivyReport): ScanSummary {
  const all = (report.Results ?? []).flatMap((r) => r.Vulnerabilities ?? []);
  const seen = new Set<string>();
  const vulns = all.filter((v) => !seen.has(`${v.VulnerabilityID}/${v.PkgName}`) && seen.add(`${v.VulnerabilityID}/${v.PkgName}`));
  const rank = (s: string) => (s === "CRITICAL" ? 0 : 1);
  return {
    critical: vulns.filter((v) => v.Severity === "CRITICAL").length,
    high: vulns.filter((v) => v.Severity === "HIGH").length,
    fixable: vulns.filter((v) => v.FixedVersion).length,
    top: vulns
      .sort((a, b) => rank(a.Severity) - rank(b.Severity) || Number(Boolean(b.FixedVersion)) - Number(Boolean(a.FixedVersion)))
      .slice(0, 15)
      .map((v) => ({ id: v.VulnerabilityID, pkg: v.PkgName, installed: v.InstalledVersion, fixed: v.FixedVersion ?? null, severity: v.Severity, title: (v.Title ?? "").slice(0, 160) })),
  };
}

let chain: Promise<unknown> = Promise.resolve();

/** Taramalar sırayla çalışır (Trivy belleği yoğun kullanır). */
export function scanApp(appId: number) {
  const run = chain.then(() => doScan(appId));
  chain = run.catch(() => {});
  return run;
}

async function doScan(appId: number) {
  const app = db.prepare("SELECT id, name, slug, server_id, current_image, source_type FROM apps WHERE id = ?").get(appId) as
    | { id: number; name: string; slug: string; server_id: number; current_image: string | null; source_type: string }
    | undefined;
  if (!app?.current_image) return;
  db.prepare("UPDATE apps SET scan_status = 'running' WHERE id = ?").run(app.id);
  const docker = dockerFor(getServer(app.server_id));
  const name = `xb-scan-${app.slug}`;
  try {
    await pullImage(docker, config.trivyImage, () => {});
    await docker.getContainer(name).remove({ force: true }).catch(() => {});
    const container = await docker.createContainer({
      name,
      Image: config.trivyImage,
      Cmd: ["image", "--quiet", "--format", "json", "--severity", "HIGH,CRITICAL", "--scanners", "vuln", "--timeout", "15m", app.current_image],
      Tty: true,
      Labels: { "xudbin.managed": "true", "xudbin.task": "image-scan" },
      HostConfig: {
        Binds: ["/var/run/docker.sock:/var/run/docker.sock:ro", "xudbin-trivy-cache:/root/.cache"],
        Memory: 1536 * 1024 * 1024,
        AutoRemove: false,
      },
    });
    await container.start();
    const res = (await withTimeout(container.wait(), 20 * 60_000, "Tarama 20 dakikada bitmedi")) as { StatusCode: number };
    const out = (await container.logs({ stdout: true, stderr: true })).toString("utf8");
    await container.remove({ force: true }).catch(() => {});
    const json = out.slice(out.indexOf("{"));
    if (res.StatusCode !== 0 || !json.startsWith("{")) throw new Error(out.trim().split("\n").pop() || `Trivy ${res.StatusCode} koduyla çıktı`);
    const summary = summarize(JSON.parse(json) as TrivyReport);
    db.prepare("UPDATE apps SET scan_status = 'success', scan_summary = ?, scanned_at = ? WHERE id = ?").run(JSON.stringify(summary), Date.now(), app.id);
    if (summary.critical > 0) notify("vulnerability", `${app.name}: ${summary.critical} kritik güvenlik açığı`, `İmajda ${summary.critical} kritik, ${summary.high} yüksek seviye açık var; ${summary.fixable} tanesi güncellemeyle kapanıyor.`);
    return summary;
  } catch (e) {
    db.prepare("UPDATE apps SET scan_status = 'failed', scan_summary = ?, scanned_at = ? WHERE id = ?").run(JSON.stringify({ error: (e as Error).message }), Date.now(), app.id);
    await docker.getContainer(name).remove({ force: true }).catch(() => {});
    throw e;
  }
}

export const imageScanEnabled = () => getSettings().imageScanEnabled;
