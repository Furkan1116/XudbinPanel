import { isIP } from "node:net";
import { createMiddleware } from "hono/factory";
import { ipInList, isValidIpOrCidr } from "./cidr.js";
import { clientIp } from "./client-ip.js";
import { getSettings } from "./settings.js";
import type { AppEnv } from "./types.js";

/**
 * Panelin kendi IP izin listesi. Liste boşsa panel herkese açıktır (bugünkü davranış).
 * Doluysa Caddy panel alan adı ve https://<ip>:8443 rotalarında listede olmayan istemciye 403 verir;
 * panel de aynı kontrolü kendi içinde tekrarlar (Caddy yapılandırması uygulanamasa bile liste geçerli kalsın).
 */

/** Git sağlayıcılarının deploy webhook'ları dışarıdan gelir ve kendi token'ıyla korunur; izin listesi onları kesmez. */
export const PANEL_ALLOW_EXEMPT_PREFIX = "/api/webhooks/";

/** Girdiyi temizler: boşları atar, tekrarları kaldırır, "/032" gibi önek uzunluklarını sadeleştirir. */
export function normalizeAllowList(entries: string[]): string[] {
  const out: string[] = [];
  for (const raw of entries) {
    const e = raw.trim();
    if (!e) continue;
    const [addr, len] = e.split("/") as [string, string | undefined];
    const norm = len === undefined ? addr.toLowerCase() : `${addr.toLowerCase()}/${Number(len)}`;
    if (!out.includes(norm)) out.push(norm);
  }
  return out;
}

export function invalidAllowEntries(entries: string[]): string[] {
  return entries.filter((e) => !isValidIpOrCidr(e));
}

/** Panelin kendi içinden yapılan istekler (konteyner sağlık kontrolü) loopback'ten gelir; Caddy her zaman gerçek IP'yi iletir. */
function isLoopback(ip: string) {
  return ip === "::1" || ip === "::ffff:127.0.0.1" || (isIP(ip) === 4 && ip.startsWith("127."));
}

export function panelIpAllowed(ip: string, list: string[]): boolean {
  if (!list.length) return true;
  return isIP(ip) !== 0 && ipInList(ip, list);
}

/**
 * Yönetici kendini dışarıda bırakmasın: kaydedilecek liste doluysa ve isteği yapanın IP'si listede yoksa hata metni döner.
 * Kilitlenme olursa sunucuda: xudbin panel-allow clear
 */
export function selfLockoutError(list: string[], requesterIp: string): string | null {
  if (!list.length || panelIpAllowed(requesterIp, list)) return null;
  return `Şu anki IP adresin (${requesterIp}) listede yok; kaydedersen panele erişimin kesilir. Önce kendi adresini ekle.`;
}

export const panelAccessGuard = createMiddleware<AppEnv>(async (c, next) => {
  const list = getSettings().panelAllowIps;
  if (!list.length || c.req.path.startsWith(PANEL_ALLOW_EXEMPT_PREFIX)) return next();
  const ip = clientIp(c);
  if (isLoopback(ip) || panelIpAllowed(ip, list)) return next();
  return c.req.path.startsWith("/api/") ? c.json({ error: "Bu IP adresinden panele erişim kapalı" }, 403) : c.text("Erişim engellendi.", 403);
});
