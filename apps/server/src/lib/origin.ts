import type { Context } from "hono";
import { config } from "../config.js";

/** Panelin dışarıdan görünen adresi (Caddy arkasında X-Forwarded-* başlıklarından). */
export function publicOrigin(c: Context) {
  const proto = (config.trustProxy && c.req.header("x-forwarded-proto")) || new URL(c.req.url).protocol.replace(":", "");
  const host = (config.trustProxy && c.req.header("x-forwarded-host")) || c.req.header("host") || new URL(c.req.url).host;
  return `${proto}://${host}`;
}
