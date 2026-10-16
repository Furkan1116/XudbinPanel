import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createGunzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { config } from "../config.js";
import { db } from "../db.js";
import { Mmdb } from "../lib/mmdb.js";
import { getSettings, updateSettings } from "../lib/settings.js";
import { parseUserAgent } from "../lib/user-agent.js";

/**
 * Trafik analitiği: Caddy erişim loglarından, ziyaretçi sitesine kod eklemeden ve çerez kullanmadan.
 * - Ziyaretçi = (günlük gizli anahtar + gün + uygulama + IP + tarayıcı) özetinin ilk 16 karakteri. IP saklanmaz;
 *   anahtar her gün yenilenir ve eskisi silinir, yani ziyaretçiler günler arasında izlenemez.
 * - Sayfa görüntüleme: GET, durum < 400, yanıt text/html, bot değil.
 * - Ham ziyaretçi özetleri 2 gün sonra günlük toplamlara çevrilip silinir; toplamlar 400 gün tutulur.
 */

export type AccessEntry = {
  ts?: number;
  status?: number;
  size?: number;
  duration?: number;
  request?: { remote_ip?: string; client_ip?: string; method?: string; host?: string; uri?: string; headers?: Record<string, string[]> };
  resp_headers?: Record<string, string[]>;
};

const RETENTION_DAYS = 400;
const GEO_FILE = path.join(config.dataDir, "geo", "dbip-country-lite.mmdb");

// --- Saat dilimi ve gün anahtarları -------------------------------------------------------------

export const timeZone = () => getSettings().timezone || "Europe/Istanbul";
const dayFormatters = new Map<string, Intl.DateTimeFormat>();
export function dayKey(ms: number, tz = timeZone()) {
  let f = dayFormatters.get(tz);
  if (!f) dayFormatters.set(tz, (f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })));
  return f.format(ms);
}

// --- Günlük gizli anahtar -----------------------------------------------------------------------

function saltFor(day: string) {
  const s = getSettings().analyticsSalt;
  if (s?.day === day) return s.value;
  const value = randomBytes(16).toString("hex");
  updateSettings({ analyticsSalt: { day, value } });
  return value;
}

// --- Alan adı → uygulama ------------------------------------------------------------------------

let hostMap = new Map<string, number>();
let hostMapAt = 0;
function appForHost(host: string) {
  if (Date.now() - hostMapAt > 30_000) {
    hostMap = new Map((db.prepare("SELECT host, app_id FROM domains").all() as { host: string; app_id: number }[]).map((r) => [r.host, r.app_id]));
    hostMapAt = Date.now();
  }
  return hostMap.get(host);
}

// --- Ülke (DB-IP Lite, CC BY 4.0) ---------------------------------------------------------------

let geo: Mmdb | null = null;
let geoTried = 0;
function country(ip: string): string {
  if (!geo && Date.now() - geoTried > 3_600_000) {
    geoTried = Date.now();
    try {
      if (fs.existsSync(GEO_FILE)) geo = new Mmdb(GEO_FILE);
    } catch {
      geo = null;
    }
  }
  const r = geo?.get(ip) as { country?: { iso_code?: string } } | null | undefined;
  return r?.country?.iso_code ?? "??";
}

/** DB-IP Lite ülke veritabanını ayda bir indirir (yaklaşık 4 MB). */
export async function updateGeoDatabase() {
  const now = new Date();
  for (const back of [0, 1]) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
    const month = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    const res = await fetch(`https://download.db-ip.com/free/dbip-country-lite-${month}.mmdb.gz`).catch(() => null);
    if (!res?.ok || !res.body) continue;
    fs.mkdirSync(path.dirname(GEO_FILE), { recursive: true });
    const tmp = `${GEO_FILE}.tmp`;
    await pipeline(Readable.fromWeb(res.body as never), createGunzip(), fs.createWriteStream(tmp));
    new Mmdb(tmp); // bozuk değilse
    fs.renameSync(tmp, GEO_FILE);
    geo = null;
    geoTried = 0;
    updateSettings({ geoDbMonth: month });
    return month;
  }
  return null;
}

// --- Gerçek zamanlı ----------------------------------------------------------------------------

