import { Hono } from "hono";
import { db } from "../db.js";
import { nextRun } from "../lib/cron.js";
import type { AppEnv } from "../lib/types.js";
import { accessibleProjectIds } from "../services/access.js";
import { timeZone } from "../services/analytics.js";
import { downApps } from "../services/uptime.js";

/**
 * Kenar çubuğundaki genel sayfaların verisi: tüm projelerdeki dağıtımlar, veritabanları, erişilebilirlik,
 * yedekler ve zamanlanmış görevler. Üyeler yalnız erişebildikleri projeleri görür.
 */
const inProjects = (c: { get: (k: "user") => AppEnv["Variables"]["user"] }, col: string) => {
  const ids = accessibleProjectIds(c.get("user"));
  return `${col} IN (${ids.join(",") || "-1"})`;
};

export const overviewRoutes = new Hono<AppEnv>()
  .get("/deployments", (c) => {
    const status = c.req.query("status");
    const limit = Math.min(Math.max(Number(c.req.query("limit")) || 50, 1), 200);
    const before = Number(c.req.query("before")) || 0;
    const where = [inProjects(c, "a.project_id")];
    const params: (string | number)[] = [];
    if (status && ["queued", "running", "success", "failed", "cancelled"].includes(status)) {
      where.push("d.status = ?");
      params.push(status);
    }
    if (before) {
      where.push("d.id < ?");
      params.push(before);
    }
    const deployments = db
      .prepare(
        `SELECT d.id, d.status, d.trigger, d.title, d.commit_sha AS commitSha, d.started_at AS startedAt, d.finished_at AS finishedAt,
                a.id AS appId, a.name AS appName, a.framework, p.id AS projectId, p.name AS projectName, s.name AS serverName
         FROM deployments d JOIN apps a ON a.id = d.app_id JOIN projects p ON p.id = a.project_id JOIN servers s ON s.id = a.server_id
         WHERE ${where.join(" AND ")} ORDER BY d.id DESC LIMIT ?`,
      )
      .all(...params, limit);
    const counts = db
      .prepare(
        `SELECT d.status, COUNT(*) AS n FROM deployments d JOIN apps a ON a.id = d.app_id
         WHERE ${inProjects(c, "a.project_id")} AND d.started_at > ? GROUP BY d.status`,
      )
      .all(Date.now() - 7 * 86_400_000) as { status: string; n: number }[];
    return c.json({ deployments, last7d: Object.fromEntries(counts.map((r) => [r.status, r.n])) });
  })

  .get("/databases", (c) => {
    const databases = db
      .prepare(
        `SELECT b.id, b.name, b.engine, b.version, b.status, b.external_port AS externalPort, b.backup_interval_h AS backupIntervalH,
                b.last_backup_at AS lastBackupAt, b.last_verify_at AS lastVerifyAt, p.id AS projectId, p.name AS projectName, s.name AS serverName,
                (SELECT status FROM backups WHERE database_id = b.id ORDER BY id DESC LIMIT 1) AS lastBackupStatus,
                (SELECT verify_status FROM backups WHERE database_id = b.id AND verify_status IS NOT NULL ORDER BY id DESC LIMIT 1) AS lastVerifyStatus
         FROM databases b JOIN projects p ON p.id = b.project_id JOIN servers s ON s.id = b.server_id
         WHERE ${inProjects(c, "b.project_id")} ORDER BY p.name, b.name`,
      )
      .all();
    return c.json({ databases });
  })

  // Tüm sitelerin erişilebilirliği: anlık durum, 24 saat / 7 gün oranı, son yanıt süresi, son olay.
  .get("/monitoring", (c) => {
    const now = Date.now();
    const down = new Map(downApps().map((d) => [d.appId, d]));
    const apps = db
      .prepare(
        `SELECT a.id, a.name, a.status, a.uptime_enabled AS uptimeEnabled, p.id AS projectId, p.name AS projectName,
                (SELECT host FROM domains WHERE app_id = a.id ORDER BY generated, id LIMIT 1) AS host,
                (SELECT https FROM domains WHERE app_id = a.id ORDER BY generated, id LIMIT 1) AS https,
                (SELECT COUNT(*) FROM uptime_checks WHERE app_id = a.id AND at > ?) AS n24,
                (SELECT SUM(ok) FROM uptime_checks WHERE app_id = a.id AND at > ?) AS ok24,
                (SELECT COUNT(*) FROM uptime_checks WHERE app_id = a.id AND at > ?) AS n7,
                (SELECT SUM(ok) FROM uptime_checks WHERE app_id = a.id AND at > ?) AS ok7,
                (SELECT ms FROM uptime_checks WHERE app_id = a.id ORDER BY at DESC LIMIT 1) AS lastMs,
                (SELECT AVG(ms) FROM uptime_checks WHERE app_id = a.id AND at > ? AND ok = 1) AS avgMs,
                (SELECT started_at FROM uptime_incidents WHERE app_id = a.id ORDER BY id DESC LIMIT 1) AS lastIncidentAt
         FROM apps a JOIN projects p ON p.id = a.project_id
         WHERE ${inProjects(c, "a.project_id")} AND a.kind != 'worker' AND a.parent_app_id IS NULL ORDER BY p.name, a.name`,
      )
      .all(now - 86_400_000, now - 86_400_000, now - 7 * 86_400_000, now - 7 * 86_400_000, now - 86_400_000) as Record<string, number | string | null>[];
    // Son 24 saat 24 dilimde: her saat için kontrol oranı (çubuk grafik).
    const hourly = db
      .prepare(
        `SELECT app_id AS appId, CAST((at - ?) / 3600000 AS INTEGER) AS h, COUNT(*) AS n, SUM(ok) AS ok
         FROM uptime_checks WHERE at > ? GROUP BY app_id, h`,
      )
      .all(now - 86_400_000, now - 86_400_000) as { appId: number; h: number; n: number; ok: number }[];
    const bars = new Map<number, (number | null)[]>();
    for (const r of hourly) {
      const arr = bars.get(r.appId) ?? Array<number | null>(24).fill(null);
      if (r.h >= 0 && r.h < 24) arr[r.h] = r.n ? r.ok / r.n : null;
      bars.set(r.appId, arr);
    }
    const incidents = db
      .prepare(
        `SELECT i.app_id AS appId, a.name AS appName, i.started_at AS startedAt, i.ended_at AS endedAt, i.reason
         FROM uptime_incidents i JOIN apps a ON a.id = i.app_id WHERE ${inProjects(c, "a.project_id")} ORDER BY i.id DESC LIMIT 20`,
      )
      .all();
    return c.json({
      apps: apps.map((a) => ({
        id: a.id,
        name: a.name,
        status: a.status,
        projectId: a.projectId,
        projectName: a.projectName,
        url: a.host ? `${a.https ? "https" : "http"}://${a.host}` : null,
        monitored: Boolean(a.uptimeEnabled) && a.status === "running" && Boolean(a.host),
        down: down.has(Number(a.id)),
        downSince: down.get(Number(a.id))?.since ?? null,
        up24h: a.n24 ? Number(a.ok24 ?? 0) / Number(a.n24) : null,
        up7d: a.n7 ? Number(a.ok7 ?? 0) / Number(a.n7) : null,
        lastMs: a.lastMs,
        avgMs: a.avgMs === null ? null : Math.round(Number(a.avgMs)),
        lastIncidentAt: a.lastIncidentAt,
        bars: bars.get(Number(a.id)) ?? Array(24).fill(null),
      })),
      incidents,
    });
  })

  // Yedeklerin tek ekranda durumu: veritabanları, kalıcı klasörler ve (yöneticiye) panel yedeği.
  .get("/backups", (c) => {
    const databases = db
      .prepare(
        `SELECT b.id, b.name, b.engine, p.name AS projectName, b.backup_interval_h AS intervalH, b.backup_keep AS keep, b.last_backup_at AS lastAt,
                b.last_verify_at AS lastVerifyAt,
                (SELECT status FROM backups WHERE database_id = b.id ORDER BY id DESC LIMIT 1) AS lastStatus,
                (SELECT error FROM backups WHERE database_id = b.id ORDER BY id DESC LIMIT 1) AS lastError,
                (SELECT size FROM backups WHERE database_id = b.id AND status = 'success' ORDER BY id DESC LIMIT 1) AS lastSize,
                (SELECT remote_key IS NOT NULL FROM backups WHERE database_id = b.id AND status = 'success' ORDER BY id DESC LIMIT 1) AS offsite,
                (SELECT verify_status FROM backups WHERE database_id = b.id AND verify_status IS NOT NULL ORDER BY id DESC LIMIT 1) AS verifyStatus,
                (SELECT COUNT(*) FROM backups WHERE database_id = b.id AND status = 'success') AS count
         FROM databases b JOIN projects p ON p.id = b.project_id WHERE ${inProjects(c, "b.project_id")} ORDER BY p.name, b.name`,
      )
      .all();
    const volumes = db
      .prepare(
        `SELECT a.id, a.name, p.name AS projectName, a.volumes, a.volume_backup_interval_h AS intervalH, a.volume_backup_keep AS keep,
                a.last_volume_backup_at AS lastAt,
                (SELECT status FROM volume_backups WHERE app_id = a.id ORDER BY id DESC LIMIT 1) AS lastStatus,
                (SELECT error FROM volume_backups WHERE app_id = a.id ORDER BY id DESC LIMIT 1) AS lastError,
                (SELECT SUM(size) FROM volume_backups WHERE app_id = a.id AND status = 'success' AND created_at = (SELECT MAX(created_at) FROM volume_backups WHERE app_id = a.id AND status = 'success')) AS lastSize,
                (SELECT COUNT(*) FROM volume_backups WHERE app_id = a.id AND status = 'success') AS count
         FROM apps a JOIN projects p ON p.id = a.project_id
         WHERE ${inProjects(c, "a.project_id")} AND a.volumes != '[]' AND a.parent_app_id IS NULL ORDER BY p.name, a.name`,
      )
      .all() as (Record<string, unknown> & { volumes: string })[];
    const panel =
      c.get("user").role === "admin"
        ? (db.prepare("SELECT status, error, size, remote_key IS NOT NULL AS offsite, created_at AS createdAt FROM panel_backups ORDER BY id DESC LIMIT 1").get() ?? null)
        : undefined;
    return c.json({
      databases,
      volumes: volumes.map(({ volumes: v, ...rest }) => ({ ...rest, volumeCount: (JSON.parse(v || "[]") as unknown[]).length })),
      panel,
    });
  })

  // Tüm uygulamaların zamanlanmış görevleri: son çalışma sonucu ve sonraki çalışma zamanı.
  .get("/schedules", (c) => {
    const tz = timeZone();
    const jobs = db
      .prepare(
        `SELECT j.id, j.name, j.schedule, j.command, j.enabled, j.last_run_at AS lastRunAt, a.id AS appId, a.name AS appName, p.name AS projectName,
                (SELECT status FROM cron_runs WHERE job_id = j.id ORDER BY id DESC LIMIT 1) AS lastStatus,
                (SELECT exit_code FROM cron_runs WHERE job_id = j.id ORDER BY id DESC LIMIT 1) AS lastExitCode,
                (SELECT finished_at - started_at FROM cron_runs WHERE job_id = j.id ORDER BY id DESC LIMIT 1) AS lastDurationMs
         FROM cron_jobs j JOIN apps a ON a.id = j.app_id JOIN projects p ON p.id = a.project_id
         WHERE ${inProjects(c, "a.project_id")} ORDER BY p.name, a.name, j.name`,
      )
      .all() as (Record<string, unknown> & { schedule: string; enabled: number })[];
    return c.json({
      timezone: tz,
      jobs: jobs.map((j) => ({ ...j, enabled: Boolean(j.enabled), nextRunAt: j.enabled ? (() => { try { return nextRun(j.schedule, Date.now(), tz); } catch { return null; } })() : null })),
    });
  });
