import { db } from "../db.js";
import { getSettings } from "../lib/settings.js";
import { ipInList } from "../lib/cidr.js";
import { ACCESS_LOG, applyCaddyConfig, CADDY_CONTAINER, parseSecurity } from "./caddy.js";
import { dockerFor, execIn, type ServerRow } from "./docker.js";
import { ingestAnalytics, type AccessEntry } from "./analytics.js";
import { notify } from "./notify.js";
import { listServers, updateServer } from "./servers.js";

type AccessLog = AccessEntry;

/** Erişim logundaki bir isteğin güvenlik olayı olup olmadığını ve türünü belirler. */
export function classify(entry: AccessLog): string | null {
  const block = entry.resp_headers?.["X-Xudbin-Block"]?.[0];
  if (entry.status === 403 && block === "waf") return "waf";
  if (entry.status === 403 && block) return block === "blocklist" ? "blocked" : "denied";
  // İşaretsiz 403 uygulamanın kendi yanıtıdır (WAF engeli Caddy'de X-Xudbin-Block: waf ile işaretlenir); olay sayılmaz.
  if (entry.status === 429) return "ratelimit";
  if (entry.status === 401) return "auth";
  return null;
}

const MAX_CHUNK = 4 * 1024 * 1024;
/** Bir turda en fazla bu kadar parça okunur; yoğun trafikte geride kalınırsa sonraki turlarda yetişilir. */
const MAX_CHUNKS_PER_TICK = 8;

/** Sunucunun Caddy erişim logundan son okunan yerden itibaren yeni satırları okur; güvenlik olaylarını ve analitiği işler. */
async function ingestServer(server: ServerRow) {
  const docker = dockerFor(server);
  let total = 0;
  for (let i = 0; i < MAX_CHUNKS_PER_TICK; i++) {
    const stat = await execIn(docker, CADDY_CONTAINER, ["sh", "-c", `stat -c '%s %i' ${ACCESS_LOG} 2>/dev/null || echo '0 0'`], { timeoutMs: 15_000 });
    const [sizeStr, inode] = stat.stdout.trim().split(" ");
    const size = Number(sizeStr) || 0;
    let offset = server.log_offset;
    // Log döndürüldüyse (Caddy dosyayı yeniden adlandırıp yenisini açar) baştan okunur.
    if (size < offset || (server.log_inode && inode && inode !== server.log_inode)) offset = 0;
    if (inode && inode !== server.log_inode) {
      updateServer(server.id, { log_inode: inode });
      server.log_inode = inode;
    }
    if (size === offset) break;

    const length = Math.min(size - offset, MAX_CHUNK);
    const res = await execIn(docker, CADDY_CONTAINER, ["sh", "-c", `tail -c +${offset + 1} ${ACCESS_LOG} | head -c ${length}`], { timeoutMs: 30_000 });
    const text = res.stdout;
    const lastNewline = text.lastIndexOf("\n");
    if (lastNewline < 0) break;
    const complete = text.slice(0, lastNewline);
    server.log_offset = offset + Buffer.byteLength(complete) + 1;
    updateServer(server.id, { log_offset: server.log_offset });
    total += processLines(server.id, complete.split("\n"));
    if (size - server.log_offset <= 0) break;
  }
  return total;
}

