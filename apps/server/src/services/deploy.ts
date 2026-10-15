import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import tarFs from "tar-fs";
import YAML from "yaml";
import { config } from "../config.js";
import { db } from "../db.js";
import { decrypt } from "../lib/crypto.js";
import { bus } from "../lib/events.js";
import { detectFrameworks, getFramework, openRepo, type Options } from "./frameworks/index.js";
import { applyCaddyConfig, CADDY_CONTAINER } from "./caddy.js";
import { buildImage, containerState, dockerFor, execIn, pullImage, removeContainer, type ServerRow } from "./docker.js";
import { notify } from "./notify.js";
import { getServer } from "./servers.js";
import { getPrivateKey } from "./ssh.js";
import { extractZip, latestAppUpload } from "./uploads.js";

export type AppRow = {
  id: number;
  project_id: number;
  server_id: number;
  name: string;
  slug: string;
  source_type: "git" | "image" | "compose" | "upload";
  git_url: string | null;
  git_branch: string;
  git_token: string | null;
  build_type: "auto" | "dockerfile" | "static";
  framework: string;
  build_options: string;
  dockerfile_path: string;
  build_context: string;
  image: string | null;
  compose_file: string | null;
  compose_service: string | null;
  port: number;
  command: string | null;
  env: string | null;
  volumes: string;
  security: string;
  webhook_token: string;
  auto_deploy: number;
  status: string;
  container: string | null;
  current_image: string | null;
  created_at: number;
};

export function getApp(id: number) {
  return db.prepare("SELECT * FROM apps WHERE id = ?").get(id) as AppRow | undefined;
}

const BUILD_ROOT = path.join(config.dataDir, "builds");

/** {{XUDBIN_URL}}, {{XUDBIN_DOMAINS}}, {{XUDBIN_ORIGINS}} yer tutucularını uygulamanın güncel alan adlarıyla doldurur. */
export function fillPlaceholders(env: Record<string, string>, appId: number, httpsOn: boolean) {
  const hosts = db.prepare("SELECT host, https FROM domains WHERE app_id = ? ORDER BY generated, id").all(appId) as { host: string; https: number }[];
  const url = (h: { host: string; https: number }) => `${h.https && httpsOn ? "https" : "http"}://${h.host}`;
  const values: Record<string, string> = {
    XUDBIN_URL: hosts[0] ? url(hosts[0]) : "",
    XUDBIN_DOMAINS: hosts.map((h) => h.host).join(","),
    XUDBIN_ORIGINS: hosts.map(url).join(","),
  };
  for (const k of Object.keys(env)) env[k] = env[k]!.replace(/\{\{(XUDBIN_URL|XUDBIN_DOMAINS|XUDBIN_ORIGINS)\}\}/g, (_, n: string) => values[n] ?? "");
  return { env, values };
}

export function parseEnv(raw: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i <= 0) continue;
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    env[t.slice(0, i).trim()] = v;
  }
  return env;
}

// ---------------------------------------------------------------------------
// Kuyruk: aynı uygulama için deploylar sırayla, sistem genelinde en fazla 2 eşzamanlı.
// ---------------------------------------------------------------------------

const queue: number[] = [];
const active = new Set<number>(); // deployment id
const activeApps = new Set<number>();
const MAX_CONCURRENT = 2;

export function enqueueDeploy(appId: number, trigger: "manual" | "webhook" | "rollback", opts: { title?: string; image?: string } = {}) {
  const res = db
    .prepare("INSERT INTO deployments (app_id, status, trigger, title, image, started_at) VALUES (?, 'queued', ?, ?, ?, ?)")
    .run(appId, trigger, opts.title ?? "", opts.image ?? null, Date.now());
  const id = Number(res.lastInsertRowid);
  queue.push(id);
  db.prepare("UPDATE apps SET status = 'deploying' WHERE id = ?").run(appId);
  setImmediate(pump);
  return id;
}

function pump() {
  if (active.size >= MAX_CONCURRENT) return;
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i]!;
    const dep = db.prepare("SELECT app_id, status FROM deployments WHERE id = ?").get(id) as { app_id: number; status: string } | undefined;
    if (!dep || dep.status === "cancelled") {
      queue.splice(i--, 1);
      continue;
    }
    if (activeApps.has(dep.app_id)) continue;
    queue.splice(i, 1);
    active.add(id);
    activeApps.add(dep.app_id);
    runDeployment(id).finally(() => {
      active.delete(id);
      activeApps.delete(dep.app_id);
      setImmediate(pump);
    });
    if (active.size >= MAX_CONCURRENT) return;
    i--;
  }
}

