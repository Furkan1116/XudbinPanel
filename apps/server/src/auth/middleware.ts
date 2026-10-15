import { getCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../lib/types.js";
import { validateSession } from "./session.js";

export const SESSION_COOKIE = "xudbin_session";

export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
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
const ADMIN_ANY = [/^\/api\/ssh-keys/, /^\/api\/users/, /^\/api\/settings\/(panel|notifications)/];
const ADMIN_WRITE = [/^\/api\/servers/, /^\/api\/security/];

export const enforceRoles = createMiddleware<AppEnv>(async (c, next) => {
  const user = c.get("user");
  if (user.role !== "admin") {
    const p = c.req.path;
    const write = c.req.method !== "GET";
    if (ADMIN_ANY.some((r) => r.test(p)) || (write && ADMIN_WRITE.some((r) => r.test(p)))) {
      return c.json({ error: "Bu işlem için yönetici yetkisi gerekiyor" }, 403);
    }
  }
  await next();
});
