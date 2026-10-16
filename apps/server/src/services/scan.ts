import { config } from "../config.js";
import { db } from "../db.js";
import { getSettings } from "../lib/settings.js";
import { dockerFor, pullImage, withTimeout } from "./docker.js";
import { getServer } from "./servers.js";
import { notify } from "./notify.js";

/**
 * Uygulama imajlarını Trivy ile bilinen açıklara (CVE) karşı tarar. Tarama, imajın bulunduğu sunucuda
 * kısa ömürlü bir Trivy konteyneriyle yapılır; açık veritabanı bir volume'da önbelleğe alınır.
 *
 * Ham rapor, uzman olmayan birinin "ne yapmalıyım?" sorusunu cevaplayabileceği biçime getirilir:
 * açıklar paket bazında toplanır ve kapanma yoluna göre üç gruba ayrılır (temel imaj güncellemesi,
 * uygulama bağımlılığı güncellemesi, henüz düzeltmesi olmayanlar).
 */
export type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN";
export type SeverityCounts = { critical: number; high: number; medium: number; low: number; unknown: number };

export type ScanCve = { id: string; severity: Severity; title: string; url: string; score: number | null; description: string };
export type ScanPackage = {
  name: string;
  ecosystem: string;
  source: "base" | "app";
  installed: string;
  fixed: string | null;
  maxSeverity: Severity;
  /** Bu paketteki tekil açık sayısı (cves listesi kısaltılmış olabilir). */
  cveCount: number;
  cves: ScanCve[];
};
export type ScanAppGroup = { ecosystem: string; command: string | null; counts: SeverityCounts; packages: ScanPackage[] };

export type ScanSummary = {
  v: 2;
  status: "temiz" | "dikkat" | "acil";
  /** Tekil CVE sayıları (bir CVE birden çok pakette olsa da bir kez sayılır, en yüksek önemiyle). */
  counts: SeverityCounts;
  os: { family: string; name: string; eosl: boolean } | null;
  /** Grup bazında tekil CVE sayıları. */
  groups: { base: SeverityCounts; app: SeverityCounts; noFix: SeverityCounts };
  baseFix: ScanPackage[];
  appFix: ScanAppGroup[];
  noFix: ScanPackage[];
  truncated: boolean;
  // Eski biçimle ve bildirimlerle uyum için: kritik/yüksek sayıları ve bunlardan düzeltmesi olanlar.
  critical: number;
  high: number;
  fixable: number;
};

type TrivyVuln = {
  VulnerabilityID: string;
  PkgName: string;
  PkgPath?: string;
  InstalledVersion: string;
  FixedVersion?: string;
  Status?: string;
  Severity: string;
  Title?: string;
  Description?: string;
  PrimaryURL?: string;
  CVSS?: Record<string, { V3Score?: number; V2Score?: number } | undefined>;
};
export type TrivyReport = {
  Metadata?: { OS?: { Family?: string; Name?: string; EOSL?: boolean } };
  Results?: { Target: string; Class?: string; Type?: string; Vulnerabilities?: TrivyVuln[] | null }[] | null;
};

const SEVERITIES: Severity[] = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "UNKNOWN"];
const sevRank = (s: Severity) => SEVERITIES.indexOf(s);
const toSeverity = (s: string): Severity => (SEVERITIES.includes(s as Severity) ? (s as Severity) : "UNKNOWN");
const sevKey = (s: Severity) => s.toLowerCase() as keyof SeverityCounts;
const emptyCounts = (): SeverityCounts => ({ critical: 0, high: 0, medium: 0, low: 0, unknown: 0 });

const MAX_PACKAGES = 200;
const MAX_CVES_PER_PACKAGE = 20;
const NO_FIX_STATUSES = new Set(["will_not_fix", "fix_deferred", "end_of_life", "under_investigation", "unknown"]);