const live = new Map<number, Map<string, number>>();
export function realtimeVisitors(appId: number) {
  const m = live.get(appId);
  if (!m) return 0;
  const cutoff = Date.now() - 5 * 60_000;
  let n = 0;
  for (const [k, t] of m) if (t >= cutoff) n++;
  else m.delete(k);
  return n;
}

// --- Toplama ------------------------------------------------------------------------------------

const ASSET = /\.(?:js|mjs|css|map|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|eot|mp4|webm|mp3|wav|pdf|zip|gz|json|xml|txt|wasm)$/i;

function referrerOf(ref: string | undefined, appHosts: Set<string>): string {
  if (!ref) return "Doğrudan";
  try {
    const h = new URL(ref).hostname.replace(/^www\./, "");
    if (appHosts.has(h) || appHosts.has(`www.${h}`)) return "Doğrudan";
    return h;
  } catch {
    return "Doğrudan";
  }
}

let appHostsCache = new Map<number, Set<string>>();
let appHostsAt = 0;
function hostsOf(appId: number) {
  if (Date.now() - appHostsAt > 30_000) {
    appHostsCache = new Map();
    for (const r of db.prepare("SELECT host, app_id FROM domains").all() as { host: string; app_id: number }[]) {
      if (!appHostsCache.has(r.app_id)) appHostsCache.set(r.app_id, new Set());
      appHostsCache.get(r.app_id)!.add(r.host.replace(/^www\./, ""));
    }
    appHostsAt = Date.now();
  }
  return appHostsCache.get(appId) ?? new Set<string>();
}

