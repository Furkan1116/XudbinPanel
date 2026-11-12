import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Hono } from "hono";
import { applyMigrations, db, migrations } from "../src/db.js";
import { HttpError } from "../src/lib/http.js";
import type { AppEnv } from "../src/lib/types.js";
import { appRoutes, deploymentRoutes } from "../src/routes/apps.js";
import { projectAccess } from "../src/services/access.js";
import { auditTrail } from "../src/services/audit.js";
import { enqueueDeploy, getApp } from "../src/services/deploy.js";
import { PreflightBlockedError, preflightForDeploy, recordComposePolicy } from "../src/services/preflight/gate.js";
import { storeAppUpload } from "../src/services/uploads.js";

const now = Date.now();
const tag = () => Math.random().toString(36).slice(2, 8);
const SECRET = "akis-testi-gizli-deger-55c1";

// Sunucu "pending": yanlışlıkla kuyruğa giren bir deploy Docker'a dokunmadan "sunucu hazır değil" ile biter.
const serverId = Number(db.prepare("INSERT INTO servers (name, kind, status, created_at) VALUES ('pf', 'ssh', 'pending', ?)").run(now).lastInsertRowid);

function user(role: "admin" | "member") {
  return Number(db.prepare("INSERT INTO users (email, name, password_hash, role, created_at) VALUES (?, 'u', 'x', ?, ?)").run(`pf-${tag()}@t`, role, now).lastInsertRowid);
}

function seedApp(extra: Record<string, string | number | null> = {}) {
  const t = tag();
  const pid = Number(db.prepare("INSERT INTO projects (name, description, created_at) VALUES (?, '', ?)").run(`pf-${t}`, now).lastInsertRowid);
  const id = Number(
    db.prepare("INSERT INTO apps (project_id, server_id, name, slug, source_type, port, webhook_token, created_at) VALUES (?, ?, 'pf', ?, 'upload', 3000, ?, ?)").run(pid, serverId, `pf-${t}`, `pfw-${t}`, now).lastInsertRowid,
  );
  for (const [k, v] of Object.entries(extra)) db.prepare(`UPDATE apps SET ${k} = ? WHERE id = ?`).run(v, id);
  return { id, pid };
}

function deployment(appId: number, trigger = "manual") {
  return Number(db.prepare("INSERT INTO deployments (app_id, status, trigger, started_at) VALUES (?, 'running', ?, ?)").run(appId, trigger, now).lastInsertRowid);
}

function project(files: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xb-pf-flow-"));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  return root;
}

const withSecret = () => project({ ".env": `SECRET_KEY=${SECRET}\n`, ".gitignore": "x", "index.html": "<h1>x</h1>" });
const row = (table: string, id: number) => db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as Record<string, string | number | null>;

function http(userId: number, role: "admin" | "member") {
  const h = new Hono<AppEnv>();
  h.use("*", async (c, next) => {
    c.set("user", { id: userId, email: `u${userId}@t`, name: "", role, mustChangePassword: false });
    await next();
  });
  h.use("/api/*", auditTrail, projectAccess);
  h.route("/api/apps", appRoutes);
  h.route("/api/deployments", deploymentRoutes);
  h.onError((e, c) => (e instanceof HttpError ? c.json({ error: e.message }, e.status) : c.json({ error: String(e) }, 500)));
  // İşlem kaydı istemci adresini bağlantıdan okur; testte sahte bir soket verilir.
  const env = { incoming: { socket: { remoteAddress: "127.0.0.1", remotePort: 1, remoteFamily: "IPv4" } } };
  return (method: string, url: string, body?: object) => h.request(url, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }, env);
}

test("göç: var olan uygulamalar 'warn', yeni uygulamalar 'block' ile başlar", () => {
  const mem = new DatabaseSync(":memory:");
  const index = migrations.findIndex((m) => m.includes("preflight_mode"));
  assert.ok(index > 0);
  applyMigrations(mem, index);
  mem.exec("INSERT INTO servers (id, name, kind, created_at) VALUES (1, 's', 'local', 0); INSERT INTO projects (id, name, created_at) VALUES (1, 'p', 0);");
  mem.exec("INSERT INTO apps (project_id, server_id, name, slug, source_type, webhook_token, created_at) VALUES (1, 1, 'eski', 'eski', 'git', 'w1', 0)");
  applyMigrations(mem);
  mem.exec("INSERT INTO apps (project_id, server_id, name, slug, source_type, webhook_token, created_at) VALUES (1, 1, 'yeni', 'yeni', 'git', 'w2', 0)");
  const modes = mem.prepare("SELECT slug, preflight_mode FROM apps ORDER BY id").all();
  assert.deepEqual(modes.map((m) => ({ ...m })), [
    { slug: "eski", preflight_mode: "warn" },
    { slug: "yeni", preflight_mode: "block" },
  ]);
  assert.ok(mem.prepare("SELECT preflight, preflight_skip FROM deployments LIMIT 0").all());
});

