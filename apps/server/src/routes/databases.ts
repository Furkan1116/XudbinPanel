import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { db } from "../db.js";
import { decrypt, encrypt, randomAlnum } from "../lib/crypto.js";
import { body, HttpError, idParam, must } from "../lib/http.js";
import { makeSlug } from "../lib/slug.js";
import {
  backupDir,
  connectionUrl,
  containerName,
  createBackup,
  databaseAction,
  deleteDatabase,
  ENGINES,
  getDatabase,
  restoreBackup,
  startDatabase,
  verifyBackup,
  type DatabaseRow,
  type Engine,
} from "../services/databases.js";
import { demuxLogs } from "../services/deploy.js";
import { offsiteTarget } from "../services/offsite.js";
import { canWriteProject } from "../services/access.js";
import type { AppEnv } from "../lib/types.js";
import { s3Delete } from "../lib/s3.js";
import { dockerFor } from "../services/docker.js";
import { getServer } from "../services/servers.js";

function publicDb(d: DatabaseRow) {
  const server = getServer(d.server_id);
  const password = decrypt(d.db_password);
  return {
    id: d.id,
    projectId: d.project_id,
    server: { id: server.id, name: server.name },
    name: d.name,
    slug: d.slug,
    engine: d.engine,
    engineLabel: ENGINES[d.engine].label,
    version: d.version,
    dbName: d.db_name,
    dbUser: d.db_user,
    password,
    internalHost: containerName(d),
    internalPort: ENGINES[d.engine].port,
    internalUrl: connectionUrl(d, password),
    externalPort: d.external_port,
    externalUrl: d.external_port && server.public_ip ? connectionUrl(d, password, server.public_ip, d.external_port) : null,
    status: d.status,
    backupIntervalH: d.backup_interval_h,
    backupKeep: d.backup_keep,
    lastBackupAt: d.last_backup_at,
    createdAt: d.created_at,
  };
}

const load = (id: number) => must(getDatabase(id), "Veritabanı bulunamadı");

