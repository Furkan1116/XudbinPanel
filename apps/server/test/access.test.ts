import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import { createApiToken } from "../src/auth/api-tokens.js";
import { enforceRoles, requireAuth } from "../src/auth/middleware.js";
import { createSession } from "../src/auth/session.js";
import { db } from "../src/db.js";
import type { AppEnv } from "../src/lib/types.js";
import { accessibleAppIds, canSeeSecrets, projectAccess, requireSecretAccess, secretsVisible } from "../src/services/access.js";
import { appTokenAllowed, approvedAppUrl, gitTokenFor } from "../src/services/github-app.js";
import { domainProblem, MAX_DOMAINS_PER_APP, panelHosts } from "../src/services/domain-policy.js";
import { updateSettings } from "../src/lib/settings.js";
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

test("sır yetkisi okuma yetkisi değildir: izleyici ve salt okunur anahtar sırrı göremez (O2)", async () => {
  const s = seed();
  const h = new Hono<AppEnv>();
  h.use("/api/*", requireAuth, enforceRoles, projectAccess);
  h.get("/api/apps/:id", (c) => c.json({ secrets: secretsVisible(c, s.p1) }));
  h.get("/api/apps/:id/volume-backups/1/download", (c) => {
    requireSecretAccess(c, s.p1);
    return c.json({ ok: true });
  });
  h.onError((e, c) => c.json({ error: e.message }, (e as HttpError).status ?? 500));
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const seen = async (headers: Record<string, string>) => ((await h.request(`/api/apps/${s.a1}`, { headers })).json() as Promise<{ secrets: boolean }>).then((j) => j.secrets);
  assert.equal(await seen(cookie(s.admin)), true);
  assert.equal(await seen(cookie(s.dev)), true);
  assert.equal(await seen(cookie(s.viewer)), false);
  assert.equal(await seen(auth(createApiToken(s.dev, "rw").token)), true);
  assert.equal(await seen(auth(createApiToken(s.dev, "ro", { readOnly: true }).token)), false);
  assert.equal(await seen(auth(createApiToken(s.admin, "admin-ro", { readOnly: true }).token)), false);
  const dl = (headers: Record<string, string>) => h.request(`/api/apps/${s.a1}/volume-backups/1/download`, { headers }).then((r) => r.status);
  assert.equal(await dl(cookie(s.dev)), 200);
  assert.equal(await dl(cookie(s.viewer)), 403);
  assert.equal(await dl(auth(createApiToken(s.dev, "ro2", { readOnly: true }).token)), 403);
  assert.equal(canSeeSecrets({ id: s.stranger, email: "", name: "", role: "member", mustChangePassword: false }, s.p1), false);
});

test("GitHub App token'ı yalnız yöneticiye ya da projede onaylı repoya verilir (O3)", async () => {
  const s = seed();
  const admin = { role: "admin" };
  const member = { role: "member" };
  const x = "https://github.com/sirket/gizli-repo.git";
  const y = "https://github.com/sirket/baska-repo";
  // Yönetici her repoyu onaylar; üye onaylı repo yoksa onaylayamaz.
  assert.equal(approvedAppUrl(admin, s.p1, x), x);
  assert.equal(approvedAppUrl(member, s.p1, x), null);
  assert.equal(approvedAppUrl(member, s.p1, "https://gitlab.com/a/b"), null);
  // Projede onaylı uygulama varsa aynı repo (farklı yazımla da) üyeye açılır; başka proje ve başka repo açılmaz.
  db.prepare("UPDATE apps SET git_url = ?, git_app_url = ? WHERE id = ?").run(x, x, s.a1);
  assert.equal(approvedAppUrl(member, s.p1, "https://github.com/Sirket/Gizli-Repo", s.a2), "https://github.com/Sirket/Gizli-Repo");
  assert.equal(approvedAppUrl(member, s.p1, y, s.a2), null);
  assert.equal(approvedAppUrl(member, s.p2, x, s.a2), null);
  // Adres değişince onay düşer.
  assert.equal(appTokenAllowed({ git_url: x, git_app_url: x }), true);
  assert.equal(appTokenAllowed({ git_url: y, git_app_url: x }), false);
  assert.equal(appTokenAllowed({ git_url: x, git_app_url: null }), false);
  // İzin yoksa App'e hiç gidilmez: kendi token'ı (boşsa boş) döner.
  updateSettings({ githubApp: { id: 1, slug: "t", name: "t", htmlUrl: "", owner: "", pem: "", webhookSecret: "", clientId: "", clientSecret: "" } });
  try {
    assert.equal(await gitTokenFor(x, "", false), "");
    assert.equal(await gitTokenFor(x, "kendi", false), "kendi");
  } finally {
    updateSettings({ githubApp: null });
  }
});

test("panel alan adı ve alt alanları üyeye kapalı, uygulama başına alan adı sınırlı (O7)", () => {
  const panel = ["xudbin.ornek.com", "xudbin.1-2-3-4.sslip.io"];
  assert.match(domainProblem("xudbin.ornek.com", "member", 0, panel) ?? "", /panelin kendi adresi/);
  assert.match(domainProblem("xudbin.ornek.com", "admin", 0, panel) ?? "", /panelin kendi adresi/);
  assert.match(domainProblem("XUDBIN.1-2-3-4.sslip.io", "member", 0, panel) ?? "", /kendi adresi/);
  assert.match(domainProblem("evil.xudbin.ornek.com", "member", 0, panel) ?? "", /alt alan/);
  assert.equal(domainProblem("evil.xudbin.ornek.com", "admin", 0, panel), null);
  assert.equal(domainProblem("blog.ornek.com", "member", 0, panel), null);
  assert.equal(domainProblem("notxudbin.ornek.com", "member", 0, panel), null);
  assert.match(domainProblem("a.example.org", "member", MAX_DOMAINS_PER_APP, panel) ?? "", /en fazla/);
  assert.equal(domainProblem("a.example.org", "admin", MAX_DOMAINS_PER_APP - 1, panel), null);
  // Ayardaki panel alan adı ve kurulum ortam değişkeni listeye girer.
  const old = process.env.XUDBIN_DOMAIN;
  process.env.XUDBIN_DOMAIN = "Panel.Kurulum.Test";
  updateSettings({ panelDomain: "panel.ayar.test" });
  try {
    const hosts = panelHosts();
    assert.ok(hosts.includes("panel.kurulum.test") && hosts.includes("panel.ayar.test"));
    assert.ok(domainProblem("panel.ayar.test", "member", 0));
    assert.ok(domainProblem("x.panel.kurulum.test", "member", 0));
  } finally {
    if (old === undefined) delete process.env.XUDBIN_DOMAIN;
    else process.env.XUDBIN_DOMAIN = old;
    updateSettings({ panelDomain: "" });
  }
});