/** Temel imajla birlikte gelen dil araçları (npm, yarn, pip...): uygulamanın değil, imajın parçası. */
const BASE_TOOLING = /^\/?(usr\/local\/lib\/node_modules\/(npm|corepack|yarn)\/|usr\/(local\/)?lib\/python3[^/]*\/(site|dist)-packages\/(pip|setuptools|wheel)[-_/.]|opt\/yarn)/;
export const isBaseToolingPath = (p: string | undefined) => Boolean(p && BASE_TOOLING.test(p));

const ECOSYSTEMS: Record<string, string> = {
  npm: "npm", yarn: "npm", pnpm: "npm", bun: "npm", "node-pkg": "npm",
  pip: "pip", pipenv: "pip", poetry: "pip", uv: "pip", "python-pkg": "pip",
  composer: "composer", "composer-vendor": "composer",
  gomod: "go", gobinary: "go",
  bundler: "gem", gemspec: "gem",
  cargo: "cargo", "rust-binary": "cargo",
  jar: "maven", pom: "maven", gradle: "maven", sbt: "maven",
  nuget: "nuget", "dotnet-core": "nuget", "packages-props": "nuget",
};

/** Sürüm karşılaştırması: sayısal parçalar sayı olarak, diğerleri metin olarak karşılaştırılır. */
export function compareVersions(a: string, b: string) {
  const parts = (v: string) => v.replace(/^v(?=\d)/i, "").match(/\d+|[a-z]+/gi) ?? [];
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i];
    const y = pb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) {
      const d = Number(x) - Number(y);
      if (d) return d < 0 ? -1 : 1;
    } else if (nx !== ny) return nx ? 1 : -1;
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** "1.2.5, 2.0.1" gibi listeden kurulu sürümden büyük-eşit olan en küçüğü (yoksa en büyüğü). */
export function pickFixedVersion(fixed: string, installed: string) {
  const list = fixed.split(",").map((s) => s.trim()).filter(Boolean).sort(compareVersions);
  return list.find((v) => compareVersions(v, installed) >= 0) ?? list[list.length - 1] ?? null;
}

const maxVersion = (a: string | null, b: string | null) => (!a ? b : !b ? a : compareVersions(a, b) >= 0 ? a : b);

