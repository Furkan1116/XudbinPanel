import { ChevronDown, ChevronRight, ExternalLink, ShieldCheck } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Button, CopyButton, useAction } from "@/components/ui";
import { api, type App } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import { t } from "@/lib/i18n";

/* Sunucudaki services/scan.ts özetinin (v: 2) biçimi. */
type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN";
type Counts = { critical: number; high: number; medium: number; low: number; unknown: number };
type Cve = { id: string; severity: Severity; title: string; url: string; score: number | null; description: string };
type Pkg = { name: string; ecosystem: string; source: "base" | "app"; installed: string; fixed: string | null; maxSeverity: Severity; cveCount: number; cves: Cve[] };
type AppGroup = { ecosystem: string; command: string | null; counts: Counts; packages: Pkg[] };
type ScanV2 = {
  v: 2;
  status: "temiz" | "dikkat" | "acil";
  counts: Counts;
  os: { family: string; name: string; eosl: boolean } | null;
  groups: { base: Counts; app: Counts; noFix: Counts };
  baseFix: Pkg[];
  appFix: AppGroup[];
  noFix: Pkg[];
  truncated: boolean;
};
type Legacy = { critical: number; high: number; fixable: number };

const SEV_LABEL: Record<Severity, () => string> = {
  CRITICAL: () => t("Kritik"),
  HIGH: () => t("Yüksek"),
  MEDIUM: () => t("Orta"),
  LOW: () => t("Düşük"),
  UNKNOWN: () => t("Bilinmiyor"),
};
const SEV_ADVICE: Record<Severity, () => string> = {
  CRITICAL: () => t("bugün düzelt"),
  HIGH: () => t("bu hafta düzelt"),
  MEDIUM: () => t("fırsat buldukça düzelt"),
  LOW: () => t("takip etmen yeterli"),
  UNKNOWN: () => t("takip etmen yeterli"),
};
const SEV_CLASS: Record<Severity, string> = {
  CRITICAL: "bg-accent/15 text-accent",
  HIGH: "bg-warn/15 text-warn",
  MEDIUM: "bg-surface-2 text-fg",
  LOW: "bg-surface-2 text-faint",
  UNKNOWN: "bg-surface-2 text-faint",
};
const ECOSYSTEM_LABEL: Record<string, string> = {
  npm: "Node.js (npm)",
  pip: "Python (pip)",
  composer: "PHP (Composer)",
  go: "Go",
  gem: "Ruby (Bundler)",
  cargo: "Rust (Cargo)",
  maven: "Java (Maven)",
  nuget: ".NET (NuGet)",
};
const ecoLabel = (e: string) => ECOSYSTEM_LABEL[e] ?? e;
const isLow = (s: Severity) => s === "LOW" || s === "UNKNOWN";
const serious = (c: Counts) => c.critical + c.high;
const total = (c: Counts) => c.critical + c.high + c.medium + c.low + c.unknown;
// Başlık özetle tutarlı olsun: ciddi (kritik + yüksek) açıklar ayrıca belirtilir.
const closesTitle = (action: string, c: Counts) => {
  const serious = c.critical + c.high;
  return serious ? t("{action}: {s} ciddi açık kapanır (toplam {n})", { action, s: serious, n: total(c) }) : t("{action}: {n} açık kapanır", { action, n: total(c) });
};
const impact = (c: Counts) => c.critical * 1000 + c.high * 100 + c.medium * 10 + c.low;
const osLabel = (os: ScanV2["os"]) => (os ? `${os.family.charAt(0).toUpperCase()}${os.family.slice(1)} ${os.name}`.trim() : "");

function SeverityBadge({ severity }: { severity: Severity }) {
  return (
    <span title={`${SEV_LABEL[severity]()}: ${SEV_ADVICE[severity]()}`} className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[12px] ${SEV_CLASS[severity]}`}>
      {SEV_LABEL[severity]()}
    </span>
  );
}

function StatusChip({ status }: { status: ScanV2["status"] }) {
  const map = {
    temiz: { cls: "bg-ok/15 text-ok", label: t("Temiz") },
    dikkat: { cls: "bg-warn/15 text-warn", label: t("Dikkat") },
    acil: { cls: "bg-accent/15 text-accent", label: t("Acil") },
  }[status];
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[12px] font-medium ${map.cls}`}>{map.label}</span>;
}

