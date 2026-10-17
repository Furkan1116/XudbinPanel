import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { ENCRYPTED_EXT, encryptStream, openBackupPlain } from "../lib/backup-crypto.js";
import { config } from "../config.js";
import { db } from "../db.js";
import { s3Delete, s3Download, s3Upload } from "../lib/s3.js";
import { composeCommand, getApp, type AppRow } from "./deploy.js";
import { dockerFor, removeContainer, withTimeout } from "./docker.js";
import { notify } from "./notify.js";
import { offsiteTarget } from "./offsite.js";
import { getServer } from "./servers.js";

/**
 * Kalıcı klasör (volume) yedekleri: uygulamanın Docker volume'ları, onları salt okunur bağlayan geçici bir
 * konteynerden Docker'ın arşiv API'siyle tar olarak alınır ve sıkıştırılır; uzak depolamaya da yüklenir.
 * Geri yüklemede uygulama durdurulur, volume boşaltılıp yedek açılır, uygulama yeniden başlatılır.
 */
const DIR = path.join(config.dataDir, "backups", "_volumes");
const HELPER_IMAGE = config.caddyImage; // her sunucuda bulunan, tar/sh içeren küçük bir imaj

export async function appVolumes(app: AppRow): Promise<string[]> {
  const docker = dockerFor(getServer(app.server_id));
  if (app.source_type === "compose") {
    const res = await docker.listVolumes({ filters: { label: [`com.docker.compose.project=xb-${app.slug}`] } }).catch(() => ({ Volumes: [] }));
    return (res.Volumes ?? []).map((v) => v.Name).sort();
  }
  const declared = (JSON.parse(app.volumes || "[]") as { name: string }[]).map((v) => `xb-${app.slug}-${v.name}`);
  const existing = new Set(((await docker.listVolumes().catch(() => ({ Volumes: [] }))).Volumes ?? []).map((v) => v.Name));
  return declared.filter((n) => existing.has(n));
}

async function helper(app: AppRow, volume: string, readOnly: boolean, cmd?: string[]) {
  const docker = dockerFor(getServer(app.server_id));
  const name = `xb-volbackup-${app.slug}-${Date.now()}`;
  const c = await docker.createContainer({
    name,
    Image: HELPER_IMAGE,
    Entrypoint: cmd ? ["sh", "-c"] : ["true"],
    Cmd: cmd,
    Labels: { "xudbin.managed": "true", "xudbin.task": "volume-backup" },
    HostConfig: { Binds: [`${volume}:/v${readOnly ? ":ro" : ""}`], NetworkMode: "none" },
  });
  return { docker, c, name };
}

let chain: Promise<unknown> = Promise.resolve();
const serial = <T>(fn: () => Promise<T>) => {
  const run = chain.then(fn);
  chain = run.catch(() => {});
  return run;
};

export function backupAppVolumes(appId: number, trigger: "manual" | "schedule" = "manual") {
  return serial(async () => {
    const app = getApp(appId);
    if (!app) throw new Error("Uygulama bulunamadı");
    const volumes = await appVolumes(app);
    if (!volumes.length) throw new Error("Bu uygulamanın kalıcı klasörü (volume) yok");
    fs.mkdirSync(path.join(DIR, app.slug), { recursive: true });
    const results: number[] = [];
    for (const volume of volumes) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const file = `${volume}-${stamp}.tar.gz${ENCRYPTED_EXT}`;
      const id = Number(db.prepare("INSERT INTO volume_backups (app_id, volume, file, status, trigger, created_at) VALUES (?, ?, ?, 'running', ?, ?)").run(app.id, volume, file, trigger, Date.now()).lastInsertRowid);
      const full = path.join(DIR, app.slug, file);
      const h = await helper(app, volume, true);
      try {
        const archive = await h.c.getArchive({ path: "/v" });
        await withTimeout(pipeline(archive, createGzip(), encryptStream(), fs.createWriteStream(full, { mode: 0o600 })), 60 * 60_000, "Yedek 1 saatte bitmedi");
        const size = fs.statSync(full).size;
        db.prepare("UPDATE volume_backups SET status = 'success', size = ? WHERE id = ?").run(size, id);
        const target = offsiteTarget();
        if (target) {
          try {
            const key = await s3Upload(target, `volumes/${app.slug}/${file}`, full);
            db.prepare("UPDATE volume_backups SET remote_key = ? WHERE id = ?").run(key, id);
          } catch (e) {
            db.prepare("UPDATE volume_backups SET remote_error = ? WHERE id = ?").run((e as Error).message, id);
          }
        }
        results.push(id);
      } catch (e) {
        fs.rmSync(full, { force: true });
        db.prepare("UPDATE volume_backups SET status = 'failed', error = ? WHERE id = ?").run((e as Error).message, id);
        notify("backup_failed", `${app.name}: ${volume} yedeklenemedi`, (e as Error).message);
      } finally {
        await removeContainer(h.docker, h.name);
      }
    }
    await prune(app);
    db.prepare("UPDATE apps SET last_volume_backup_at = ? WHERE id = ?").run(Date.now(), app.id);
    return results;
  });
}

