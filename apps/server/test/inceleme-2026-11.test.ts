import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import { db } from "../src/db.js";
import { encrypt } from "../src/lib/crypto.js";
import { HttpError } from "../src/lib/http.js";
import type { AppEnv } from "../src/lib/types.js";
import { appRoutes } from "../src/routes/apps.js";
import { databaseRoutes } from "../src/routes/databases.js";
import { buildCaddyConfig } from "../src/services/caddy.js";
import { startBackupScheduler } from "../src/services/databases.js";
import { cancelDeployment, enqueueDeploy } from "../src/services/deploy.js";
import { autoBan } from "../src/services/security.js";
import { startUptimeMonitor, uptimeSummary } from "../src/services/uptime.js";

/** 2026-11 kod incelemesinde bulunan işleyiş hataları. */
const now = () => Date.now();
const tag = () => Math.random().toString(36).slice(2, 8);

function seed() {
  const t = tag();
  const server =
    (db.prepare("SELECT id FROM servers LIMIT 1").get() as { id: number } | undefined)?.id ??
    Number(db.prepare("INSERT INTO servers (name, kind, status, created_at) VALUES ('local', 'local', 'pending', ?)").run(now()).lastInsertRowid);
  const project = Number(db.prepare("INSERT INTO projects (name, description, created_at) VALUES (?, '', ?)").run(`p-${t}`, now()).lastInsertRowid);
  const app = (extra: Record<string, string | number> = {}) => {
    const cols = { project_id: project, server_id: server, name: `a-${tag()}`, slug: `a-${tag()}`, source_type: "image", webhook_token: `w-${tag()}`, created_at: now(), ...extra };
    return Number(db.prepare(`INSERT INTO apps (${Object.keys(cols).join(", ")}) VALUES (${Object.keys(cols).map(() => "?").join(", ")})`).run(...Object.values(cols)).lastInsertRowid);
  };
  const user = (role: string) => Number(db.prepare("INSERT INTO users (email, name, password_hash, role, created_at) VALUES (?, 'u', 'x', ?, ?)").run(`${role}-${t}@t`, role, now()).lastInsertRowid);
  return { server, project, app, user, t };
}

function api(userId: number, role: "admin" | "member") {
  const h = new Hono<AppEnv>();
  h.use("*", async (c, next) => {
    c.set("user", { id: userId, email: "t@t", name: "t", role, mustChangePassword: false } as AppEnv["Variables"]["user"]);
    await next();
  });
  h.route("/apps", appRoutes);
  h.route("/databases", databaseRoutes);
  h.onError((err, c) => c.json({ error: err.message }, err instanceof HttpError ? err.status : 500));
  return h;
}
const json = (method: string, body: unknown) => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

test("iptal edilen sıradaki deploy uygulamayı 'deploy ediliyor' durumunda bırakmaz", () => {
  const s = seed();
  // Uygulama silinmiş gibi davranan bir kimlikle kuyruk çalışmaz; durum yalnız veritabanında izlenir.
  const app = s.app();
  const res = db.prepare("INSERT INTO deployments (app_id, status, trigger, title, started_at) VALUES (?, 'queued', 'manual', '', ?)").run(app, now());
  db.prepare("UPDATE apps SET status = 'deploying' WHERE id = ?").run(app);
  assert.equal(cancelDeployment(Number(res.lastInsertRowid)), true);
  assert.equal((db.prepare("SELECT status FROM apps WHERE id = ?").get(app) as { status: string }).status, "idle");
  // Başka bir deploy hâlâ sıradaysa durum korunur.
  const app2 = s.app({ container: "xb-x-1" });
  const d1 = Number(db.prepare("INSERT INTO deployments (app_id, status, trigger, title, started_at) VALUES (?, 'queued', 'manual', '', ?)").run(app2, now()).lastInsertRowid);
  db.prepare("INSERT INTO deployments (app_id, status, trigger, title, started_at) VALUES (?, 'running', 'manual', '', ?)").run(app2, now());
  db.prepare("UPDATE apps SET status = 'deploying' WHERE id = ?").run(app2);
  cancelDeployment(d1);
  assert.equal((db.prepare("SELECT status FROM apps WHERE id = ?").get(app2) as { status: string }).status, "deploying");
  void enqueueDeploy;
});

test("otomatik ban: özel ağ adresi ve oturumu açık yöneticinin adresi banlanmaz", async () => {
  const s = seed();
  const admin = s.user("admin");
  const ips = { tunnel: "172.18.0.5", admin: `198.51.100.${10 + Math.floor(Math.random() * 200)}`, bot: `198.18.7.${10 + Math.floor(Math.random() * 200)}` };
  db.prepare("INSERT INTO sessions (id, user_id, expires_at, created_at, ip) VALUES (?, ?, ?, ?, ?)").run(`sess-${s.t}`, admin, now() + 3_600_000, now(), ips.admin);
  const ins = db.prepare("INSERT INTO security_events (server_id, host, ip, kind, method, path, status, created_at) VALUES (NULL, 'h', ?, 'waf', 'GET', ?, 403, ?)");
  for (const ip of Object.values(ips)) for (let i = 0; i < 40; i++) ins.run(ip, `/p${i}`, now());
  const banned = await autoBan();
  assert.ok(banned.includes(ips.bot), "tarayan adres banlanmalı");
  assert.ok(!banned.includes(ips.tunnel), "özel ağ adresi banlanmamalı");
  assert.ok(!banned.includes(ips.admin), "yöneticinin adresi banlanmamalı");
  db.prepare("DELETE FROM blocked_ips WHERE ip = ?").run(ips.bot);
});

