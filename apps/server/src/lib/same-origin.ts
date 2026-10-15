import { createMiddleware } from "hono/factory";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * CSRF koruması: durum değiştiren her istek JSON olmalı ve (tarayıcıdan geliyorsa)
 * panelin kendi adresinden gelmeli. SameSite=Strict cookie ile birlikte ikinci bir savunma katmanı.
 */
export const sameOrigin = createMiddleware(async (c, next) => {
  if (SAFE_METHODS.has(c.req.method)) return next();

  const type = c.req.header("content-type") ?? "";
  // Proje arşivi yüklemeleri zip olarak gelir; Origin kontrolü onlar için de geçerli.
  const isUpload = /\/upload(s)?$/.test(c.req.path) && /^application\/(zip|octet-stream|x-zip-compressed)/.test(type);
  if (!type.startsWith("application/json") && !isUpload) {
    return c.json({ error: "İstek JSON olmalı" }, 415);
  }
  if (c.req.header("sec-fetch-site") === "cross-site") {
    return c.json({ error: "Başka siteden gelen istek reddedildi" }, 403);
  }
  const origin = c.req.header("origin");
  if (origin) {
    const host = c.req.header("x-forwarded-host") ?? c.req.header("host");
    if (URL.canParse(origin) && new URL(origin).host !== host) {
      return c.json({ error: "Başka siteden gelen istek reddedildi" }, 403);
    }
  }
  return next();
});