test("yayın: block modunda kritik bulgu yayını durdurur; rapor yayınla ve uygulamada saklanır, gizli değer saklanmaz", () => {
  const { id } = seedApp({ preflight_mode: "block" });
  const dep = deployment(id);
  const lines: string[] = [];
  assert.throws(
    () => preflightForDeploy({ app: getApp(id)!, deploymentId: dep, trigger: "manual", skip: false, root: withSecret(), source: { uploadedAt: 123 }, log: (l) => lines.push(l) }),
    (e) => e instanceof PreflightBlockedError && /1 kritik bulgu/.test(e.message) && /Yine de yayınla/.test(e.message),
  );
  const saved = JSON.parse(String(row("deployments", dep).preflight));
  assert.equal(saved.outcome, "blocked");
  assert.equal(saved.mode, "block");
  assert.equal(saved.deploymentId, dep);
  assert.equal(saved.source.uploadedAt, 123);
  assert.equal(JSON.parse(String(row("apps", id).preflight_report)).deploymentId, dep);
  assert.match(lines[0]!, /^Yayın kontrolü: 1 kritik/);
  assert.ok(!(JSON.stringify(saved) + lines.join("\n")).includes(SECRET));
});

test("yayın: elle 'yine de yayınla' geçer ve günlüğe yazılır; webhook'ta geçiş yok; warn ve off durdurmaz", () => {
  const { id } = seedApp({ preflight_mode: "block" });
  const lines: string[] = [];
  const bypass = preflightForDeploy({ app: getApp(id)!, deploymentId: deployment(id), trigger: "manual", skip: true, root: withSecret(), source: {}, log: (l) => lines.push(l) });
  assert.equal(bypass?.outcome, "bypassed");
  assert.ok(lines.some((l) => l.includes("bilerek geçildi")));
  assert.throws(() => preflightForDeploy({ app: getApp(id)!, deploymentId: deployment(id, "webhook"), trigger: "webhook", skip: true, root: withSecret(), source: {}, log: () => {} }), /otomatik yayın durduruldu/);

  const warn = seedApp({ preflight_mode: "warn" });
  assert.equal(preflightForDeploy({ app: getApp(warn.id)!, deploymentId: deployment(warn.id, "webhook"), trigger: "webhook", skip: false, root: withSecret(), source: {}, log: () => {} })?.outcome, "warned");

  const off = seedApp({ preflight_mode: "off" });
  const offLines: string[] = [];
  const offDep = deployment(off.id);
  assert.equal(preflightForDeploy({ app: getApp(off.id)!, deploymentId: offDep, trigger: "manual", skip: false, root: withSecret(), source: {}, log: (l) => offLines.push(l) }), null);
  assert.match(offLines[0]!, /kapalı/);
  assert.equal(row("deployments", offDep).preflight, null);
});

test("yayın: kontrolün kendi hatası yayını durdurmaz", () => {
  const { id } = seedApp({ preflight_mode: "block" });
  const lines: string[] = [];
  const r = preflightForDeploy({ app: getApp(id)!, deploymentId: deployment(id), trigger: "webhook", skip: false, root: path.join(os.tmpdir(), `xb-yok-${tag()}`), source: {}, log: (l) => lines.push(l) });
  assert.equal(r?.outcome, "error");
  assert.ok(lines.some((l) => l.includes("tamamlanamadı")));
});

test("compose politikası sonucu yayının raporuna eklenir", () => {
  const { id } = seedApp({ source_type: "compose", preflight_mode: "warn" });
  const dep = deployment(id);
  preflightForDeploy({ app: getApp(id)!, deploymentId: dep, trigger: "manual", skip: false, root: null, source: {}, log: () => {} });
  recordComposePolicy(dep, id, ["web: privileged: true sunucuda root yetkisi verir"]);
  const saved = JSON.parse(String(row("deployments", dep).preflight));
  assert.ok(saved.groups.includes("compose"));
  assert.equal(saved.counts.critical, 1);
  assert.equal(saved.findings[0].group, "compose");
});

