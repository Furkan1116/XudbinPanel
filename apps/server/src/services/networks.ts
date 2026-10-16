import type Docker from "dockerode";
import { config } from "../config.js";
import { db } from "../db.js";
import { CADDY_CONTAINER } from "./caddy.js";
import { dockerFor, type ServerRow } from "./docker.js";

/**
 * Ağ ayrımı: her projenin uygulamaları ve veritabanları kendi Docker ağındadır (xb-p<id>), birbirini yalnız
 * aynı projedekiler görür. Caddy tüm proje ağlarına bağlıdır. Panel ayrı bir ağda (xudbin-panel) yalnız
 * Caddy ile konuşur; uygulamalar panelin API'sine doğrudan ulaşamaz.
 */
export const projectNetwork = (projectId: number) => `xb-p${projectId}`;
export const PANEL_NETWORK = "xudbin-panel";

async function ensureNamed(docker: Docker, name: string, labels: Record<string, string>) {
  const nets = await docker.listNetworks({ filters: { name: [name] } });
  if (!nets.some((n) => n.Name === name)) await docker.createNetwork({ Name: name, Driver: "bridge", Labels: { "xudbin.managed": "true", ...labels } });
}

async function connect(docker: Docker, network: string, container: string, aliases: string[] = []) {
  const info = await docker.getContainer(container).inspect().catch(() => null);
  if (!info || info.NetworkSettings.Networks[network]) return false;
  await docker.getNetwork(network).connect({ Container: container, EndpointConfig: aliases.length ? { Aliases: aliases } : {} });
  return true;
}

async function disconnect(docker: Docker, network: string, container: string) {
  const info = await docker.getContainer(container).inspect().catch(() => null);
  if (!info?.NetworkSettings.Networks[network]) return;
  await docker.getNetwork(network).disconnect({ Container: container, Force: true }).catch(() => {});
}

/** Projenin ağını oluşturur ve Caddy'yi bağlar; konteyner oluşturmadan önce çağrılır. */
export async function ensureProjectNetwork(server: ServerRow, projectId: number) {
  const docker = dockerFor(server);
  const name = projectNetwork(projectId);
  await ensureNamed(docker, name, { "xudbin.project": String(projectId) });
  await connect(docker, name, CADDY_CONTAINER).catch(() => {});
  return name;
}

/**
 * Açılışta ve sunucu kurulumundan sonra: çalışan uygulama ve veritabanı konteynerlerini kendi proje ağlarına
 * canlı olarak bağlar, ortak ağdan ayırır. Yeniden deploy gerekmez. Yerel sunucuda Caddy'yi panel ağına bağlar.
 */
export async function reconcileNetworks(server: ServerRow) {
  const docker = dockerFor(server);
  if (server.kind === "local") {
    const panelNet = await docker.listNetworks({ filters: { name: [PANEL_NETWORK] } });
    if (panelNet.some((n) => n.Name === PANEL_NETWORK)) await connect(docker, PANEL_NETWORK, CADDY_CONTAINER).catch(() => {});
  }
  const apps = db.prepare("SELECT project_id, slug, container, source_type FROM apps WHERE server_id = ?").all(server.id) as {
    project_id: number;
    slug: string;
    container: string | null;
    source_type: string;
  }[];
  const dbs = db.prepare("SELECT project_id, slug FROM databases WHERE server_id = ?").all(server.id) as { project_id: number; slug: string }[];
  let moved = 0;
  for (const a of apps) {
    const net = await ensureProjectNetwork(server, a.project_id);
    const names =
      a.source_type === "compose"
        ? (await docker.listContainers({ all: true, filters: { label: [`com.docker.compose.project=xb-${a.slug}`] } })).map((c) => c.Names[0]!.slice(1))
        : a.container
          ? [a.container]
          : [];
    for (const n of names) {
      if (await connect(docker, net, n, a.source_type === "compose" ? [] : [`xb-${a.slug}`]).catch(() => false)) moved++;
      await disconnect(docker, config.network, n);
    }
  }
  for (const d of dbs) {
    const net = await ensureProjectNetwork(server, d.project_id);
    if (await connect(docker, net, `xb-db-${d.slug}`).catch(() => false)) moved++;
    await disconnect(docker, config.network, `xb-db-${d.slug}`);
  }
  return moved;
}
