import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import { config } from "../config.js";
import { db } from "../db.js";
import { decrypt, randomAlnum } from "../lib/crypto.js";
import { getSettings } from "../lib/settings.js";
import { s3Delete, s3Download, s3Upload } from "../lib/s3.js";
import { containerState, dockerFor, execIn, pullImage, removeContainer } from "./docker.js";
import { notify } from "./notify.js";
import { applyDockerFirewall } from "./firewall.js";
import { offsiteTarget } from "./offsite.js";
import { getServer } from "./servers.js";

export type Engine = "postgres" | "mysql" | "mariadb" | "mongo" | "redis";

export type DatabaseRow = {
  id: number;
  project_id: number;
  server_id: number;
  name: string;
  slug: string;
  engine: Engine;
  version: string;
  db_name: string;
  db_user: string;
  db_password: string;
  external_port: number | null;
  status: string;
  backup_interval_h: number;
  backup_keep: number;
  last_backup_at: number | null;
  last_verify_at: number | null;
  created_at: number;
};

export const ENGINES: Record<Engine, { label: string; image: string; versions: string[]; port: number; dataPath: string }> = {
  postgres: { label: "PostgreSQL", image: "postgres", versions: ["17", "16", "15"], port: 5432, dataPath: "/var/lib/postgresql/data" },
  mysql: { label: "MySQL", image: "mysql", versions: ["8.4", "8.0"], port: 3306, dataPath: "/var/lib/mysql" },
  mariadb: { label: "MariaDB", image: "mariadb", versions: ["11", "10.11"], port: 3306, dataPath: "/var/lib/mysql" },
  mongo: { label: "MongoDB", image: "mongo", versions: ["8", "7"], port: 27017, dataPath: "/data/db" },
  redis: { label: "Redis", image: "redis", versions: ["7-alpine", "8-alpine"], port: 6379, dataPath: "/data" },
};

export const containerName = (d: DatabaseRow) => `xb-db-${d.slug}`;

export function getDatabase(id: number) {
  return db.prepare("SELECT * FROM databases WHERE id = ?").get(id) as DatabaseRow | undefined;
}

function engineEnv(d: DatabaseRow, password: string): string[] {
  switch (d.engine) {
    case "postgres":
      return [`POSTGRES_DB=${d.db_name}`, `POSTGRES_USER=${d.db_user}`, `POSTGRES_PASSWORD=${password}`];
    case "mysql":
      return [`MYSQL_DATABASE=${d.db_name}`, `MYSQL_USER=${d.db_user}`, `MYSQL_PASSWORD=${password}`, `MYSQL_ROOT_PASSWORD=${password}`];
    case "mariadb":
      return [`MARIADB_DATABASE=${d.db_name}`, `MARIADB_USER=${d.db_user}`, `MARIADB_PASSWORD=${password}`, `MARIADB_ROOT_PASSWORD=${password}`];
    case "mongo":
      return [`MONGO_INITDB_ROOT_USERNAME=${d.db_user}`, `MONGO_INITDB_ROOT_PASSWORD=${password}`, `MONGO_INITDB_DATABASE=${d.db_name}`];
    case "redis":
      return [];
  }
}

/** Diğer uygulamaların Xudbin ağı içinden kullanacağı bağlantı adresi. */
export function connectionUrl(d: DatabaseRow, password: string, host = containerName(d), port = ENGINES[d.engine].port) {
  const p = encodeURIComponent(password);
  switch (d.engine) {
    case "postgres":
      return `postgresql://${d.db_user}:${p}@${host}:${port}/${d.db_name}`;
    case "mysql":
    case "mariadb":
      return `mysql://${d.db_user}:${p}@${host}:${port}/${d.db_name}`;
    case "mongo":
      return `mongodb://${d.db_user}:${p}@${host}:${port}/${d.db_name}?authSource=admin`;
    case "redis":
      return `redis://default:${p}@${host}:${port}`;
  }
}

