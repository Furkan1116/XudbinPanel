import { useQuery } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { Notice, PageHeader, PageLoading, Section } from "@/components/ui";
import { api } from "@/lib/api";
import { formatBytes } from "@/lib/format";
import { getLang, t } from "@/lib/i18n";

type Row = { value: string; visitors: number; pageviews: number };
type Period = { visitors: number; pageviews: number; requests: number; bytes: number; errors4xx: number; errors5xx: number; bots: number; bounceRate: number | null; avgDurationMs: number | null };
type Report = {
  range: string;
  timeZone: string;
  current: Period;
  previous: Period;
  realtime: number;
  series: { t: number; visitors: number; pageviews: number }[];
  pages: Row[];
  entries: Row[];
  referrers: Row[];
  countries: Row[];
  browsers: Row[];
  os: Row[];
  devices: Row[];
  utmSources: Row[];
  utmMediums: Row[];
  utmCampaigns: Row[];
};
type Site = { id: number; name: string; project: string; host: string | null };

const RANGES = [
  { id: "24h", label: "Son 24 saat" },
  { id: "7d", label: "Son 7 gün" },
  { id: "30d", label: "Son 30 gün" },
  { id: "90d", label: "Son 90 gün" },
  { id: "365d", label: "Son 1 yıl" },
] as const;

const nf = () => new Intl.NumberFormat(getLang() === "en" ? "en-US" : "tr-TR");

/** Google Analytics tarzı trafik paneli: sitelerin ziyaretçileri, sayfaları ve trafiğin geldiği yerler. */
export function AnalyticsPage() {
  const [params, setParams] = useSearchParams();
  const site = params.get("site") ?? "all";
  const range = params.get("range") ?? "7d";
  const set = (k: string, v: string) => setParams((p) => ({ ...Object.fromEntries(p), [k]: v }), { replace: true });

  const sites = useQuery({ queryKey: ["analytics", "sites"], queryFn: () => api.get<{ sites: Site[] }>("/analytics/sites") });
  const report = useQuery({
    queryKey: ["analytics", site, range],
    queryFn: () => api.get<Report>(`/analytics/report?site=${site}&range=${range}`),
    refetchInterval: 30_000,
  });

  return (
    <>
      <PageHeader
        title={t("Analitik")}
        description={t("Sitelerine gelen ziyaretçiler ve trafiğin nereden geldiği. Çerez kullanılmaz, ziyaretçi sitelerine kod eklenmez; veriler sunucunun erişim loglarından hesaplanır.")}
        actions={
          <div className="flex flex-wrap gap-2">
            <select className="input w-auto" value={site} onChange={(e) => set("site", e.target.value)} aria-label={t("Site")}>
              <option value="all">{t("Tüm siteler")}</option>
              {sites.data?.sites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} {s.host ? `· ${s.host}` : ""}
                </option>
              ))}
            </select>
            <select className="input w-auto" value={range} onChange={(e) => set("range", e.target.value)} aria-label={t("Zaman aralığı")}>
              {RANGES.map((r) => (
                <option key={r.id} value={r.id}>{t(r.label)}</option>
              ))}
            </select>
          </div>
        }
      />
      {!report.data ? (
        report.error ? <Notice tone="danger" title={t("Analitik yüklenemedi")}>{report.error.message}</Notice> : <PageLoading />
      ) : (
        <ReportView r={report.data} />
      )}
    </>
  );
}

function change(cur: number, prev: number) {
  if (!prev) return null;
  return (cur - prev) / prev;
}