export const databaseRoutes = new Hono<AppEnv>()
  .get("/engines", (c) =>
    c.json({ engines: Object.entries(ENGINES).map(([id, e]) => ({ id, label: e.label, versions: e.versions, port: e.port })) }),
  )

  .post("/", async (c) => {
    const input = await body(
      c,
      z.object({
        projectId: z.number().int(),
        serverId: z.number().int(),
        name: z.string().trim().min(1, "İsim gerekli").max(60),
        engine: z.enum(["postgres", "mysql", "mariadb", "mongo", "redis"]),
        version: z.string().max(20).optional(),
        externalPort: z.number().int().min(1024).max(65535).nullable().optional(),
      }),
    );
    if (!canWriteProject(c.get("user"), input.projectId)) throw new HttpError(403, "Bu projeye veritabanı ekleme yetkin yok");
    must(db.prepare("SELECT id FROM projects WHERE id = ?").get(input.projectId), "Proje bulunamadı");
    const server = getServer(input.serverId);
    if (server.status !== "ready") throw new HttpError(422, "Sunucu hazır değil");
    const engine = ENGINES[input.engine as Engine];
    const version = input.version && engine.versions.includes(input.version) ? input.version : engine.versions[0]!;
    const slug = makeSlug(input.name);
    const dbName = slug.replace(/-/g, "_").slice(0, 30);
    const res = db
      .prepare(
        `INSERT INTO databases (project_id, server_id, name, slug, engine, version, db_name, db_user, db_password, external_port, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'starting', ?)`,
      )
      .run(input.projectId, server.id, input.name, slug, input.engine, version, dbName, input.engine === "mongo" ? "admin_xb" : "xudbin", encrypt(randomAlnum(28)), input.externalPort ?? null, Date.now());
    const d = load(Number(res.lastInsertRowid));
    startDatabase(d).catch((err) => console.error("Veritabanı başlatılamadı:", (err as Error).message));
    return c.json({ database: publicDb(d) }, 201);
  })

  .get("/:id", (c) => {
    const d = load(idParam(c));
    const backups = db
      .prepare(
        `SELECT id, file, size, status, error, created_at AS createdAt, remote_key IS NOT NULL AS remote, remote_error AS remoteError,
                verify_status AS verifyStatus, verify_note AS verifyNote, verified_at AS verifiedAt
         FROM backups WHERE database_id = ? ORDER BY id DESC`,
      )
      .all(d.id);
    return c.json({ database: publicDb(d), backups });
  })

  .patch("/:id", async (c) => {
    const d = load(idParam(c));
    const input = await body(
      c,
      z.object({
        name: z.string().trim().min(1).max(60).optional(),
        externalPort: z.number().int().min(1024).max(65535).nullable().optional(),
        backupIntervalH: z.number().int().min(0).max(24 * 30).optional(),
        backupKeep: z.number().int().min(1).max(100).optional(),
      }),
    );
    db.prepare(
      `UPDATE databases SET name = COALESCE(?, name), backup_interval_h = COALESCE(?, backup_interval_h),
       backup_keep = COALESCE(?, backup_keep) WHERE id = ?`,
    ).run(input.name ?? null, input.backupIntervalH ?? null, input.backupKeep ?? null, d.id);
    if (input.externalPort !== undefined && input.externalPort !== d.external_port) {
      db.prepare("UPDATE databases SET external_port = ? WHERE id = ?").run(input.externalPort, d.id);
      await startDatabase(load(d.id)); // port değişikliği konteynerin yeniden oluşturulmasını gerektirir
    }
    return c.json({ database: publicDb(load(d.id)) });
  })

  .post("/:id/:action{start|stop|restart}", async (c) => {
    const d = load(idParam(c));
    await databaseAction(d, c.req.param("action") as "start" | "stop" | "restart");
    return c.json({ database: publicDb(load(d.id)) });
  })

  .delete("/:id", async (c) => {
    const d = load(idParam(c));
    await deleteDatabase(d, c.req.query("withData") === "1");
    return c.json({ ok: true });
  })

  .post("/:id/backups", async (c) => {
    const d = load(idParam(c));
    if (d.status !== "running") throw new HttpError(422, "Yedek almak için veritabanı çalışıyor olmalı");
    try {
      await createBackup(d);
    } catch (err) {
      throw new HttpError(500, `Yedek alınamadı: ${(err as Error).message}`);
    }
    return c.json({ ok: true }, 201);
  })

  .get("/:id/backups/:backupId/download", (c) => {
    const d = load(idParam(c));
    const b = must(db.prepare("SELECT file FROM backups WHERE id = ? AND database_id = ? AND status = 'success'").get(idParam(c, "backupId"), d.id) as { file: string } | undefined, "Yedek bulunamadı");
    const full = path.join(backupDir(d), b.file);
    if (!fs.existsSync(full)) throw new HttpError(404, "Yedek dosyası diskte yok");
    c.header("Content-Type", "application/gzip");
    c.header("Content-Disposition", `attachment; filename="${b.file}"`);
    c.header("Content-Length", String(fs.statSync(full).size));
    return c.body(Readable.toWeb(fs.createReadStream(full)) as ReadableStream);
  })

  .post("/:id/backups/:backupId/restore", async (c) => {
    const d = load(idParam(c));
    const b = must(db.prepare("SELECT file FROM backups WHERE id = ? AND database_id = ? AND status = 'success'").get(idParam(c, "backupId"), d.id) as { file: string } | undefined, "Yedek bulunamadı");
    try {
      await restoreBackup(d, b.file);
    } catch (err) {
      throw new HttpError(500, `Geri yüklenemedi: ${(err as Error).message}`);
    }
    return c.json({ ok: true });
  })

  // Yedeği geçici bir konteynere geri yükleyip dener; arka planda çalışır, sonuç yedek listesinde görünür.
  .post("/:id/backups/:backupId/verify", (c) => {
    const d = load(idParam(c));
    const id = idParam(c, "backupId");
    must(db.prepare("SELECT 1 FROM backups WHERE id = ? AND database_id = ? AND status = 'success'").get(id, d.id), "Yedek bulunamadı");
    db.prepare("UPDATE backups SET verify_status = 'running', verify_note = NULL WHERE id = ?").run(id);
    verifyBackup(d, id).catch(() => {});
    return c.json({ ok: true }, 202);
  })

  .delete("/:id/backups/:backupId", async (c) => {
    const d = load(idParam(c));
    const b = db.prepare("SELECT file, remote_key FROM backups WHERE id = ? AND database_id = ?").get(idParam(c, "backupId"), d.id) as { file: string; remote_key: string | null } | undefined;
    if (b) fs.rmSync(path.join(backupDir(d), b.file), { force: true });
    const target = offsiteTarget();
    if (b?.remote_key && target) await s3Delete(target, b.remote_key).catch(() => {});
    db.prepare("DELETE FROM backups WHERE id = ? AND database_id = ?").run(idParam(c, "backupId"), d.id);
    return c.json({ ok: true });
  })

  .get("/:id/logs/stream", async (c) => {
    const d = load(idParam(c));
    const docker = dockerFor(getServer(d.server_id));
    return streamSSE(c, async (stream) => {
      let logStream: NodeJS.ReadableStream;
      try {
        logStream = (await docker.getContainer(containerName(d)).logs({ follow: true, stdout: true, stderr: true, tail: 200, timestamps: true })) as unknown as NodeJS.ReadableStream;
      } catch {
        await stream.writeSSE({ event: "line", data: "Konteyner bulunamadı." });
        return;
      }
      logStream.on("data", (chunk: Buffer) => {
        for (const line of demuxLogs(chunk)) void stream.writeSSE({ event: "line", data: line });
      });
      stream.onAbort(() => {
        (logStream as unknown as { destroy?: () => void }).destroy?.();
      });
      while (!stream.aborted) await stream.sleep(15_000).then(() => stream.writeSSE({ event: "ping", data: "" }));
    });
  });
