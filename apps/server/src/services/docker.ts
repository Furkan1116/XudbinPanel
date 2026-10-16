import { PassThrough, type Readable } from "node:stream";
import Docker from "dockerode";
import tarStream from "tar-stream";
import { config } from "../config.js";
import { db } from "../db.js";
import { getPrivateKey, hostVerifier } from "./ssh.js";

export type ServerRow = {
  id: number;
  name: string;
  kind: "local" | "ssh";
  host: string | null;
  port: number;
  username: string;
  ssh_key_id: number | null;
  host_key: string | null;
  apps_domain: string | null;
  tunnel_token: string | null;
  public_ip: string | null;
  https_mode: "auto" | "internal" | "off";
  acme_email: string | null;
  status: string;
  status_detail: string | null;
  setup_log: string;
  log_offset: number;
  log_inode: string | null;
  created_at: number;
};

const clients = new Map<number, Docker>();

/** Sunucunun Docker API istemcisi: yerelde soket, uzakta SSH tüneli (docker system dial-stdio). */
export function dockerFor(server: ServerRow): Docker {
  let client = clients.get(server.id);
  if (client) return client;
  if (server.kind === "local") {
    client = new Docker({ socketPath: config.dockerSocket });
  } else {
    if (!server.host || !server.ssh_key_id) throw new Error("Sunucunun SSH bilgileri eksik");
    client = new Docker({
      protocol: "ssh",
      host: server.host,
      port: server.port,
      username: server.username,
      sshOptions: {
        privateKey: getPrivateKey(server.ssh_key_id),
        readyTimeout: 15_000,
        hostVerifier: hostVerifier({
          hostKey: server.host_key,
          onNewHostKey: (key) => {
            db.prepare("UPDATE servers SET host_key = ? WHERE id = ? AND host_key IS NULL").run(key, server.id);
            server.host_key = key;
          },
        }),
      },
    } as Docker.DockerOptions);
  }
  clients.set(server.id, client);
  return client;
}

export function forgetDockerClient(serverId: number) {
  clients.delete(serverId);
}

export async function withTimeout<T>(promise: Promise<T>, ms: number, message = "Docker yanıt vermedi"): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export async function getDockerInfo(docker: Docker) {
  try {
    const info = await withTimeout(docker.info(), 8000);
    return {
      available: true as const,
      version: info.ServerVersion as string,
      containers: { total: info.Containers as number, running: info.ContainersRunning as number },
      images: info.Images as number,
    };
  } catch (err) {
    return { available: false as const, error: (err as Error).message };
  }
}

