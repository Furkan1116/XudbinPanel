import { db } from "../db.js";
import { getSettings } from "../lib/settings.js";

/** Bir uygulamaya eklenebilecek en fazla alan adı (otomatik adresler dahil). */
export const MAX_DOMAINS_PER_APP = 50;

/**
 * Panelin kendi adresleri: ayarlardaki panel alan adı, kurulumda verilen XUDBIN_DOMAIN ve
 * kurulumun ürettiği `xudbin.<ip>.sslip.io` adresi. Bir uygulamaya bağlanırsa panelin sertifikası
 * atlanır ya da panel trafiği uygulamaya yönlenebilir (bağımsız inceleme O7).
 */
export function panelHosts(): string[] {
  const hosts = new Set<string>();
  const add = (h: string | null | undefined) => {
    const v = h?.trim().toLowerCase();
    if (v) hosts.add(v);
  };
  add(getSettings().panelDomain);
  add(process.env.XUDBIN_DOMAIN);
  for (const s of db.prepare("SELECT public_ip FROM servers WHERE public_ip IS NOT NULL").all() as { public_ip: string }[]) {
    add(`xudbin.${s.public_ip.replace(/\./g, "-")}.sslip.io`);
  }
  return [...hosts];
}

/**
 * Alan adı eklenebilir mi? Sorun varsa kullanıcıya gösterilecek metin, yoksa null.
 * Panel alan adının kendisi herkese kapalıdır; alt alanları yalnız yöneticiye açıktır.
 */
export function domainProblem(host: string, role: string, currentCount: number, panel: string[] = panelHosts()): string | null {
  const h = host.trim().toLowerCase();
  if (currentCount >= MAX_DOMAINS_PER_APP) return `Bir uygulamaya en fazla ${MAX_DOMAINS_PER_APP} alan adı eklenebilir`;
  for (const p of panel) {
    if (h === p) return "Bu alan adı panelin kendi adresi; uygulamaya bağlanamaz";
    if (role !== "admin" && h.endsWith(`.${p}`)) return "Panelin alt alan adları yalnız yönetici tarafından eklenebilir";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Yönlendirmeler (www → çıplak alan adı gibi)
// ---------------------------------------------------------------------------

/**
 * Uygulamayı gerçekten servis eden alan adları için SQL koşulu. Yönlendiren bir alan adı uygulamanın adresi
 * sayılmaz: XUDBIN_URL / XUDBIN_DOMAINS, erişilebilirlik ve sağlık kontrolleri, analitik ve önizleme adresi
 * hep bu koşulla seçilir.
 */
export const SERVING_DOMAIN = "redirect_to IS NULL";

/** Uygulamanın servis eden alan adları; ilki uygulamanın asıl adresidir (önce kendi alan adları, sonra otomatik adresler). */
export function servingDomains(appId: number): { host: string; https: number }[] {
  return db.prepare(`SELECT host, https FROM domains WHERE app_id = ? AND ${SERVING_DOMAIN} ORDER BY generated, id`).all(appId) as { host: string; https: number }[];
}

/** Uygulamanın asıl adresi (yönlendiren alan adları hariç), yoksa undefined. */
export function primaryDomain(appId: number): { host: string; https: number } | undefined {
  return servingDomains(appId)[0];
}

/**
 * Bir alan adının yönlendirme hedefi geçerli mi? Sorun varsa kullanıcıya gösterilecek metin, yoksa null.
 * Hedef aynı uygulamanın başka bir alan adı olmalı ve kendisi yönlendirme olmamalı; yönlendirme hedefi olan bir
 * alan adı da yönlendirilemez. Böylece zincir ve döngü oluşamaz, panel dış adreslere açık yönlendirici olamaz.
 */
export const REDIRECT_TARGET_ERROR = "Yönlendirme hedefi bu uygulamanın, uygulamayı servis eden alan adlarından biri olmalı";
export const REDIRECT_DELETE_ERROR = "Bu alan adına yönlendiren adresler var. Önce onların yönlendirmesini kaldır ya da başka adrese çevir.";

export function redirectProblem(appId: number, domainId: number, targetId: number | null): string | null {
  const domain = db.prepare("SELECT id FROM domains WHERE id = ? AND app_id = ?").get(domainId, appId);
  if (!domain) return "Alan adı bulunamadı";
  if (targetId === null) return null;
  if (targetId === domainId) return "Bir alan adı kendisine yönlendirilemez";
  // Metinler sabit: panel arayüzü sunucu hatalarını birebir eşleşmeyle çevirir.
  const target = db.prepare("SELECT redirect_to FROM domains WHERE id = ? AND app_id = ?").get(targetId, appId) as { redirect_to: number | null } | undefined;
  if (!target) return REDIRECT_TARGET_ERROR;
  if (target.redirect_to !== null) return "Hedef alan adı zaten başka bir adrese yönlendiriyor; uygulamayı servis eden bir alan adı seç";
  if (redirectSources(domainId).length) return "Bu alan adına yönlendiren adresler var; önce onların yönlendirmesini değiştir";
  return null;
}

/** Verilen alan adına yönlendiren alan adları. */
export function redirectSources(domainId: number): string[] {
  return (db.prepare("SELECT host FROM domains WHERE redirect_to = ? ORDER BY id").all(domainId) as { host: string }[]).map((r) => r.host);
}