async function prune(app: AppRow) {
  const keep = Math.max(1, app.volume_backup_keep || 7);
  const target = offsiteTarget();
  for (const volume of new Set((db.prepare("SELECT volume FROM volume_backups WHERE app_id = ?").all(app.id) as { volume: string }[]).map((r) => r.volume))) {
    const old = db
      .prepare("SELECT id, file, remote_key FROM volume_backups WHERE app_id = ? AND volume = ? AND status = 'success' ORDER BY id DESC LIMIT -1 OFFSET ?")
      .all(app.id, volume, keep) as { id: number; file: string; remote_key: string | null }[];
    for (const b of old) {
      fs.rmSync(path.join(DIR, app.slug, b.file), { force: true });
      if (b.remote_key && target) await s3Delete(target, b.remote_key).catch(() => {});
      db.prepare("DELETE FROM volume_backups WHERE id = ?").run(b.id);
    }
  }
}

export function volumeBackupFile(app: AppRow, file: string) {
  return path.join(DIR, app.slug, path.basename(file));
}

/** Yedeği geri yükler: uygulama durur, volume boşaltılır, yedek açılır, uygulama başlar. */
export function restoreVolumeBackup(appId: number, backupId: number) {
  return serial(async () => {
    const app = getApp(appId);
    if (!app) throw new Error("Uygulama bulunamadı");
    const b = db.prepare("SELECT * FROM volume_backups WHERE id = ? AND app_id = ? AND status = 'success'").get(backupId, app.id) as
      | { volume: string; file: string; remote_key: string | null }
      | undefined;
    if (!b) throw new Error("Yedek bulunamadı");
    let full = volumeBackupFile(app, b.file);
    if (!fs.existsSync(full)) {
      const target = offsiteTarget();
      if (!b.remote_key || !target) throw new Error("Yedek dosyası bulunamadı");
      fs.mkdirSync(path.dirname(full), { recursive: true });
      await s3Download(target, b.remote_key, full);
    }
    const docker = dockerFor(getServer(app.server_id));
    const names = app.source_type === "compose" ? [] : [app.container, ...(JSON.parse(app.replica_containers || "[]") as string[])].filter((n): n is string => Boolean(n));
    if (app.source_type === "compose") await composeCommand(app, "stop");
    else for (const n of names) await docker.getContainer(n).stop({ t: 10 }).catch(() => {});
    try {
      const wipe = await helper(app, b.volume, false, ["find /v -mindepth 1 -delete"]);
      await wipe.c.start();
      await withTimeout(wipe.c.wait(), 10 * 60_000, "Volume boşaltılamadı");
      await removeContainer(wipe.docker, wipe.name);
      const h = await helper(app, b.volume, false);
      try {
        await h.c.putArchive(await openBackupPlain(full), { path: "/" });
      } finally {
        await removeContainer(h.docker, h.name);
      }
    } finally {
      if (app.source_type === "compose") await composeCommand(app, "start").catch(() => {});
      else for (const n of names) await docker.getContainer(n).start().catch(() => {});
    }
  });
}

export function startVolumeBackupScheduler() {
  setInterval(() => {
    const due = db
      .prepare(
        `SELECT id FROM apps WHERE volume_backup_interval_h > 0 AND status = 'running'
         AND (last_volume_backup_at IS NULL OR last_volume_backup_at + volume_backup_interval_h * 3600000 <= ?)`,
      )
      .all(Date.now()) as { id: number }[];
    for (const a of due) {
      db.prepare("UPDATE apps SET last_volume_backup_at = ? WHERE id = ?").run(Date.now(), a.id);
      backupAppVolumes(a.id, "schedule").catch((e) => console.error(`Volume yedeği alınamadı (#${a.id}):`, (e as Error).message));
    }
  }, 5 * 60_000).unref();
}
