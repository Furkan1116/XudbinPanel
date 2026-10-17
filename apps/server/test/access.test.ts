import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import { createApiToken } from "../src/auth/api-tokens.js";
import { enforceRoles, requireAuth } from "../src/auth/middleware.js";
import { createSession } from "../src/auth/session.js";
import { db } from "../src/db.js";
import type { AppEnv } from "../src/lib/types.js";
import { accessibleAppIds, projectAccess } from "../src/services/access.js";
import { HttpError, idParam } from "../src/lib/http.js";

function seed() {
  const now = Date.now();
  const u = (email: string, role: string) =>
    Number(db.prepare("INSERT INTO users (email, name, password_hash, role, created_at) VALUES (?, ?, 'x', ?, ?)").run(email, email, role, now).lastInsertRowid);
  const tag = Math.random().toString(36).slice(2, 8);
  const admin = u(`admin-${tag}@t`, "admin");
  const dev = u(`dev-${tag}@t`, "member");
  const viewer = u(`viewer-${tag}@t`, "member");
  const stranger = u(`stranger-${tag}@t`, "member");
  const p = (name: string) => Number(db.prepare("INSERT INTO projects (name, description, created_at) VALUES (?, '', ?)").run(name, now).lastInsertRowid);
  const p1 = p(`p1-${tag}`);
  const p2 = p(`p2-${tag}`);
  const server = (db.prepare("SELECT id FROM servers LIMIT 1").get() as { id: number } | undefined)?.id ??
    Number(db.prepare("INSERT INTO servers (name, kind, status, created_at) VALUES ('local', 'local', 'ready', ?)").run(now).lastInsertRowid);
  const app = (pid: number, slug: string) =>
    Number(db.prepare("INSERT INTO apps (project_id, server_id, name, slug, source_type, webhook_token, created_at) VALUES (?, ?, ?, ?, 'image', ?, ?)").run(pid, server, slug, `${slug}-${tag}`, `w-${slug}-${tag}`, now).lastInsertRowid);
  const a1 = app(p1, "a1");
  const a2 = app(p2, "a2");
  db.prepare("INSERT INTO project_members (project_id, user_id, role, created_at) VALUES (?, ?, 'developer', ?), (?, ?, 'viewer', ?)").run(p1, dev, now, p1, viewer, now);
  return { admin, dev, viewer, stranger, p1, p2, a1, a2 };
}

function app() {
  const h = new Hono<AppEnv>();
  h.use("/api/*", requireAuth, enforceRoles, projectAccess);
  h.get("/api/apps/:id", (c) => c.json({ ok: true }));
  h.post("/api/apps/:id/deploy", (c) => c.json({ ok: true }));
  h.post("/api/settings/account/tokens", (c) => c.json({ ok: true }));
  h.get("/api/security/summary", (c) => c.json({ ok: true }));
  return h;
}

const cookie = (userId: number) => ({ Cookie: `xudbin_session=${createSession(userId, {}).token}` });

test("proje yetkileri: üye yalnız kendi projesini görür, izleyici değiştiremez", async () => {
  const s = seed();
  const h = app();
  const get = (u: number, a: number) => h.request(`/api/apps/${a}`, { headers: cookie(u) }).then((r) => r.status);
  const post = (u: number, a: number) => h.request(`/api/apps/${a}/deploy`, { method: "POST", headers: cookie(u) }).then((r) => r.status);
  assert.equal(await get(s.admin, s.a2), 200);
  assert.equal(await get(s.dev, s.a1), 200);
  assert.equal(await get(s.dev, s.a2), 404);
  assert.equal(await get(s.stranger, s.a1), 404);
  assert.equal(await post(s.dev, s.a1), 200);
  assert.equal(await get(s.viewer, s.a1), 200);
  assert.equal(await post(s.viewer, s.a1), 403);
  assert.equal(await h.request("/api/security/summary", { headers: cookie(s.dev) }).then((r) => r.status), 403);
  assert.ok(accessibleAppIds({ id: s.dev, email: "", name: "", role: "member", mustChangePassword: false }).includes(s.a1));
  assert.ok(!accessibleAppIds({ id: s.dev, email: "", name: "", role: "member", mustChangePassword: false }).includes(s.a2));
});

test("API anahtarları: sahibinin yetkisi, salt okunur ve hesap kısıtı", async () => {
  const s = seed();
  const h = app();
  const rw = createApiToken(s.dev, "ci").token;
  const ro = createApiToken(s.dev, "okuma", { readOnly: true }).token;
  const expired = createApiToken(s.dev, "eski", { expiresInDays: 1 });
  db.prepare("UPDATE api_tokens SET expires_at = ? WHERE id = ?").run(Date.now() - 1000, expired.id);
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  assert.equal((await h.request(`/api/apps/${s.a1}/deploy`, { method: "POST", headers: auth(rw) })).status, 200);
  assert.equal((await h.request(`/api/apps/${s.a2}`, { headers: auth(rw) })).status, 404);
  assert.equal((await h.request(`/api/apps/${s.a1}`, { headers: auth(ro) })).status, 200);
  assert.equal((await h.request(`/api/apps/${s.a1}/deploy`, { method: "POST", headers: auth(ro) })).status, 403);
  assert.equal((await h.request(`/api/apps/${s.a1}`, { headers: auth(expired.token) })).status, 401);
  assert.equal((await h.request(`/api/apps/${s.a1}`, { headers: auth("xb_uydurma") })).status, 401);
  assert.equal((await h.request("/api/settings/account/tokens", { method: "POST", headers: auth(rw) })).status, 403);
});

test("proje yetkisi sayısal olmayan kimlik yazımlarıyla atlanamaz (K1)", async () => {
  const s = seed();
  const h = app();
  const strict = new Hono<AppEnv>();
  strict.use("/api/*", requireAuth, enforceRoles, projectAccess);
  strict.get("/api/apps/:id", (c) => c.json({ id: idParam(c) }));
  strict.onError((e, c) => c.json({ error: e.message }, (e as HttpError).status ?? 500));
  for (const form of [`${s.a2}e0`, `${s.a2}.0`, `0x${s.a2.toString(16)}`, `+${s.a2}`, `%20${s.a2}`, `0${s.a2}`]) {
    const status = (await strict.request(`/api/apps/${form}`, { headers: cookie(s.dev) })).status;
    assert.ok(status === 404 || status === 400, `${form} -> ${status}`);
    assert.notEqual((await h.request(`/api/apps/${form}`, { headers: cookie(s.dev) })).status, 200, form);
  }
  assert.equal((await strict.request(`/api/apps/${s.a1}`, { headers: cookie(s.dev) })).status, 200);
});
