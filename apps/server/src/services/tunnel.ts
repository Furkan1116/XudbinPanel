import { createHash } from "node:crypto";
import { config } from "../config.js";
import { decrypt } from "../lib/crypto.js";
import { dockerFor, ensureNetwork, pullImage, removeContainer, type ServerRow } from "./docker.js";

/**
 * Cloudflare Tunnel: dış IP'si olmayan / port açamayan sunucular (ev sunucusu, NAT arkası) için.
 * Panel sunucuda cloudflared'i, Cloudflare panelinden alınan token ile çalıştırır. Cloudflare'de her alan adı
 * için "Public hostname" eklenir ve servis olarak http://xudbin-caddy:80 verilir; HTTPS'i Cloudflare sağlar.
 */
export const TUNNEL_CONTAINER = "xudbin-tunnel";
const IMAGE = "cloudflare/cloudflared:2026.9.0";

export async function ensureTunnel(server: ServerRow) {
  const docker = dockerFor(server);
  const token = server.tunnel_token ? decrypt(server.tunnel_token) : "";
  const hash = token ? createHash("sha256").update(token).digest("hex").slice(0, 16) : "";
  const existing = await docker.getContainer(TUNNEL_CONTAINER).inspect().catch(() => null);
  if (!token) {
    if (existing) await removeContainer(docker, TUNNEL_CONTAINER);
    return { running: false };
  }
  if (existing && existing.Config.Labels?.["xudbin.tunnel"] === hash && existing.State.Running) return { running: true };
  if (existing) await removeContainer(docker, TUNNEL_CONTAINER);
  await ensureNetwork(docker);
  await pullImage(docker, IMAGE, () => {});
  const c = await docker.createContainer({
    name: TUNNEL_CONTAINER,
    Image: IMAGE,
    Cmd: ["tunnel", "--no-autoupdate", "run"],
    Env: [`TUNNEL_TOKEN=${token}`],
    Labels: { "xudbin.managed": "true", "xudbin.tunnel": hash },
    HostConfig: { NetworkMode: config.network, RestartPolicy: { Name: "unless-stopped" } },
  });
  await c.start();
  return { running: true };
}

export async function tunnelStatus(server: ServerRow) {
  const info = await dockerFor(server).getContainer(TUNNEL_CONTAINER).inspect().catch(() => null);
  if (!info) return { enabled: Boolean(server.tunnel_token), running: false, logs: [] as string[] };
  const raw = (await dockerFor(server).getContainer(TUNNEL_CONTAINER).logs({ stdout: true, stderr: true, tail: 20 }).catch(() => Buffer.from(""))) as Buffer;
  const { demuxLogs } = await import("./deploy.js");
  const logs = demuxLogs(raw).map((l) => l.replace(/token=\S+/gi, "token=***"));
  return { enabled: Boolean(server.tunnel_token), running: info.State.Running, connected: logs.some((l) => /Registered tunnel connection/i.test(l)), logs };
}
