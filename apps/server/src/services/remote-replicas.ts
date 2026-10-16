import { db } from "../db.js";
import { randomToken } from "../lib/crypto.js";
import { CADDY_CONTAINER } from "./caddy.js";
import { probeHttp, isHealthy } from "./doctor.js";
import { containerState, dockerFor, execIn, imageExists, removeContainer, type ServerRow } from "./docker.js";
import { ensureProjectNetwork } from "./networks.js";
import { getServer } from "./servers.js";

/**
 * Çok sunuculu yük dağıtımı. Uygulama ana sunucusunun yanında seçilen "ek sunucularda" da çalışır; ziyaretçiler
 * her zaman ana sunucunun Caddy'sine gelir (alan adı, sertifika, WAF, hız sınırı, IP engeli orada uygulanır),
 * Caddy istekleri yerel ve uzak kopyalar arasında dağıtır, hata veren kopyayı devre dışı bırakır.
 *
 * Sunucular arası trafik şifrelidir: ana sunucu, ek sunucunun Caddy'sine 443 üzerinden TLS ile bağlanır. Ek sunucu
 * Caddy'sinin kendi iç sertifika otoritesi (CA) kullanılır ve ana sunucu yalnız o CA'ya güvenir (sabitlenmiş).
 * Ek sunucu isteği yalnız uygulamaya özel gizli başlık (X-Xudbin-Relay) varsa kabul eder; başlık uygulamaya iletilmez.
 *
 * Sınırlar: kalıcı klasörlü (volume) uygulamalar ve Compose dağıtılamaz (veri sunucular arasında paylaşılmaz).
 * Panelin veritabanları ana sunucunun iç ağında olduğundan ek sunucudaki kopyalar onlara ulaşamaz; veritabanını
 * dış erişime açıp bağlantı adresini ona göre vermek gerekir.
 */
export type RemoteReplica = { serverId: number; container: string };
type Route = Record<string, unknown>;

export const RELAY_HEADER = "X-Xudbin-Relay";
export const relayHost = (appId: number) => `app${appId}.relay.xudbin.internal`;
const CA_PATH = "/data/caddy/pki/authorities/local/root.crt";

export function parseIds(json: string | null | undefined): number[] {
  try {
    const v = JSON.parse(json || "[]");
    return Array.isArray(v) ? v.filter((n): n is number => Number.isInteger(n)) : [];
  } catch {
    return [];
  }
}