/** Veritabanı konteynerini (yeniden) oluşturup başlatır. Veri, adlandırılmış volume'da kalır. */
export async function startDatabase(d: DatabaseRow, log: (l: string) => void = () => {}) {
  const server = getServer(d.server_id);
  const docker = dockerFor(server);
  const engine = ENGINES[d.engine];
  const image = `${engine.image}:${d.version}`;
  const password = decrypt(d.db_password);
  const name = containerName(d);

  db.prepare("UPDATE databases SET status = 'starting' WHERE id = ?").run(d.id);
  try {
    await pullImage(docker, image, log);
    // Dışarı açılan port Docker güvenlik duvarında izinli olmalı; konteyner açılmadan önce güncellenir.
    await applyDockerFirewall(server).catch((err) => log(`Uyarı: ${(err as Error).message}`));
    await removeContainer(docker, name);
    await docker.createContainer({
      name,
      Image: image,
      Env: engineEnv(d, password),
      Cmd: d.engine === "redis" ? ["redis-server", "--requirepass", password, "--appendonly", "yes"] : undefined,
      Labels: { "xudbin.managed": "true", "xudbin.database": d.slug },
      ExposedPorts: { [`${engine.port}/tcp`]: {} },
      HostConfig: {
        NetworkMode: config.network,
        RestartPolicy: { Name: "unless-stopped" },
        Binds: [`xb-db-${d.slug}-data:${engine.dataPath}`],
        PortBindings: d.external_port ? { [`${engine.port}/tcp`]: [{ HostPort: String(d.external_port) }] } : undefined,
        LogConfig: { Type: "json-file", Config: { "max-size": "10m", "max-file": "3" } },
      },
    });
    await docker.getContainer(name).start();
    db.prepare("UPDATE databases SET status = 'running' WHERE id = ?").run(d.id);
  } catch (err) {
    db.prepare("UPDATE databases SET status = 'failed' WHERE id = ?").run(d.id);
    throw err;
  }
}

export async function databaseAction(d: DatabaseRow, action: "stop" | "start" | "restart") {
  const docker = dockerFor(getServer(d.server_id));
  const c = docker.getContainer(containerName(d));
  const state = await containerState(docker, containerName(d));
  if (!state.exists) return startDatabase(d);
  if (action === "stop") await c.stop().catch(() => {});
  if (action === "start") await c.start().catch(() => {});
  if (action === "restart") await c.restart();
  db.prepare("UPDATE databases SET status = ? WHERE id = ?").run(action === "stop" ? "stopped" : "running", d.id);
}

export async function deleteDatabase(d: DatabaseRow, withData: boolean) {
  const docker = dockerFor(getServer(d.server_id));
  await removeContainer(docker, containerName(d));
  if (withData) {
    try {
      await docker.getVolume(`xb-db-${d.slug}-data`).remove();
    } catch {}
  }
  fs.rmSync(backupDir(d), { recursive: true, force: true });
  db.prepare("DELETE FROM databases WHERE id = ?").run(d.id);
  if (d.external_port) await applyDockerFirewall(getServer(d.server_id)).catch(() => {});
}

// ---------------------------------------------------------------------------
// Yedekleme
// ---------------------------------------------------------------------------

export const backupDir = (d: DatabaseRow) => path.join(config.dataDir, "backups", d.slug);

function dumpCommand(d: DatabaseRow): { cmd: string[]; ext: string } {
  switch (d.engine) {
    case "postgres":
      return { cmd: ["sh", "-c", `PGPASSWORD="$P" pg_dump -U ${d.db_user} -d ${d.db_name} --clean --if-exists`], ext: "sql" };
    case "mysql":
    case "mariadb": {
      const bin = d.engine === "mysql" ? "mysqldump" : "mariadb-dump";
      return { cmd: ["sh", "-c", `${bin} -u root -p"$P" --single-transaction --routines --databases ${d.db_name}`], ext: "sql" };
    }
    case "mongo":
      return { cmd: ["sh", "-c", `mongodump --archive -u ${d.db_user} -p "$P" --authenticationDatabase admin --db ${d.db_name}`], ext: "archive" };
    case "redis":
      return { cmd: ["sh", "-c", `redis-cli -a "$P" --no-auth-warning --rdb /tmp/xudbin.rdb >/dev/null && cat /tmp/xudbin.rdb && rm /tmp/xudbin.rdb`], ext: "rdb" };
  }
}

