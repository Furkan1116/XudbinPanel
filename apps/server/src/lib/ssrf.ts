import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { config } from "../config.js";

/**
 * SSRF koruması (bağımsız inceleme O4): üyelerin verdiği adreslere (git clone adresi, uptime izleyicinin
 * alan adı) panel sunucusundan istek atılırken hedef özel/loopback/link-local gibi iç ağ adreslerine
 * çözülüyorsa istek yapılmaz.
 * Yönetici ayarları (bildirim webhook'u, S3, OIDC) bilerek bu süzgeçten geçmez: yerel ağdaki MinIO veya
 * kurum içi bir Keycloak meşru kullanımdır ve ayarı yalnız yönetici değiştirir.
 */

/** Adres IPv4 ise dört sekizli, değilse null. */
function v4Octets(ip: string): number[] | null {
  if (net.isIPv4(ip)) return ip.split(".").map(Number);
  return null;
}

/** IPv6 adresini 8 adet 16 bitlik gruba açar (yerel arayüz son eki ve gömülü IPv4 dahil). */
function v6Groups(ip: string): number[] | null {
  let s = ip.split("%")[0]!.toLowerCase();
  if (!net.isIPv6(s)) return null;
  const tail = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (tail) {
    const o = tail[1]!.split(".").map(Number);
    s = s.slice(0, -tail[1]!.length) + ((o[0]! << 8) | o[1]!).toString(16) + ":" + ((o[2]! << 8) | o[3]!).toString(16);
  }
  const [head, rest] = s.split("::");
  const h = head ? head.split(":") : [];
  const r = rest === undefined ? [] : rest ? rest.split(":") : [];
  const fill = s.includes("::") ? Array(8 - h.length - r.length).fill("0") : [];
  const groups = [...h, ...fill, ...r].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g)) ? groups : null;
}

function forbiddenV4(o: number[]): boolean {
  const [a, b, c] = o as [number, number, number, number];
  return (
    a === 0 || // "bu ağ", 0.0.0.0
    a === 10 ||
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // CGNAT 100.64/10
    (a === 169 && b === 254) || // link-local, bulut metadata (169.254.169.254)
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) || // 192.0.0/24 IETF, 192.0.2/24 test-net
    (a === 192 && b === 168) ||
    (a === 192 && b === 88 && c === 99) || // 6to4 relay
    (a === 198 && (b === 18 || b === 19)) || // kıyaslama ağı
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224 // çok noktaya yayın (224/4), ayrılmış (240/4), yayın (255.255.255.255)
  );
}

/** Verilen IP adresi (v4, v6, IPv4-mapped v6) iç ağ/özel/ayrılmış bir aralıkta mı? Geçersiz girdi de yasak sayılır. */
export function isForbiddenIp(ip: string): boolean {
  const v4 = v4Octets(ip);
  if (v4) return forbiddenV4(v4);
  const g = v6Groups(ip);
  if (!g) return true;
  const embedded = (hi: number, lo: number) => [hi >> 8, hi & 255, lo >> 8, lo & 255];
  const first5Zero = g.slice(0, 5).every((x) => x === 0);
  if (g.slice(0, 7).every((x) => x === 0)) return true; // ::, ::1 (ve ::a.b.c.d uyumluluk adresleri)
  if (first5Zero && g[5] === 0xffff) return forbiddenV4(embedded(g[6]!, g[7]!)); // ::ffff:a.b.c.d
  if (first5Zero && g[5] === 0) return true; // ::/96 IPv4-uyumlu
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return forbiddenV4(embedded(g[6]!, g[7]!)); // NAT64
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) return true; // yerel NAT64 (RFC 8215)
  if (g[0] === 0x2002) return forbiddenV4(embedded(g[1]!, g[2]!)); // 6to4: gömülü IPv4'e bak
  if (g[0] === 0x2001 && g[1] === 0) return true; // Teredo
  if (g[0] === 0x2001 && g[1] === 0xdb8) return true; // dokümantasyon
  if ((g[0]! & 0xfe00) === 0xfc00) return true; // fc00::/7 benzersiz yerel
  if ((g[0]! & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g[0]! & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (eski)
  if ((g[0]! & 0xff00) === 0xff00) return true; // ff00::/8 çok noktaya yayın
  return false;
}

function allowedByConfig(host: string) {
  return config.ssrfAllow.includes("*") || config.ssrfAllow.includes(host.toLowerCase().replace(/^\[|\]$/g, ""));
}

export class SsrfError extends Error {}

/**
 * Ana bilgisayar adını çözer ve TÜM adreslerin herkese açık olduğunu doğrular; birinden biri bile iç ağdaysa
 * reddeder (saldırgan hem herkese açık hem iç bir A kaydı koyabilir). Güvenli adresleri döndürür.
 */
export async function resolvePublic(host: string): Promise<{ address: string; family: 4 | 6 }[]> {
  const bare = host.replace(/^\[|\]$/g, "");
  const allow = allowedByConfig(bare);
  let addrs: { address: string; family: number }[];
  if (net.isIP(bare)) addrs = [{ address: bare, family: net.isIPv6(bare) ? 6 : 4 }];
  else {
    try {
      addrs = await dns.promises.lookup(bare, { all: true, verbatim: true });
    } catch (e) {
      throw new SsrfError(`${bare} çözülemedi: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`);
    }
  }
  if (!addrs.length) throw new SsrfError(`${bare} için adres bulunamadı`);
  if (!allow) {
    const bad = addrs.find((a) => isForbiddenIp(a.address));
    if (bad) throw new SsrfError(`${bare} iç ağ/özel bir adrese çözülüyor (${bad.address}); güvenlik nedeniyle bağlanılmaz`);
  }
  return addrs.map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }));
}