export function remoteReplicasOf(app: { remote_replicas?: string | null }): RemoteReplica[] {
  try {
    const v = JSON.parse(app.remote_replicas || "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

type RelayApp = { id: number; server_id: number; port: number; relay_secret: string | null; remote_replicas: string; container: string | null; replica_containers: string };
const relayApps = () =>
  db
    .prepare("SELECT id, server_id, port, relay_secret, remote_replicas, container, replica_containers FROM apps WHERE remote_replicas != '[]' AND relay_secret IS NOT NULL")
    .all() as RelayApp[];

const localContainers = (a: RelayApp) => (a.container ? [a.container, ...(JSON.parse(a.replica_containers || "[]") as string[])] : []);
const serverOrNull = (id: number) => {
  try {
    return getServer(id);
  } catch {
    return null;
  }
};

/**
 * Gelen aktarma rotaları (443, gizli başlık şartlı). Ek sunucuda: oradaki uzak kopyalara. Ana sunucuda: uygulamanın
 * yerel kopyalarına (ana sunucu da kendi kopyalarına aynı şifreli yoldan gider; böylece tüm kopyalar tek tip olur ve
 * bir sunucu çökünce bağlantı hatası alınıp istek diğer sunucuda yeniden denenir).
 */
export function incomingRelays(server: ServerRow): { routes: Route[]; hosts: string[] } {
  const routes: Route[] = [];
  const hosts: string[] = [];
  for (const a of relayApps()) {
    const isPrimary = a.server_id === server.id;
    const targets = isPrimary ? localContainers(a) : remoteReplicasOf(a).filter((r) => r.serverId === server.id).map((r) => r.container);
    if (!targets.length) continue;
    const primary = isPrimary ? server : serverOrNull(a.server_id);
    hosts.push(relayHost(a.id));
    routes.push({
      match: [{ header: { [RELAY_HEADER]: [a.relay_secret] } }],
      handle: [
        // İstek ana sunucuda zaten loglandı; analitikte iki kez sayılmasın.
        { handler: "vars", log_skip: true },
        {
          handler: "reverse_proxy",
          upstreams: targets.map((c) => ({ dial: `${c}:${a.port}` })),
          headers: { request: { delete: [RELAY_HEADER] } },
          // Ziyaretçinin gerçek IP'si ana sunucunun eklediği X-Forwarded-For'dan alınır (yalnız ana sunucudan gelirse).
          trusted_proxies: isPrimary ? ["127.0.0.1/32"] : primary?.public_ip ? [`${primary.public_ip}/32`] : [],
          ...(targets.length > 1 ? { load_balancing: { selection_policy: { policy: "round_robin" }, retries: 2 } } : {}),
        },
      ],
      terminal: true,
    });
  }
  return { routes, hosts };
}

export type OutgoingRelay = { upstreams: { dial: string; weight: number }[]; transport: unknown; headers: unknown };

/**
 * Ana sunucu tarafı: uygulamanın yük dağıtıcısının hedefleri. Kendi kopyaları için 127.0.0.1:443, her ek sunucu için
 * IP:443; hepsi TLS ile ve yalnız bu sunucuların iç CA'larına güvenerek. Ağırlık, o hedefteki kopya sayısıdır.
 * Kendi CA'sı henüz okunmadıysa boş döner (uygulama yalnız yerel kopyalarla, doğrudan çalışır).
 */
export function outgoingRelays(server: ServerRow): Map<number, OutgoingRelay> {
  const out = new Map<number, OutgoingRelay>();
  if (!server.relay_ca) return out;
  for (const a of relayApps().filter((x) => x.server_id === server.id)) {
    const upstreams: { dial: string; weight: number }[] = [];
    const cas = [server.relay_ca];
    const local = localContainers(a).length;
    if (local) upstreams.push({ dial: "127.0.0.1:443", weight: local });
    const bySrv = new Map<number, number>();
    for (const r of remoteReplicasOf(a)) bySrv.set(r.serverId, (bySrv.get(r.serverId) ?? 0) + 1);
    for (const [sid, n] of bySrv) {
      const extra = serverOrNull(sid);
      if (!extra?.public_ip || !extra.relay_ca) continue;
      upstreams.push({ dial: `${extra.public_ip}:443`, weight: n });
      if (!cas.includes(extra.relay_ca)) cas.push(extra.relay_ca);
    }
    if (upstreams.length < 2) continue;
    out.set(a.id, {
      upstreams,
      transport: { protocol: "http", dial_timeout: "3s", tls: { server_name: relayHost(a.id), ca: { provider: "inline", trusted_ca_certs: cas } } },
      // HTTPS hedefte Caddy Host'u hedef adrese çevirir; uygulama gerçek alan adını görmeli (ör. Django ALLOWED_HOSTS).
      headers: { request: { set: { [RELAY_HEADER]: [a.relay_secret], Host: ["{http.request.hostport}"] } } },
    });
  }
  return out;
}

/** Ek sunucu Caddy'sinin iç CA kök sertifikasını (DER, base64) okuyup saklar. */
export async function ensureRelayCa(server: ServerRow, log: (l: string) => void) {
  for (let i = 0; i < 10; i++) {
    const res = await execIn(dockerFor(server), CADDY_CONTAINER, ["cat", CA_PATH], { timeoutMs: 10_000 }).catch(() => ({ exitCode: 1, stdout: "" }));
    const m = res.exitCode === 0 ? /-----BEGIN CERTIFICATE-----([\s\S]+?)-----END CERTIFICATE-----/.exec(res.stdout) : null;
    if (m) {
      const der = m[1]!.replace(/\s+/g, "");
      if (der !== server.relay_ca) db.prepare("UPDATE servers SET relay_ca = ? WHERE id = ?").run(der, server.id);
      server.relay_ca = der;
      return der;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  log(`Uyarı: ${server.name} sunucusunun iç sertifika otoritesi okunamadı; bu sunucudaki kopyalara trafik gönderilmeyecek.`);
  return null;
}

/** Ek sunucu seçimi kurallara uyuyor mu? Uymuyorsa sebebini döndürür. */
export function extraServerProblem(app: { server_id: number; source_type: string; volumes: string }, extra: ServerRow) {
  if (extra.id === app.server_id) return "Ana sunucu ek sunucu olarak seçilemez";
  if (app.source_type === "compose") return "Docker Compose uygulamaları birden çok sunucuya dağıtılamaz";
  if (JSON.parse(app.volumes || "[]").length) return "Kalıcı klasörü olan uygulamalar birden çok sunucuya dağıtılamaz (veri sunucular arasında paylaşılmaz)";
  if (extra.status !== "ready") return `${extra.name} hazır değil`;
  if (!extra.public_ip) return `${extra.name} sunucusunun genel IP adresi bilinmiyor`;
  if (extra.https_mode === "off") return `${extra.name} sunucusunda HTTPS kapalı; sunucular arası şifreli bağlantı için açık olmalı`;
  const primary = serverOrNull(app.server_id);
  if (primary?.https_mode === "off") return "Uygulamanın sunucusunda HTTPS kapalı; sunucular arası şifreli bağlantı için açık olmalı";
  return null;
}

type Ctx = {
  app: { id: number; slug: string; project_id: number; port: number; command: string | null; memory_limit: number | null; cpu_limit: number | null; kind: string; http_check: number; health_path: string | null; relay_secret: string | null };
  primary: ServerRow;
  image: string;
  deploymentId: number;
  env: Record<string, string>;
  hosts: string[];
  log: (l: string) => void;
  signal: AbortSignal;
};

/** Ek sunuculara imajı aktarır, kopyaları başlatır ve sağlık kontrolü yapar. Başarısız sunucu atlanır (ana sunucu yayında kalır). */
export async function startRemoteReplicas(ctx: Ctx, extras: ServerRow[]): Promise<RemoteReplica[]> {
  const { app, log } = ctx;
  if (!extras.length) return [];
  if (!app.relay_secret) {
    app.relay_secret = randomToken(32);
    db.prepare("UPDATE apps SET relay_secret = ? WHERE id = ?").run(app.relay_secret, app.id);
  }
  if (Object.values(ctx.env).some((v) => /\bxb-[a-z0-9-]+\b/.test(v)) || Object.keys(ctx.env).some((k) => /DATABASE_URL|REDIS_URL|DB_HOST/.test(k))) {
    log("Not: Ek sunuculardaki kopyalar ana sunucunun iç ağındaki veritabanlarına ulaşamaz. Veritabanı kullanıyorsan onu dış erişime aç ve bağlantı adresini ona göre ver.");
  }
  const primaryDocker = dockerFor(ctx.primary);
  const arch = (a: string) => ({ x86_64: "amd64", aarch64: "arm64" })[a] ?? a;
  const primaryArch = arch((await primaryDocker.info()).Architecture as string);
  const started: RemoteReplica[] = [];
  for (const extra of extras) {
    const docker = dockerFor(extra);
    const name = `xb-${app.slug}-${ctx.deploymentId}-s${extra.id}`;
    try {
      if (ctx.signal.aborted) throw new Error(String(ctx.signal.reason));
      const extraArch = arch((await docker.info()).Architecture as string);
      if (extraArch !== primaryArch) throw new Error(`mimari farklı (${extraArch}, ana sunucu ${primaryArch})`);
      if (!(await imageExists(docker, ctx.image))) {
        log(`İmaj ${extra.name} sunucusuna aktarılıyor...`);
        const res = await docker.loadImage(await primaryDocker.getImage(ctx.image).get());
        await new Promise<void>((resolve, reject) => docker.modem.followProgress(res, (err) => (err ? reject(err) : resolve())));
      }
      const network = await ensureProjectNetwork(extra, app.project_id);
      log(`Konteyner başlatılıyor: ${name} (${extra.name})`);
      const c = await docker.createContainer({
        name,
        Image: ctx.image,
        Env: Object.entries({ ...ctx.env, XUDBIN_REPLICA: `s${extra.id}`, XUDBIN_SERVER: extra.name }).map(([k, v]) => `${k}=${v}`),
        Cmd: app.command ? ["sh", "-c", app.command] : undefined,
        Labels: { "xudbin.managed": "true", "xudbin.app": app.slug, "xudbin.deployment": String(ctx.deploymentId), "xudbin.remote": "true" },
        HostConfig: {
          NetworkMode: network,
          RestartPolicy: { Name: "unless-stopped" },
          ...(app.memory_limit ? { Memory: app.memory_limit * 1024 * 1024, MemorySwap: app.memory_limit * 1024 * 1024 } : {}),
          ...(app.cpu_limit ? { NanoCpus: Math.round(app.cpu_limit * 1e9) } : {}),
          LogConfig: { Type: "json-file", Config: { "max-size": "10m", "max-file": "3" } },
        },
      });
      await c.start();
      await waitHealthy(ctx, extra, name);
      started.push({ serverId: extra.id, container: name });
    } catch (err) {
      log(`Uyarı: ${extra.name} sunucusundaki kopya başlatılamadı: ${(err as Error).message}. Bu sunucu bu sürümde atlanıyor.`);
      await removeContainer(docker, name).catch(() => {});
    }
  }
  return started;
}

async function waitHealthy(ctx: Ctx, extra: ServerRow, name: string) {
  const docker = dockerFor(extra);
  const deadline = Date.now() + 120_000;
  if (ctx.app.kind === "worker") {
    await new Promise((r) => setTimeout(r, 10_000));
    const st = await containerState(docker, name);
    if (!st.running) throw new Error(`işçi kapandı (çıkış kodu ${st.exitCode})`);
    return;
  }
  for (;;) {
    if (ctx.signal.aborted) throw new Error(String(ctx.signal.reason));
    const st = await containerState(docker, name);
    if (!st.running) throw new Error(`konteyner kapandı (çıkış kodu ${st.exitCode})`);
    const probe = await execIn(docker, CADDY_CONTAINER, ["nc", "-z", "-w", "2", name, String(ctx.app.port)], { timeoutMs: 10_000 }).catch(() => ({ exitCode: 1 }));
    if (probe.exitCode === 0) break;
    if (Date.now() > deadline) throw new Error(`2 dakika içinde ${ctx.app.port} portunu açmadı`);
    await new Promise((r) => setTimeout(r, 1500));
  }
  if (ctx.app.http_check) {
    const host = ctx.hosts[0] ?? `xb-${ctx.app.slug}`;
    const path = ctx.app.health_path || "/";
    const until = Date.now() + 45_000;
    for (;;) {
      const p = await probeHttp(docker, name, ctx.app.port, host, path);
      if (p.status !== null && isHealthy(p.status, Boolean(ctx.app.health_path))) break;
      if (Date.now() > until) throw new Error(`HTTP kontrolü geçmedi (${p.statusLine || p.error})`);
      await new Promise((r) => setTimeout(r, 2500));
    }
  }
  ctx.log(`${name} (${extra.name}) çalışıyor.`);
}

/** Uzak kopyaları kaldırır (eski sürüm, ek sunucudan çıkarma veya uygulama silme). */
export async function removeRemoteReplicas(list: RemoteReplica[], log: (l: string) => void = () => {}) {
  for (const r of list) {
    try {
      const s = getServer(r.serverId);
      log(`Eski konteyner kaldırılıyor: ${r.container} (${s.name})`);
      await removeContainer(dockerFor(s), r.container);
    } catch {}
  }
}
