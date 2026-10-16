import { createHmac, timingSafeEqual } from "node:crypto";
import bcrypt from "bcryptjs";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { db } from "../db.js";
import { decrypt, encrypt, randomAlnum, randomToken } from "../lib/crypto.js";
import { bus } from "../lib/events.js";
import { body, HttpError, idParam, must } from "../lib/http.js";
import { resolveInside } from "../lib/paths.js";
import type { AppEnv } from "../lib/types.js";
import { makeSlug } from "../lib/slug.js";
import { applyCaddyConfig, parseSecurity } from "../services/caddy.js";
import {
  cancelDeployment,
  composeCommand,
  demuxLogs,
  enqueueDeploy,
  getApp,
  mergeEnvText,
  parseEnv,
  shallowClone,
  type AppRow,
} from "../services/deploy.js";
import { dockerFor, removeContainer, type ServerRow } from "../services/docker.js";
import { detectFrameworks, getFramework, publicCatalog } from "../services/frameworks/index.js";
import { config } from "../config.js";
import fs from "node:fs";
import path from "node:path";
import { extractZip, newTempUpload, saveUpload, storeAppUpload, tempUploadFile } from "../services/uploads.js";
import { getServer } from "../services/servers.js";
import { diagnose, isHealthy, probeHttp, type Finding } from "../services/doctor.js";
import { scanApp } from "../services/scan.js";
import { uptimeSummary } from "../services/uptime.js";
import { deletePreview, handlePrEvent, parsePrEvent } from "../services/previews.js";
import { appVolumes, backupAppVolumes, restoreVolumeBackup, volumeBackupFile } from "../services/volume-backups.js";
import { Readable } from "node:stream";
import { runCronJob, type CronJob } from "../services/cron.js";
import { nextRun, parseCron } from "../lib/cron.js";
import { timeZone } from "../services/analytics.js";
import { accessibleAppIds, accessibleProjectIds, canWriteProject } from "../services/access.js";

const parseJson = (raw: string | null) => {
  try {
    return raw ? (JSON.parse(raw) as unknown) : null;
  } catch {
    return null;
  }
};

const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

export function generatedHost(slug: string, server: ServerRow) {
  if (!server.public_ip) return null;
  return `${slug}.${server.public_ip.replace(/\./g, "-")}.sslip.io`;
}

function publicApp(a: AppRow) {
  const server = getServer(a.server_id);
  const domains = db.prepare("SELECT id, host, https, generated, created_at AS createdAt FROM domains WHERE app_id = ? ORDER BY generated DESC, id").all(a.id) as {
    id: number;
    host: string;
    https: number;
    generated: number;
  }[];
  const sec = parseSecurity(a.security);
  const httpsActive = server.https_mode !== "off";
  return {
    id: a.id,
    projectId: a.project_id,
    server: { id: server.id, name: server.name, status: server.status },
    name: a.name,
    slug: a.slug,
    sourceType: a.source_type,
    gitUrl: a.git_url,
    gitBranch: a.git_branch,
    hasGitToken: Boolean(a.git_token),
    buildType: a.build_type,
    framework: a.framework,
    buildOptions: JSON.parse(a.build_options || "{}"),
    dockerfilePath: a.dockerfile_path,
    buildContext: a.build_context,
    image: a.image,
    composeFile: a.compose_file,
    composeService: a.compose_service,
    port: a.port,
    command: a.command,
    volumes: JSON.parse(a.volumes || "[]"),
    autoDeploy: Boolean(a.auto_deploy),
    hostAccess: Boolean(a.host_access),
    status: a.status,
    container: a.container,
    currentImage: a.current_image,
    internalHost: `xb-${a.slug}`,
    webhookPath: `/api/webhooks/deploy/${a.webhook_token}`,
    webhookSecret: a.webhook_secret,
    webhookSigned: Boolean(a.webhook_signed),
    cpuLimit: a.cpu_limit,
    httpCheck: Boolean(a.http_check),
    uptimeEnabled: Boolean(a.uptime_enabled),
    kind: a.kind,
    replicas: a.replicas,
    previewsEnabled: Boolean(a.previews_enabled),
    parentAppId: a.parent_app_id,
    previewPr: a.preview_pr,
    previews: (db.prepare("SELECT id, name, preview_pr AS pr, git_branch AS branch, status FROM apps WHERE parent_app_id = ? ORDER BY preview_pr").all(a.id) as { id: number }[]).map((p) => ({
      ...p,
      url: ((d) => (d ? `${d.https && httpsActive ? "https" : "http"}://${d.host}` : null))(db.prepare("SELECT host, https FROM domains WHERE app_id = ? LIMIT 1").get(p.id) as { host: string; https: number } | undefined),
    })),
    scan: { status: a.scan_status, at: a.scanned_at, summary: parseJson(a.scan_summary) },
    healthPath: a.health_path,
    memoryLimit: a.memory_limit,
    domains: domains.map((d) => ({ ...d, https: Boolean(d.https) && httpsActive, generated: Boolean(d.generated), url: `${d.https && httpsActive ? "https" : "http"}://${d.host}` })),
    security: { ...sec, basicAuth: sec.basicAuth ? { username: sec.basicAuth.username } : null },
    createdAt: a.created_at,
  };
}

const appInput = z.object({
  projectId: z.number().int(),
  serverId: z.number().int(),
  name: z.string().trim().min(1, "İsim gerekli").max(60),
  sourceType: z.enum(["git", "image", "compose", "upload"]),
  uploadId: z.string().max(40).optional(),
  gitUrl: z.string().trim().max(500).optional(),
  gitBranch: z.string().trim().max(200).optional(),
  gitToken: z.string().max(500).optional(),
  buildType: z.enum(["auto", "dockerfile", "static"]).optional(),
  framework: z.string().max(40).optional(),
  buildOptions: z.record(z.string(), z.union([z.string().max(500), z.boolean()])).optional(),
  buildContext: z.string().trim().max(300).optional(),
  env: z.string().max(200_000).optional(),
  image: z.string().trim().max(300).optional(),
  composeFile: z.string().max(100_000).optional(),
  port: z.number().int().min(1).max(65535).optional(),
});