/** Kurallarla kurulan tek cümlelik, sade özet. */
function summarySentence(s: ScanV2) {
  const { critical: c, high: h, medium: m } = s.counts;
  const parts: string[] = [];
  if (c || h) {
    parts.push(
      c && h ? t("{c} kritik ve {h} yüksek önemli açık var.", { c, h }) : c ? t("{c} kritik açık var.", { c }) : t("{h} yüksek önemli açık var.", { h }),
    );
    const b = serious(s.groups.base);
    const a = s.appFix.reduce((n, g) => n + serious(g.counts), 0);
    const appPkgs = s.appFix.flatMap((g) => g.packages).filter((p) => p.maxSeverity === "CRITICAL" || p.maxSeverity === "HIGH");
    const one = appPkgs.length === 1 ? appPkgs[0]!.name : null;
    if (b && a)
      parts.push(
        one
          ? t("{b} tanesi temel imajı, {a} tanesi {pkg} paketini güncelleyerek kapanıyor.", { b, a, pkg: one })
          : t("{b} tanesi temel imajı, {a} tanesi uygulama bağımlılıklarını güncelleyerek kapanıyor.", { b, a }),
      );
    else if (b) parts.push(t("{b} tanesi temel imajı güncelleyerek kapanıyor.", { b }));
    else if (a)
      parts.push(
        one ? t("{a} tanesi {pkg} paketini güncelleyerek kapanıyor.", { a, pkg: one }) : t("{a} tanesi uygulama bağımlılıklarını güncelleyerek kapanıyor.", { a }),
      );
    const rest = serious(s.groups.noFix);
    if (!b && !a) parts.push(t("Henüz hiçbiri için düzeltme yayımlanmamış."));
    else if (rest) parts.push(t("{n} tanesinin henüz düzeltmesi yok.", { n: rest }));
  } else parts.push(m ? t("Ciddi bir açık yok; {m} orta önemli açık var.", { m }) : t("Ciddi bir açık yok."));
  if (s.os?.eosl) parts.push(t("İşletim sistemi sürümü artık güvenlik güncellemesi almıyor."));
  return parts.join(" ");
}

/** Temel imajdaki paketleri Dockerfile'da güncellemek için önerilen satırlar. */
function baseUpgradeLines(s: ScanV2) {
  const lines: string[] = [];
  const family = s.os?.family.toLowerCase() ?? "";
  if (s.baseFix.some((p) => s.os && p.ecosystem === s.os.family)) {
    if (family === "debian" || family === "ubuntu") lines.push("RUN apt-get update && apt-get upgrade -y && rm -rf /var/lib/apt/lists/*");
    else if (family === "alpine" || family === "wolfi" || family === "chainguard") lines.push("RUN apk upgrade --no-cache");
    else if (["redhat", "rocky", "alma", "fedora", "centos", "oracle", "amazon"].includes(family)) lines.push("RUN (dnf -y upgrade || yum -y update)");
  }
  if (s.baseFix.some((p) => p.ecosystem === "npm")) lines.push("RUN npm install -g npm@latest");
  if (s.baseFix.some((p) => p.ecosystem === "pip")) lines.push("RUN pip install --no-cache-dir -U pip setuptools wheel");
  return lines;
}

/** Kopyalanabilir, satır kaydıran komut kutusu. */
function Code({ value }: { value: string }) {
  return (
    <div className="flex items-start gap-1 rounded-md border border-line bg-surface-2 py-1 pr-1 pl-3">
      <pre className="min-w-0 flex-1 py-1 font-mono text-[12px] break-all whitespace-pre-wrap text-fg">{value}</pre>
      <CopyButton value={value} label={t("Kopyala")} />
    </div>
  );
}

function ActionBlock({ tone, title, children }: { tone: "danger" | "warn" | "info"; title: string; children: ReactNode }) {
  const border = { warn: "border-l-warn", danger: "border-l-accent", info: "border-l-line-strong" }[tone];
  return (
    <div className={`rounded-md border border-line border-l-[3px] px-4 py-3 ${border}`}>
      <div className="text-[14px] font-medium">{title}</div>
      <div className="mt-1 space-y-2 text-[13px] leading-relaxed text-muted">{children}</div>
    </div>
  );
}