function processLines(serverId: number, lines: string[]) {
  const insert = db.prepare(
    `INSERT INTO security_events (server_id, host, ip, kind, method, path, status, user_agent, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const entries: AccessLog[] = [];
  let count = 0;
  for (const line of lines) {
    let entry: AccessLog;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    entries.push(entry);
    const kind = classify(entry);
    if (!kind) continue;
    const r = entry.request ?? {};
    insert.run(
      serverId,
      r.host ?? null,
      r.client_ip ?? r.remote_ip ?? "?",
      kind,
      r.method ?? null,
      (r.uri ?? "").slice(0, 500),
      entry.status ?? null,
      r.headers?.["User-Agent"]?.[0]?.slice(0, 300) ?? null,
      Math.round((entry.ts ?? Date.now() / 1000) * 1000),
    );
    count++;
  }
  try {
    ingestAnalytics(entries);
  } catch (err) {
    console.error("Analitik işlenemedi:", (err as Error).message);
  }
  return count;
}

/** Otomatik banı yalnız Coraza'nın engellediği istekler ve panel girişindeki başarısız denemeler tetikler; uygulamanın kendi 401/403/429 yanıtları saldırı sayılmaz. */
export const BAN_KINDS = ["waf", "panel_login"] as const;

/**
 * WAF engelleri ancak bu kadar farklı adrese dağılmışsa banı tetikler. Tarayıcı botlar onlarca farklı yolu dener;
 * gerçek bir kullanıcı ise WAF'ın yanlış pozitif verdiği aynı form/action adresine tekrar tekrar takılır
 * (idas-stok'ta dükkân IP'si böyle banlandı). Engelleme yine istek başına sürer, yalnız ban atılmaz.
 */
export const WAF_BAN_MIN_PATHS = 5;

/** Panelin kendi giriş ekranına yapılan başarısız denemeler de güvenlik olayıdır. */
export function recordPanelEvent(ip: string, kind: string, path: string, userAgent?: string) {
  db.prepare(
    "INSERT INTO security_events (server_id, ip, kind, method, path, status, user_agent, created_at) VALUES (NULL, ?, ?, 'POST', ?, 401, ?, ?)",
  ).run(ip, kind, path, userAgent ?? null, Date.now());
}

const PRIVATE_RANGES = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "127.0.0.0/8", "169.254.0.0/16", "100.64.0.0/10", "fc00::/7", "fe80::/10"];

/** Eşiği aşan IP'leri geçici olarak banlar ve tüm sunuculardaki Caddy yapılandırmasını günceller. */
export async function autoBan() {
  const s = getSettings();
  db.prepare("DELETE FROM blocked_ips WHERE expires_at IS NOT NULL AND expires_at < ?").run(Date.now());
  if (!s.autoBanEnabled) return [];
  const since = Date.now() - s.autoBanWindowMin * 60_000;
  const offenders = db
    .prepare(
      `SELECT ip, COUNT(*) AS n,
              SUM(kind = 'panel_login') AS login,
              COUNT(DISTINCT CASE WHEN kind = 'waf' THEN COALESCE(host, '') || ' ' || COALESCE(path, '') END) AS paths
       FROM security_events
       WHERE created_at > ? AND kind IN (${BAN_KINDS.map((k) => `'${k}'`).join(", ")}) AND ip NOT IN (SELECT ip FROM blocked_ips)
       GROUP BY ip HAVING n >= ? AND (login >= ? OR paths >= ?)`,
    )
    .all(since, s.autoBanThreshold, s.autoBanThreshold, WAF_BAN_MIN_PATHS) as { ip: string; n: number; paths: number }[];
  const banned: string[] = [];
  const allow = allAllowIps();
  // Açık oturumu olan bir yöneticinin adresi otomatik banlanmaz: panel sahibi kendini kilitlemesin.
  const adminIps = new Set(
    (db.prepare("SELECT DISTINCT s.ip FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.role = 'admin' AND s.expires_at > ? AND s.ip IS NOT NULL").all(Date.now()) as { ip: string }[]).map((r) => r.ip),
  );
  for (const o of offenders) {
    if (o.ip === "?" || o.ip === "127.0.0.1" || o.ip === "::1") continue;
    // Özel ağ adresleri ziyaretçi değildir (ör. tunnel/proxy konteyneri); banlanırsa o yoldan gelen herkes engellenir.
    if (ipInList(o.ip.replace(/^::ffff:/, ""), PRIVATE_RANGES) || adminIps.has(o.ip)) continue;
    if (ipInList(o.ip, allow)) continue; // izin listesindeki IP asla otomatik banlanmaz
    db.prepare("INSERT OR IGNORE INTO blocked_ips (ip, reason, auto, expires_at, created_at) VALUES (?, ?, 1, ?, ?)").run(
      o.ip,
      `${s.autoBanWindowMin} dakikada ${o.n} engellenen istek${o.paths ? `, ${o.paths} farklı adres` : ""}`,
      Date.now() + s.autoBanDurationH * 3_600_000,
      Date.now(),
    );
    banned.push(o.ip);
    notify("ip_banned", `${o.ip} banlandı`, `${s.autoBanWindowMin} dakikada ${o.n} engellenen istek. Ban ${s.autoBanDurationH} saat sürecek. Yanlışsa panelde Güvenlik → Banlı IP'ler'den kaldır.`);
  }
  if (banned.length) await applyToAllServers();
  return banned;
}

export async function applyToAllServers() {
  await Promise.allSettled(listServers().filter((s) => s.status === "ready").map((s) => applyCaddyConfig(s)));
}

/** Hiçbir uygulamanın izin listesinde (allowIps) bulunan adresler otomatik banlanmaz. */
function allAllowIps(): string[] {
  const rows = db.prepare("SELECT security FROM apps").all() as { security: string }[];
  return rows.flatMap((r) => parseSecurity(r.security).allowIps ?? []);
}

/** Engel listesi tek IP ve CIDR (IPv4/IPv6) içerebilir. */
export function isBlocked(ip: string) {
  const rows = db.prepare("SELECT ip FROM blocked_ips WHERE expires_at IS NULL OR expires_at > ?").all(Date.now()) as { ip: string }[];
  return ipInList(ip, rows.map((r) => r.ip));
}

let ticking = false;
export function startSecurityMonitor() {
  const tick = async () => {
    if (ticking) return;
    ticking = true;
    try {
      for (const server of listServers().filter((s) => s.status === "ready")) {
        await ingestServer(server).catch(() => {});
      }
      await autoBan();
      // 30 günden eski olayları temizle.
      db.prepare("DELETE FROM security_events WHERE created_at < ?").run(Date.now() - 30 * 86_400_000);
    } finally {
      ticking = false;
    }
  };
  setInterval(tick, 20_000).unref();
  setTimeout(tick, 5000).unref();
}