/** Erişim logu satırlarını analitik tablolarına işler. */
export function ingestAnalytics(entries: AccessEntry[]) {
  const tz = timeZone();
  const hourly = new Map<string, { app: number; hour: number; requests: number; pageviews: number; visitors: number; bytes: number; e4: number; e5: number; bots: number }>();
  const dims = new Map<string, { app: number; day: string; dim: string; value: string; pv: number; vis: number }>();
  const getVisitor = db.prepare("SELECT pageviews FROM analytics_visitors WHERE app_id = ? AND day = ? AND vhash = ?");
  const insVisitor = db.prepare("INSERT INTO analytics_visitors (app_id, day, vhash, first_ts, last_ts, pageviews) VALUES (?, ?, ?, ?, ?, 1)");
  const updVisitor = db.prepare("UPDATE analytics_visitors SET last_ts = MAX(last_ts, ?), pageviews = pageviews + 1 WHERE app_id = ? AND day = ? AND vhash = ?");
  const addDim = (app: number, day: string, dim: string, value: string, isNew: boolean) => {
    const k = `${app}|${day}|${dim}|${value}`;
    const d = dims.get(k) ?? { app, day, dim, value, pv: 0, vis: 0 };
    d.pv++;
    if (isNew) d.vis++;
    dims.set(k, d);
  };

  db.exec("BEGIN");
  try {
    for (const e of entries) {
      const r = e.request ?? {};
      const host = (r.host ?? "").toLowerCase().replace(/:\d+$/, "");
      const app = appForHost(host);
      if (!app) continue;
      const tsMs = Math.round((e.ts ?? Date.now() / 1000) * 1000);
      const hour = Math.floor(tsMs / 3_600_000);
      const hk = `${app}|${hour}`;
      const h = hourly.get(hk) ?? { app, hour, requests: 0, pageviews: 0, visitors: 0, bytes: 0, e4: 0, e5: 0, bots: 0 };
      hourly.set(hk, h);
      h.requests++;
      h.bytes += e.size ?? 0;
      const status = e.status ?? 0;
      if (status >= 500) h.e5++;
      else if (status >= 400) h.e4++;

      const ua = r.headers?.["User-Agent"]?.[0];
      const info = parseUserAgent(ua);
      if (info.bot) {
        h.bots++;
        continue;
      }
      const uri = r.uri ?? "/";
      const pathOnly = uri.split("?")[0]!.slice(0, 300) || "/";
      const ctype = e.resp_headers?.["Content-Type"]?.[0] ?? "";
      const isPage = r.method === "GET" && status > 0 && status < 400 && (ctype.startsWith("text/html") || (status === 304 && !ASSET.test(pathOnly)));
      if (!isPage) continue;

      const day = dayKey(tsMs, tz);
      const ip = r.client_ip ?? r.remote_ip ?? "";
      const vhash = createHash("sha256").update(`${saltFor(day)}|${day}|${app}|${ip}|${ua ?? ""}`).digest("hex").slice(0, 16);
      const existing = getVisitor.get(app, day, vhash) as { pageviews: number } | undefined;
      const isNew = !existing;
      if (isNew) insVisitor.run(app, day, vhash, tsMs, tsMs);
      else updVisitor.run(tsMs, app, day, vhash);
      h.pageviews++;
      if (isNew) h.visitors++;

      let m = live.get(app);
      if (!m) live.set(app, (m = new Map()));
      m.set(vhash, Math.max(m.get(vhash) ?? 0, tsMs));

      addDim(app, day, "page", pathOnly, isNew);
      if (isNew) {
        // Ziyaretçiye ait özellikler: ilk sayfa görüntülemesinde sayılır.
        const q = new URLSearchParams(uri.includes("?") ? uri.slice(uri.indexOf("?") + 1) : "");
        const add = (dim: string, value: string) => addDim(app, day, dim, value.slice(0, 200), true);
        add("entry", pathOnly);
        add("referrer", referrerOf(r.headers?.["Referer"]?.[0], hostsOf(app)));
        add("country", country(ip));
        add("browser", info.browser);
        add("os", info.os);
        add("device", info.device);
        for (const u of ["utm_source", "utm_medium", "utm_campaign"]) {
          const v = q.get(u);
          if (v) add(u, v);
        }
      }
    }
    const upHour = db.prepare(
      `INSERT INTO analytics_hourly (app_id, hour, requests, pageviews, visitors, bytes, errors_4xx, errors_5xx, bot_hits)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(app_id, hour) DO UPDATE SET requests = requests + excluded.requests, pageviews = pageviews + excluded.pageviews,
         visitors = visitors + excluded.visitors, bytes = bytes + excluded.bytes, errors_4xx = errors_4xx + excluded.errors_4xx,
         errors_5xx = errors_5xx + excluded.errors_5xx, bot_hits = bot_hits + excluded.bot_hits`,
    );
    for (const h of hourly.values()) upHour.run(h.app, h.hour, h.requests, h.pageviews, h.visitors, h.bytes, h.e4, h.e5, h.bots);
    const upDim = db.prepare(
      `INSERT INTO analytics_dims (app_id, day, dim, value, pageviews, visitors) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(app_id, day, dim, value) DO UPDATE SET pageviews = pageviews + excluded.pageviews, visitors = visitors + excluded.visitors`,
    );
    for (const d of dims.values()) upDim.run(d.app, d.day, d.dim, d.value, d.pv, d.vis);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** Biten günlerin ziyaretçi özetlerini günlük toplamlara çevirir ve siler; eski toplamları temizler. */
export function rollupAnalytics() {
  const yesterday = dayKey(Date.now() - 86_400_000);
  const days = db.prepare("SELECT DISTINCT app_id, day FROM analytics_visitors WHERE day < ?").all(yesterday) as { app_id: number; day: string }[];
  const agg = db.prepare(
    `SELECT COUNT(*) AS visitors, SUM(pageviews) AS pageviews, SUM(pageviews = 1) AS bounces, SUM(CASE WHEN pageviews > 1 THEN last_ts - first_ts ELSE 0 END) AS duration
     FROM analytics_visitors WHERE app_id = ? AND day = ?`,
  );
  const put = db.prepare(
    "INSERT OR REPLACE INTO analytics_daily (app_id, day, visitors, pageviews, bounces, duration_ms) VALUES (?, ?, ?, ?, ?, ?)",
  );
  for (const d of days) {
    const a = agg.get(d.app_id, d.day) as { visitors: number; pageviews: number; bounces: number; duration: number };
    put.run(d.app_id, d.day, a.visitors, a.pageviews ?? 0, a.bounces ?? 0, a.duration ?? 0);
    db.prepare("DELETE FROM analytics_visitors WHERE app_id = ? AND day = ?").run(d.app_id, d.day);
  }
  const cutoffDay = dayKey(Date.now() - RETENTION_DAYS * 86_400_000);
  db.prepare("DELETE FROM analytics_dims WHERE day < ?").run(cutoffDay);
  db.prepare("DELETE FROM analytics_daily WHERE day < ?").run(cutoffDay);
  db.prepare("DELETE FROM analytics_hourly WHERE hour < ?").run(Math.floor((Date.now() - RETENTION_DAYS * 86_400_000) / 3_600_000));
}

// --- Sorgular -----------------------------------------------------------------------------------

export type Range = "24h" | "7d" | "30d" | "90d" | "365d";
const RANGE_MS: Record<Range, number> = { "24h": 86_400_000, "7d": 7 * 86_400_000, "30d": 30 * 86_400_000, "90d": 90 * 86_400_000, "365d": 365 * 86_400_000 };

function daysBetween(fromMs: number, toMs: number, tz: string) {
  const out: string[] = [];
  for (let t = fromMs; t <= toMs + 86_400_000; t += 86_400_000) {
    const k = dayKey(t, tz);
    if (!out.includes(k) && k <= dayKey(toMs, tz)) out.push(k);
  }
  return out;
}

/** Günlük ziyaretçi/hemen çıkma/süre: biten günler toplamlardan, son günler canlı özetlerden. */
function dailyStats(appIds: number[], days: string[]) {
  if (!appIds.length || !days.length) return new Map<string, { visitors: number; pageviews: number; bounces: number; duration: number }>();
  const ph = (n: number) => Array(n).fill("?").join(",");
  const out = new Map<string, { visitors: number; pageviews: number; bounces: number; duration: number }>();
  const add = (day: string, v: { visitors: number; pageviews: number; bounces: number; duration: number }) => {
    const c = out.get(day) ?? { visitors: 0, pageviews: 0, bounces: 0, duration: 0 };
    c.visitors += v.visitors;
    c.pageviews += v.pageviews;
    c.bounces += v.bounces;
    c.duration += v.duration;
    out.set(day, c);
  };
  for (const r of db
    .prepare(`SELECT day, visitors, pageviews, bounces, duration_ms AS duration FROM analytics_daily WHERE app_id IN (${ph(appIds.length)}) AND day IN (${ph(days.length)})`)
    .all(...appIds, ...days) as { day: string; visitors: number; pageviews: number; bounces: number; duration: number }[])
    add(r.day, r);
  for (const r of db
    .prepare(
      `SELECT day, COUNT(*) AS visitors, SUM(pageviews) AS pageviews, SUM(pageviews = 1) AS bounces, SUM(CASE WHEN pageviews > 1 THEN last_ts - first_ts ELSE 0 END) AS duration
       FROM analytics_visitors WHERE app_id IN (${ph(appIds.length)}) AND day IN (${ph(days.length)}) GROUP BY day`,
    )
    .all(...appIds, ...days) as { day: string; visitors: number; pageviews: number; bounces: number; duration: number }[])
    add(r.day, r);
  return out;
}

export function analyticsReport(appIds: number[], range: Range) {
  const tz = timeZone();
  const now = Date.now();
  const span = RANGE_MS[range];
  const ph = (n: number) => Array(n).fill("?").join(",");
  const ids = appIds.length ? appIds : [-1];

  const period = (from: number, to: number) => {
    const hours = db
      .prepare(
        `SELECT SUM(requests) AS requests, SUM(pageviews) AS pageviews, SUM(visitors) AS visitors, SUM(bytes) AS bytes,
                SUM(errors_4xx) AS e4, SUM(errors_5xx) AS e5, SUM(bot_hits) AS bots
         FROM analytics_hourly WHERE app_id IN (${ph(ids.length)}) AND hour >= ? AND hour <= ?`,
      )
      .get(...ids, Math.floor(from / 3_600_000), Math.floor(to / 3_600_000)) as Record<string, number | null>;
    let visitors = hours.visitors ?? 0;
    let bounces = 0;
    let duration = 0;
    let multi = 0;
    if (range !== "24h") {
      const daily = dailyStats(ids, daysBetween(from, to, tz));
      visitors = 0;
      for (const d of daily.values()) {
        visitors += d.visitors;
        bounces += d.bounces;
        duration += d.duration;
        multi += d.visitors - d.bounces;
      }
    } else {
      const daily = dailyStats(ids, daysBetween(from, to, tz));
      for (const d of daily.values()) {
        bounces += d.bounces;
        duration += d.duration;
        multi += d.visitors - d.bounces;
      }
    }
    const totalForBounce = bounces + multi;
    return {
      visitors,
      pageviews: hours.pageviews ?? 0,
      requests: hours.requests ?? 0,
      bytes: hours.bytes ?? 0,
      errors4xx: hours.e4 ?? 0,
      errors5xx: hours.e5 ?? 0,
      bots: hours.bots ?? 0,
      bounceRate: totalForBounce ? bounces / totalForBounce : null,
      avgDurationMs: multi ? duration / multi : null,
    };
  };

  const current = period(now - span, now);
  const previous = period(now - 2 * span, now - span);

  let series: { t: number; visitors: number; pageviews: number }[];
  if (range === "24h" || range === "7d") {
    const fromHour = Math.floor((now - span) / 3_600_000);
    const rows = db
      .prepare(`SELECT hour, SUM(visitors) AS visitors, SUM(pageviews) AS pageviews FROM analytics_hourly WHERE app_id IN (${ph(ids.length)}) AND hour > ? GROUP BY hour`)
      .all(...ids, fromHour) as { hour: number; visitors: number; pageviews: number }[];
    const byHour = new Map(rows.map((r) => [r.hour, r]));
    series = [];
    for (let h = fromHour + 1; h <= Math.floor(now / 3_600_000); h++) series.push({ t: h * 3_600_000, visitors: byHour.get(h)?.visitors ?? 0, pageviews: byHour.get(h)?.pageviews ?? 0 });
  } else {
    const days = daysBetween(now - span, now, tz);
    const daily = dailyStats(ids, days);
    series = days.map((d) => ({ t: Date.parse(`${d}T12:00:00Z`), visitors: daily.get(d)?.visitors ?? 0, pageviews: daily.get(d)?.pageviews ?? 0 }));
  }

  const days = daysBetween(now - span, now, tz);
  const top = (dim: string, by: "visitors" | "pageviews", limit = 10) =>
    db
      .prepare(
        `SELECT value, SUM(visitors) AS visitors, SUM(pageviews) AS pageviews FROM analytics_dims
         WHERE app_id IN (${ph(ids.length)}) AND dim = ? AND day IN (${ph(days.length)}) GROUP BY value ORDER BY ${by} DESC LIMIT ?`,
      )
      .all(...ids, dim, ...days, limit) as { value: string; visitors: number; pageviews: number }[];

  return {
    range,
    timeZone: tz,
    current,
    previous,
    realtime: ids.reduce((n, id) => n + realtimeVisitors(id), 0),
    series,
    pages: top("page", "pageviews"),
    entries: top("entry", "visitors"),
    referrers: top("referrer", "visitors"),
    countries: top("country", "visitors", 15),
    browsers: top("browser", "visitors"),
    os: top("os", "visitors"),
    devices: top("device", "visitors"),
    utmSources: top("utm_source", "visitors"),
    utmMediums: top("utm_medium", "visitors"),
    utmCampaigns: top("utm_campaign", "visitors"),
  };
}

export function startAnalyticsJobs() {
  const roll = () => {
    try {
      rollupAnalytics();
    } catch (err) {
      console.error("Analitik toplama hatası:", (err as Error).message);
    }
  };
  setTimeout(roll, 60_000).unref();
  setInterval(roll, 3_600_000).unref();
  // Ülke veritabanı: yoksa hemen, sonra ayda bir.
  const geoMonth = () => {
    const want = new Date().toISOString().slice(0, 7);
    if (getSettings().geoDbMonth !== want || !fs.existsSync(GEO_FILE)) updateGeoDatabase().catch(() => {});
  };
  setTimeout(geoMonth, 30_000).unref();
  setInterval(geoMonth, 12 * 3_600_000).unref();
}
