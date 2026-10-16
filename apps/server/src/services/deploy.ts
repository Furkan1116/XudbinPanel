import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import tarFs from "tar-fs";
import YAML from "yaml";
import { config } from "../config.js";
import { db } from "../db.js";
import { decrypt, encrypt, randomAlnum } from "../lib/crypto.js";
import { bus } from "../lib/events.js";
import { resolveInside } from "../lib/paths.js";
import { detectFrameworks, getFramework, missingDefaultEnv, openRepo, type Framework, type Options } from "./frameworks/index.js";
import { applyCaddyConfig, CADDY_CONTAINER, certificateReady } from "./caddy.js";
import { composeHostAccessIssues } from "./compose-policy.js";
import { diagnose, isHealthy, probeHttp, type Finding } from "./doctor.js";
import { buildImage, containerState, dockerFor, execIn, pullImage, removeContainer, type ServerRow } from "./docker.js";
import { ensureProjectNetwork } from "./networks.js";
import { notify } from "./notify.js";
import { imageScanEnabled, scanApp } from "./scan.js";
import { getServer } from "./servers.js";
import { getPrivateKey } from "./ssh.js";
import { extractZip, latestAppUpload } from "./uploads.js";
import { gitTokenFor } from "./github-app.js";
import { ensureRelayCa, extraServerProblem, parseIds, remoteReplicasOf, removeRemoteReplicas, startRemoteReplicas } from "./remote-replicas.js";

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
  host_access: number;
  webhook_secret: string | null;
  webhook_signed: number;
  cpu_limit: number | null;
  memory_limit: number | null;
  http_check: number;
  health_path: string | null;
  scan_status: string | null;
  scan_summary: string | null;
  scanned_at: number | null;
  uptime_enabled: number;
  kind: "web" | "worker";
  replicas: number;
  replica_containers: string;
  previews_enabled: number;
  parent_app_id: number | null;
  preview_pr: number | null;
  volume_backup_interval_h: number;
  volume_backup_keep: number;
  last_volume_backup_at: number | null;
  build_server_id: number | null;
  extra_server_ids: string;
  remote_replicas: string;
  relay_secret: string | null;
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
    XUDBIN_HOST: hosts[0]?.host ?? "",
    XUDBIN_DOMAINS: hosts.map((h) => h.host).join(","),
    XUDBIN_ORIGINS: hosts.map(url).join(","),
  };
  for (const k of Object.keys(env)) env[k] = env[k]!.replace(/\{\{(XUDBIN_URL|XUDBIN_HOST|XUDBIN_DOMAINS|XUDBIN_ORIGINS)\}\}/g, (_, n: string) => values[n] ?? "");
  return { env, values };
}

