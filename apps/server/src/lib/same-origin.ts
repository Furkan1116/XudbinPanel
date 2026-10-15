import { createMiddleware } from "hono/factory";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * CSRF koruması: durum değiştiren her istek JSON olmalı ve (tarayıcıdan geliyorsa)
 * panelin kendi adresinden gelmeli. SameSite=Strict cookie ile birlikte ikinci bir savunma katmanı.
 */
export const sameOrigin = createMiddleware(async (c, next) => {
  if (SAFE_METHODS.has(c.req.method)) return next();

  if (!c.req.header("content-type")?.startsWith("application/json")) {
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