function ReportView({ r }: { r: Report }) {
  const n = nf();
  const c = r.current;
  const p = r.previous;
  const minutes = (ms: number | null) => (ms === null ? "–" : ms < 60_000 ? `${Math.round(ms / 1000)} sn` : `${Math.floor(ms / 60_000)} dk ${Math.round((ms % 60_000) / 1000)} sn`);
  const empty = c.pageviews === 0 && c.requests === 0;

  return (
    <div className="space-y-9">
      <section className="panel">
        <dl className="grid grid-cols-2 border-b border-line sm:grid-cols-3 lg:grid-cols-6">
          <Kpi label={t("Ziyaretçi")} value={n.format(c.visitors)} delta={change(c.visitors, p.visitors)} big />
          <Kpi label={t("Sayfa görüntüleme")} value={n.format(c.pageviews)} delta={change(c.pageviews, p.pageviews)} />
          <Kpi label={t("Hemen çıkma")} value={c.bounceRate === null ? "–" : `%${Math.round(c.bounceRate * 100)}`} delta={c.bounceRate !== null && p.bounceRate ? change(c.bounceRate, p.bounceRate) : null} invert />
          <Kpi label={t("Ort. ziyaret süresi")} value={minutes(c.avgDurationMs)} delta={c.avgDurationMs !== null && p.avgDurationMs ? change(c.avgDurationMs, p.avgDurationMs) : null} />
          <Kpi label={t("Bant genişliği")} value={formatBytes(c.bytes)} delta={change(c.bytes, p.bytes)} neutral />
          <Kpi
            label={t("Şu an sitede")}
            value={
              <span className="inline-flex items-center gap-2">
                <span className={`size-2 rounded-full ${r.realtime ? "animate-pulse bg-ok" : "bg-line-strong"}`} />
                {n.format(r.realtime)}
              </span>
            }
          />
        </dl>
        <div className="px-5 pt-4 pb-5">
          <TrafficChart series={r.series} hourly={r.range === "24h" || r.range === "7d"} />
        </div>
        <div className="flex flex-wrap gap-x-5 gap-y-1 border-t border-line px-5 py-3 text-[13px] text-muted">
          <span>{t("{n} istek", { n: n.format(c.requests) })}</span>
          <span>{t("{n} istemci hatası (4xx)", { n: n.format(c.errors4xx) })}</span>
          <span className={c.errors5xx ? "text-accent" : ""}>{t("{n} sunucu hatası (5xx)", { n: n.format(c.errors5xx) })}</span>
          <span>{t("{n} bot isteği (sayılmadı)", { n: n.format(c.bots) })}</span>
          <span className="ml-auto text-faint">{t("Saat dilimi: {tz}", { tz: r.timeZone })}</span>
        </div>
      </section>

      {empty && (
        <Notice tone="info" title={t("Bu dönemde trafik yok")}>
          {t("Siteye gelen istekler, sunucunun erişim logları okundukça (yaklaşık 20 saniyede bir) burada görünür.")}
        </Notice>
      )}

      <div className="grid gap-9 lg:grid-cols-2">
        <Tabbed
          tabs={[
            { id: "pages", label: t("Sayfalar"), rows: r.pages, metric: "pageviews" },
            { id: "entries", label: t("Giriş sayfaları"), rows: r.entries, metric: "visitors" },
          ]}
          mono
        />
        <Tabbed
          tabs={[
            { id: "ref", label: t("Yönlendirenler"), rows: r.referrers, metric: "visitors", format: (v) => (v === "Doğrudan" ? t("Doğrudan / yer imi") : v), icon: (v) => (v === "Doğrudan" ? null : `https://${v}/favicon.ico`) },
            { id: "src", label: t("Kampanya kaynağı"), rows: r.utmSources, metric: "visitors" },
            { id: "med", label: t("Kampanya türü"), rows: r.utmMediums, metric: "visitors" },
            { id: "cmp", label: t("Kampanya"), rows: r.utmCampaigns, metric: "visitors" },
          ]}
        />
        <Tabbed tabs={[{ id: "country", label: t("Ülkeler"), rows: r.countries, metric: "visitors", format: countryName, prefix: flag }]} />
        <Tabbed
          tabs={[
            { id: "device", label: t("Cihazlar"), rows: r.devices, metric: "visitors", format: (v) => t(v) },
            { id: "browser", label: t("Tarayıcılar"), rows: r.browsers, metric: "visitors", format: (v) => t(v) },
            { id: "os", label: t("İşletim sistemleri"), rows: r.os, metric: "visitors", format: (v) => t(v) },
          ]}
        />
      </div>
    </div>
  );
}

