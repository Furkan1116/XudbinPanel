import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import { db } from "../src/db.js";
import { decrypt, encrypt } from "../src/lib/crypto.js";
import { HttpError } from "../src/lib/http.js";
import type { AppEnv } from "../src/lib/types.js";
import { appRoutes } from "../src/routes/apps.js";

const now = Date.now();
const admin = Number(db.prepare("INSERT INTO users (email, name, password_hash, role, created_at) VALUES (?, 'a', 'x', 'admin', ?)").run(`src-${now}@t`, now).lastInsertRowid);
const h = new Hono<AppEnv>();
h.use("*", async (c, next) => { c.set("user", { id: admin, email: "", name: "", role: "admin", mustChangePassword: false }); await next(); });
h.route("/api/apps", appRoutes);
h.onError((e, c) => (e instanceof HttpError ? c.json({ error: e.message }, e.status) : c.json({ error: String(e) }, 500)));
const send = (method: string, url: string, body: object) => h.request(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const patch = (id: number, body: object) => send("PATCH", `/api/apps/${id}`, body);
const put = (id: number, body: object) => h.request(`/api/apps/${id}/source`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

function seed(source: string, extra: Record<string, unknown> = {}) {
  const tag = Math.random().toString(36).slice(2, 8);
  if (!db.prepare("SELECT 1 FROM servers WHERE id = 987301").get()) db.prepare("INSERT INTO servers (id, name, kind, status, created_at) VALUES (987301, 's', 'ssh', 'ready', ?)").run(now);
  const pid = Number(db.prepare("INSERT INTO projects (name, description, created_at) VALUES (?, '', ?)").run(`sp-${tag}`, now).lastInsertRowid);
  const id = Number(
    db.prepare("INSERT INTO apps (project_id, server_id, name, slug, source_type, port, env, webhook_token, created_at) VALUES (?, 987301, 'a', ?, ?, 3000, ?, ?, ?)")
      .run(pid, `s-${tag}`, source, encrypt("DATABASE_URL=postgres://x"), `wt-${tag}`, now).lastInsertRowid,
  );
  db.prepare("INSERT INTO domains (app_id, host, https, created_at) VALUES (?, ?, 1, ?)").run(id, `${tag}.ornek.test`, now);
  for (const [k, v] of Object.entries(extra)) db.prepare(`UPDATE apps SET ${k} = ? WHERE id = ?`).run(v as string | number | null, id);
  return id;
}
const row = (id: number) => db.prepare("SELECT * FROM apps WHERE id = ?").get(id) as Record<string, unknown>;

test("kaynak değiştirme: upload → git; ortam değişkeni, alan adı ve port korunur", async () => {
  const id = seed("upload");
  const before = row(id);
  const res = await put(id, { sourceType: "git", gitUrl: "https://github.com/ornek/stok", gitBranch: "canli" });
  assert.equal(res.status, 200);
  const after = row(id);
  assert.equal(after.source_type, "git");
  assert.equal(after.git_url, "https://github.com/ornek/stok");
  assert.equal(after.git_branch, "canli");
  assert.equal(after.env, before.env);
  assert.equal(after.port, 3000);
  assert.equal(after.webhook_token, before.webhook_token);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM domains WHERE app_id = ?").get(id) as { n: number }).n, 1);
});

test("kaynak değiştirme: git → imaj git bilgisini ve token'ı siler, önizlemeleri kapatır", async () => {
  const id = seed("git", { git_url: "https://github.com/ornek/x", git_token: encrypt("gizli"), previews_enabled: 1 });
  assert.equal((await put(id, { sourceType: "image", image: "nginx:1.27" })).status, 200);
  const r = row(id);
  assert.equal(r.source_type, "image");
  assert.equal(r.image, "nginx:1.27");
  assert.equal(r.git_url, null);
  assert.equal(r.git_token, null);
  assert.equal(r.previews_enabled, 0);
});

test("kaynak değiştirme: geçersiz istekler reddedilir, kayıt değişmez", async () => {
  const compose = seed("compose");
  assert.equal((await put(compose, { sourceType: "git", gitUrl: "https://github.com/a/b" })).status, 400);
  const up = seed("upload");
  assert.equal((await put(up, { sourceType: "git", gitUrl: "http://github.com/a/b" })).status, 400); // https zorunlu
  assert.equal((await put(up, { sourceType: "git" })).status, 400);
  assert.equal((await put(up, { sourceType: "image" })).status, 400);
  const git = seed("git", { git_url: "https://github.com/a/b" });
  assert.equal((await put(git, { sourceType: "upload" })).status, 400); // dosya yok
  const busy = seed("upload", { status: "deploying" });
  assert.equal((await put(busy, { sourceType: "git", gitUrl: "https://github.com/a/b" })).status, 409);
  assert.deepEqual([compose, up, git, busy].map((id) => row(id).source_type), ["compose", "upload", "git", "upload"]);
  // Açık PR önizlemesi olan uygulama git'ten ayrılamaz.
  const parent = seed("git", { git_url: "https://github.com/a/b" });
  seed("git", { parent_app_id: parent, preview_pr: 3 });
  assert.equal((await put(parent, { sourceType: "image", image: "nginx" })).status, 400);
  assert.equal(row(parent).source_type, "git");
});

test("git token: repo adresi değişince saklı token silinir, aynı repoda korunur, yeni token kullanılır", async () => {
  const id = seed("git", { git_url: "https://github.com/ornek/ozel", git_token: encrypt("yonetici-tokeni") });
  const token = () => decrypt(row(id).git_token as string | null);
  // Aynı repo (sonda .git ya da /) ve yalnız dal değişikliği token'a dokunmaz.
  assert.equal((await patch(id, { gitUrl: "https://github.com/ornek/ozel.git", gitBranch: "canli" })).status, 200);
  assert.equal(token(), "yonetici-tokeni");
  // Başka bir repo/host: token yeni adrese gitmesin diye silinir.
  assert.equal((await patch(id, { gitUrl: "https://saldirgan.example.com/ornek/ozel" })).status, 200);
  assert.equal(row(id).git_token, null);
  // Yeni adresle birlikte yeni token verilirse o saklanır.
  assert.equal((await patch(id, { gitUrl: "https://github.com/ornek/diger", gitToken: "yeni-token" })).status, 200);
  assert.equal(token(), "yeni-token");
});

test("git token: kaynak değiştirme ve kopyalama saklı token'ı başka repoya taşımaz", async () => {
  const id = seed("git", { git_url: "https://github.com/ornek/ozel", git_token: encrypt("yonetici-tokeni") });
  assert.equal((await put(id, { sourceType: "git", gitUrl: "https://github.com/ornek/ozel/", gitBranch: "main" })).status, 200);
  assert.equal(decrypt(row(id).git_token as string), "yonetici-tokeni");
  assert.equal((await put(id, { sourceType: "git", gitUrl: "https://saldirgan.example.com/x/y" })).status, 200);
  assert.equal(row(id).git_token, null);
  assert.equal((await put(id, { sourceType: "git", gitUrl: "https://github.com/ornek/z", gitToken: "yeni" })).status, 200);
  assert.equal(decrypt(row(id).git_token as string), "yeni");

  // Kopya aynı repoyu ve token'ı alır; kopyanın adresi değişince token orada da silinir.
  const res = await send("POST", `/api/apps/${id}/clone`, { name: "Kopya" });
  assert.equal(res.status, 201, await res.clone().text());
  const copy = ((await res.json()) as { app: { id: number } }).app.id;
  assert.equal(row(copy).git_url, "https://github.com/ornek/z");
  assert.equal(decrypt(row(copy).git_token as string), "yeni");
  assert.equal((await patch(copy, { gitUrl: "https://saldirgan.example.com/x/y" })).status, 200);
  assert.equal(row(copy).git_token, null);
  assert.equal(decrypt(row(id).git_token as string), "yeni");
});
