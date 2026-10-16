import { lookup } from "node:dns/promises";
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

export function clientIp(c: Context): string {
  const remote = getConnInfo(c).remote.address ?? "unknown";
  if (!config.trustProxy) return remote;
  if (Date.now() - resolvedAt > 60_000) void refreshProxyIps();
  if (!proxyIps.has(remote)) return remote;
  const forwarded = c.req.header("x-forwarded-for")?.split(",").pop()?.trim();
  return forwarded || remote;
}