function Kpi({ label, value, delta, big, invert, neutral }: { label: string; value: React.ReactNode; delta?: number | null; big?: boolean; invert?: boolean; neutral?: boolean }) {
  const good = delta === null || delta === undefined ? null : invert ? delta < 0 : delta > 0;
  return (
    <div className="border-line px-5 py-4 not-last:border-r max-sm:[&:nth-child(2n)]:border-r-0">
      <dt className="text-[13px] text-muted">{label}</dt>
      <dd className={`mt-1 font-semibold tabular-nums ${big ? "text-2xl" : "text-xl"}`}>{value}</dd>
      {delta !== null && delta !== undefined && Number.isFinite(delta) && (
        <div className={`mt-0.5 text-[12px] tabular-nums ${neutral ? "text-faint" : good ? "text-ok" : "text-accent"}`}>
          {delta > 0 ? "▲" : delta < 0 ? "▼" : "•"} %{Math.abs(Math.round(delta * 100))} <span className="text-faint">{t("önceki döneme göre")}</span>
        </div>
      )}
    </div>
  );
}

const H = 180;

function TrafficChart({ series, hourly }: { series: Report["series"]; hourly: boolean }) {
  const ref = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...series.map((s) => Math.max(s.visitors, s.pageviews)));
  const nice = useMemo(() => {
    const p = 10 ** Math.floor(Math.log10(max));
    return Math.ceil(max / p) * p;
  }, [max]);
  const x = (i: number) => (series.length <= 1 ? 50 : (i / (series.length - 1)) * 100);
  const y = (v: number) => H - (v / nice) * H;
  const line = (k: "visitors" | "pageviews") => series.map((s, i) => `${i ? "L" : "M"}${x(i).toFixed(2)},${y(s[k]).toFixed(2)}`).join(" ");
  const area = `${line("visitors")} L100,${H} L0,${H} Z`;
  const fmt = new Intl.DateTimeFormat(getLang() === "en" ? "en-US" : "tr-TR", hourly ? { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" } : { day: "numeric", month: "short", year: "numeric" });
  const n = nf();
  const active = hover !== null ? series[hover] : null;

  const onMove = (e: React.PointerEvent) => {
    const box = ref.current?.getBoundingClientRect();
    if (!box || !series.length) return;
    const i = Math.round(((e.clientX - box.left) / box.width) * (series.length - 1));
    setHover(Math.min(Math.max(i, 0), series.length - 1));
  };

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-baseline gap-x-5 gap-y-1 text-[13px]">
        <span className="inline-flex items-center gap-2">
          <span className="inline-block h-[3px] w-3.5 rounded-full bg-accent" />
          <span className="text-muted">{t("Ziyaretçi")}</span>
          {active && <span className="font-medium tabular-nums">{n.format(active.visitors)}</span>}
        </span>
        <span className="inline-flex items-center gap-2">
          <span className="inline-block h-[3px] w-3.5 rounded-full bg-[var(--chart-2)]" />
          <span className="text-muted">{t("Sayfa görüntüleme")}</span>
          {active && <span className="font-medium tabular-nums">{n.format(active.pageviews)}</span>}
        </span>
        <span className="ml-auto text-faint">{active ? fmt.format(active.t) : ""}</span>
      </div>
      <div className="relative" style={{ height: H }}>
        {[nice, nice / 2, 0].map((v) => (
          <div key={v} className="absolute inset-x-0 border-t border-dashed border-line" style={{ top: y(v) }}>
            <span className="absolute -top-2.5 right-0 bg-surface pl-1.5 text-[11px] text-faint tabular-nums">{n.format(v)}</span>
          </div>
        ))}
        <svg
          ref={ref}
          viewBox={`0 0 100 ${H}`}
          preserveAspectRatio="none"
          className="absolute inset-0 h-full w-[calc(100%-2.75rem)] touch-none overflow-visible"
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
          role="img"
          aria-label={t("Ziyaretçi ve sayfa görüntüleme grafiği")}
        >
          <path d={area} fill="var(--accent)" opacity="0.08" />
          <path d={line("pageviews")} fill="none" stroke="var(--chart-2)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
          <path d={line("visitors")} fill="none" stroke="var(--accent)" strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
          {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={0} y2={H} stroke="var(--line-strong)" vectorEffect="non-scaling-stroke" />}
        </svg>
      </div>
      {series.length > 1 && (
        <div className="mt-2 flex justify-between text-[11px] text-faint">
          <span>{fmt.format(series[0]!.t)}</span>
          <span className="mr-11">{fmt.format(series.at(-1)!.t)}</span>
        </div>
      )}
    </div>
  );
}