function command(ecosystem: string, pkgs: ScanPackage[]) {
  const fix = pkgs.filter((p) => p.fixed && p.name !== "stdlib");
  if (!fix.length) return null;
  const quote = (s: string) => (/^[\w@./:+=~-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`);
  switch (ecosystem) {
    case "npm":
      return `npm install ${fix.map((p) => quote(`${p.name}@${p.fixed}`)).join(" ")}`;
    case "pip":
      return `pip install -U ${fix.map((p) => `'${p.name}>=${p.fixed}'`).join(" ")}`;
    case "composer":
      return `composer update ${fix.map((p) => quote(p.name)).join(" ")} --with-dependencies`;
    case "go":
      return `go get ${fix.map((p) => quote(`${p.name}@${p.fixed!.startsWith("v") ? p.fixed : `v${p.fixed}`}`)).join(" ")}`;
    case "gem":
      return `bundle update ${fix.map((p) => quote(p.name)).join(" ")}`;
    case "cargo":
      return fix.map((p) => `cargo update -p ${quote(p.name)} --precise ${quote(p.fixed!)}`).join(" && ");
    default:
      return null;
  }
}

type Acc = ScanPackage & { cveMap: Map<string, ScanCve> };

/** Trivy JSON raporunu arayüzün doğrudan gösterebileceği, sınırlı boyutlu özete çevirir. */
export function summarize(report: TrivyReport): ScanSummary {
  const osMeta = report.Metadata?.OS;
  const os = osMeta?.Family ? { family: osMeta.Family, name: osMeta.Name ?? "", eosl: Boolean(osMeta.EOSL) } : null;
  const groups = { base: new Map<string, Acc>(), app: new Map<string, Acc>(), noFix: new Map<string, Acc>() };
  const cveSeverity = new Map<string, Severity>();
  const groupCves = { base: new Map<string, Severity>(), app: new Map<string, Severity>(), noFix: new Map<string, Severity>() };
  const fixableIds = new Set<string>();

  for (const result of report.Results ?? []) {
    const isOs = result.Class === "os-pkgs";
    const type = result.Type ?? "";
    for (const v of result.Vulnerabilities ?? []) {
      const status = (v.Status ?? "").toLowerCase();
      if (status === "not_affected") continue;
      const source: "base" | "app" = isOs || isBaseToolingPath(v.PkgPath) ? "base" : "app";
      const ecosystem = isOs ? (os?.family ?? type ?? "os") : (ECOSYSTEMS[type] ?? (type || "diğer"));
      const fixedRaw = v.FixedVersion?.trim();
      const hasFix = Boolean(fixedRaw) && !NO_FIX_STATUSES.has(status);
      const group = !hasFix ? "noFix" : source === "base" ? "base" : "app";
      const severity = toSeverity(v.Severity);
      const id = v.VulnerabilityID;

      const prev = cveSeverity.get(id);
      if (!prev || sevRank(severity) < sevRank(prev)) cveSeverity.set(id, severity);
      const gPrev = groupCves[group].get(id);
      if (!gPrev || sevRank(severity) < sevRank(gPrev)) groupCves[group].set(id, severity);
      if (hasFix) fixableIds.add(id);

      const key = `${source}/${ecosystem}/${v.PkgName}`;
      let pkg = groups[group].get(key);
      if (!pkg) {
        pkg = { name: v.PkgName, ecosystem, source, installed: v.InstalledVersion, fixed: null, maxSeverity: severity, cveCount: 0, cves: [], cveMap: new Map() };
        groups[group].set(key, pkg);
      } else if (compareVersions(v.InstalledVersion, pkg.installed) < 0) pkg.installed = v.InstalledVersion;
      if (hasFix) pkg.fixed = maxVersion(pkg.fixed, pickFixedVersion(fixedRaw!, v.InstalledVersion));
      if (sevRank(severity) < sevRank(pkg.maxSeverity)) pkg.maxSeverity = severity;
      if (pkg.cveMap.has(id)) continue; // Aynı (CVE, paket, kaynak) yalnızca bir kez.
      const scores = Object.values(v.CVSS ?? {}).map((c) => c?.V3Score ?? c?.V2Score).filter((n): n is number => typeof n === "number");
      const nvd = v.CVSS?.nvd?.V3Score;
      const description = (v.Description ?? "").replace(/\s+/g, " ").trim();
      pkg.cveMap.set(id, {
        id,
        severity,
        title: (v.Title ?? "").slice(0, 160),
        url: v.PrimaryURL || `https://avd.aquasec.com/nvd/${id.toLowerCase()}`,
        score: nvd ?? (scores.length ? Math.max(...scores) : null),
        description: description.length > 200 ? `${description.slice(0, 197).trimEnd()}...` : description,
      });
    }
  }

  const count = (m: Map<string, Severity>) => {
    const c = emptyCounts();
    for (const s of m.values()) c[sevKey(s)]++;
    return c;
  };
  const byImpact = (a: ScanPackage, b: ScanPackage) => sevRank(a.maxSeverity) - sevRank(b.maxSeverity) || b.cveCount - a.cveCount || a.name.localeCompare(b.name);
  const finish = (m: Map<string, Acc>): ScanPackage[] =>
    [...m.values()]
      .map(({ cveMap, ...p }) => {
        const cves = [...cveMap.values()].sort((a, b) => sevRank(a.severity) - sevRank(b.severity) || (b.score ?? 0) - (a.score ?? 0));
        return { ...p, cveCount: cves.length, cves: cves.slice(0, MAX_CVES_PER_PACKAGE) };
      })
      .sort(byImpact);

  // Toplam paket sayısı sınırı: önce en önemlileri tutulur.
  let baseFix = finish(groups.base);
  let appPkgs = finish(groups.app);
  let noFix = finish(groups.noFix);
  const all = [...baseFix, ...appPkgs, ...noFix].sort(byImpact);
  const truncated = all.length > MAX_PACKAGES || all.some((p) => p.cveCount > p.cves.length);
  if (all.length > MAX_PACKAGES) {
    const keep = new Set(all.slice(0, MAX_PACKAGES));
    baseFix = baseFix.filter((p) => keep.has(p));
    appPkgs = appPkgs.filter((p) => keep.has(p));
    noFix = noFix.filter((p) => keep.has(p));
  }

  const appFix: ScanAppGroup[] = [...new Set(appPkgs.map((p) => p.ecosystem))]
    .map((ecosystem) => {
      const packages = appPkgs.filter((p) => p.ecosystem === ecosystem);
      const counts = emptyCounts();
      const seen = new Set<string>();
      for (const p of packages) for (const c of p.cves) if (!seen.has(c.id) && seen.add(c.id)) counts[sevKey(c.severity)]++;
      return { ecosystem, command: command(ecosystem, packages), counts, packages };
    })
    .sort((a, b) => b.counts.critical - a.counts.critical || b.counts.high - a.counts.high || b.packages.length - a.packages.length);

  const counts = count(cveSeverity);
  const serious = [...cveSeverity].filter(([, s]) => s === "CRITICAL" || s === "HIGH");
  return {
    v: 2,
    status: counts.critical > 0 ? "acil" : counts.high > 0 || os?.eosl ? "dikkat" : "temiz",
    counts,
    os,
    groups: { base: count(groupCves.base), app: count(groupCves.app), noFix: count(groupCves.noFix) },
    baseFix,
    appFix,
    noFix,
    truncated,
    critical: counts.critical,
    high: counts.high,
    fixable: serious.filter(([id]) => fixableIds.has(id)).length,
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
      Cmd: ["image", "--quiet", "--format", "json", "--scanners", "vuln", "--timeout", "15m", app.current_image],
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
    // docker-modem, çıktı JSON olunca gövdeyi kendisi ayrıştırıp nesne döndürür.
    const raw = (await container.logs({ stdout: true, stderr: true })) as unknown;
    await container.remove({ force: true }).catch(() => {});
    let report: TrivyReport;
    if (Buffer.isBuffer(raw) || typeof raw === "string") {
      const out = raw.toString();
      const json = out.slice(out.indexOf("{"));
      if (res.StatusCode !== 0 || !json.startsWith("{")) throw new Error(out.trim().split("\n").pop() || `Trivy ${res.StatusCode} koduyla çıktı`);
      report = JSON.parse(json) as TrivyReport;
    } else {
      if (res.StatusCode !== 0) throw new Error(`Trivy ${res.StatusCode} koduyla çıktı`);
      report = raw as TrivyReport;
    }
    const summary = summarize(report);
    db.prepare("UPDATE apps SET scan_status = 'success', scan_summary = ?, scanned_at = ? WHERE id = ?").run(JSON.stringify(summary), Date.now(), app.id);
    if (summary.critical > 0) notify("vulnerability", `${app.name}: ${summary.critical} kritik güvenlik açığı`, `İmajda ${summary.critical} kritik, ${summary.high} yüksek seviye açık var; ${summary.fixable} tanesi güncellemeyle kapanıyor.`);
    return summary;
  } catch (e) {
    const message = e instanceof Error ? e.message : typeof e === "object" ? JSON.stringify(e) : String(e);
    db.prepare("UPDATE apps SET scan_status = 'failed', scan_summary = ?, scanned_at = ? WHERE id = ?").run(JSON.stringify({ error: message }), Date.now(), app.id);
    await docker.getContainer(name).remove({ force: true }).catch(() => {});
    throw e;
  }
}

export const imageScanEnabled = () => getSettings().imageScanEnabled;