export function cancelDeployment(id: number) {
  const r = db.prepare("UPDATE deployments SET status = 'cancelled', finished_at = ? WHERE id = ? AND status = 'queued'").run(Date.now(), id);
  return r.changes > 0;
}

/** Panel yeniden başlarken yarıda kalan deployları başarısız olarak işaretle. */
export function recoverInterruptedDeployments() {
  const now = Date.now();
  db.prepare("UPDATE deployments SET status = 'failed', finished_at = ?, log = log || ? WHERE status IN ('queued', 'running')").run(
    now,
    "\nPanel yeniden başlatıldığı için deploy yarıda kaldı.\n",
  );
  db.prepare("UPDATE apps SET status = CASE WHEN container IS NULL THEN 'idle' ELSE 'running' END WHERE status = 'deploying'").run();
}

// ---------------------------------------------------------------------------
// Deploy
// ---------------------------------------------------------------------------

function makeLogger(deploymentId: number) {
  let pending = "";
  let timer: NodeJS.Timeout | null = null;
  const flush = () => {
    if (!pending) return;
    db.prepare("UPDATE deployments SET log = substr(log || ?, -500000) WHERE id = ?").run(pending, deploymentId);
    pending = "";
    timer = null;
  };
  const log = (line: string) => {
    pending += `${line}\n`;
    bus.emit(`deploy:${deploymentId}`, line);
    if (!timer) timer = setTimeout(flush, 500);
  };
  return { log, flush };
}

async function runDeployment(deploymentId: number) {
  const dep = db.prepare("SELECT * FROM deployments WHERE id = ?").get(deploymentId) as { app_id: number; trigger: string; image: string | null };
  const app = getApp(dep.app_id);
  const { log, flush } = makeLogger(deploymentId);
  db.prepare("UPDATE deployments SET status = 'running', started_at = ? WHERE id = ?").run(Date.now(), deploymentId);
  const workdir = path.join(BUILD_ROOT, String(deploymentId));
  const started = Date.now();

  try {
    if (!app) throw new Error("Uygulama silinmiş");
    const server = getServer(app.server_id);
    if (server.status !== "ready") throw new Error(`"${server.name}" sunucusu hazır değil. Önce sunucu kurulumunu tamamla.`);
    log(`${app.name} → ${server.name}`);

    if (app.source_type === "compose") {
      await deployCompose(app, server, workdir, log);
    } else {
      let image: string;
      if (dep.image) {
        image = dep.image;
        log(`Önceki sürüme dönülüyor: ${image}`);
      } else if (app.source_type === "image") {
        image = app.image!;
        log(`İmaj çekiliyor: ${image}`);
        await pullImage(dockerFor(server), image, log);
      } else {
        image = await buildFromSource(app, server, deploymentId, workdir, log);
      }
      db.prepare("UPDATE deployments SET image = ? WHERE id = ?").run(image, deploymentId);
      await runContainer(app, server, image, deploymentId, log);
      if ((app.source_type === "git" || app.source_type === "upload") && !dep.image) pruneImages(app, server).catch(() => {});
    }

    const seconds = Math.round((Date.now() - started) / 1000);
    log(`Deploy tamamlandı (${seconds} sn).`);
    db.prepare("UPDATE deployments SET status = 'success', finished_at = ? WHERE id = ?").run(Date.now(), deploymentId);
    db.prepare("UPDATE apps SET status = 'running' WHERE id = ?").run(app.id);
    notify("deploy_success", `${app.name} yayında`, `Deploy #${deploymentId} ${seconds} saniyede tamamlandı.`);
  } catch (err) {
    const message = (err as Error).message;
    log(`Hata: ${message}`);
    db.prepare("UPDATE deployments SET status = 'failed', finished_at = ? WHERE id = ?").run(Date.now(), deploymentId);
    if (app) {
      db.prepare("UPDATE apps SET status = CASE WHEN container IS NULL THEN 'failed' ELSE 'running' END WHERE id = ?").run(app.id);
      notify("deploy_failed", `${app.name} deploy edilemedi`, message);
    }
  } finally {
    flush();
    bus.emit(`deploy:${deploymentId}`, "__done__");
    fs.rm(workdir, { recursive: true, force: true }, () => {});
  }
}