export async function createBackup(d: DatabaseRow) {
  const password = decrypt(d.db_password);
  const { cmd, ext } = dumpCommand(d);
  const dir = backupDir(d);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const file = `${d.slug}-${stamp}.${ext}.gz`;
  const res = db
    .prepare("INSERT INTO backups (database_id, file, status, created_at) VALUES (?, ?, 'running', ?)")
    .run(d.id, file, Date.now());
  const backupId = Number(res.lastInsertRowid);

  try {
    const docker = dockerFor(getServer(d.server_id));
    const exec = await docker.getContainer(containerName(d)).exec({
      Cmd: cmd,
      Env: [`P=${password}`],
      AttachStdout: true,
      AttachStderr: true,
    });
    const stream = await exec.start({ hijack: true, stdin: false });
    const { PassThrough } = await import("node:stream");
    const out = new PassThrough();
    const err = new PassThrough();
    let stderr = "";
    err.on("data", (c: Buffer) => (stderr += c.toString()));
    docker.modem.demuxStream(stream, out, err);
    stream.on("end", () => out.end());
    stream.on("close", () => out.end());
    await pipeline(out, createGzip(), fs.createWriteStream(path.join(dir, file)));
    const info = await exec.inspect();
    if (info.ExitCode !== 0) throw new Error(stderr.trim().split("\n").pop() || `Yedekleme ${info.ExitCode} koduyla çıktı`);
    const size = fs.statSync(path.join(dir, file)).size;
    db.prepare("UPDATE backups SET status = 'success', size = ? WHERE id = ?").run(size, backupId);
    db.prepare("UPDATE databases SET last_backup_at = ? WHERE id = ?").run(Date.now(), d.id);
    await uploadOffsite(d, backupId, path.join(dir, file));
    await pruneBackups(d);
    return backupId;
  } catch (e) {
    const message = (e as Error).message;
    fs.rmSync(path.join(dir, file), { force: true });
    db.prepare("UPDATE backups SET status = 'failed', error = ? WHERE id = ?").run(message, backupId);
    notify("backup_failed", `${d.name} yedeklenemedi`, message);
    throw e;
  }
}

/** Uzak depolama tanımlıysa yedeği oraya da yükler; sunucu giderse yedek kaybolmaz. */
async function uploadOffsite(d: DatabaseRow, backupId: number, file: string) {
  const target = offsiteTarget();
  if (!target) return;
  try {
    const key = await s3Upload(target, `databases/${d.slug}/${path.basename(file)}`, file);
    db.prepare("UPDATE backups SET remote_key = ?, remote_error = NULL WHERE id = ?").run(key, backupId);
  } catch (e) {
    db.prepare("UPDATE backups SET remote_error = ? WHERE id = ?").run((e as Error).message, backupId);
    notify("backup_failed", `${d.name} yedeği uzak depolamaya yüklenemedi`, (e as Error).message);
  }
}

async function pruneBackups(d: DatabaseRow) {
  const keep = Math.max(1, d.backup_keep);
  const old = db
    .prepare("SELECT id, file, remote_key FROM backups WHERE database_id = ? AND status = 'success' ORDER BY id DESC LIMIT -1 OFFSET ?")
    .all(d.id, keep) as { id: number; file: string; remote_key: string | null }[];
  const target = offsiteTarget();
  for (const b of old) {
    fs.rmSync(path.join(backupDir(d), b.file), { force: true });
    if (b.remote_key && target) await s3Delete(target, b.remote_key).catch(() => {});
    db.prepare("DELETE FROM backups WHERE id = ?").run(b.id);
  }
}

/** Yedek dosyası yerelde yoksa (ör. panel yeni sunucuya taşındı) uzak depolamadan indirir. */
async function localBackupFile(d: DatabaseRow, file: string) {
  const full = path.join(backupDir(d), path.basename(file));
  if (fs.existsSync(full)) return full;
  const row = db.prepare("SELECT remote_key FROM backups WHERE database_id = ? AND file = ?").get(d.id, path.basename(file)) as { remote_key: string | null } | undefined;
  const target = offsiteTarget();
  if (!row?.remote_key || !target) throw new Error("Yedek dosyası bulunamadı");
  fs.mkdirSync(backupDir(d), { recursive: true });
  await s3Download(target, row.remote_key, full);
  return full;
}

function restoreCommand(d: DatabaseRow): string | null {
  const cmd: Record<Engine, string | null> = {
    postgres: `PGPASSWORD="$P" psql -v ON_ERROR_STOP=1 -h 127.0.0.1 -U ${d.db_user} -d ${d.db_name}`,
    mysql: `mysql -u root -p"$P"`,
    mariadb: `mariadb -u root -p"$P"`,
    mongo: `mongorestore --archive --drop -u ${d.db_user} -p "$P" --authenticationDatabase admin`,
    redis: null,
  };
  return cmd[d.engine];
}