test("API: skipPreflight yalnız elle başlatılan yayında saklanır ve işlem kaydına ayrı etiketle yazılır", async () => {
  const admin = user("admin");
  const { id } = seedApp();
  const send = http(admin, "admin");
  const res = await send("POST", `/api/apps/${id}/deploy`, { skipPreflight: true });
  assert.equal(res.status, 202);
  const { deploymentId } = (await res.json()) as { deploymentId: number };
  assert.equal(row("deployments", deploymentId).preflight_skip, 1);
  const audit = db.prepare("SELECT action FROM audit_log WHERE user_id = ? ORDER BY id DESC LIMIT 1").get(admin) as { action: string };
  assert.equal(audit.action, "Yayın kontrolünü bilerek geçerek deploy başlattı");
  const plain = (await (await send("POST", `/api/apps/${id}/deploy`)).json()) as { deploymentId: number };
  assert.equal(row("deployments", plain.deploymentId).preflight_skip, 0);
  assert.equal((db.prepare("SELECT action FROM audit_log WHERE user_id = ? ORDER BY id DESC LIMIT 1").get(admin) as { action: string }).action, "Deploy başlattı");
  // Webhook yayınında geçiş isteği yok sayılır.
  assert.equal(row("deployments", enqueueDeploy(id, "webhook", { skipPreflight: true })).preflight_skip, 0);
});

test("API: mod ayarı, son rapor, yayın özeti; görüntüleyici raporu görür ama kontrol çalıştıramaz", async () => {
  const admin = user("admin");
  const viewer = user("member");
  const { id, pid } = seedApp({ preflight_mode: "block" });
  db.prepare("INSERT INTO project_members (project_id, user_id, role, created_at) VALUES (?, ?, 'viewer', ?)").run(pid, viewer, now);
  const asAdmin = http(admin, "admin");
  const asViewer = http(viewer, "member");

  assert.equal((await asAdmin("PATCH", `/api/apps/${id}`, { preflightMode: "kapali" })).status, 400);
  assert.equal((await asAdmin("PATCH", `/api/apps/${id}`, { preflightMode: "warn" })).status, 200);
  assert.equal(row("apps", id).preflight_mode, "warn");

  const dep = deployment(id);
  preflightForDeploy({ app: getApp(id)!, deploymentId: dep, trigger: "manual", skip: false, root: withSecret(), source: {}, log: () => {} });
  const detail = (await (await asViewer("GET", `/api/apps/${id}`)).json()) as { app: { preflightMode: string }; deployments: { id: number; preflight: { outcome: string; counts: { critical: number } } | null }[] };
  assert.equal(detail.app.preflightMode, "warn");
  assert.deepEqual(detail.deployments.find((d) => d.id === dep)?.preflight, { outcome: "warned", counts: { critical: 1, warning: 0, info: 1 } });

  const last = (await (await asViewer("GET", `/api/apps/${id}/preflight`)).json()) as { mode: string; report: { counts: { critical: number } } };
  assert.equal(last.mode, "warn");
  assert.equal(last.report.counts.critical, 1);
  const full = (await (await asViewer("GET", `/api/deployments/${dep}/preflight`)).json()) as { report: { findings: unknown[] } };
  assert.equal(full.report.findings.length, 2);
  assert.equal((await asViewer("POST", `/api/apps/${id}/preflight`)).status, 403);
  assert.equal((await asViewer("POST", `/api/apps/${id}/deploy`, { skipPreflight: true })).status, 403);
});

test("API: 'Kontrol et' yayınlamadan son yüklemeyi kontrol eder; imaj kaynağında atlandığını söyler", async () => {
  const admin = user("admin");
  const send = http(admin, "admin");
  const { id } = seedApp();
  const src = withSecret();
  const zip = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "xb-pf-zip-")), "p.zip");
  execFileSync("zip", ["-q", "-r", zip, "."], { cwd: src });
  storeAppUpload(String(row("apps", id).slug), zip);
  const before = (db.prepare("SELECT COUNT(*) AS n FROM deployments WHERE app_id = ?").get(id) as { n: number }).n;
  const res = await send("POST", `/api/apps/${id}/preflight`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { report: { counts: { critical: number }; source: { type: string; uploadedAt: number | null } } };
  assert.equal(body.report.counts.critical, 1);
  assert.equal(body.report.source.type, "upload");
  assert.ok(body.report.source.uploadedAt);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM deployments WHERE app_id = ?").get(id) as { n: number }).n, before, "kontrol yayın başlatmaz");
  assert.ok(row("apps", id).preflight_report);

  const image = seedApp({ source_type: "image", image: "nginx:1.27" });
  const skipped = (await (await send("POST", `/api/apps/${image.id}/preflight`)).json()) as { report: { status: string } };
  assert.equal(skipped.report.status, "skipped");
  const noUpload = seedApp();
  assert.equal((await send("POST", `/api/apps/${noUpload.id}/preflight`)).status, 422);
});