function pkgLine(p: Pkg) {
  return t("{n} açık, en yüksek: {sev}", { n: p.cveCount, sev: SEV_LABEL[p.maxSeverity]() });
}

function Actions({ s }: { s: ScanV2 }) {
  const blocks: { score: number; node: ReactNode }[] = [];
  if (s.os?.eosl)
    blocks.push({
      score: Infinity,
      node: (
        <ActionBlock key="eol" tone="danger" title={t("İşletim sistemi sürümü desteğin dışında")}>
          <p>
            {t("{os} artık güvenlik güncellemesi almıyor; yeni bulunan açıklar kapatılmayacak. Dockerfile'daki FROM satırında daha yeni bir sürüme dayanan temel imaja geç.", {
              os: osLabel(s.os),
            })}
          </p>
        </ActionBlock>
      ),
    });
  if (s.baseFix.length && impact(s.groups.base) >= 10) {
    const lines = baseUpgradeLines(s);
    const names = s.baseFix.slice(0, 4).map((p) => p.name);
    blocks.push({
      score: impact(s.groups.base),
      node: (
        <ActionBlock key="base" tone={s.groups.base.critical ? "danger" : s.groups.base.high ? "warn" : "info"} title={closesTitle(t("Temel imajı güncelle"), s.groups.base)}>
          <p>
            {t("Bu açıklar senin kodunda değil; imajın üzerine kurulduğu işletim sistemi paketlerinde ve hazır gelen araçlarda (npm, pip gibi). Temel imajın güncel sürümünü çekip yeniden deploy et; sunucu eski kopyayı önbellekte tutuyorsa önce o imajı yeniden çek (docker pull).")}
          </p>
          <p>
            {t("Etkilenen paketler")}: <span className="font-mono text-fg">{names.join(", ")}</span>
            {s.baseFix.length > names.length && ` ${t("ve {n} paket daha", { n: s.baseFix.length - names.length })}`}
          </p>
          {lines.length > 0 && (
            <>
              <p>{t("Öneri: Dockerfile'da FROM satırından hemen sonra şunu ekleyerek paketleri derleme sırasında güncelleyebilirsin:")}</p>
              <Code value={lines.join("\n")} />
            </>
          )}
        </ActionBlock>
      ),
    });
  }
  for (const g of s.appFix) {
    if (impact(g.counts) < 10) continue;
    const shown = g.packages.slice(0, 6);
    blocks.push({
      score: impact(g.counts),
      node: (
        <ActionBlock
          key={`app-${g.ecosystem}`}
          tone={g.counts.critical ? "danger" : g.counts.high ? "warn" : "info"}
          title={closesTitle(t("{eco} bağımlılıklarını güncelle", { eco: ecoLabel(g.ecosystem) }), g.counts)}
        >
          <p>{t("Bu paketler uygulamanın kendi bağımlılıkları. Sürümlerini yükselt, uygulamanın çalıştığını kontrol et ve yeniden deploy et.")}</p>
          <ul className="space-y-0.5">
            {shown.map((p) => (
              <li key={p.name}>
                <span className="font-mono text-fg">
                  {p.name} {p.installed} → {p.fixed}
                </span>{" "}
                ({pkgLine(p)})
              </li>
            ))}
            {g.packages.length > shown.length && <li>{t("ve {n} paket daha", { n: g.packages.length - shown.length })}</li>}
          </ul>
          {g.command && (
            <>
              <p>{t("Proje klasöründe çalıştır:")}</p>
              <Code value={g.command} />
            </>
          )}
        </ActionBlock>
      ),
    });
  }
  const top = blocks.sort((a, b) => b.score - a.score).slice(0, 3);
  return (
    <div className="mt-4">
      <h4 className="text-[14px] font-medium">{t("Ne yapmalısın?")}</h4>
      {top.length ? (
        <div className="mt-2 space-y-2">{top.map((b) => b.node)}</div>
      ) : (
        <p className="mt-1 text-[13px] text-muted">
          {serious(s.counts)
            ? t("Ciddi açıkların henüz düzeltmesi yayımlanmamış; temel imaj ve paketler güncellendikçe yeniden tara.")
            : t("Şu an yapman gereken bir şey yok.")}
        </p>
      )}
    </div>
  );
}