export async function restoreBackup(d: DatabaseRow, file: string) {
  const full = await localBackupFile(d, file);
  const password = decrypt(d.db_password);
  const c = restoreCommand(d);
  if (!c) throw new Error("Redis yedeği panelden geri yüklenemez; .rdb dosyasını indirip elle yükle.");
  const res = await execIn(dockerFor(getServer(d.server_id)), containerName(d), ["sh", "-c", c], {
    stdin: fs.createReadStream(full).pipe(createGunzip()),
    env: [`P=${password}`],
    timeoutMs: 30 * 60_000,
  });
  if (res.exitCode !== 0) throw new Error(res.stderr.trim().split("\n").pop() || "Geri yükleme başarısız");
}

// ---------------------------------------------------------------------------
// Yedek doğrulama: yedek, geçici bir konteynere geri yüklenip içi sayılır.
// ---------------------------------------------------------------------------

function readyCommand(d: DatabaseRow): string {
  switch (d.engine) {
    case "postgres":
      return `pg_isready -q -h 127.0.0.1 -U ${d.db_user} -d ${d.db_name}`;
    case "mysql":
      return `mysqladmin ping -h 127.0.0.1 -uroot -p"$P" --silent`;
    case "mariadb":
      return `mariadb-admin ping -h 127.0.0.1 -uroot -p"$P" --silent`;
    case "mongo":
      return `mongosh --quiet -u ${d.db_user} -p "$P" --authenticationDatabase admin --eval 'db.runCommand({ping:1}).ok' | grep -q 1`;
    case "redis":
      return "redis-cli ping | grep -q PONG";
  }
}

function countCommand(d: DatabaseRow): string {
  switch (d.engine) {
    case "postgres":
      return `PGPASSWORD="$P" psql -h 127.0.0.1 -U ${d.db_user} -d ${d.db_name} -tAc "select count(*) from information_schema.tables where table_schema not in ('pg_catalog','information_schema')"`;
    case "mysql":
    case "mariadb":
      return `${d.engine === "mysql" ? "mysql" : "mariadb"} -h 127.0.0.1 -uroot -p"$P" -N -e "select count(*) from information_schema.tables where table_schema='${d.db_name}'"`;
    case "mongo":
      return `mongosh --quiet -u ${d.db_user} -p "$P" --authenticationDatabase admin --eval "db.getSiblingDB('${d.db_name}').getCollectionNames().length"`;
    case "redis":
      return "";
  }
}

let verifyChain: Promise<unknown> = Promise.resolve();

/** Aynı anda tek doğrulama çalışır (geçici konteynerler sunucuyu yormasın). */
export function verifyBackup(d: DatabaseRow, backupId: number) {
  const run = verifyChain.then(() => doVerify(d, backupId));
  verifyChain = run.catch(() => {});
  return run;
}