type Tab = { id: string; label: string; rows: Row[]; metric: "visitors" | "pageviews"; format?: (v: string) => string; prefix?: (v: string) => string; icon?: (v: string) => string | null };

function Tabbed({ tabs, mono }: { tabs: Tab[]; mono?: boolean }) {
  const [active, setActive] = useState(tabs[0]!.id);
  const tab = tabs.find((x) => x.id === active) ?? tabs[0]!;
  const n = nf();
  const max = Math.max(1, ...tab.rows.map((r) => r[tab.metric]));
  return (
    <Section
      title={tabs.length === 1 ? tab.label : ""}
      className="!mt-0"
      actions={
        tabs.length > 1 ? (
          <div className="flex flex-wrap gap-1">
            {tabs.map((x) => (
              <button key={x.id} type="button" onClick={() => setActive(x.id)} className={`rounded-md px-2.5 py-1 text-[13px] ${x.id === tab.id ? "bg-surface-2 font-medium text-fg" : "text-muted hover:text-fg"}`}>
                {x.label}
              </button>
            ))}
          </div>
        ) : undefined
      }
    >
      <div className="panel">
        <div className="flex justify-between border-b border-line px-4 py-2 text-[12px] text-faint">
          <span>{tab.label}</span>
          <span>{tab.metric === "visitors" ? t("Ziyaretçi") : t("Görüntüleme")}</span>
        </div>
        {tab.rows.length === 0 ? (
          <div className="px-4 py-6 text-[14px] text-muted">{t("Henüz veri yok.")}</div>
        ) : (
          <ul className="space-y-0.5 p-2">
            {tab.rows.map((r) => (
              <li key={r.value} className="relative flex items-center justify-between gap-3 overflow-hidden rounded px-2 py-1.5 text-[14px]">
                <span className="absolute inset-y-0 left-0 rounded bg-accent/10" style={{ width: `${(r[tab.metric] / max) * 100}%` }} />
                <span className={`relative min-w-0 truncate ${mono ? "font-mono text-[13px]" : ""}`} title={r.value}>
                  {tab.prefix && <span className="mr-2">{tab.prefix(r.value)}</span>}
                  {tab.format ? tab.format(r.value) : r.value}
                </span>
                <span className="relative shrink-0 font-medium tabular-nums">{n.format(r[tab.metric])}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Section>
  );
}

function flag(code: string) {
  if (!/^[A-Z]{2}$/.test(code)) return "🌐";
  return String.fromCodePoint(...[...code].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

function countryName(code: string) {
  if (!/^[A-Z]{2}$/.test(code)) return t("Bilinmiyor");
  try {
    return new Intl.DisplayNames([getLang() === "en" ? "en" : "tr"], { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
}