test("veritabanı dış portu: aynı sunucuda kullanılan port reddedilir", async () => {
  const s = seed();
  const port = 20000 + Math.floor(Math.random() * 20000);
  const mk = (p: number | null) =>
    Number(
      db
        .prepare("INSERT INTO databases (project_id, server_id, name, slug, engine, version, db_name, db_user, db_password, external_port, status, created_at) VALUES (?, ?, ?, ?, 'postgres', '17', 'd', 'xudbin', ?, ?, 'running', ?)")
        .run(s.project, s.server, `db-${tag()}`, `db-${tag()}`, encrypt("x"), p, now()).lastInsertRowid,
    );
  mk(port);
  const other = mk(null);
  const h = api(s.user("admin"), "admin");
  const res = await h.request(`/databases/${other}`, json("PATCH", { externalPort: port }));
  assert.equal(res.status, 409, await res.text());
  assert.equal((db.prepare("SELECT external_port FROM databases WHERE id = ?").get(other) as { external_port: number | null }).external_port, null);
});

test("Compose servis adı Caddy yapılandırmasını bozamaz; üye kaynağı değiştirince sunucu erişimi onayı düşer", async () => {
  const s = seed();
  const app = s.app({ source_type: "compose", compose_file: "services:\n  web:\n    image: nginx\n", host_access: 1 });
  const admin = api(s.user("admin"), "admin");
  assert.equal((await admin.request(`/apps/${app}`, json("PATCH", { composeService: "web:80/x y" }))).status, 400);
  // Eski kayıtlarda geçersiz ad kalmışsa yapılandırmaya yazılmaz.
  db.prepare("UPDATE apps SET compose_service = 'a b:1', container = 'xb-x' WHERE id = ?").run(app);
  db.prepare("INSERT INTO domains (app_id, host, https, generated, created_at) VALUES (?, ?, 0, 0, ?)").run(app, `c-${s.t}.example.com`, now());
  const server = db.prepare("SELECT * FROM servers WHERE id = ?").get(s.server) as Parameters<typeof buildCaddyConfig>[0];
  assert.ok(!JSON.stringify(buildCaddyConfig(server)).includes("a b:1"));
  db.prepare("UPDATE apps SET compose_service = NULL WHERE id = ?").run(app);

  const member = s.user("member");
  db.prepare("INSERT INTO project_members (project_id, user_id, role, created_at) VALUES (?, ?, 'developer', ?)").run(s.project, member, now());
  const access = () => (db.prepare("SELECT host_access FROM apps WHERE id = ?").get(app) as { host_access: number }).host_access;
  // Yönetici içeriği değiştirince onay kalır, üye değiştirince düşer.
  await admin.request(`/apps/${app}`, json("PATCH", { composeFile: "services:\n  web:\n    image: nginx:1\n" }));
  assert.equal(access(), 1);
  const res = await api(member, "member").request(`/apps/${app}`, json("PATCH", { composeFile: "services:\n  web:\n    image: nginx\n    privileged: true\n" }));
  assert.equal(res.status, 200, await res.text());
  assert.equal(access(), 0);
});

test("panel yeniden başlayınca: süren kesinti geri yüklenir, yarım kalan yedekler kapatılır", () => {
  const s = seed();
  const app = s.app();
  db.prepare("INSERT INTO uptime_incidents (app_id, started_at, reason) VALUES (?, ?, 'HTTP 502')").run(app, now() - 60_000);
  const dbId = Number(
    db
      .prepare("INSERT INTO databases (project_id, server_id, name, slug, engine, version, db_name, db_user, db_password, status, created_at) VALUES (?, ?, 'd', ?, 'postgres', '17', 'd', 'xudbin', ?, 'stopped', ?)")
      .run(s.project, s.server, `db-${tag()}`, encrypt("x"), now()).lastInsertRowid,
  );
  const backup = Number(db.prepare("INSERT INTO backups (database_id, file, status, created_at) VALUES (?, 'f.sql.gz', 'running', ?)").run(dbId, now()).lastInsertRowid);
  assert.equal(uptimeSummary(app).down, false);
  startUptimeMonitor();
  startBackupScheduler();
  assert.equal(uptimeSummary(app).down, true);
  assert.equal((db.prepare("SELECT status FROM backups WHERE id = ?").get(backup) as { status: string }).status, "failed");
  db.prepare("UPDATE uptime_incidents SET ended_at = ? WHERE app_id = ?").run(now(), app);
});
