import { Hono } from "hono";
import { z } from "zod";
import { db } from "../db.js";
import { body, HttpError, idParam } from "../lib/http.js";
import { getSettings, updateSettings } from "../lib/settings.js";
import { applyToAllServers } from "../services/security.js";

export const securityRoutes = new Hono()
  .get("/summary", (c) => {
    const hours = Math.min(Math.max(Number(c.req.query("hours")) || 24, 1), 24 * 30);
    const since = Date.now() - hours * 3_600_000;
    const bucketMs = hours <= 24 ? 3_600_000 : 86_400_000;
    const byKind = db.prepare("SELECT kind, COUNT(*) AS n FROM security_events WHERE created_at > ? GROUP BY kind").all(since) as { kind: string; n: number }[];
    const timeline = db
      .prepare(`SELECT (created_at / ?) * ? AS t, COUNT(*) AS n FROM security_events WHERE created_at > ? GROUP BY t ORDER BY t`)
      .all(bucketMs, bucketMs, since);
    const topIps = db
      .prepare(
        `SELECT e.ip, COUNT(*) AS n, MAX(e.created_at) AS last,
                EXISTS(SELECT 1 FROM blocked_ips b WHERE b.ip = e.ip) AS blocked
         FROM security_events e WHERE e.created_at > ? GROUP BY e.ip ORDER BY n DESC LIMIT 10`,
      )
      .all(since);
    const topPaths = db
      .prepare(`SELECT path, COUNT(*) AS n FROM security_events WHERE created_at > ? AND path IS NOT NULL GROUP BY path ORDER BY n DESC LIMIT 10`)
      .all(since);
    const topHosts = db
      .prepare(`SELECT COALESCE(host, 'Panel') AS host, COUNT(*) AS n FROM security_events WHERE created_at > ? GROUP BY host ORDER BY n DESC LIMIT 10`)
      .all(since);
    const blockedCount = (db.prepare("SELECT COUNT(*) AS n FROM blocked_ips WHERE expires_at IS NULL OR expires_at > ?").get(Date.now()) as { n: number }).n;
    return c.json({ hours, bucketMs, byKind, timeline, topIps, topPaths, topHosts, blockedCount });
  })

  .get("/events", (c) => {
    const limit = Math.min(Number(c.req.query("limit")) || 100, 500);
    const kind = c.req.query("kind");
    const ip = c.req.query("ip");
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (kind) where.push("e.kind = ?"), params.push(kind);
    if (ip) where.push("e.ip = ?"), params.push(ip);
    const events = db
      .prepare(
        `SELECT e.id, e.ip, e.kind, e.method, e.path, e.status, e.host, e.user_agent AS userAgent, e.created_at AS createdAt, s.name AS serverName
         FROM security_events e LEFT JOIN servers s ON s.id = e.server_id
         ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY e.id DESC LIMIT ?`,
      )
      .all(...params, limit);
    return c.json({ events });
  })

  .get("/blocked", (c) => {
    db.prepare("DELETE FROM blocked_ips WHERE expires_at IS NOT NULL AND expires_at < ?").run(Date.now());
    const blocked = db.prepare("SELECT id, ip, reason, auto, expires_at AS expiresAt, created_at AS createdAt FROM blocked_ips ORDER BY id DESC").all();
    return c.json({ blocked });
  })

  .post("/blocked", async (c) => {
    const input = await body(
      c,
      z.object({
        ip: z.string().trim().regex(/^[0-9a-f:.]+(\/\d{1,3})?$/i, "Geçerli bir IP veya CIDR gir"),
        reason: z.string().trim().max(200).default("Elle engellendi"),
        hours: z.number().int().min(1).max(24 * 365).nullable().default(null),
      }),
    );
    if (db.prepare("SELECT 1 FROM blocked_ips WHERE ip = ?").get(input.ip)) throw new HttpError(409, "Bu IP zaten engelli");
    db.prepare("INSERT INTO blocked_ips (ip, reason, auto, expires_at, created_at) VALUES (?, ?, 0, ?, ?)").run(
      input.ip,
      input.reason || "Elle engellendi",
      input.hours ? Date.now() + input.hours * 3_600_000 : null,
      Date.now(),
    );
    await applyToAllServers();
    return c.json({ ok: true }, 201);
  })

  .delete("/blocked/:id", async (c) => {
    db.prepare("DELETE FROM blocked_ips WHERE id = ?").run(idParam(c));
    await applyToAllServers();
    return c.json({ ok: true });
  })

  .get("/settings", (c) => {
    const s = getSettings();
    return c.json({ autoBanEnabled: s.autoBanEnabled, autoBanThreshold: s.autoBanThreshold, autoBanWindowMin: s.autoBanWindowMin, autoBanDurationH: s.autoBanDurationH });
  })

  .put("/settings", async (c) => {
    const input = await body(
      c,
      z.object({
        autoBanEnabled: z.boolean(),
        autoBanThreshold: z.number().int().min(3).max(10_000),
        autoBanWindowMin: z.number().int().min(1).max(1440),
        autoBanDurationH: z.number().int().min(1).max(24 * 365),
      }),
    );
    updateSettings(input);
    return c.json({ ok: true });
  });
