import { dockerFor } from "./docker.js";
import { serverBusy } from "./deploy.js";
import { listServers } from "./servers.js";

/**
 * Günlük bakım: bir haftadan eski Docker derleme önbelleği ve sahipsiz (dangling) imajlar silinir.
 * Uygulama imajları ayrıca deploy sırasında son 3 sürüm tutularak temizlenir.
 */
export async function pruneServer(serverId: number) {
  const server = listServers().find((s) => s.id === serverId);
  if (!server || server.status !== "ready") return { reclaimed: 0 };
  // Derleme sürerken sahipsiz imajlar silinirse çok aşamalı derlemenin ara katmanları kaybolur.
  if (serverBusy(serverId)) return { reclaimed: 0 };
  const docker = dockerFor(server);
  const builder = (await docker.pruneBuilder({ filters: { until: ["168h"] } } as object).catch(() => ({ SpaceReclaimed: 0 }))) as { SpaceReclaimed?: number };
  const images = (await docker.pruneImages({ filters: { dangling: ["true"] } }).catch(() => ({ SpaceReclaimed: 0 }))) as { SpaceReclaimed?: number };
  return { reclaimed: (builder.SpaceReclaimed ?? 0) + (images.SpaceReclaimed ?? 0) };
}

export function startMaintenance() {
  const run = async () => {
    for (const s of listServers().filter((x) => x.status === "ready")) {
      const r = await pruneServer(s.id).catch(() => ({ reclaimed: 0 }));
      if (r.reclaimed > 100 * 1024 * 1024) console.log(`${s.name}: ${(r.reclaimed / 1024 / 1024).toFixed(0)} MB derleme önbelleği temizlendi`);
    }
  };
  setTimeout(run, 5 * 60_000).unref();
  setInterval(run, 24 * 3_600_000).unref();
}