function PackageRow({ p, noFix }: { p: Pkg; noFix: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <li>
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-left hover:bg-surface-2">
        {open ? <ChevronDown className="size-3.5 shrink-0 text-faint" /> : <ChevronRight className="size-3.5 shrink-0 text-faint" />}
        <span className="font-mono text-fg">{p.name}</span>
        <span className="rounded-full border border-line px-2 py-0.5 text-[11px] text-muted">{p.source === "base" ? t("Temel imaj") : t("Uygulama")}</span>
        <span className="font-mono text-muted">
          {p.installed} {noFix || !p.fixed ? <span className="font-sans text-faint">· {t("düzeltme yok")}</span> : `→ ${p.fixed}`}
        </span>
        <span className="ml-auto flex items-center gap-2">
          <span className="text-muted">{t("{n} açık", { n: p.cveCount })}</span>
          <SeverityBadge severity={p.maxSeverity} />
        </span>
      </button>
      {open && (
        <ul className="space-y-2 border-t border-line bg-surface-2/50 px-4 py-2 pl-9">
          {p.cves.map((c) => (
            <li key={c.id}>
              <div className="flex flex-wrap items-center gap-2">
                <a href={c.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-mono text-accent hover:underline">
                  {c.id} <ExternalLink className="size-3" />
                </a>
                <SeverityBadge severity={c.severity} />
                {c.score != null && <span className="text-faint">CVSS {c.score.toFixed(1)}</span>}
              </div>
              {c.title && <div className="text-fg">{c.title}</div>}
              {c.description && c.description !== c.title && <div className="text-faint">{c.description}</div>}
            </li>
          ))}
          {p.cveCount > p.cves.length && <li className="text-faint">{t("ve {n} açık daha", { n: p.cveCount - p.cves.length })}</li>}
        </ul>
      )}
    </li>
  );
}

function Details({ s }: { s: ScanV2 }) {
  const [open, setOpen] = useState(false);
  const [showLow, setShowLow] = useState(false);
  const [showNoFix, setShowNoFix] = useState(false);
  const entries = [
    ...[...s.baseFix, ...s.appFix.flatMap((g) => g.packages)].map((p) => ({ p, noFix: false })),
    ...s.noFix.map((p) => ({ p, noFix: true })),
  ];
  if (!entries.length) return null;
  const lowCount = entries.filter((e) => isLow(e.p.maxSeverity) && (showNoFix || !e.noFix)).length;
  const noFixCount = entries.filter((e) => e.noFix && (showLow || !isLow(e.p.maxSeverity))).length;
  const visible = entries.filter((e) => (showLow || !isLow(e.p.maxSeverity)) && (showNoFix || !e.noFix));
  const toggle = (on: boolean, set: (v: boolean) => void, label: string) => (
    <label className="inline-flex cursor-pointer items-center gap-1.5">
      <input type="checkbox" checked={on} onChange={(e) => set(e.target.checked)} className="accent-[var(--accent)]" />
      {label}
    </label>
  );

  return (
    <div className="mt-4">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="inline-flex items-center gap-1 text-[13px] font-medium text-muted hover:text-fg">
        {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        {t("Ayrıntılar")} <span className="font-normal text-faint">({t("{n} paket", { n: entries.length })})</span>
      </button>
      {open && (
        <>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-muted">
            {(showLow || lowCount > 0) && toggle(showLow, setShowLow, t("Düşük önemlileri göster ({n})", { n: lowCount }))}
            {(showNoFix || noFixCount > 0) && toggle(showNoFix, setShowNoFix, t("Düzeltmesi olmayanları göster ({n})", { n: noFixCount }))}
          </div>
          {visible.length ? (
            <ul className="mt-2 divide-y divide-line rounded-md border border-line text-[13px]">
              {visible.map((e) => (
                <PackageRow key={`${e.noFix ? "nf" : "fx"}/${e.p.source}/${e.p.ecosystem}/${e.p.name}`} p={e.p} noFix={e.noFix} />
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-[13px] text-faint">{t("Gösterilecek paket yok; gizlenenleri yukarıdan açabilirsin.")}</p>
          )}
          {s.truncated && <p className="mt-2 text-[12px] text-faint">{t("Liste uzun olduğu için en önemli paketler ve açıklar gösteriliyor.")}</p>}
        </>
      )}
    </div>
  );
}

/** Son imajın Trivy taraması: durum, sade özet, ne yapılacağı ve paket ayrıntıları. */
export function ImageScan({ app }: { app: App }) {
  const scan = useAction(() => api.post(`/apps/${app.id}/scan`), { success: t("Tarama başladı"), invalidate: [["app", app.id]] });
  if (app.sourceType === "compose" || !app.currentImage) return null;
  const { status, at } = app.scan;
  const summary = app.scan.summary as unknown;
  const v2 = summary && typeof summary === "object" && (summary as { v?: number }).v === 2 ? (summary as ScanV2) : null;
  const legacy = !v2 && summary && typeof summary === "object" && "critical" in summary ? (summary as Legacy) : null;
  const error = summary && typeof summary === "object" && "error" in summary ? String((summary as { error: unknown }).error) : "";
  const done = status === "success";
  const chip: ScanV2["status"] | null = done && v2 ? v2.status : done && legacy ? (legacy.critical ? "acil" : legacy.high ? "dikkat" : "temiz") : null;
  const meta = [at ? t("Son tarama {ago}", { ago: timeAgo(at) }) : "", done && v2?.os ? osLabel(v2.os) : ""].filter(Boolean).join(" · ");

  return (
    <div className="panel px-5 py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <ShieldCheck className="size-4 text-muted" />
          <h3 className="font-medium">{t("Güvenlik taraması")}</h3>
          {chip && <StatusChip status={chip} />}
        </div>
        <Button size="sm" variant="ghost" loading={scan.isPending || status === "running"} onClick={() => scan.mutate()}>
          {status === "running" ? t("Taranıyor") : done ? t("Yeniden tara") : t("Tara")}
        </Button>
      </div>

      {status === "running" && (
        <p className="mt-2 text-[13px] text-muted">{t("İmaj bilinen açıklara (CVE) karşı taranıyor; ilk taramada açık veritabanı indirildiği için birkaç dakika sürebilir.")}</p>
      )}
      {status === "failed" && (
        <p className="mt-2 text-[13px] text-accent">
          {t("Tarama başarısız")}: {error}
        </p>
      )}
      {!status && <p className="mt-2 text-[13px] text-muted">{t("Bu imaj henüz taranmadı.")}</p>}

      {done && v2 && (
        <>
          <p className="mt-2 text-[14px] leading-relaxed">{summarySentence(v2)}</p>
          {meta && <p className="mt-1 text-[12px] text-faint">{meta}</p>}
          <Actions s={v2} />
          <Details s={v2} />
          <div className="mt-4 border-t border-line pt-3 text-[12px] leading-relaxed text-faint">
            <p>
              {(["CRITICAL", "HIGH", "MEDIUM", "LOW"] as Severity[]).map((sev, i) => (
                <span key={sev}>
                  {i > 0 && " · "}
                  <span className="text-muted">{SEV_LABEL[sev]()}</span> = {SEV_ADVICE[sev]()}
                </span>
              ))}
            </p>
            <p className="mt-1">{t("Bu bulgular paketin imajda bulunduğunu gösterir; uygulamanın onu kullandığı anlamına gelmez.")}</p>
          </div>
        </>
      )}

      {done && legacy && (
        <>
          <p className="mt-2 text-[14px]">
            {legacy.critical || legacy.high
              ? t("{c} kritik, {h} yüksek seviye açık; {f} tanesi paket güncellemesiyle kapanıyor.", { c: legacy.critical, h: legacy.high, f: legacy.fixable })
              : t("Bilinen kritik veya yüksek seviye açık yok.")}
          </p>
          {meta && <p className="mt-1 text-[12px] text-faint">{meta}</p>}
          <p className="mt-2 text-[13px] text-muted">{t("Bu sonuç eski biçimde kaydedilmiş; ne yapman gerektiğini adım adım görmek için yeniden tara.")}</p>
        </>
      )}
      {done && !v2 && !legacy && <p className="mt-2 text-[13px] text-muted">{t("Tarama sonucu okunamadı; yeniden tara.")}</p>}
    </div>
  );
}
