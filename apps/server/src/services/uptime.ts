import tls from "node:tls";
import { db } from "../db.js";
import { getSettings } from "../lib/settings.js";
import { safeGet } from "../lib/ssrf.js";
import { dockerFor } from "./docker.js";
import { isHealthy, probeHttp } from "./doctor.js";
import { notify } from "./notify.js";
import { getServer, listServers, getServerStats } from "./servers.js";

/**
 * Erişilebilirlik izleme: her uygulamanın adresi dakikada bir dışarıdan (gerçek alan adıyla) denenir.
 * Art arda 2 başarısız denemede "site çöktü", ilk başarılı denemede "site yeniden çalışıyor" bildirimi gider.
 * Dışarıdan ulaşılamayıp sunucu içinden sağlıklı yanıt geliyorsa (ör. sunucu kendi IP'sine ulaşamıyor) çökme sayılmaz.
 */
type AppRow = { id: number; name: string; server_id: number; container: string | null; port: number; health_path: string | null; status: string; source_type: string; uptime_enabled: number };

const FAIL_THRESHOLD = 2;
const state = new Map<number, { fails: number; down: boolean; since: number; firstFail: number; reason: string }>();

async function checkUrl(url: string): Promise<{ ok: boolean; status: number | null; ms: number; error?: string }> {
  const started = Date.now();
  try {
    // Alan adı kullanıcıdan geldiği için istek, çözülüp iç ağ denetiminden geçen IP'ye yapılır (SSRF / DNS-rebinding, O4);
    // yönlendirmeler takip edilmez.
    const res = await safeGet(url, { timeoutMs: 15_000, headers: { "User-Agent": "xudbin-uptime" } });
    return { ok: res.status < 500, status: res.status, ms: res.ms };
  } catch (err) {
    const e = err as Error & { code?: string };
    return { ok: false, status: null, ms: Date.now() - started, error: e.code ?? e.message };
  }
}

function primaryUrl(appId: number) {
  const d = db.prepare("SELECT host, https FROM domains WHERE app_id = ? ORDER BY generated, id LIMIT 1").get(appId) as { host: string; https: number } | undefined;
  if (!d) return null;
  const server = db.prepare("SELECT s.https_mode FROM apps a JOIN servers s ON s.id = a.server_id WHERE a.id = ?").get(appId) as { https_mode: string };
  return { host: d.host, url: `${d.https && server.https_mode !== "off" ? "https" : "http"}://${d.host}` };
}

async function checkApp(app: AppRow) {
  const target = primaryUrl(app.id);
  if (!target) return;
  const path = app.health_path || "/";
  // health_path "/" ile başlar ama yine de adresin ana bilgisayarı değişmemeli.
  const full = target.url + path;
  let r = new URL(full).host === target.host ? await checkUrl(full) : { ok: false, status: null, ms: 0, error: "Geçersiz sağlık yolu" };
  if (!r.ok && r.status === null && app.container && app.source_type !== "compose") {
    // Dışarıdan ulaşılamadı: sunucu içinden de dene; sağlıklıysa sorun ağ/kendi IP'sine dönüş (hairpin), çökme değil.
    const server = getServer(app.server_id);
    const probe = await probeHttp(dockerFor(server), app.container, app.port, target.host, path).catch(() => null);
    if (probe?.status && isHealthy(probe.status, false)) r = { ok: true, status: probe.status, ms: r.ms, error: "dışarıdan ulaşılamadı, içeriden sağlıklı" };
  }
  db.prepare("INSERT INTO uptime_checks (app_id, at, ok, status, ms, error) VALUES (?, ?, ?, ?, ?, ?)").run(app.id, Date.now(), r.ok ? 1 : 0, r.status, r.ms, r.error ?? null);

  const s = state.get(app.id) ?? { fails: 0, down: false, since: 0, firstFail: 0, reason: "" };
  if (r.ok) {
    if (s.down) {
      const minutes = Math.max(1, Math.round((Date.now() - s.since) / 60_000));
      db.prepare("UPDATE uptime_incidents SET ended_at = ? WHERE app_id = ? AND ended_at IS NULL").run(Date.now(), app.id);
      notify("site_up", `${app.name} yeniden çalışıyor`, `${target.url} yaklaşık ${minutes} dakika erişilemedi, şimdi yanıt veriyor (${r.status}, ${r.ms} ms).`);
    }
    state.set(app.id, { fails: 0, down: false, since: 0, firstFail: 0, reason: "" });
    return;
  }
  s.fails++;
  if (s.fails === 1) s.firstFail = Date.now() - r.ms;
  const reason = r.status ? `HTTP ${r.status}` : (r.error ?? "yanıt yok");
  if (!s.down && s.fails >= FAIL_THRESHOLD) {
    s.down = true;
    // Kesinti ilk başarısız denemeden başlar.
    s.since = s.firstFail || Date.now();
    s.reason = reason;
    db.prepare("INSERT INTO uptime_incidents (app_id, started_at, reason) VALUES (?, ?, ?)").run(app.id, s.since, reason);
    notify("site_down", `${app.name} çöktü`, `${target.url} art arda ${s.fails} denemede yanıt vermedi (${reason}). Düzelince ayrıca haber verilecek.`);
  }
  state.set(app.id, s);
}

/** Şu an erişilemeyen uygulamalar (Genel bakış uyarısı için). */
export function downApps() {
  return [...state.entries()].filter(([, s]) => s.down).map(([appId, s]) => ({ appId, since: s.since, reason: s.reason }));
}

