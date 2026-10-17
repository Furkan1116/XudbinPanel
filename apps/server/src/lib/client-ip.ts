import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { Context } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import { config } from "../config.js";

/**
 * X-Forwarded-For yalnız doğrudan bağlanan taraf Caddy ise (veya yerel geliştirmede loopback) dikkate alınır.
 * Aksi halde aynı ağdaki herhangi bir konteyner bu başlığı uydurup giriş hız sınırını atlatabilirdi.
 */
let proxyIps = new Set<string>(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
let resolvedAt = 0;

async function refreshProxyIps() {
  resolvedAt = Date.now();
  const ips = await lookup("xudbin-caddy", { all: true }).catch(() => []);
  proxyIps = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1", ...ips.flatMap((a) => [a.address, `::ffff:${a.address}`])]);
}
if (config.trustProxy) void refreshProxyIps();

/**
 * Güvenilir (Caddy) bağlantıda tek doğru kaynak Caddy'nin kendi koyduğu X-Xudbin-Client-Ip başlığıdır:
 * Caddy bunu trusted_proxies/client_ip_headers ile çözdüğü gerçek IP'ye ayarlar (Cloudflare Tunnel dahil).
 * XFF'nin son öğesi tunnel'da cloudflared'ın IP'si olurdu; yalnız eski yapılandırma için yedek olarak kalır.
 */
export function pickForwardedIp(header: string | undefined, xff: string | undefined): string | undefined {
  const own = header?.trim();
  if (own && isIP(own)) return own;
  const last = xff?.split(",").pop()?.trim();
  return last || undefined;
}

export function clientIp(c: Context): string {
  const remote = getConnInfo(c).remote.address ?? "unknown";
  if (!config.trustProxy) return remote;
  if (Date.now() - resolvedAt > 60_000) void refreshProxyIps();
  if (!proxyIps.has(remote)) return remote;
  return pickForwardedIp(c.req.header("x-xudbin-client-ip"), c.req.header("x-forwarded-for")) ?? remote;
}