function validateSource(a: { sourceType: string; gitUrl?: string | null; image?: string | null; composeFile?: string | null; uploadId?: string }) {
  if (a.sourceType === "upload" && a.uploadId !== undefined && !tempUploadFile(a.uploadId)) throw new HttpError(400, "Yüklenen dosya bulunamadı ya da süresi doldu; tekrar yükle");
  if (a.sourceType === "git" && !a.gitUrl) throw new HttpError(400, "Git adresi gerekli");
  if (a.gitUrl && !/^https:\/\/[^\s]+$/.test(a.gitUrl)) throw new HttpError(400, "Git adresi https:// ile başlamalı");
  if (a.sourceType === "image" && !a.image) throw new HttpError(400, "Docker imajı gerekli");
  if (a.sourceType === "compose" && !a.gitUrl && !a.composeFile?.trim()) throw new HttpError(400, "Compose dosyası veya git adresi gerekli");
}

const cronInput = z.object({
  name: z.string().trim().min(1, "Ad gerekli").max(60),
  schedule: z.string().trim().min(1).max(100),
  command: z.string().trim().min(1, "Komut gerekli").max(2000),
  enabled: z.boolean().default(true),
  timeoutMin: z.number().int().min(1).max(24 * 60).default(60),
});

function validateCron(expr: string) {
  try {
    parseCron(expr);
  } catch (err) {
    throw new HttpError(400, (err as Error).message);
  }
}

function loadApp(id: number) {
  return must(getApp(id), "Uygulama bulunamadı");
}