/**
 * Üye kaynaklı git adresi için ön denetim: yalnız https, kimlik bilgisi/yönlendirme hilesi yok, ana bilgisayar herkese açık.
 * SINIRLAMA: git adresi kendisi çözer; bu denetimle gerçek bağlantı arasında DNS yanıtı değişebilir (DNS-rebinding),
 * ayrıca git'in bağlantıları IP'ye sabitlenemez. Bu yüzden yönlendirmeler git tarafında kapatılır
 * (http.followRedirects=false) ve yalnız https'e izin verilir; kalan pencere dar bir TOCTOU yarışıdır, tam koruma değildir.
 * Tam yalıtım için panel sunucusunun giden trafiğini ağ düzeyinde (güvenlik duvarı) sınırlamak gerekir.
 */
export async function assertSafeGitUrl(raw: string): Promise<void> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new SsrfError("Git adresi geçersiz");
  }
  if (u.protocol !== "https:") throw new SsrfError("Git adresi https:// ile başlamalı");
  await resolvePublic(u.hostname);
}

/** `http.request` için lookup: çözülen adresleri doğrular; bağlantı tam bu doğrulanan IP'ye yapılır (DNS-rebinding'e karşı). */
export function safeLookup(host: string, options: dns.LookupOptions | ((...a: any[]) => void), cb?: (...a: any[]) => void) {
  const callback = (typeof options === "function" ? options : cb)!;
  const opts = typeof options === "function" ? {} : options;
  resolvePublic(host).then(
    (addrs) => (opts.all ? callback(null, addrs) : callback(null, addrs[0]!.address, addrs[0]!.family)),
    (err) => callback(err),
  );
}

export type SafeProbe = { status: number; ms: number };

/**
 * Üye kaynaklı adrese GET atar: bağlantı, doğrulanmış IP'ye yapılır (DNS çözümü ve denetim tek adımda),
 * yönlendirmeler takip edilmez (3xx yanıtı olduğu gibi durum kodu olarak döner), gövde okunmaz.
 */
export async function safeGet(url: string, opts: { timeoutMs?: number; headers?: Record<string, string> } = {}): Promise<SafeProbe> {
  // IP adresi doğrudan yazılmışsa Node lookup'u hiç çağırmaz; bu yüzden ayrıca denetlenir.
  try {
    const host = new URL(url).hostname;
    if (net.isIP(host.replace(/^\[|\]$/g, ""))) await resolvePublic(host);
  } catch (e) {
    if (e instanceof SsrfError) throw e;
  }
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return reject(new SsrfError("Geçersiz adres"));
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") return reject(new SsrfError("Yalnız http(s) adreslerine bağlanılır"));
    const mod = u.protocol === "https:" ? https : http;
    const req = mod.request(u, { method: "GET", lookup: safeLookup as any, headers: opts.headers, timeout: opts.timeoutMs ?? 15_000 }, (res) => {
      res.destroy();
      resolve({ status: res.statusCode ?? 0, ms: Date.now() - started });
    });
    req.on("timeout", () => req.destroy(Object.assign(new Error("zaman aşımı"), { code: "ETIMEDOUT" })));
    req.on("error", reject);
    req.end();
  });
}