function gitUrlWithToken(url: string, token: string) {
  if (!token) return url;
  const u = new URL(url);
  u.username = "x-access-token";
  u.password = token;
  return u.toString();
}

function run(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; log: (l: string) => void; redact?: string[] }) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env } });
    let out = "";
    const onData = (d: Buffer) => {
      let text = d.toString();
      for (const secret of opts.redact ?? []) if (secret) text = text.split(secret).join("***");
      out += text;
      text.split(/\r?\n|\r/).filter((l) => l.trim()).forEach(opts.log);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", (e) => reject(new Error(`${cmd} çalıştırılamadı: ${e.message}`)));
    child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} ${code} koduyla çıktı`))));
  });
}

/** Repoyu yalnız son commit'iyle klonlar (algılama ve derleme için). */
export async function shallowClone(url: string, branch: string, token: string, dest: string, log: (l: string) => void = () => {}) {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  await run("git", ["clone", "--depth", "1", "--branch", branch, gitUrlWithToken(url, token), dest], {
    env: { GIT_TERMINAL_PROMPT: "0" },
    log,
    redact: [token],
  });
}

async function cloneRepo(app: AppRow, workdir: string, log: (l: string) => void) {
  if (!app.git_url) throw new Error("Git adresi tanımlı değil");
  fs.rmSync(workdir, { recursive: true, force: true });
  fs.mkdirSync(workdir, { recursive: true });
  const token = decrypt(app.git_token);
  log(`Klonlanıyor: ${app.git_url} (${app.git_branch})`);
  await run("git", ["clone", "--depth", "1", "--branch", app.git_branch, gitUrlWithToken(app.git_url, token), "src"], {
    cwd: workdir,
    env: { GIT_TERMINAL_PROMPT: "0" },
    log,
    redact: [token],
  });
  const sha = (await run("git", ["rev-parse", "--short", "HEAD"], { cwd: path.join(workdir, "src"), log: () => {} })).trim();
  const msg = (await run("git", ["log", "-1", "--pretty=%s"], { cwd: path.join(workdir, "src"), log: () => {} })).trim();
  log(`Commit ${sha}: ${msg}`);
  return { dir: path.join(workdir, "src"), sha, msg };
}

async function buildFromSource(app: AppRow, server: ServerRow, deploymentId: number, workdir: string, log: (l: string) => void) {
  let dir: string;
  if (app.source_type === "upload") {
    const zip = latestAppUpload(app.slug);
    if (!zip) throw new Error("Yüklenmiş dosya yok. Uygulama sayfasından proje klasörünü veya zip'i yükle.");
    log(`Yüklenen dosya açılıyor (${(fs.statSync(zip).size / 1024 / 1024).toFixed(1)} MB)...`);
    dir = await extractZip(zip, path.join(workdir, "src"));
    db.prepare("UPDATE deployments SET title = CASE WHEN title = '' THEN 'Dosya yüklemesi' ELSE title END WHERE id = ?").run(deploymentId);
  } else {
    const cloned = await cloneRepo(app, workdir, log);
    dir = cloned.dir;
    db.prepare("UPDATE deployments SET commit_sha = ?, title = CASE WHEN title = '' THEN ? ELSE title END WHERE id = ?").run(cloned.sha, cloned.msg, deploymentId);
  }

  const contextDir = path.resolve(dir, app.build_context || ".");
  if (!contextDir.startsWith(dir)) throw new Error("Derleme klasörü repo dışında olamaz");
  if (!fs.existsSync(contextDir)) throw new Error(`Derleme klasörü bulunamadı: ${app.build_context}`);

  const opts = JSON.parse(app.build_options || "{}") as Options;
  let frameworkId = app.framework || "auto";
  if (frameworkId === "auto") {
    const best = detectFrameworks(contextDir).matches[0];
    if (!best) throw new Error("Proje türü tanınamadı. Uygulama ayarlarından framework seç veya repoya bir Dockerfile ekle.");
    frameworkId = best.id;
    Object.assign(opts, { ...best.options, ...opts });
    log(`Proje türü otomatik algılandı: ${getFramework(best.id)!.name} (${best.reason})`);
  }

  let dockerfile = (typeof opts.dockerfilePath === "string" && opts.dockerfilePath) || app.dockerfile_path || "Dockerfile";
  if (frameworkId === "dockerfile") {
    if (!fs.existsSync(path.join(contextDir, dockerfile))) throw new Error(`${dockerfile} bulunamadı`);
    log(`Repodaki ${dockerfile} kullanılıyor.`);
  } else {
    const fw = getFramework(frameworkId);
    if (!fw) throw new Error(`Bilinmeyen framework: ${frameworkId}`);
    const env = fillPlaceholders(parseEnv(decrypt(app.env)), app.id, server.https_mode !== "off").env;
    const result = fw.build(openRepo(contextDir), opts, env);
    dockerfile = "Dockerfile.xudbin";
    for (const [name, content] of Object.entries(result.files ?? {})) fs.writeFileSync(path.join(contextDir, name), content);
    fs.writeFileSync(path.join(contextDir, dockerfile), result.dockerfile);
    log(`Framework: ${fw.name}`);
    result.notes?.forEach((n) => log(n));
    log("Üretilen Dockerfile:");
    result.dockerfile.trim().split("\n").forEach((l) => log(`  ${l}`));
    if (result.port !== app.port) {
      log(`Uygulama portu ${app.port} → ${result.port} olarak güncellendi.`);
      db.prepare("UPDATE apps SET port = ? WHERE id = ?").run(result.port, app.id);
      app.port = result.port;
    }
  }

  const tag = `xudbin/${app.slug}:${deploymentId}`;
  log(`İmaj derleniyor: ${tag}`);
  const context = tarFs.pack(contextDir, { ignore: (name) => name.split(path.sep).includes(".git") });
  await buildImage(dockerFor(server), context, { tag, dockerfile }, log);
  return tag;
}

type Volume = { name: string; path: string };

async function runContainer(app: AppRow, server: ServerRow, image: string, deploymentId: number, log: (l: string) => void) {
  const docker = dockerFor(server);
  const fresh = getApp(app.id)!;
  const filled = fillPlaceholders(parseEnv(decrypt(fresh.env)), app.id, server.https_mode !== "off");
  const env = { PORT: String(fresh.port), XUDBIN_URL: filled.values.XUDBIN_URL!, XUDBIN_DOMAINS: filled.values.XUDBIN_DOMAINS!, ...filled.env };
  const volumes = JSON.parse(fresh.volumes || "[]") as Volume[];
  const name = `xb-${app.slug}-${deploymentId}`;

  log(`Konteyner başlatılıyor: ${name}`);
  const container = await docker.createContainer({
    name,
    Image: image,
    Env: Object.entries(env).map(([k, v]) => `${k}=${v}`),
    Cmd: fresh.command ? ["sh", "-c", fresh.command] : undefined,
    Labels: { "xudbin.managed": "true", "xudbin.app": app.slug, "xudbin.deployment": String(deploymentId) },
    HostConfig: {
      NetworkMode: config.network,
      RestartPolicy: { Name: "unless-stopped" },
      Binds: volumes.map((v) => `xb-${app.slug}-${v.name}:${v.path}`),
      LogConfig: { Type: "json-file", Config: { "max-size": "10m", "max-file": "3" } },
    },
    NetworkingConfig: { EndpointsConfig: { [config.network]: { Aliases: [`xb-${app.slug}`] } } },
  });
  await container.start();

  // Sağlık kontrolü: trafik, yeni konteyner portunu gerçekten dinlemeye başlayana kadar eski sürümde kalır.
  // Kontrol, ortak ağdaki Caddy konteynerinden yapılır (uygulama imajında araç olması gerekmez).
  const failWithLogs = async (message: string) => {
    const logs = await container.logs({ stdout: true, stderr: true, tail: 30 }).catch(() => Buffer.from(""));
    const lines = demuxLogs(logs);
    if (lines.length) {
      log("Uygulamanın son çıktısı:");
      lines.forEach((l) => log(`  ${l}`));
    }
    await removeContainer(docker, name);
    throw new Error(`${message} Eski sürüm yayında kalmaya devam ediyor.`);
  };
  const started = Date.now();
  const limitMs = 120_000;
  let announced = false;
  let inspected = false;
  for (;;) {
    const state = await containerState(docker, name);
    if (!state.running) await failWithLogs(`Konteyner kapandı (çıkış kodu ${state.exitCode}).`);
    const probe = await execIn(docker, CADDY_CONTAINER, ["nc", "-z", "-w", "2", name, String(fresh.port)], { timeoutMs: 10_000 }).catch(() => ({ exitCode: 1 }));
    if (probe.exitCode === 0) break;
    // Uygulama başka bir portu dinliyorsa (ör. kodda sabitlenmiş) ayarı kendisi düzelt.
    if (!inspected && Date.now() - started > 8000) {
      inspected = true;
      const ports = await listeningPorts(docker, name);
      const external = ports.filter((p) => !p.localOnly).map((p) => p.port);
      const found = external[0];
      if (external.length === 1 && found !== undefined && found !== fresh.port) {
        log(`Uygulama ${fresh.port} yerine ${found} portunu dinliyor; port ayarı ${found} olarak güncellendi.`);
        db.prepare("UPDATE apps SET port = ? WHERE id = ?").run(found, app.id);
        fresh.port = found;
        continue;
      }
      if (!external.length && ports.some((p) => p.localOnly)) {
        log(`Uyarı: Uygulama yalnız 127.0.0.1 adresini dinliyor (${ports.map((p) => p.port).join(", ")}). Dışarıdan erişilebilmesi için 0.0.0.0 dinlemeli.`);
      }
    }
    if (Date.now() - started > limitMs) {
      await failWithLogs(`Uygulama 2 dakika içinde ${fresh.port} portunu dinlemeye başlamadı. Port ayarını ve uygulamanın PORT değişkenini kullandığını kontrol et.`);
    }
    if (!announced && Date.now() - started > 5000) {
      log(`Uygulamanın ${fresh.port} portunu açması bekleniyor...`);
      announced = true;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  log(`Konteyner çalışıyor, ${fresh.port} portu ${Math.round((Date.now() - started) / 1000)} sn içinde yanıt verdi.`);

  const previous = fresh.container;
  db.prepare("UPDATE apps SET container = ?, current_image = ? WHERE id = ?").run(name, image, app.id);
  log("Trafik yeni sürüme yönlendiriliyor...");
  await applyCaddyConfig(server);

  if (previous && previous !== name) {
    log(`Eski konteyner kaldırılıyor: ${previous}`);
    await removeContainer(docker, previous);
  }
}

/** Konteynerde dinlenen TCP portları (/proc/net/tcp*). Araç gerektirmez; okunamazsa boş döner. */
async function listeningPorts(docker: ReturnType<typeof dockerFor>, name: string) {
  const res = await execIn(docker, name, ["cat", "/proc/net/tcp", "/proc/net/tcp6"], { timeoutMs: 5000 }).catch(() => null);
  const out: { port: number; localOnly: boolean }[] = [];
  for (const line of res?.stdout.split("\n") ?? []) {
    const cols = line.trim().split(/\s+/);
    if (cols[3] !== "0A") continue; // LISTEN
    const [addr, portHex] = (cols[1] ?? "").split(":");
    const port = parseInt(portHex ?? "", 16);
    if (!port || out.some((p) => p.port === port)) continue;
    // 127.0.0.0/8 (Docker'ın gömülü DNS'i 127.0.0.11'de rastgele bir portu dinler) ve ::1 dışarıdan erişilemez.
    const localOnly = (addr?.length === 8 && addr.endsWith("7F")) || addr === "00000000000000000000000001000000";
    out.push({ port, localOnly });
  }
  return out;
}

/** Docker log akışındaki 8 baytlık çerçeve başlıklarını temizleyip satırlara ayırır. */
export function demuxLogs(buf: Buffer | string): string[] {
  if (typeof buf === "string") return buf.split("\n").filter(Boolean);
  const lines: string[] = [];
  let i = 0;
  let raw = "";
  if (buf.length >= 8 && (buf[0] === 1 || buf[0] === 2) && buf[1] === 0 && buf[2] === 0 && buf[3] === 0) {
    while (i + 8 <= buf.length) {
      const len = buf.readUInt32BE(i + 4);
      raw += buf.subarray(i + 8, i + 8 + len).toString();
      i += 8 + len;
    }
  } else raw = buf.toString();
  for (const l of raw.split(/\r?\n/)) if (l) lines.push(l);
  return lines;
}

/** Son 3 başarılı deploy'un imajı geri dönüş için tutulur, daha eskileri silinir. */
async function pruneImages(app: AppRow, server: ServerRow) {
  const keep = (
    db
      .prepare("SELECT image FROM deployments WHERE app_id = ? AND status IN ('success', 'running') AND image IS NOT NULL ORDER BY id DESC LIMIT 4")
      .all(app.id) as { image: string }[]
  ).map((r) => r.image);
  const docker = dockerFor(server);
  const images = await docker.listImages({ filters: { reference: [`xudbin/${app.slug}`] } });
  for (const img of images) {
    const tags = img.RepoTags ?? [];
    if (tags.some((t) => keep.includes(t))) continue;
    try {
      await docker.getImage(img.Id).remove({ force: false });
    } catch {}
  }
}

// ---------------------------------------------------------------------------
// Docker Compose
// ---------------------------------------------------------------------------

function dockerBin() {
  const candidates = [process.env.DOCKER_BIN, "/usr/local/bin/docker", "/usr/bin/docker", path.join(os.homedir(), ".orbstack/bin/docker")];
  return candidates.find((c) => c && fs.existsSync(c)) ?? "docker";
}

/** docker CLI'nin hedef sunucuya bağlanması için ortam (uzak sunucuda geçici SSH yapılandırmasıyla). */
export function composeEnv(server: ServerRow, workdir: string): NodeJS.ProcessEnv {
  if (server.kind === "local") return { DOCKER_HOST: `unix://${config.dockerSocket}` };
  const home = path.join(workdir, "home");
  const sshDir = path.join(home, ".ssh");
  fs.mkdirSync(sshDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(sshDir, "id"), getPrivateKey(server.ssh_key_id!).trim() + "\n", { mode: 0o600 });
  fs.writeFileSync(
    path.join(sshDir, "config"),
    `Host xudbin-target\n  HostName ${server.host}\n  Port ${server.port}\n  User ${server.username}\n  IdentityFile ${path.join(sshDir, "id")}\n  StrictHostKeyChecking accept-new\n  UserKnownHostsFile ${path.join(sshDir, "known_hosts")}\n`,
    { mode: 0o600 },
  );
  return { HOME: home, DOCKER_HOST: "ssh://xudbin-target", DOCKER_CONFIG: path.join(home, ".docker") };
}