/** Uygulamanın erişilebilirlik özeti: 24 saat / 7 gün / 30 gün oranları, son yanıt süreleri, olaylar. */
export function uptimeSummary(appId: number) {
  const now = Date.now();
  const ratio = (ms: number) => {
    const r = db.prepare("SELECT COUNT(*) AS n, SUM(ok) AS ok FROM uptime_checks WHERE app_id = ? AND at > ?").get(appId, now - ms) as { n: number; ok: number | null };
    return r.n ? (r.ok ?? 0) / r.n : null;
  };
  const recent = db
    .prepare("SELECT at, ok, status, ms FROM uptime_checks WHERE app_id = ? AND at > ? ORDER BY at")
    .all(appId, now - 24 * 3_600_000) as { at: number; ok: number; status: number | null; ms: number }[];
  const incidents = db.prepare("SELECT started_at AS startedAt, ended_at AS endedAt, reason FROM uptime_incidents WHERE app_id = ? ORDER BY id DESC LIMIT 10").all(appId);
  const s = state.get(appId);
  return { up24h: ratio(86_400_000), up7d: ratio(7 * 86_400_000), up30d: ratio(30 * 86_400_000), down: Boolean(s?.down), recent, incidents };
}

/** Sertifikanın bitiş tarihi (HTTPS'li alan adları için); 14 günden az kaldıysa uyarı. */
function certExpiry(host: string): Promise<number | null> {
  return new Promise((resolve) => {
    const sock = tls.connect({ host, port: 443, servername: host, timeout: 10_000 }, () => {
      const cert = sock.getPeerCertificate();
      sock.end();
      resolve(cert?.valid_to ? Date.parse(cert.valid_to) : null);
    });
    sock.on("error", () => resolve(null));
    sock.on("timeout", () => {
      sock.destroy();
      resolve(null);
    });
  });
}

const warned = new Map<string, number>();
async function checkCertificates() {
  const rows = db
    .prepare("SELECT d.host, a.name FROM domains d JOIN apps a ON a.id = d.app_id JOIN servers s ON s.id = a.server_id WHERE d.https = 1 AND s.https_mode = 'auto' AND a.status = 'running'")
    .all() as { host: string; name: string }[];
  for (const r of rows) {
    const exp = await certExpiry(r.host);
    if (!exp) continue;
    const days = Math.floor((exp - Date.now()) / 86_400_000);
    if (days < 14 && (warned.get(r.host) ?? 0) < Date.now() - 86_400_000) {
      warned.set(r.host, Date.now());
      notify("cert_expiring", `${r.host} sertifikası ${days} gün içinde bitiyor`, `${r.name} uygulamasının HTTPS sertifikası yenilenemiyor olabilir. Alan adının DNS kaydının bu sunucuyu gösterdiğini kontrol et.`);
    }
  }
}

/** Sunucu kaynak uyarıları: disk %90 üstü, bellek %95 üstü (ardışık iki ölçümde). */
const resourceState = new Map<string, number>();
async function checkResources() {
  for (const s of listServers().filter((x) => x.status === "ready")) {
    const stats = await getServerStats(s).catch(() => null);
    if (!stats) continue;
    const disk = stats.disk?.total ? stats.disk.used / stats.disk.total : 0;
    const mem = stats.memory.total ? stats.memory.used / stats.memory.total : 0;
    for (const [key, val, limit, label] of [
      [`${s.id}:disk`, disk, 0.9, "disk"],
      [`${s.id}:mem`, mem, 0.95, "bellek"],
    ] as const) {
      const n = val >= limit ? (resourceState.get(key) ?? 0) + 1 : 0;
      resourceState.set(key, n);
      if (n === 2) notify("server_resource", `${s.name}: ${label} %${Math.round(val * 100)} dolu`, `${s.name} sunucusunda ${label} kullanımı %${Math.round(val * 100)}. Uygulamalar yavaşlayabilir veya deploy'lar başarısız olabilir.`);
    }
  }
}

export function startUptimeMonitor() {
  let running = false;
  const tick = async () => {
    if (running || !getSettings().uptimeEnabled) return;
    running = true;
    try {
      const apps = db
        .prepare("SELECT id, name, server_id, container, port, health_path, status, source_type, uptime_enabled FROM apps WHERE status = 'running' AND uptime_enabled = 1 AND kind = 'web'")
        .all() as AppRow[];
      // Aynı anda en fazla 8 kontrol.
      for (let i = 0; i < apps.length; i += 8) await Promise.all(apps.slice(i, i + 8).map((a) => checkApp(a).catch(() => {})));
      // Çalışmayan (durdurulmuş, silinmiş) uygulamaların durumunu unut.
      const ids = new Set(apps.map((a) => a.id));
      for (const id of state.keys()) if (!ids.has(id)) state.delete(id);
    } finally {
      running = false;
    }
  };
  setTimeout(tick, 30_000).unref();
  setInterval(tick, 60_000).unref();
  setInterval(() => void checkResources().catch(() => {}), 5 * 60_000).unref();
  setInterval(() => void checkCertificates().catch(() => {}), 12 * 3_600_000).unref();
  setTimeout(() => void checkCertificates().catch(() => {}), 5 * 60_000).unref();
  // 30 günden eski kontrolleri temizle.
  setInterval(() => db.prepare("DELETE FROM uptime_checks WHERE at < ?").run(Date.now() - 30 * 86_400_000), 6 * 3_600_000).unref();
}
