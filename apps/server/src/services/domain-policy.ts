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