async function doVerify(d: DatabaseRow, backupId: number) {
  const b = db.prepare("SELECT * FROM backups WHERE id = ? AND database_id = ?").get(backupId, d.id) as { file: string; status: string } | undefined;
  if (!b || b.status !== "success") throw new Error("Doğrulanacak başarılı bir yedek yok");
  db.prepare("UPDATE backups SET verify_status = 'running', verify_note = NULL WHERE id = ?").run(backupId);
  const docker = dockerFor(getServer(d.server_id));
  const name = `xb-verify-${d.slug}`;
  const pass = randomAlnum(24);
  const env = [`P=${pass}`];
  const finish = (status: "success" | "failed", note: string) => {
    db.prepare("UPDATE backups SET verify_status = ?, verify_note = ?, verified_at = ? WHERE id = ?").run(status, note, Date.now(), backupId);
    db.prepare("UPDATE databases SET last_verify_at = ? WHERE id = ?").run(Date.now(), d.id);
    return { status, note };
  };
  try {
    const full = await localBackupFile(d, b.file);
    const image = `${ENGINES[d.engine].image}:${d.version}`;
    await pullImage(docker, image, () => {});
    await removeContainer(docker, name);
    await docker.createContainer({
      name,
      Image: image,
      Env: engineEnv(d, pass),
      Labels: { "xudbin.managed": "true", "xudbin.task": "verify-backup" },
      // Ağ yok: geri yüklenen veri hiçbir yere ulaşamaz, hiçbir yerden ulaşılamaz.
      HostConfig: { NetworkMode: "none", Memory: 1024 * 1024 * 1024, AutoRemove: false },
    });
    await docker.getContainer(name).start();

    if (d.engine === "redis") {
      const res = await execIn(docker, name, ["sh", "-c", "cat > /tmp/dump.rdb && redis-check-rdb /tmp/dump.rdb"], {
        stdin: fs.createReadStream(full).pipe(createGunzip()),
        timeoutMs: 10 * 60_000,
      });
      const out = res.stdout + res.stderr;
      if (res.exitCode !== 0 || !/RDB looks OK/i.test(out)) throw new Error(out.trim().split("\n").pop() || "RDB dosyası okunamadı");
      const keys = out.match(/(\d+) keys read/)?.[1];
      return finish("success", keys ? `${keys} anahtar` : "RDB dosyası sağlam");
    }

    // Hazır olana kadar bekle; ilk açılıştaki geçici sunucuya takılmamak için art arda iki başarılı yanıt aranır.
    let ok = 0;
    const deadline = Date.now() + 180_000;
    while (ok < 2) {
      if (Date.now() > deadline) throw new Error("Geçici veritabanı 3 dakikada hazır olmadı");
      const state = await containerState(docker, name);
      if (!state.running) throw new Error(`Geçici veritabanı kapandı (çıkış kodu ${state.exitCode})`);
      const r = await execIn(docker, name, ["sh", "-c", readyCommand(d)], { env, timeoutMs: 15_000 }).catch(() => ({ exitCode: 1 }));
      ok = r.exitCode === 0 ? ok + 1 : 0;
      await new Promise((res) => setTimeout(res, 3000));
    }

    const restore = await execIn(docker, name, ["sh", "-c", restoreCommand(d)!], {
      stdin: fs.createReadStream(full).pipe(createGunzip()),
      env,
      timeoutMs: 30 * 60_000,
    });
    if (restore.exitCode !== 0) throw new Error(`Geri yüklenemedi: ${restore.stderr.trim().split("\n").pop() || restore.exitCode}`);
    const count = await execIn(docker, name, ["sh", "-c", countCommand(d)], { env, timeoutMs: 60_000 });
    const n = Number(count.stdout.trim().split("\n").pop());
    if (count.exitCode !== 0 || Number.isNaN(n)) throw new Error(`Geri yüklenen veri okunamadı: ${count.stderr.trim().split("\n").pop() ?? ""}`);
    const unit = d.engine === "mongo" ? "koleksiyon" : "tablo";
    return finish("success", n === 0 ? `Geri yüklendi, 0 ${unit} (veritabanı boş)` : `Geri yüklendi, ${n} ${unit}`);
  } catch (e) {
    const message = (e as Error).message;
    finish("failed", message);
    notify("backup_failed", `${d.name} yedeği doğrulanamadı`, `Yedek geçici bir veritabanına geri yüklenemedi: ${message}`);
    throw e;
  } finally {
    await removeContainer(docker, name).catch(() => {});
    await docker.getContainer(name).remove({ force: true, v: true }).catch(() => {});
  }
}

/** Dakikada bir: zamanı gelen otomatik yedekleri alır. */
export function startBackupScheduler() {
  setInterval(() => {
    const due = db
      .prepare(
        `SELECT * FROM databases WHERE backup_interval_h > 0 AND status = 'running'
         AND (last_backup_at IS NULL OR last_backup_at + backup_interval_h * 3600000 <= ?)`,
      )
      .all(Date.now()) as DatabaseRow[];
    const everyH = getSettings().verifyBackupsEveryH;
    for (const d of due) {
      db.prepare("UPDATE databases SET last_backup_at = ? WHERE id = ?").run(Date.now(), d.id);
      createBackup(d)
        .then((backupId) => {
          // Yedeğin gerçekten geri yüklenebildiği düzenli olarak denenir.
          const fresh = getDatabase(d.id);
          if (fresh && everyH > 0 && (!fresh.last_verify_at || fresh.last_verify_at + everyH * 3_600_000 <= Date.now())) return verifyBackup(fresh, backupId);
        })
        .catch((e) => console.error(`Otomatik yedek başarısız (${d.name}):`, (e as Error).message));
    }
  }, 60_000).unref();
}