export async function listContainers(docker: Docker) {
  const containers = await withTimeout(docker.listContainers({ all: true }), 10_000);
  return containers.map((c) => ({
    id: c.Id.slice(0, 12),
    name: c.Names[0]?.replace(/^\//, "") ?? c.Id.slice(0, 12),
    image: c.Image,
    state: c.State,
    status: c.Status,
    createdAt: c.Created * 1000,
    ports: c.Ports.filter((p) => p.PublicPort).map((p) => `${p.PublicPort}:${p.PrivatePort}/${p.Type}`),
    managed: c.Labels?.["xudbin.managed"] === "true",
  }));
}

export async function ensureNetwork(docker: Docker) {
  const nets = await docker.listNetworks({ filters: { name: [config.network] } });
  if (!nets.some((n) => n.Name === config.network)) {
    await docker.createNetwork({ Name: config.network, Driver: "bridge", Labels: { "xudbin.managed": "true" } });
  }
}

export async function imageExists(docker: Docker, name: string) {
  try {
    await docker.getImage(name).inspect();
    return true;
  } catch {
    return false;
  }
}

/** İmajı çeker; ilerlemeyi okunabilir satırlar halinde bildirir. */
export async function pullImage(docker: Docker, image: string, log: (line: string) => void, auth?: object) {
  const stream = await docker.pull(image, auth ? { authconfig: auth } : {});
  const seen = new Set<string>();
  await new Promise<void>((resolve, reject) => {
    docker.modem.followProgress(
      stream,
      (err) => (err ? reject(err) : resolve()),
      (ev: { status?: string; id?: string; error?: string }) => {
        if (ev.error) return log(`Hata: ${ev.error}`);
        const key = `${ev.id ?? ""}:${ev.status}`;
        if (ev.status && !ev.status.startsWith("Downloading") && !ev.status.startsWith("Extracting") && !seen.has(key)) {
          seen.add(key);
          log(ev.id ? `${ev.id}: ${ev.status}` : ev.status);
        }
      },
    );
  });
}

const cpuCache = new WeakMap<Docker, number>();
async function buildCpus(docker: Docker): Promise<number | null> {
  let n = cpuCache.get(docker);
  if (n === undefined) {
    n = Number((await docker.info().catch(() => ({ NCPU: 0 })) as { NCPU?: number }).NCPU) || 0;
    cpuCache.set(docker, n);
  }
  return n >= 2 ? n - 1 : null;
}

/** Tar akışından imaj derler, derleme çıktısını satır satır verir. Hata olursa fırlatır. */
export async function buildImage(
  docker: Docker,
  context: Readable,
  opts: { tag: string; dockerfile?: string; buildargs?: Record<string, string>; signal?: AbortSignal },
  log: (line: string) => void,
) {
  // Derleme, sunucudaki canlı uygulamalara en az bir çekirdek bırakır.
  const cpus = await buildCpus(docker);
  const stream = await docker.buildImage(context, {
    t: opts.tag,
    dockerfile: opts.dockerfile ?? "Dockerfile",
    buildargs: opts.buildargs,
    rm: true,
    forcerm: true,
    labels: { "xudbin.managed": "true" },
    ...(cpus ? { cpuperiod: 100_000, cpuquota: cpus * 100_000 } : {}),
  });
  let failure: string | null = null;
  await new Promise<void>((resolve, reject) => {
    // Bağlantı kapanınca Docker derlemeyi durdurur (iptal ve zaman aşımı için).
    const abort = () => {
      (stream as unknown as { destroy: () => void }).destroy();
      reject(new Error(String(opts.signal?.reason ?? "Derleme durduruldu")));
    };
    if (opts.signal?.aborted) return abort();
    opts.signal?.addEventListener("abort", abort, { once: true });
    docker.modem.followProgress(
      stream,
      (err) => (err ? reject(err) : resolve()),
      (ev: { stream?: string; status?: string; error?: string; errorDetail?: { message?: string } }) => {
        if (ev.error) {
          failure = ev.errorDetail?.message ?? ev.error;
          log(`Hata: ${failure}`);
        } else if (ev.stream) {
          for (const line of ev.stream.split("\n")) if (line.trim()) log(line.replace(/\u001b\[[0-9;]*m/g, ""));
        } else if (ev.status && !ev.status.startsWith("Downloading") && !ev.status.startsWith("Extracting")) {
          log(ev.status);
        }
      },
    );
  });
  if (failure) throw new Error(`Derleme başarısız: ${failure}`);
}

/** Konteyner içinde komut çalıştırır; stdout/stderr ayrılmış olarak döner. */
export async function execIn(
  docker: Docker,
  containerName: string,
  cmd: string[],
  opts: { stdin?: Readable | Buffer | string; timeoutMs?: number; env?: string[] } = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const container = docker.getContainer(containerName);
  const exec = await container.exec({
    Cmd: cmd,
    AttachStdout: true,
    AttachStderr: true,
    AttachStdin: opts.stdin !== undefined,
    Env: opts.env,
  });
  const stream = await exec.start({ hijack: true, stdin: opts.stdin !== undefined });
  const out = new PassThrough();
  const err = new PassThrough();
  let stdout = "";
  let stderr = "";
  out.on("data", (d: Buffer) => (stdout += d.toString()));
  err.on("data", (d: Buffer) => (stderr += d.toString()));
  docker.modem.demuxStream(stream, out, err);

  if (opts.stdin !== undefined) {
    if (typeof opts.stdin === "string" || Buffer.isBuffer(opts.stdin)) stream.end(opts.stdin);
    else opts.stdin.pipe(stream);
  }

  await withTimeout(
    new Promise<void>((resolve) => {
      stream.on("end", resolve);
      stream.on("close", resolve);
    }),
    opts.timeoutMs ?? 60_000,
    "Konteyner komutu zaman aşımına uğradı",
  );
  const info = await exec.inspect();
  return { exitCode: info.ExitCode ?? 0, stdout, stderr };
}

/** Konteyner içindeki bir komutun çıktısını ham (demux edilmiş) akış olarak verir; yedek almak için. */
export async function execStream(docker: Docker, containerName: string, cmd: string[]) {
  const exec = await docker.getContainer(containerName).exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true });
  const stream = await exec.start({ hijack: true, stdin: false });
  const out = new PassThrough();
  const err = new PassThrough();
  let stderr = "";
  err.on("data", (d: Buffer) => (stderr += d.toString()));
  docker.modem.demuxStream(stream, out, err);
  stream.on("end", () => out.end());
  stream.on("close", () => out.end());
  return { stdout: out, exec, stderr: () => stderr };
}

/** Konteynere tek dosya yazar (konteyner durmuş olsa bile çalışır). */
export async function putFile(docker: Docker, containerName: string, dir: string, name: string, content: string | Buffer) {
  const pack = tarStream.pack();
  pack.entry({ name, mode: 0o644 }, content);
  pack.finalize();
  await docker.getContainer(containerName).putArchive(pack, { path: dir });
}

export async function containerState(docker: Docker, name: string) {
  try {
    const info = await docker.getContainer(name).inspect();
    return { exists: true, running: info.State.Running, status: info.State.Status, exitCode: info.State.ExitCode, info };
  } catch {
    return { exists: false, running: false, status: "missing", exitCode: null, info: null };
  }
}

export async function removeContainer(docker: Docker, name: string) {
  const c = docker.getContainer(name);
  try {
    await c.stop({ t: 10 });
  } catch {}
  try {
    await c.remove({ force: true, v: false });
  } catch {}
}