async function deployCompose(app: AppRow, server: ServerRow, workdir: string, log: (l: string) => void) {
  let dir: string;
  let composePath: string;
  if (app.git_url) {
    const cloned = await cloneRepo(app, workdir, log);
    dir = cloned.dir;
    composePath = path.join(dir, app.dockerfile_path || "docker-compose.yml");
    if (!fs.existsSync(composePath)) throw new Error(`Compose dosyası bulunamadı: ${app.dockerfile_path}`);
  } else {
    if (!app.compose_file?.trim()) throw new Error("Compose dosyası boş");
    dir = path.join(workdir, "src");
    fs.mkdirSync(dir, { recursive: true });
    composePath = path.join(dir, "docker-compose.yml");
    fs.writeFileSync(composePath, app.compose_file);
  }

  const doc = YAML.parse(fs.readFileSync(composePath, "utf8")) as { services?: Record<string, unknown> };
  const services = Object.keys(doc?.services ?? {});
  if (!services.length) throw new Error("Compose dosyasında servis yok");
  log(`Servisler: ${services.join(", ")}`);

  // Her servisi Xudbin ağına da bağla ki Caddy alan adlarını yönlendirebilsin.
  const override = {
    services: Object.fromEntries(services.map((s) => [s, { networks: ["default", "xudbin"], labels: { "xudbin.managed": "true", "xudbin.app": app.slug } }])),
    networks: { xudbin: { external: true, name: config.network } },
  };
  const overridePath = path.join(dir, "docker-compose.xudbin.yml");
  fs.writeFileSync(overridePath, YAML.stringify(override));
  fs.writeFileSync(path.join(dir, ".env"), decrypt(app.env));

  const env = composeEnv(server, workdir);
  const args = ["compose", "-p", `xb-${app.slug}`, "-f", composePath, "-f", overridePath];
  log("docker compose up çalıştırılıyor...");
  await run(dockerBin(), [...args, "up", "-d", "--build", "--remove-orphans", "--wait", "--wait-timeout", "120"], { cwd: dir, env, log });
  db.prepare("UPDATE apps SET container = ? WHERE id = ?").run(`xb-${app.slug}`, app.id);
  await applyCaddyConfig(server);
}

export async function composeCommand(app: AppRow, action: "stop" | "start" | "restart" | "down") {
  const server = getServer(app.server_id);
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "xudbin-compose-"));
  try {
    const args = ["compose", "-p", `xb-${app.slug}`, action];
    if (action === "down") args.push("--remove-orphans");
    await run(dockerBin(), args, { env: composeEnv(server, workdir), log: () => {} });
  } finally {
    fs.rmSync(workdir, { recursive: true, force: true });
  }
}