export const appRoutes = new Hono<AppEnv>()
  // Erişilebilen tüm uygulamalar (CLI ve API anahtarlarıyla otomasyon için).
  .get("/", (c) => {
    const ids = accessibleAppIds(c.get("user"));
    const apps = ids.length ? (db.prepare(`SELECT * FROM apps WHERE id IN (${ids.join(",")}) ORDER BY project_id, name`).all() as AppRow[]) : [];
    return c.json({ apps: apps.map((a) => { const p = publicApp(a); return { id: p.id, projectId: p.projectId, name: p.name, slug: p.slug, status: p.status, sourceType: p.sourceType, framework: p.framework, domains: p.domains.map((d) => d.url) }; }) });
  })
  .post("/", async (c) => {
    const input = await body(c, appInput);
    must(db.prepare("SELECT id FROM projects WHERE id = ?").get(input.projectId), "Proje bulunamadı");
    if (!canWriteProject(c.get("user"), input.projectId)) throw new HttpError(403, "Bu projeye uygulama ekleme yetkin yok");
    const server = getServer(input.serverId);
    validateSource(input);

    const slug = makeSlug(input.name);
    const res = db
      .prepare(
        `INSERT INTO apps (project_id, server_id, name, slug, source_type, git_url, git_branch, git_token, build_type,
                           image, compose_file, port, webhook_token, created_at, framework, build_options, build_context, env,
                           webhook_secret, webhook_signed)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      )
      .run(
        input.projectId,
        server.id,
        input.name,
        slug,
        input.sourceType,
        input.gitUrl || null,
        input.gitBranch || "main",
        input.gitToken ? encrypt(input.gitToken) : null,
        input.buildType ?? "auto",
        input.image || null,
        input.composeFile || null,
        input.port ?? (input.framework ? (getFramework(input.framework)?.defaultPort ?? 3000) : input.sourceType === "image" ? 80 : 3000),
        randomToken(24),
        Date.now(),
        input.framework && (input.framework === "auto" || getFramework(input.framework)) ? input.framework : "auto",
        JSON.stringify(input.buildOptions ?? {}),
        input.buildContext || ".",
        input.env?.trim() ? encrypt(input.env) : null,
        randomToken(24),
      );
    const id = Number(res.lastInsertRowid);
    if (input.sourceType === "upload" && input.uploadId) storeAppUpload(slug, tempUploadFile(input.uploadId)!);

    // Domain almadan önce de çalışan bir adres: <slug>.<ip>.sslip.io
    const host = generatedHost(slug, server);
    if (host) {
      db.prepare("INSERT INTO domains (app_id, host, https, generated, created_at) VALUES (?, ?, ?, 1, ?)").run(
        id,
        host,
        server.https_mode === "off" ? 0 : 1,
        Date.now(),
      );
    }
    return c.json({ app: publicApp(loadApp(id)) }, 201);
  })

  .get("/:id", (c) => {
    const app = loadApp(idParam(c));
    const deployments = db
      .prepare("SELECT id, status, trigger, title, commit_sha AS commitSha, image, started_at AS startedAt, finished_at AS finishedAt, diagnosis FROM deployments WHERE app_id = ? ORDER BY id DESC LIMIT 30")
      .all(app.id)
      .map((d) => {
        const row = d as { diagnosis: string | null };
        return { ...row, diagnosis: row.diagnosis ? (JSON.parse(row.diagnosis) as Finding[]) : null };
      });
    return c.json({ app: publicApp(app), env: decrypt(app.env), deployments });
  })

  .patch("/:id", async (c) => {
    const app = loadApp(idParam(c));
    const input = await body(
      c,
      z.object({
        name: z.string().trim().min(1).max(60).optional(),
        gitUrl: z.string().trim().max(500).nullable().optional(),
        gitBranch: z.string().trim().min(1).max(200).optional(),
        gitToken: z.string().max(500).nullable().optional(),
        buildType: z.enum(["auto", "dockerfile", "static"]).optional(),
        framework: z.string().max(40).optional(),
        buildOptions: z.record(z.string(), z.union([z.string().max(500), z.boolean()])).optional(),
        dockerfilePath: z.string().trim().min(1).max(300).optional(),
        buildContext: z.string().trim().min(1).max(300).optional(),
        image: z.string().trim().max(300).nullable().optional(),
        composeFile: z.string().max(100_000).nullable().optional(),
        composeService: z.string().trim().max(100).nullable().optional(),
        port: z.number().int().min(1).max(65535).optional(),
        command: z.string().max(2000).nullable().optional(),
        autoDeploy: z.boolean().optional(),
        hostAccess: z.boolean().optional(),
        webhookSigned: z.boolean().optional(),
        cpuLimit: z.number().min(0.1).max(256).nullable().optional(),
        httpCheck: z.boolean().optional(),
        uptimeEnabled: z.boolean().optional(),
        kind: z.enum(["web", "worker"]).optional(),
        replicas: z.number().int().min(1).max(10).optional(),
        previewsEnabled: z.boolean().optional(),
        volumeBackupIntervalH: z.number().int().min(0).max(24 * 30).optional(),
        volumeBackupKeep: z.number().int().min(1).max(100).optional(),
        healthPath: z.string().trim().max(200).regex(/^\/[\w\-./?=&%~]*$/, "Sağlık yolu / ile başlamalı, ör. /health").nullable().optional(),
        memoryLimit: z.number().int().min(32).max(1024 * 1024).nullable().optional(),
        volumes: z
          .array(z.object({ name: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,40}$/i, "Volume adı yalnız harf, rakam, - ve _ içerebilir"), path: z.string().startsWith("/", "Yol / ile başlamalı").max(300) }))
          .max(20)
          .optional(),
      }),
    );
    if (input.hostAccess !== undefined && input.hostAccess !== Boolean(app.host_access) && c.get("user").role !== "admin") {
      throw new HttpError(403, "Sunucu erişimi iznini yalnız yönetici değiştirebilir");
    }
    const next = {
      sourceType: app.source_type,
      gitUrl: input.gitUrl === undefined ? app.git_url : input.gitUrl,
      image: input.image === undefined ? app.image : input.image,
      composeFile: input.composeFile === undefined ? app.compose_file : input.composeFile,
    };
    validateSource(next);

    const map: Record<string, unknown> = {
      name: input.name,
      git_url: input.gitUrl,
      git_branch: input.gitBranch,
      git_token: input.gitToken === undefined ? undefined : input.gitToken ? encrypt(input.gitToken) : null,
      build_type: input.buildType,
      framework: input.framework === undefined ? undefined : input.framework === "auto" || getFramework(input.framework) ? input.framework : undefined,
      build_options: input.buildOptions ? JSON.stringify(input.buildOptions) : undefined,
      dockerfile_path: input.dockerfilePath,
      build_context: input.buildContext,
      image: input.image,
      compose_file: input.composeFile,
      compose_service: input.composeService,
      port: input.port,
      command: input.command,
      auto_deploy: input.autoDeploy === undefined ? undefined : input.autoDeploy ? 1 : 0,
      host_access: input.hostAccess === undefined ? undefined : input.hostAccess ? 1 : 0,
      webhook_signed: input.webhookSigned === undefined ? undefined : input.webhookSigned ? 1 : 0,
      cpu_limit: input.cpuLimit,
      http_check: input.httpCheck === undefined ? undefined : input.httpCheck ? 1 : 0,
      uptime_enabled: input.uptimeEnabled === undefined ? undefined : input.uptimeEnabled ? 1 : 0,
      kind: input.kind,
      replicas: input.replicas,
      previews_enabled: input.previewsEnabled === undefined ? undefined : input.previewsEnabled ? 1 : 0,
      volume_backup_interval_h: input.volumeBackupIntervalH,
      volume_backup_keep: input.volumeBackupKeep,
      health_path: input.healthPath,
      memory_limit: input.memoryLimit,
      volumes: input.volumes ? JSON.stringify(input.volumes) : undefined,
    };
    const entries = Object.entries(map).filter(([, v]) => v !== undefined);
    if (entries.length) {
      db.prepare(`UPDATE apps SET ${entries.map(([k]) => `${k} = ?`).join(", ")} WHERE id = ?`).run(
        ...entries.map(([, v]) => (v === "" ? null : (v as string | number | null))),
        app.id,
      );
    }
    if (input.port !== undefined || input.composeService !== undefined) {
      const server = getServer(app.server_id);
      if (server.status === "ready") await applyCaddyConfig(server);
    }
    return c.json({ app: publicApp(loadApp(app.id)) });
  })

  .put("/:id/env", async (c) => {
    const app = loadApp(idParam(c));
    const { env } = await body(c, z.object({ env: z.string().max(200_000) }));
    db.prepare("UPDATE apps SET env = ? WHERE id = ?").run(env.trim() ? encrypt(env) : null, app.id);
    return c.json({ ok: true, note: "Değişikliklerin geçerli olması için yeniden deploy et." });
  })

  // --- Kalıcı klasör (volume) yedekleri ------------------------------------------------------
  .get("/:id/volume-backups", async (c) => {
    const app = loadApp(idParam(c));
    const volumes = await appVolumes(app).catch(() => []);
    const backups = db
      .prepare(
        `SELECT id, volume, file, size, status, error, remote_key IS NOT NULL AS remote, remote_error AS remoteError, trigger, created_at AS createdAt
         FROM volume_backups WHERE app_id = ? ORDER BY id DESC LIMIT 100`,
      )
      .all(app.id);
    return c.json({ volumes, backups, intervalH: app.volume_backup_interval_h, keep: app.volume_backup_keep, lastAt: app.last_volume_backup_at });
  })
  .post("/:id/volume-backups", (c) => {
    const app = loadApp(idParam(c));
    backupAppVolumes(app.id).catch(() => {});
    return c.json({ ok: true }, 202);
  })
  .post("/:id/volume-backups/:backupId/restore", async (c) => {
    const app = loadApp(idParam(c));
    try {
      await restoreVolumeBackup(app.id, idParam(c, "backupId"));
    } catch (err) {
      throw new HttpError(500, `Geri yüklenemedi: ${(err as Error).message}`);
    }
    return c.json({ ok: true });
  })
  .get("/:id/volume-backups/:backupId/download", (c) => {
    const app = loadApp(idParam(c));
    const b = must(db.prepare("SELECT file FROM volume_backups WHERE id = ? AND app_id = ? AND status = 'success'").get(idParam(c, "backupId"), app.id) as { file: string } | undefined, "Yedek bulunamadı");
    const full = volumeBackupFile(app, b.file);
    if (!fs.existsSync(full)) throw new HttpError(404, "Yedek dosyası diskte yok (uzak depolamada olabilir)");
    c.header("Content-Type", "application/gzip");
    c.header("Content-Disposition", `attachment; filename="${b.file}"`);
    c.header("Content-Length", String(fs.statSync(full).size));
    return c.body(Readable.toWeb(fs.createReadStream(full)) as ReadableStream);
  })
  .delete("/:id/volume-backups/:backupId", (c) => {
    const app = loadApp(idParam(c));
    const b = db.prepare("SELECT file FROM volume_backups WHERE id = ? AND app_id = ?").get(idParam(c, "backupId"), app.id) as { file: string } | undefined;
    if (b) fs.rmSync(volumeBackupFile(app, b.file), { force: true });
    db.prepare("DELETE FROM volume_backups WHERE id = ? AND app_id = ?").run(idParam(c, "backupId"), app.id);
    return c.json({ ok: true });
  })

  // --- Zamanlanmış görevler ---------------------------------------------------------------
  .get("/:id/cron", (c) => {
    const app = loadApp(idParam(c));
    const jobs = (db.prepare("SELECT * FROM cron_jobs WHERE app_id = ? ORDER BY id").all(app.id) as CronJob[]).map((j) => {
      const last = db.prepare("SELECT id, status, exit_code AS exitCode, started_at AS startedAt, finished_at AS finishedAt, trigger FROM cron_runs WHERE job_id = ? ORDER BY id DESC LIMIT 1").get(j.id);
      let next: number | null = null;
      try {
        next = nextRun(j.schedule, Date.now(), timeZone());
      } catch {}
      return { id: j.id, name: j.name, schedule: j.schedule, command: j.command, enabled: Boolean(j.enabled), timeoutMin: j.timeout_min, lastRun: last ?? null, nextRun: j.enabled ? next : null };
    });
    return c.json({ jobs });
  })
  .post("/:id/cron", async (c) => {
    const app = loadApp(idParam(c));
    const input = await body(c, cronInput);
    validateCron(input.schedule);
    const res = db
      .prepare("INSERT INTO cron_jobs (app_id, name, schedule, command, enabled, timeout_min, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(app.id, input.name, input.schedule, input.command, input.enabled ? 1 : 0, input.timeoutMin, Date.now());
    return c.json({ id: Number(res.lastInsertRowid) }, 201);
  })
  .put("/:id/cron/:jobId", async (c) => {
    const app = loadApp(idParam(c));
    const input = await body(c, cronInput);
    validateCron(input.schedule);
    db.prepare("UPDATE cron_jobs SET name = ?, schedule = ?, command = ?, enabled = ?, timeout_min = ? WHERE id = ? AND app_id = ?").run(
      input.name, input.schedule, input.command, input.enabled ? 1 : 0, input.timeoutMin, idParam(c, "jobId"), app.id,
    );
    return c.json({ ok: true });
  })
  .delete("/:id/cron/:jobId", (c) => {
    const app = loadApp(idParam(c));
    db.prepare("DELETE FROM cron_jobs WHERE id = ? AND app_id = ?").run(idParam(c, "jobId"), app.id);
    return c.json({ ok: true });
  })
  .post("/:id/cron/:jobId/run", (c) => {
    const app = loadApp(idParam(c));
    const job = must(db.prepare("SELECT id FROM cron_jobs WHERE id = ? AND app_id = ?").get(idParam(c, "jobId"), app.id) as { id: number } | undefined, "Görev bulunamadı");
    runCronJob(job.id, "manual").catch(() => {});
    return c.json({ ok: true }, 202);
  })
  .get("/:id/cron/:jobId/runs", (c) => {
    const app = loadApp(idParam(c));
    const runs = db
      .prepare(
        `SELECT r.id, r.status, r.exit_code AS exitCode, r.started_at AS startedAt, r.finished_at AS finishedAt, r.trigger, r.output
         FROM cron_runs r JOIN cron_jobs j ON j.id = r.job_id WHERE j.id = ? AND j.app_id = ? ORDER BY r.id DESC`,
      )
      .all(idParam(c, "jobId"), app.id);
    return c.json({ runs });
  })

  .get("/:id/uptime", (c) => {
    const app = loadApp(idParam(c));
    return c.json(uptimeSummary(app.id));
  })

  .post("/:id/scan", (c) => {
    const app = loadApp(idParam(c));
    if (!app.current_image || app.source_type === "compose") throw new HttpError(422, "Taranacak bir imaj yok; önce deploy et");
    db.prepare("UPDATE apps SET scan_status = 'running' WHERE id = ?").run(app.id);
    scanApp(app.id).catch(() => {});
    return c.json({ ok: true }, 202);
  })

  // Deploy Doktoru'nun önerdiği değişkenleri ekler/günceller; istenirse yeniden deploy eder.
  .post("/:id/env/merge", async (c) => {
    const app = loadApp(idParam(c));
    const input = await body(
      c,
      z.object({
        env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().max(10_000)).default({}),
        buildOptions: z.record(z.string().regex(/^[A-Za-z]+$/), z.union([z.string().max(500), z.boolean()])).optional(),
        deploy: z.boolean().default(true),
      }),
    );
    if (input.buildOptions) {
      const merged = { ...(JSON.parse(app.build_options || "{}") as Record<string, unknown>), ...input.buildOptions };
      db.prepare("UPDATE apps SET build_options = ? WHERE id = ?").run(JSON.stringify(merged), app.id);
    }
    const resolved = Object.fromEntries(
      Object.entries(input.env).map(([k, v]) => [
        k,
        v.replace("{{XUDBIN_SECRET}}", () => randomAlnum(50)).replace("{{XUDBIN_LARAVEL_KEY}}", () => `base64:${Buffer.from(randomAlnum(32)).toString("base64")}`),
      ]),
    );
    if (Object.keys(resolved).length) db.prepare("UPDATE apps SET env = ? WHERE id = ?").run(encrypt(mergeEnvText(decrypt(app.env), resolved)), app.id);
    const deploymentId = input.deploy ? enqueueDeploy(app.id, "manual", { title: "Deploy Doktoru düzeltmesi" }) : null;
    return c.json({ ok: true, deploymentId });
  })

  // Çalışan uygulamayı teşhis eder: gerçek alan adıyla HTTP isteği + son loglar.
  .get("/:id/diagnose", async (c) => {
    const app = loadApp(idParam(c));
    const server = getServer(app.server_id);
    if (!app.container || app.source_type === "compose") return c.json({ probe: null, findings: [] });
    const docker = dockerFor(server);
    const hosts = (db.prepare("SELECT host FROM domains WHERE app_id = ? ORDER BY generated, id").all(app.id) as { host: string }[]).map((d) => d.host);
    const probe = await probeHttp(docker, app.container, app.port, hosts[0] ?? `xb-${app.slug}`, app.health_path || "/");
    const logs = await docker.getContainer(app.container).logs({ stdout: true, stderr: true, tail: 400 }).catch(() => Buffer.from(""));
    const findings = diagnose(demuxLogs(logs as Buffer), { framework: app.framework, env: parseEnv(decrypt(app.env)), hosts, status: probe.status });
    return c.json({ probe, healthy: probe.status !== null && isHealthy(probe.status, Boolean(app.health_path)), findings });
  })

  .put("/:id/security", async (c) => {
    const app = loadApp(idParam(c));
    const ipList = z.array(z.string().trim().regex(/^[0-9a-f:.]+(\/\d{1,3})?$/i, "Geçersiz IP veya CIDR")).max(200);
    const input = await body(
      c,
      z.object({
        waf: z.boolean(),
        rateLimit: z.number().int().min(10).max(100_000).nullable(),
        headers: z.boolean(),
        allowIps: ipList,
        denyIps: ipList,
        basicAuth: z
          .object({ username: z.string().trim().min(1).max(60), password: z.string().max(200).optional() })
          .nullable(),
      }),
    );
    const current = parseSecurity(app.security);
    let basicAuth = null;
    if (input.basicAuth) {
      if (input.basicAuth.password) {
        if (input.basicAuth.password.length < 8) throw new HttpError(400, "Şifre en az 8 karakter olmalı");
        basicAuth = { username: input.basicAuth.username, hash: Buffer.from(await bcrypt.hash(input.basicAuth.password, 12)).toString("base64") };
      } else if (current.basicAuth) {
        basicAuth = { ...current.basicAuth, username: input.basicAuth.username };
      } else throw new HttpError(400, "Şifre koruması için şifre gerekli");
    }
    const security = { waf: input.waf, rateLimit: input.rateLimit, headers: input.headers, allowIps: input.allowIps, denyIps: input.denyIps, basicAuth };
    db.prepare("UPDATE apps SET security = ? WHERE id = ?").run(JSON.stringify(security), app.id);
    const server = getServer(app.server_id);
    if (server.status === "ready") await applyCaddyConfig(server);
    return c.json({ app: publicApp(loadApp(app.id)) });
  })

  .post("/:id/domains", async (c) => {
    const app = loadApp(idParam(c));
    const input = await body(c, z.object({ host: z.string().trim().toLowerCase(), https: z.boolean().default(true) }));
    if (!HOST_RE.test(input.host)) throw new HttpError(400, "Geçerli bir alan adı gir (ör. blog.ornek.com)");
    if (db.prepare("SELECT 1 FROM domains WHERE host = ?").get(input.host)) throw new HttpError(409, "Bu alan adı zaten kullanılıyor");
    db.prepare("INSERT INTO domains (app_id, host, https, generated, created_at) VALUES (?, ?, ?, 0, ?)").run(app.id, input.host, input.https ? 1 : 0, Date.now());
    const server = getServer(app.server_id);
    if (server.status === "ready") await applyCaddyConfig(server);
    return c.json({ app: publicApp(loadApp(app.id)) }, 201);
  })

  .post("/:id/domains/generate", async (c) => {
    const app = loadApp(idParam(c));
    const server = getServer(app.server_id);
    const host = generatedHost(`${app.slug.split("-").slice(0, -1).join("-") || "app"}-${randomAlnum(4).toLowerCase()}`, server);
    if (!host) throw new HttpError(422, "Sunucunun dış IP adresi bilinmiyor. Sunucu ayarlarından gir.");
    db.prepare("INSERT INTO domains (app_id, host, https, generated, created_at) VALUES (?, ?, ?, 1, ?)").run(app.id, host, server.https_mode === "off" ? 0 : 1, Date.now());
    if (server.status === "ready") await applyCaddyConfig(server);
    return c.json({ app: publicApp(loadApp(app.id)) }, 201);
  })

  .delete("/:id/domains/:domainId", async (c) => {
    const app = loadApp(idParam(c));
    db.prepare("DELETE FROM domains WHERE id = ? AND app_id = ?").run(idParam(c, "domainId"), app.id);
    const server = getServer(app.server_id);
    if (server.status === "ready") await applyCaddyConfig(server);
    return c.json({ app: publicApp(loadApp(app.id)) });
  })

  .post("/:id/deploy", (c) => {
    const app = loadApp(idParam(c));
    const id = enqueueDeploy(app.id, "manual");
    return c.json({ deploymentId: id }, 202);
  })

  .post("/:id/rollback/:deploymentId", (c) => {
    const app = loadApp(idParam(c));
    const dep = must(
      db.prepare("SELECT id, image, status FROM deployments WHERE id = ? AND app_id = ?").get(idParam(c, "deploymentId"), app.id) as
        | { id: number; image: string | null; status: string }
        | undefined,
      "Deploy bulunamadı",
    );
    if (app.source_type === "compose") throw new HttpError(422, "Compose uygulamalarında geri dönüş yerine ilgili commit'i yeniden deploy et");
    if (dep.status !== "success" || !dep.image) throw new HttpError(422, "Yalnızca başarılı bir deploy'a geri dönülebilir");
    const id = enqueueDeploy(app.id, "rollback", { image: dep.image, title: `#${dep.id} sürümüne geri dönüş` });
    return c.json({ deploymentId: id }, 202);
  })

  .post("/:id/:action{start|stop|restart}", async (c) => {
    const app = loadApp(idParam(c));
    const action = c.req.param("action") as "start" | "stop" | "restart";
    const server = getServer(app.server_id);
    if (app.source_type === "compose") {
      await composeCommand(app, action);
    } else {
      if (!app.container) throw new HttpError(422, "Uygulama henüz deploy edilmedi");
      for (const name of [app.container, ...(JSON.parse(app.replica_containers || "[]") as string[])]) {
        const container = dockerFor(server).getContainer(name);
        try {
          if (action === "start") await container.start();
          if (action === "stop") await container.stop({ t: 10 });
          if (action === "restart") await container.restart({ t: 10 });
        } catch (err) {
          const msg = (err as { statusCode?: number }).statusCode === 304 ? null : (err as Error).message;
          if (msg) throw new HttpError(500, msg);
        }
      }
    }
    db.prepare("UPDATE apps SET status = ? WHERE id = ?").run(action === "stop" ? "stopped" : "running", app.id);
    if (server.status === "ready") await applyCaddyConfig(server);
    return c.json({ app: publicApp(loadApp(app.id)) });
  })

  .delete("/:id", async (c) => {
    const app = loadApp(idParam(c));
    for (const p of db.prepare("SELECT * FROM apps WHERE parent_app_id = ?").all(app.id) as AppRow[]) await deletePreview(p).catch(() => {});
    const server = getServer(app.server_id);
    const docker = dockerFor(server);
    if (app.source_type === "compose") await composeCommand(app, "down").catch(() => {});
    const containers = await docker.listContainers({ all: true, filters: { label: [`xudbin.app=${app.slug}`] } }).catch(() => []);
    for (const ct of containers) await removeContainer(docker, ct.Id);
    const images = await docker.listImages({ filters: { reference: [`xudbin/${app.slug}`] } }).catch(() => []);
    for (const img of images) await docker.getImage(img.Id).remove({ force: true }).catch(() => {});
    db.prepare("DELETE FROM apps WHERE id = ?").run(app.id);
    if (server.status === "ready") await applyCaddyConfig(server).catch(() => {});
    return c.json({ ok: true });
  })

  // Yeni sürüm: zip yüklenir ve deploy başlatılır.
  .post("/:id/upload", async (c) => {
    const app = loadApp(idParam(c));
    if (app.source_type !== "upload") throw new HttpError(422, "Bu uygulama dosya yüklemeyle çalışmıyor");
    if (!c.req.raw.body) throw new HttpError(400, "Dosya yok");
    const tmp = newTempUpload();
    try {
      await saveUpload(c.req.raw.body, tmp.file);
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
    storeAppUpload(app.slug, tmp.file);
    const deploymentId = enqueueDeploy(app.id, "manual", { title: "Dosya yüklemesi" });
    return c.json({ deploymentId }, 202);
  })

  .post("/:id/webhook/regenerate", (c) => {
    const app = loadApp(idParam(c));
    db.prepare("UPDATE apps SET webhook_token = ?, webhook_secret = ? WHERE id = ?").run(randomToken(24), randomToken(24), app.id);
    return c.json({ app: publicApp(loadApp(app.id)) });
  })

  .get("/:id/stats", async (c) => {
    const app = loadApp(idParam(c));
    if (!app.container || app.source_type === "compose") return c.json({ stats: null });
    try {
      const s = (await dockerFor(getServer(app.server_id)).getContainer(app.container).stats({ stream: false })) as {
        cpu_stats: { cpu_usage: { total_usage: number }; system_cpu_usage: number; online_cpus: number };
        precpu_stats: { cpu_usage: { total_usage: number }; system_cpu_usage: number };
        memory_stats: { usage: number; limit: number; stats?: { inactive_file?: number } };
      };
      const cpuDelta = s.cpu_stats.cpu_usage.total_usage - s.precpu_stats.cpu_usage.total_usage;
      const sysDelta = s.cpu_stats.system_cpu_usage - s.precpu_stats.system_cpu_usage;
      const cpu = sysDelta > 0 ? (cpuDelta / sysDelta) * (s.cpu_stats.online_cpus || 1) * 100 : 0;
      const mem = s.memory_stats.usage - (s.memory_stats.stats?.inactive_file ?? 0);
      return c.json({ stats: { cpu: Math.round(cpu * 10) / 10, memory: mem, memoryLimit: s.memory_stats.limit } });
    } catch {
      return c.json({ stats: null });
    }
  })

  // Çalışan konteynerin logları, canlı (SSE).
  .get("/:id/logs/stream", async (c) => {
    const app = loadApp(idParam(c));
    const docker = dockerFor(getServer(app.server_id));
    const names =
      app.source_type === "compose"
        ? (await docker.listContainers({ all: true, filters: { label: [`com.docker.compose.project=xb-${app.slug}`] } })).map((ct) => ct.Names[0]!.slice(1))
        : app.container
          ? [app.container, ...(JSON.parse(app.replica_containers || "[]") as string[])]
          : [];
    return streamSSE(c, async (stream) => {
      if (!names.length) {
        await stream.writeSSE({ event: "line", data: "Henüz çalışan bir konteyner yok. Önce deploy et." });
        return;
      }
      const streams: NodeJS.ReadableStream[] = [];
      for (const name of names) {
        const prefix = names.length > 1 ? `[${name.replace(`xb-${app.slug}-`, "")}] ` : "";
        const logStream = (await docker.getContainer(name).logs({ follow: true, stdout: true, stderr: true, tail: 300, timestamps: true })) as unknown as NodeJS.ReadableStream;
        streams.push(logStream);
        logStream.on("data", (chunk: Buffer) => {
          for (const line of demuxLogs(chunk)) void stream.writeSSE({ event: "line", data: prefix + line });
        });
      }
      stream.onAbort(() => {
        for (const s of streams) (s as unknown as { destroy?: () => void }).destroy?.();
      });
      while (!stream.aborted) await stream.sleep(15_000).then(() => stream.writeSSE({ event: "ping", data: "" }));
    });
  });

export const deploymentRoutes = new Hono<AppEnv>()
  .get("/", (c) => {
    const deployments = db
      .prepare(
        `SELECT d.id, d.status, d.trigger, d.title, d.commit_sha AS commitSha, d.started_at AS startedAt, d.finished_at AS finishedAt,
                a.id AS appId, a.name AS appName
         FROM deployments d JOIN apps a ON a.id = d.app_id
         WHERE a.project_id IN (${accessibleProjectIds(c.get("user")).join(",") || "-1"}) ORDER BY d.id DESC LIMIT 8`,
      )
      .all();
    return c.json({ deployments });
  })
  .get("/:id", (c) => {
    const dep = must(db.prepare("SELECT * FROM deployments WHERE id = ?").get(idParam(c)), "Deploy bulunamadı");
    return c.json({ deployment: dep });
  })
  .post("/:id/cancel", (c) => {
    if (!cancelDeployment(idParam(c))) throw new HttpError(409, "Bu deploy zaten bitmiş");
    return c.json({ ok: true });
  })
  .get("/:id/stream", (c) => {
    const id = idParam(c);
    const dep = must(db.prepare("SELECT log, status FROM deployments WHERE id = ?").get(id) as { log: string; status: string } | undefined, "Deploy bulunamadı");
    return streamSSE(c, async (stream) => {
      await stream.writeSSE({ event: "snapshot", data: JSON.stringify(dep) });
      if (dep.status !== "queued" && dep.status !== "running") {
        await stream.writeSSE({ event: "done", data: "" });
        return;
      }
      const channel = `deploy:${id}`;
      let finished = false;
      const onLine = (line: string) => {
        if (line === "__done__") {
          finished = true;
          void stream.writeSSE({ event: "done", data: "" });
        } else void stream.writeSSE({ event: "line", data: line });
      };
      bus.on(channel, onLine);
      stream.onAbort(() => {
        bus.off(channel, onLine);
      });
      while (!stream.aborted && !finished) await stream.sleep(15_000).then(() => stream.writeSSE({ event: "ping", data: "" }));
      bus.off(channel, onLine);
    });
  });

export const projectRoutes = new Hono<AppEnv>()
  .get("/", (c) => {
    const projects = db
      .prepare(
        `SELECT p.id, p.name, p.description, p.created_at AS createdAt,
                (SELECT COUNT(*) FROM apps a WHERE a.project_id = p.id) AS apps,
                (SELECT COUNT(*) FROM databases d WHERE d.project_id = p.id) AS databases,
                (SELECT COUNT(*) FROM apps a WHERE a.project_id = p.id AND a.status = 'running') AS running
         FROM projects p WHERE p.id IN (${accessibleProjectIds(c.get("user")).join(",") || "-1"}) ORDER BY p.id DESC`,
      )
      .all();
    return c.json({ projects });
  })
  .post("/", async (c) => {
    const input = await body(c, z.object({ name: z.string().trim().min(1, "İsim gerekli").max(60), description: z.string().trim().max(300).default("") }));
    const res = db.prepare("INSERT INTO projects (name, description, created_at) VALUES (?, ?, ?)").run(input.name, input.description, Date.now());
    // Projeyi oluşturan üye, projeye geliştirici olarak eklenir.
    const user = c.get("user");
    if (user.role !== "admin") db.prepare("INSERT INTO project_members (project_id, user_id, role, created_at) VALUES (?, ?, 'developer', ?)").run(Number(res.lastInsertRowid), user.id, Date.now());
    return c.json({ project: { id: Number(res.lastInsertRowid), ...input } }, 201);
  })
  .get("/:id", (c) => {
    const id = idParam(c);
    const project = must(db.prepare("SELECT id, name, description, created_at AS createdAt FROM projects WHERE id = ?").get(id), "Proje bulunamadı");
    const apps = (db.prepare("SELECT * FROM apps WHERE project_id = ? ORDER BY id").all(id) as AppRow[]).map((a) => {
      const p = publicApp(a);
      return { id: p.id, name: p.name, sourceType: p.sourceType, status: p.status, server: p.server, domains: p.domains, gitUrl: p.gitUrl, image: p.image, framework: p.framework };
    });
    const databases = db
      .prepare(
        `SELECT d.id, d.name, d.engine, d.version, d.status, s.name AS serverName
         FROM databases d JOIN servers s ON s.id = d.server_id WHERE d.project_id = ? ORDER BY d.id`,
      )
      .all(id);
    return c.json({ project, apps, databases });
  })
  // Proje üyeleri (yalnız yönetici yönetir).
  .get("/:id/members", (c) => {
    const id = idParam(c);
    const members = db
      .prepare("SELECT u.id, u.name, u.email, m.role FROM project_members m JOIN users u ON u.id = m.user_id WHERE m.project_id = ? ORDER BY u.name")
      .all(id);
    return c.json({ members });
  })
  .put("/:id/members/:userId", async (c) => {
    if (c.get("user").role !== "admin") throw new HttpError(403, "Üyeleri yalnız yönetici değiştirebilir");
    const id = idParam(c);
    const userId = idParam(c, "userId");
    const { role } = await body(c, z.object({ role: z.enum(["developer", "viewer"]) }));
    const u = must(db.prepare("SELECT role FROM users WHERE id = ?").get(userId) as { role: string } | undefined, "Kullanıcı bulunamadı");
    if (u.role === "admin") throw new HttpError(422, "Yöneticiler zaten tüm projeleri görür");
    db.prepare(
      "INSERT INTO project_members (project_id, user_id, role, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(project_id, user_id) DO UPDATE SET role = excluded.role",
    ).run(id, userId, role, Date.now());
    return c.json({ ok: true });
  })
  .delete("/:id/members/:userId", (c) => {
    if (c.get("user").role !== "admin") throw new HttpError(403, "Üyeleri yalnız yönetici değiştirebilir");
    db.prepare("DELETE FROM project_members WHERE project_id = ? AND user_id = ?").run(idParam(c), idParam(c, "userId"));
    return c.json({ ok: true });
  })
  .patch("/:id", async (c) => {
    const id = idParam(c);
    const input = await body(c, z.object({ name: z.string().trim().min(1).max(60), description: z.string().trim().max(300).default("") }));
    db.prepare("UPDATE projects SET name = ?, description = ? WHERE id = ?").run(input.name, input.description, id);
    return c.json({ ok: true });
  })
  .delete("/:id", (c) => {
    const id = idParam(c);
    const n = db.prepare("SELECT (SELECT COUNT(*) FROM apps WHERE project_id = ?) + (SELECT COUNT(*) FROM databases WHERE project_id = ?) AS n").get(id, id) as { n: number };
    if (n.n) throw new HttpError(409, "Önce projedeki uygulamaları ve veritabanlarını sil");
    db.prepare("DELETE FROM projects WHERE id = ?").run(id);
    return c.json({ ok: true });
  });

/**
 * GitHub/Gitea/Forgejo/Bitbucket gövdeyi HMAC-SHA256 ile imzalar; GitLab gizli anahtarı başlıkta düz gönderir.
 * Başlık varsa her zaman doğrulanır; imzasız istek yalnız imza zorunlu değilse kabul edilir.
 */
export function verifyWebhook(app: Pick<AppRow, "webhook_secret" | "webhook_signed">, raw: string, header: (name: string) => string | undefined) {
  const secret = app.webhook_secret ?? "";
  const equal = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
  const hmac = () => createHmac("sha256", secret).update(raw).digest("hex");
  const sig = header("x-hub-signature-256") ?? header("x-gitea-signature") ?? header("x-forgejo-signature") ?? header("x-gogs-signature");
  if (sig) return Boolean(secret) && equal(sig.replace(/^sha256=/, ""), hmac());
  const gitlab = header("x-gitlab-token");
  if (gitlab !== undefined) return Boolean(secret) && equal(gitlab, secret);
  return !app.webhook_signed;
}

/** Git sağlayıcısının (GitHub, GitLab, Gitea...) push olayında çağırdığı adres. */
export const webhookRoutes = new Hono().post("/deploy/:token", async (c) => {
  const app = db.prepare("SELECT * FROM apps WHERE webhook_token = ?").get(c.req.param("token")) as AppRow | undefined;
  if (!app) return c.json({ error: "Geçersiz webhook" }, 404);
  const raw = await c.req.text();
  if (!verifyWebhook(app, raw, (h) => c.req.header(h))) {
    return c.json({ error: "Webhook imzası doğrulanamadı. Git sağlayıcısındaki Secret alanına uygulamanın webhook gizli anahtarını gir." }, 401);
  }
  let payload: { ref?: string; head_commit?: { message?: string } } & Record<string, unknown> = {};
  try {
    payload = JSON.parse(raw);
  } catch {}
  // Pull request olayları: önizleme ortamı aç / güncelle / kapat.
  const pr = parsePrEvent((h) => c.req.header(h), payload);
  if (pr) {
    if (!app.previews_enabled || app.source_type !== "git") return c.json({ ok: false, reason: "PR önizlemeleri bu uygulamada kapalı" });
    return c.json(await handlePrEvent(app, pr), 202);
  }
  if (!app.auto_deploy) return c.json({ ok: false, reason: "Otomatik deploy kapalı" });
  if (payload.ref && payload.ref !== `refs/heads/${app.git_branch}`) {
    return c.json({ ok: false, reason: `Yalnızca ${app.git_branch} dalı deploy edilir` });
  }
  const id = enqueueDeploy(app.id, "webhook", { title: payload.head_commit?.message?.split("\n")[0] ?? "" });
  return c.json({ ok: true, deploymentId: id }, 202);
});

/** Framework kataloğu ve repo algılama. */
export const frameworkRoutes = new Hono<AppEnv>()
  .get("/", (c) => c.json({ frameworks: publicCatalog() }))
  .post("/detect", async (c) => {
    const input = await body(
      c,
      z.object({
        appId: z.number().int().optional(),
        gitUrl: z.string().trim().max(500).optional(),
        gitBranch: z.string().trim().max(200).default("main"),
        gitToken: z.string().max(500).optional(),
        buildContext: z.string().trim().max(300).default("."),
      }),
    );
    let url = input.gitUrl;
    let branch = input.gitBranch;
    let token = input.gitToken ?? "";
    let context = input.buildContext;
    if (input.appId) {
      const app = loadApp(input.appId);
      if (!accessibleAppIds(c.get("user")).includes(app.id)) throw new HttpError(404, "Uygulama bulunamadı");
      url = url || app.git_url || undefined;
      branch = input.gitUrl ? branch : app.git_branch;
      token = token || decrypt(app.git_token);
      context = input.gitUrl ? context : app.build_context;
    }
    if (!url || !/^https:\/\//.test(url)) throw new HttpError(400, "https:// ile başlayan bir repo adresi gerekli");
    const dest = path.join(config.dataDir, "builds", `detect-${randomAlnum(10)}`);
    try {
      await shallowClone(url, branch || "main", token, dest);
    } catch {
      throw new HttpError(422, token ? "Repo klonlanamadı. Adres, dal ve token'ı kontrol et." : "Repo klonlanamadı. Özel bir repoysa erişim token'ı gir; adres ve dalı kontrol et.");
    }
    try {
      const dir = resolveInside(dest, context || ".");
      if (!dir || !fs.existsSync(dir)) throw new HttpError(422, `Derleme klasörü bulunamadı: ${context}`);
      return c.json(detectFrameworks(dir));
    } finally {
      fs.rmSync(dest, { recursive: true, force: true });
    }
  });

/** Uygulama oluşturmadan önce arşivi yükleyip proje türünü algılar; dönen uploadId oluştururken kullanılır. */
export const uploadRoutes = new Hono().post("/", async (c) => {
  if (!c.req.raw.body) throw new HttpError(400, "Dosya yok");
  const tmp = newTempUpload();
  let size: number;
  try {
    size = await saveUpload(c.req.raw.body, tmp.file);
  } catch (err) {
    throw new HttpError(400, (err as Error).message);
  }
  const dest = path.join(config.dataDir, "builds", `detect-${tmp.id}`);
  try {
    const dir = await extractZip(tmp.file, dest);
    return c.json({ uploadId: tmp.id, size, detect: detectFrameworks(dir) }, 201);
  } catch (err) {
    fs.rmSync(tmp.file, { force: true });
    throw new HttpError(400, (err as Error).message);
  } finally {
    fs.rmSync(dest, { recursive: true, force: true });
  }
});