/** Env metninde verilen anahtarların değerini günceller, olmayanları sona ekler; yorum ve sıra korunur. */
export function mergeEnvText(raw: string, set: Record<string, string>): string {
  const left = { ...set };
  const lines = raw.split(/\r?\n/).map((line) => {
    const t = line.trim();
    const i = t.indexOf("=");
    if (!t || t.startsWith("#") || i <= 0) return line;
    const key = t.slice(0, i).trim();
    if (!(key in left)) return line;
    const v = left[key]!;
    delete left[key];
    return `${key}=${v}`;
  });
  while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop();
  return [...lines, ...Object.entries(left).map(([k, v]) => `${k}=${v}`)].join("\n") + "\n";
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
/** Bir deploy en fazla bu kadar sürebilir; aşarsa durdurulur, eski sürüm yayında kalır. */
const DEPLOY_TIMEOUT_MS = 30 * 60_000;
const controllers = new Map<number, AbortController>();

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

/** Sıradaki deploy'u siler, çalışan deploy'u durdurur (eski sürüm yayında kalır). */
/** Bu sunucuda şu an derleme/deploy sürüyor mu (bakım işleri derlemenin ara katmanlarını silmesin diye). */
export function serverBusy(serverId: number) {
  for (const appId of activeApps) {
    const row = db.prepare("SELECT server_id FROM apps WHERE id = ?").get(appId) as { server_id: number } | undefined;
    if (row?.server_id === serverId) return true;
  }
  return false;
}

export function cancelDeployment(id: number) {
  const running = controllers.get(id);
  if (running) {
    running.abort("Deploy iptal edildi.");
    return true;
  }
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
  const controller = new AbortController();
  controllers.set(deploymentId, controller);
  const timeout = setTimeout(() => controller.abort(`Deploy ${DEPLOY_TIMEOUT_MS / 60_000} dakikada tamamlanmadı ve durduruldu.`), DEPLOY_TIMEOUT_MS);
  const signal = controller.signal;

  try {
    if (!app) throw new Error("Uygulama silinmiş");
    const server = getServer(app.server_id);
    if (server.status !== "ready") throw new Error(`"${server.name}" sunucusu hazır değil. Önce sunucu kurulumunu tamamla.`);
    log(`${app.name} → ${server.name}`);
    // İlk deploy: alan adları Caddy'ye şimdi eklenir ki HTTPS sertifikası derleme sürerken alınsın
    // (aksi halde site yayına girdiği ilk saniyelerde sertifikasız kalıyordu).
    if (!app.container && server.https_mode !== "off") await applyCaddyConfig(server).catch(() => {});

    if (app.source_type === "compose") {
      await deployCompose(app, server, workdir, log, signal);
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
        image = await buildFromSource(app, server, deploymentId, workdir, log, signal);
      }
      db.prepare("UPDATE deployments SET image = ? WHERE id = ?").run(image, deploymentId);
      await runContainer(app, server, image, deploymentId, log, signal);
      if ((app.source_type === "git" || app.source_type === "upload") && !dep.image) pruneImages(app, server).catch(() => {});
    }

    const seconds = Math.round((Date.now() - started) / 1000);
    log(`Deploy tamamlandı (${seconds} sn).`);
    db.prepare("UPDATE deployments SET status = 'success', finished_at = ? WHERE id = ?").run(Date.now(), deploymentId);
    db.prepare("UPDATE apps SET status = 'running' WHERE id = ?").run(app.id);
    if (app.source_type !== "compose" && imageScanEnabled()) {
      log("İmaj güvenlik açıklarına karşı arka planda taranıyor (sonuç uygulama sayfasında).");
      scanApp(app.id).catch((e) => console.error(`İmaj taranamadı (${app.name}):`, (e as Error).message));
    }
    notify("deploy_success", `${app.name} yayında`, `Deploy #${deploymentId} ${seconds} saniyede tamamlandı.`);
  } catch (err) {
    const message = signal.aborted ? String(signal.reason) : (err as Error).message;
    log(`Hata: ${message}`);
    // Konteyner aşamasına gelmeden (ör. derlemede) düşen deploy'lar da deploy loguna bakılarak teşhis edilir.
    if (app && !signal.aborted) {
      flush();
      const row = db.prepare("SELECT log, diagnosis FROM deployments WHERE id = ?").get(deploymentId) as { log: string; diagnosis: string | null };
      if (!row.diagnosis) recordDiagnosis(deploymentId, diagnose(row.log.split("\n"), { framework: app.framework, env: parseEnv(decrypt(app.env)), hosts: [] }), log);
    }
    db.prepare("UPDATE deployments SET status = ?, finished_at = ? WHERE id = ?").run(signal.aborted && String(signal.reason).includes("iptal") ? "cancelled" : "failed", Date.now(), deploymentId);
    if (app) {
      db.prepare("UPDATE apps SET status = CASE WHEN container IS NULL THEN 'failed' ELSE 'running' END WHERE id = ?").run(app.id);
      notify("deploy_failed", `${app.name} deploy edilemedi`, message);
    }
  } finally {
    clearTimeout(timeout);
    controllers.delete(deploymentId);
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

function run(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; log: (l: string) => void; redact?: string[]; signal?: AbortSignal }) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, signal: opts.signal });
    let out = "";
    const onData = (d: Buffer) => {
      let text = d.toString();
      for (const secret of opts.redact ?? []) if (secret) text = text.split(secret).join("***");
      out += text;
      text.split(/\r?\n|\r/).filter((l) => l.trim()).forEach(opts.log);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", (e) => reject(opts.signal?.aborted ? new Error(String(opts.signal.reason)) : new Error(`${cmd} çalıştırılamadı: ${e.message}`)));
    child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} ${code} koduyla çıktı`))));
  });
}

/** Repoyu yalnız son commit'iyle klonlar (algılama ve derleme için). */
// git'in "could not read Username" gibi hatalarını kullanıcının anlayacağı bir mesaja çevirir.
async function gitClone(args: string[], opts: { cwd?: string; token: string; log: (l: string) => void; signal?: AbortSignal }) {
  let output = "";
  const log = (l: string) => {
    output += l + "\n";
    opts.log(l);
  };
  try {
    await run("git", args, { cwd: opts.cwd, env: { GIT_TERMINAL_PROMPT: "0" }, log, redact: [opts.token], signal: opts.signal });
  } catch (e) {
    if (opts.signal?.aborted) throw e;
    if (/Remote branch .* not found/i.test(output)) throw new Error("Repo klonlanamadı: bu isimde bir dal yok.");
    if (/could not read Username|Authentication failed|Repository not found|returned error: 40[134]/i.test(output)) {
      throw new Error(
        opts.token
          ? "Repo klonlanamadı: token geçersiz ya da bu repoya erişimi yok."
          : "Repo klonlanamadı: repo özel veya adres yanlış. Özel repolar için uygulama ayarlarına bir erişim token'ı ekle.",
      );
    }
    throw e;
  }
}

export async function shallowClone(url: string, branch: string, token: string, dest: string, log: (l: string) => void = () => {}) {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  await gitClone(["clone", "--depth", "1", "--branch", branch, gitUrlWithToken(url, token), dest], { token, log });
}

async function cloneRepo(app: AppRow, workdir: string, log: (l: string) => void, signal?: AbortSignal) {
  if (!app.git_url) throw new Error("Git adresi tanımlı değil");
  fs.rmSync(workdir, { recursive: true, force: true });
  fs.mkdirSync(workdir, { recursive: true });
  const token = await gitTokenFor(app.git_url, decrypt(app.git_token));
  log(`Klonlanıyor: ${app.git_url} (${app.git_branch})`);
  await gitClone(["clone", "--depth", "1", "--branch", app.git_branch, gitUrlWithToken(app.git_url, token), "src"], { cwd: workdir, token, log, signal });
  const sha = (await run("git", ["rev-parse", "--short", "HEAD"], { cwd: path.join(workdir, "src"), log: () => {} })).trim();
  const msg = (await run("git", ["log", "-1", "--pretty=%s"], { cwd: path.join(workdir, "src"), log: () => {} })).trim();
  log(`Commit ${sha}: ${msg}`);
  return { dir: path.join(workdir, "src"), sha, msg };
}

async function buildFromSource(app: AppRow, server: ServerRow, deploymentId: number, workdir: string, log: (l: string) => void, signal: AbortSignal) {
  let dir: string;
  if (app.source_type === "upload") {
    const zip = latestAppUpload(app.slug);
    if (!zip) throw new Error("Yüklenmiş dosya yok. Uygulama sayfasından proje klasörünü veya zip'i yükle.");
    log(`Yüklenen dosya açılıyor (${(fs.statSync(zip).size / 1024 / 1024).toFixed(1)} MB)...`);
    dir = await extractZip(zip, path.join(workdir, "src"));
    db.prepare("UPDATE deployments SET title = CASE WHEN title = '' THEN 'Dosya yüklemesi' ELSE title END WHERE id = ?").run(deploymentId);
  } else {
    const cloned = await cloneRepo(app, workdir, log, signal);
    dir = cloned.dir;
    db.prepare("UPDATE deployments SET commit_sha = ?, title = CASE WHEN title = '' THEN ? ELSE title END WHERE id = ?").run(cloned.sha, cloned.msg, deploymentId);
  }

  const contextDir = resolveInside(dir, app.build_context || ".");
  if (!contextDir) throw new Error("Derleme klasörü repo dışında olamaz");
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
    const found = resolveInside(contextDir, dockerfile);
    if (!found || !fs.existsSync(found)) throw new Error(`${dockerfile} bulunamadı`);
    log(`Repodaki ${dockerfile} kullanılıyor.`);
  } else {
    const fw = getFramework(frameworkId);
    if (!fw) throw new Error(`Bilinmeyen framework: ${frameworkId}`);
    const repoForConfig = openRepo(contextDir);
    addDefaultEnv(app, fw, log, fw.envAliases?.(repoForConfig, opts) ?? {}, fw.autoConfig?.(repoForConfig, opts) ?? {});
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
  const pack = () => tarFs.pack(contextDir, { ignore: (name) => name.split(path.sep).includes(".git") });
  // Temel imaj günde bir tazelenir (güvenlik yamaları aynı etikette gelir); kayıt deposuna ulaşılamazsa önbellektekiyle derlenir.
  const build = async (target: ServerRow) => {
    const pull = shouldPullBase(`${target.id}:${app.slug}`);
    if (pull) log("Temel imajın güncel sürümü kontrol ediliyor (günde bir).");
    try {
      await buildImage(dockerFor(target), pack(), { tag, dockerfile, signal, pull }, log);
    } catch (err) {
      if (!pull || !/pull access denied|toomanyrequests|rate limit|manifest unknown|i\/o timeout|TLS handshake|no such host|connection refused/i.test((err as Error).message)) throw err;
      basePulledAt.delete(`${target.id}:${app.slug}`);
      log("Temel imaj tazelenemedi; sunucudaki kopyayla yeniden derleniyor.");
      await buildImage(dockerFor(target), pack(), { tag, dockerfile, signal }, log);
    }
  };
  // Ayrı derleme sunucusu: ağır derlemeler canlı uygulamaların sunucusunu yormasın; imaj sonra aktarılır.
  const builder = app.build_server_id && app.build_server_id !== server.id ? getServer(app.build_server_id) : null;
  if (builder) {
    if (builder.status !== "ready") throw new Error(`Derleme sunucusu "${builder.name}" hazır değil`);
    const [bInfo, tInfo] = await Promise.all([dockerFor(builder).info(), dockerFor(server).info()]);
    const norm = (a: string) => ({ x86_64: "amd64", aarch64: "arm64" })[a] ?? a;
    if (norm(bInfo.Architecture as string) !== norm(tInfo.Architecture as string)) {
      throw new Error(`Derleme sunucusu ${norm(bInfo.Architecture as string)}, hedef sunucu ${norm(tInfo.Architecture as string)}; imaj çalışmaz. Aynı mimaride bir derleme sunucusu seç.`);
    }
    log(`İmaj derleme sunucusunda derleniyor (${builder.name}): ${tag}`);
    await build(builder);
    log(`İmaj ${server.name} sunucusuna aktarılıyor...`);
    const stream = await dockerFor(builder).getImage(tag).get();
    const res = await dockerFor(server).loadImage(stream);
    await new Promise<void>((resolve, reject) => dockerFor(server).modem.followProgress(res, (err) => (err ? reject(err) : resolve())));
    // Derleme sunucusunda yer kaplamasın (katman önbelleği kalır, sonraki derlemeler hızlı).
    await dockerFor(builder).getImage(tag).remove({ force: true }).catch(() => {});
    log("İmaj aktarıldı.");
  } else {
    log(`İmaj derleniyor: ${tag}`);
    await build(server);
  }
  return tag;
}

const basePulledAt = new Map<string, number>();
function shouldPullBase(key: string) {
  const last = basePulledAt.get(key) ?? 0;
  if (Date.now() - last < 86_400_000) return false;
  basePulledAt.set(key, Date.now());
  return true;
}

/** Framework'ün zorunlu ve alan adına bağlı env değişkenlerinden eksik olanları uygulamaya kalıcı olarak ekler. */
function addDefaultEnv(
  app: AppRow,
  fw: Framework,
  log: (l: string) => void,
  aliases: Record<string, string>,
  auto: { env?: Record<string, string>; volumes?: Volume[]; notes?: string[] } = {},
) {
  for (const [hint, name] of Object.entries(aliases)) log(`Proje ${hint} yerine ${name} değişkenini okuyor; değer bu adla verilecek.`);
  // Projenin çalışması için gereken kalıcı klasörler (aynı yola bağlı bir volume yoksa eklenir).
  const volumes = JSON.parse(app.volumes || "[]") as Volume[];
  const newVolumes = (auto.volumes ?? []).filter((v) => !volumes.some((x) => x.path === v.path || x.name === v.name));
  if (newVolumes.length) {
    app.volumes = JSON.stringify([...volumes, ...newVolumes]);
    db.prepare("UPDATE apps SET volumes = ? WHERE id = ?").run(app.volumes, app.id);
    log(`Kalıcı klasör eklendi: ${newVolumes.map((v) => v.path).join(", ")}`);
  }
  auto.notes?.forEach((n) => log(n));
  const raw = decrypt(app.env);
  const current = parseEnv(raw);
  const add = [
    ...missingDefaultEnv(fw, current, randomAlnum, aliases),
    ...Object.entries(auto.env ?? {}).filter(([k]) => !(k in current)).map(([key, value]) => ({ key, value })),
  ];
  if (!add.length) return;
  const next = (raw.trim() ? `${raw.trimEnd()}\n` : "") + add.map((e) => `${e.key}=${e.value}`).join("\n") + "\n";
  app.env = encrypt(next);
  db.prepare("UPDATE apps SET env = ? WHERE id = ?").run(app.env, app.id);
  log(`Eksik ortam değişkenleri otomatik eklendi: ${add.map((e) => e.key).join(", ")} (uygulama ayarlarından değiştirebilirsin)`);
}

type Volume = { name: string; path: string };

async function runContainer(app: AppRow, server: ServerRow, image: string, deploymentId: number, log: (l: string) => void, signal: AbortSignal) {
  const docker = dockerFor(server);
  const fresh = getApp(app.id)!;
  const filled = fillPlaceholders(parseEnv(decrypt(fresh.env)), app.id, server.https_mode !== "off");
  const env = { PORT: String(fresh.port), XUDBIN_URL: filled.values.XUDBIN_URL!, XUDBIN_DOMAINS: filled.values.XUDBIN_DOMAINS!, ...filled.env };
  const volumes = JSON.parse(fresh.volumes || "[]") as Volume[];
  const worker = fresh.kind === "worker";
  // Kopyalar (replica) aynı imajla çalışır; Caddy aralarında yük dağıtır. İşçiler ve kalıcı klasörlü uygulamalar
  // da birden çok kopya çalıştırabilir, ama klasörü paylaşırlar.
  const count = Math.max(1, Math.min(fresh.replicas || 1, 10));
  const base = `xb-${app.slug}-${deploymentId}`;
  const names = Array.from({ length: count }, (_, i) => (i === 0 ? base : `${base}-${i + 1}`));
  const network = await ensureProjectNetwork(server, app.project_id);
  const hosts = (db.prepare("SELECT host FROM domains WHERE app_id = ? ORDER BY generated, id").all(app.id) as { host: string }[]).map((d) => d.host);

  const created: string[] = [];
  const failWithLogs = async (name: string, message: string, extra: { status?: number | null } = {}): Promise<never> => {
    const logs = await docker.getContainer(name).logs({ stdout: true, stderr: true, tail: 300 }).catch(() => Buffer.from(""));
    const lines = demuxLogs(logs as Buffer);
    if (lines.length) {
      log(`Uygulamanın son çıktısı${count > 1 ? ` (${name})` : ""}:`);
      lines.slice(-60).forEach((l) => log(`  ${l}`));
    }
    const state = await containerState(docker, name);
    recordDiagnosis(deploymentId, diagnose(lines, { framework: app.framework, env: filled.env, hosts, status: extra.status, exitCode: state.running ? null : state.exitCode }), log);
    for (const n of created) await removeContainer(docker, n);
    throw new Error(`${message} Eski sürüm yayında kalmaya devam ediyor.`);
  };

  for (const name of names) {
    log(`Konteyner başlatılıyor: ${name}`);
    const container = await docker.createContainer({
      name,
      Image: image,
      Env: Object.entries({ ...env, XUDBIN_REPLICA: String(names.indexOf(name) + 1) }).map(([k, v]) => `${k}=${v}`),
      Cmd: fresh.command ? ["sh", "-c", fresh.command] : undefined,
      Labels: { "xudbin.managed": "true", "xudbin.app": app.slug, "xudbin.deployment": String(deploymentId) },
      HostConfig: {
        NetworkMode: network,
        RestartPolicy: { Name: "unless-stopped" },
        Binds: volumes.map((v) => `xb-${app.slug}-${v.name}:${v.path}`),
        // Sınır yoksa tek bir uygulama tüm sunucuyu (panel dahil) belleksiz bırakabilir.
        ...(fresh.memory_limit ? { Memory: fresh.memory_limit * 1024 * 1024, MemorySwap: fresh.memory_limit * 1024 * 1024 } : {}),
        ...(fresh.cpu_limit ? { NanoCpus: Math.round(fresh.cpu_limit * 1e9) } : {}),
        LogConfig: { Type: "json-file", Config: { "max-size": "10m", "max-file": "3" } },
      },
      NetworkingConfig: { EndpointsConfig: { [network]: { Aliases: [`xb-${app.slug}`] } } },
    });
    created.push(name);
    await container.start();
  }

  for (const name of names) {
    if (worker) {
      // Arka plan işçisi: dinlediği port yok; birkaç saniye sonra hâlâ çalışıyorsa başarılı sayılır.
      log(`İşçi kontrolü: ${name} 10 sn çalışmaya devam etmeli...`);
      for (let i = 0; i < 10; i++) {
        if (signal.aborted) await failWithLogs(name, String(signal.reason));
        await new Promise((r) => setTimeout(r, 1000));
        const state = await containerState(docker, name);
        if (!state.running) await failWithLogs(name, `İşçi kapandı (çıkış kodu ${state.exitCode}).`);
      }
      continue;
    }
    await waitForPort(name);
    if (fresh.http_check && fresh.source_type !== "compose") await httpCheck(name);
  }

  async function waitForPort(name: string) {
    // Sağlık kontrolü: trafik, yeni konteyner portunu gerçekten dinlemeye başlayana kadar eski sürümde kalır.
    // Kontrol, ortak ağdaki Caddy konteynerinden yapılır (uygulama imajında araç olması gerekmez).
    const started = Date.now();
    const limitMs = 120_000;
    let announced = false;
    let inspected = false;
    for (;;) {
      if (signal.aborted) await failWithLogs(name, String(signal.reason));
      const state = await containerState(docker, name);
      if (!state.running) await failWithLogs(name, `Konteyner kapandı (çıkış kodu ${state.exitCode}).`);
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
        await failWithLogs(name, `Uygulama 2 dakika içinde ${fresh.port} portunu dinlemeye başlamadı. Port ayarını ve uygulamanın PORT değişkenini kullandığını kontrol et. Web sunucusu değilse uygulama türünü "arka plan işçisi" yap.`);
      }
      if (!announced && Date.now() - started > 5000) {
        log(`Uygulamanın ${fresh.port} portunu açması bekleniyor...`);
        announced = true;
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    log(`${name} çalışıyor, ${fresh.port} portu ${Math.round((Date.now() - started) / 1000)} sn içinde yanıt verdi.`);
  }

  async function httpCheck(name: string) {
    // Port açık olması uygulamanın çalıştığı anlamına gelmez (ör. Django alan adını tanımayıp 400 döndürür).
    // Trafik yeni sürüme geçmeden önce gerçek alan adıyla bir HTTP isteği atılır.
    const host = hosts[0] ?? `xb-${app.slug}`;
    const pathToCheck = fresh.health_path || "/";
    const strict = Boolean(fresh.health_path);
    log(`HTTP kontrolü: GET ${pathToCheck} (Host: ${host})`);
    const deadline = Date.now() + 45_000;
    let clientErrors = 0;
    for (;;) {
      if (signal.aborted) await failWithLogs(name, String(signal.reason));
      const probe = await probeHttp(docker, name, fresh.port, host, pathToCheck);
      if (probe.status !== null && isHealthy(probe.status, strict)) {
        log(`HTTP kontrolü geçti: ${probe.statusLine}`);
        return;
      }
      // 4xx uygulama ısındıkça değişmez; art arda üç kez aynıysa beklemeye gerek yok. 5xx ve yanıtsızlık için süre tanınır.
      clientErrors = probe.status !== null && probe.status < 500 ? clientErrors + 1 : 0;
      if (Date.now() > deadline || clientErrors >= 3) {
        await failWithLogs(
          name,
          probe.status !== null
            ? `Uygulama çalışıyor ama ${pathToCheck} isteğine ${probe.status} döndürüyor (${probe.statusLine}).`
            : `Uygulama ${fresh.port} portunu açtı ama HTTP isteğine yanıt vermedi. Bu port bir web sunucusu değilse uygulama ayarlarından doğru portu seç ya da HTTP kontrolünü kapat.`,
          { status: probe.status },
        );
      }
      await new Promise((r) => setTimeout(r, 2500));
    }
  }

  // Ek sunuculardaki kopyalar (çok sunuculu yük dağıtımı). Başarısız ek sunucu atlanır; ana sunucu yayına geçer.
  const extras: ServerRow[] = [];
  for (const id of parseIds(fresh.extra_server_ids)) {
    let extra: ServerRow;
    try {
      extra = getServer(id);
    } catch {
      continue;
    }
    const problem = extraServerProblem(fresh, extra);
    if (problem) log(`Uyarı: ${problem}; bu sunucu atlanıyor.`);
    else extras.push(extra);
  }
  const previousRemote = remoteReplicasOf(fresh);
  const remote = await startRemoteReplicas({ app: fresh, primary: server, image, deploymentId, env, hosts, log, signal }, extras);

  const previous = [fresh.container, ...(JSON.parse(fresh.replica_containers || "[]") as string[])].filter((n): n is string => Boolean(n) && !names.includes(n!));
  db.prepare("UPDATE apps SET container = ?, replica_containers = ?, remote_replicas = ?, current_image = ? WHERE id = ?").run(
    names[0]!,
    JSON.stringify(names.slice(1)),
    JSON.stringify(remote),
    image,
    app.id,
  );
  const total = count + remote.length;
  // Önce ek sunucular yeni kopyaları kabul edecek şekilde güncellenir, sonra ana sunucu trafiği onlara da yollar.
  const touched = [...new Set([...remote, ...previousRemote].map((r) => r.serverId))];
  for (const sid of touched) {
    try {
      const s = getServer(sid);
      await applyCaddyConfig(s);
      if (remote.some((r) => r.serverId === sid)) await ensureRelayCa(s, log);
    } catch (err) {
      log(`Uyarı: ek sunucu Caddy yapılandırması güncellenemedi: ${(err as Error).message}`);
    }
  }
  log(total > 1 ? `Trafik ${total} kopyaya dağıtılıyor${remote.length ? ` (${remote.length} tanesi ek sunucularda)` : ""}...` : "Trafik yeni sürüme yönlendiriliyor...");
  await applyCaddyConfig(server);
  if (remote.length) {
    // Ana sunucu kendi kopyalarına da şifreli yoldan gider; iç CA'sı ilk kez oluştuysa yapılandırma bir kez daha uygulanır.
    const before = server.relay_ca;
    if ((await ensureRelayCa(server, log)) !== before) await applyCaddyConfig(server);
  }

  for (const p of previous) {
    log(`Eski konteyner kaldırılıyor: ${p}`);
    await removeContainer(docker, p);
  }
  await removeRemoteReplicas(previousRemote.filter((r) => !remote.some((x) => x.container === r.container)), log);
  if (!worker) await waitForCertificates(server, app.id, log);
}

/** HTTPS'li alan adlarının sertifikası alınana kadar (en fazla 90 sn) bekler; alınamazsa sebebini söyler. */
async function waitForCertificates(server: ServerRow, appId: number, log: (l: string) => void) {
  if (server.https_mode === "off") return;
  const hosts = (db.prepare("SELECT host FROM domains WHERE app_id = ? AND https = 1").all(appId) as { host: string }[]).map((d) => d.host);
  const pending = [];
  for (const h of hosts) if (!(await certificateReady(server, h))) pending.push(h);
  if (!pending.length) return;
  log(`HTTPS sertifikası alınıyor: ${pending.join(", ")}`);
  const deadline = Date.now() + 90_000;
  while (pending.length && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    for (const h of [...pending]) if (await certificateReady(server, h)) pending.splice(pending.indexOf(h), 1);
  }
  if (pending.length) log(`Uyarı: ${pending.join(", ")} için sertifika henüz alınamadı. Alan adının DNS kaydı bu sunucuyu göstermiyor olabilir; Caddy denemeye devam ediyor.`);
  else log("HTTPS sertifikaları hazır.");
}

function recordDiagnosis(deploymentId: number, findings: Finding[], log: (l: string) => void) {
  db.prepare("UPDATE deployments SET diagnosis = ? WHERE id = ?").run(findings.length ? JSON.stringify(findings) : null, deploymentId);
  if (!findings.length) return;
  log("Deploy Doktoru:");
  for (const f of findings) {
    log(`  • ${f.title}`);
    log(`    ${f.detail}`);
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
    `Host xudbin-target\n  HostName ${server.host}\n  Port ${server.port}\n  User ${server.username}\n  IdentityFile ${path.join(sshDir, "id")}\n  StrictHostKeyChecking ${server.host_key ? "yes" : "accept-new"}\n  UserKnownHostsFile ${path.join(sshDir, "known_hosts")}\n`,
    { mode: 0o600 },
  );
  // Panelin kaydettiği sunucu anahtarı: docker CLI de yalnız bu anahtarla bağlanır.
  if (server.host_key) fs.writeFileSync(path.join(sshDir, "known_hosts"), `${server.port === 22 ? server.host : `[${server.host}]:${server.port}`} ${server.host_key}\n`, { mode: 0o600 });
  return { HOME: home, DOCKER_HOST: "ssh://xudbin-target", DOCKER_CONFIG: path.join(home, ".docker") };
}

async function deployCompose(app: AppRow, server: ServerRow, workdir: string, log: (l: string) => void, signal: AbortSignal) {
  let dir: string;
  let composePath: string;
  if (app.git_url) {
    const cloned = await cloneRepo(app, workdir, log, signal);
    dir = cloned.dir;
    const found = resolveInside(dir, app.dockerfile_path || "docker-compose.yml");
    if (!found) throw new Error("Compose dosyası repo dışında olamaz");
    composePath = found;
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
  if (!app.host_access) {
    const issues = composeHostAccessIssues(doc as Parameters<typeof composeHostAccessIssues>[0]);
    if (issues.length) {
      issues.forEach((i) => log(`  ${i}`));
      throw new Error("Compose dosyası sunucunun kendisine erişim istiyor. Bu ayarlar konteynere sunucuda root yetkisi verebileceği için ancak bir yönetici uygulama ayarlarından \"Sunucu erişimi\" iznini açarsa çalıştırılır.");
    }
  }
  log(`Servisler: ${services.join(", ")}`);

  // Her servisi Xudbin ağına da bağla ki Caddy alan adlarını yönlendirebilsin.
  const override = {
    services: Object.fromEntries(services.map((s) => [s, { networks: ["default", "xudbin"], labels: { "xudbin.managed": "true", "xudbin.app": app.slug } }])),
    networks: { xudbin: { external: true, name: await ensureProjectNetwork(server, app.project_id) } },
  };
  const overridePath = path.join(dir, "docker-compose.xudbin.yml");
  fs.writeFileSync(overridePath, YAML.stringify(override));
  // Compose, .env dosyasındaki değişkenleri ${AD} biçimindeki yerlere koyar; yer tutucular önce doldurulur.
  const composeVars = fillPlaceholders(parseEnv(decrypt(app.env)), app.id, server.https_mode !== "off").env;
  // Tek tırnak: Compose içini olduğu gibi okur ($ işareti değişken sanılmaz). Tek tırnak içeren değerler çift tırnakla.
  const quote = (v: string) => (v.includes("'") || v.includes("\n") ? JSON.stringify(v) : `'${v}'`);
  fs.writeFileSync(path.join(dir, ".env"), Object.entries(composeVars).map(([k, v]) => `${k}=${quote(v)}`).join("\n") + "\n", { mode: 0o600 });

  const env = composeEnv(server, workdir);
  const args = ["compose", "-p", `xb-${app.slug}`, "-f", composePath, "-f", overridePath];
  log("docker compose up çalıştırılıyor...");
  await run(dockerBin(), [...args, "up", "-d", "--build", "--remove-orphans", "--wait", "--wait-timeout", "120"], { cwd: dir, env, log, signal });
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
