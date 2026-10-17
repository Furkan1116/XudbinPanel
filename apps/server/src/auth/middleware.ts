import { getCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../lib/types.js";
import { validateApiToken } from "./api-tokens.js";
import { validateSession } from "./session.js";

export const SESSION_COOKIE = "xudbin_session";

export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  // API anahtarı (CI/CD, CLI): Authorization: Bearer xb_...
  const bearer = c.req.header("authorization")?.match(/^Bearer\s+(xb_[\w-]+)$/)?.[1];
  if (bearer) {
    const found = validateApiToken(bearer);
    if (!found) return c.json({ error: "API anahtarı geçersiz veya süresi dolmuş" }, 401);
    if (found.readOnly && c.req.method !== "GET") return c.json({ error: "Bu API anahtarı salt okunur" }, 403);
    // Anahtarla yeni anahtar üretilemez, hesap ayarları değiştirilemez.
    if (/^\/api\/settings\/account/.test(c.req.path) && c.req.method !== "GET") return c.json({ error: "Hesap ayarları API anahtarıyla değiştirilemez" }, 403);
    c.set("user", found.user);
    c.set("viaToken", true);
    c.set("tokenReadOnly", found.readOnly);
    return next();
  }
  const token = getCookie(c, SESSION_COOKIE);
  const user = token ? validateSession(token) : null;
  if (!user) return c.json({ error: "Oturum açmanız gerekiyor" }, 401);
  c.set("user", user);
  await next();
});

/**
 * Üye rolündeki kullanıcılar uygulama, proje ve veritabanlarını yönetir; sunucular, güvenlik,
 * panel ayarları, bildirimler, SSH anahtarları ve kullanıcılar yalnız yöneticiye açıktır.
 */
// Sunucu listesi (`/api/servers`) üyeye yalnız asgari alanlarla açık; altındaki her şey (kurulum günlüğü, konteynerler,
// güvenlik taraması, durum) yalnız yönetici.
const ADMIN_ANY = [/^\/api\/ssh-keys/, /^\/api\/servers\/.+/, /^\/api\/users/, /^\/api\/settings\/(panel|notifications|backup|audit|sso|github(?!\/repos))/, /^\/api\/security/];
const ADMIN_WRITE = [/^\/api\/servers/, /^\/api\/security/];

export const enforceRoles = createMiddleware<AppEnv>(async (c, next) => {
  const user = c.get("user");
  // Geçici şifreyle giren kullanıcı, şifresini değiştirene kadar başka bir şey yapamaz.
  if (user.mustChangePassword && !/^\/api\/settings\/account(\/password)?$/.test(c.req.path)) {
    return c.json({ error: "Önce şifreni değiştirmen gerekiyor", mustChangePassword: true }, 403);
  }
  if (user.role !== "admin") {
    const p = c.req.path;
    const write = c.req.method !== "GET";
    if (ADMIN_ANY.some((r) => r.test(p)) || (write && ADMIN_WRITE.some((r) => r.test(p)))) {
      return c.json({ error: "Bu işlem için yönetici yetkisi gerekiyor" }, 403);
    }
  }
  await next();
});
