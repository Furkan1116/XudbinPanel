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

export type DiskUsage = {
  images: { count: number; bytes: number; danglingBytes: number };
  buildCache: { bytes: number; reclaimableBytes: number };
  volumes: { count: number; bytes: number };
  containers: { count: number; bytes: number };
};

/** Docker'ın diskte ne kadar yer kapladığı (docker system df): imajlar, derleme önbelleği, volume'lar, konteyner yazma katmanları. */
export async function dockerDiskUsage(serverId: number): Promise<DiskUsage> {
  const server = listServers().find((s) => s.id === serverId);
  if (!server) throw new Error("Sunucu bulunamadı");
  const df = (await dockerFor(server).df()) as {
    LayersSize?: number;
    Images?: { Size?: number; RepoTags?: string[] | null; Containers?: number }[];
    BuildCache?: { Size?: number; InUse?: boolean }[];
    Volumes?: { UsageData?: { Size?: number } }[];
    Containers?: { SizeRw?: number }[];
  };
  const sum = (xs: (number | undefined)[]) => xs.reduce<number>((n, x) => n + (x && x > 0 ? x : 0), 0);
  const images = df.Images ?? [];
  const dangling = images.filter((i) => !i.RepoTags?.length || i.RepoTags.every((t) => t === "<none>:<none>"));
  const cache = df.BuildCache ?? [];
  return {
    images: { count: images.length, bytes: df.LayersSize ?? sum(images.map((i) => i.Size)), danglingBytes: sum(dangling.map((i) => i.Size)) },
    buildCache: { bytes: sum(cache.map((b) => b.Size)), reclaimableBytes: sum(cache.filter((b) => !b.InUse).map((b) => b.Size)) },
    volumes: { count: (df.Volumes ?? []).length, bytes: sum((df.Volumes ?? []).map((v) => v.UsageData?.Size)) },
    containers: { count: (df.Containers ?? []).length, bytes: sum((df.Containers ?? []).map((c) => c.SizeRw)) },
  };
}

/**
 * Elle temizlik: tüm derleme önbelleği ve/veya sahipsiz (etiketsiz) imajlar. Uygulama imajlarına, durdurulmuş
 * konteynerlere ve volume'lara dokunulmaz (geri dönüş imajları ve durdurulan uygulamalar silinmesin).
 */
export async function pruneNow(serverId: number, what: { buildCache: boolean; danglingImages: boolean }) {
  const server = listServers().find((s) => s.id === serverId);
  if (!server || server.status !== "ready") throw new Error("Sunucu hazır değil");
  if (serverBusy(serverId)) throw new Error("Bu sunucuda şu an deploy sürüyor; bitince tekrar dene");
  const docker = dockerFor(server);
  let reclaimed = 0;
  if (what.buildCache) reclaimed += ((await docker.pruneBuilder({ all: true } as object)) as { SpaceReclaimed?: number }).SpaceReclaimed ?? 0;
  if (what.danglingImages) reclaimed += ((await docker.pruneImages({ filters: { dangling: ["true"] } })) as { SpaceReclaimed?: number }).SpaceReclaimed ?? 0;
  return { reclaimed };
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
