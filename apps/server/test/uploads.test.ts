import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Hono } from "hono";
import { db } from "../src/db.js";
import { HttpError } from "../src/lib/http.js";
import { resourceLimits, DEFAULT_PIDS_LIMIT } from "../src/lib/limits.js";
import type { AppEnv } from "../src/lib/types.js";
import { uploadRoutes } from "../src/routes/apps.js";
import { canUpload } from "../src/services/access.js";
import { beginUpload, UploadLimitError, UPLOADS_PER_HOUR, unzipWithLimit } from "../src/services/uploads.js";

function users() {
  const now = Date.now();
  const tag = Math.random().toString(36).slice(2, 8);
  const u = (n: string, role: string) => Number(db.prepare("INSERT INTO users (email, name, password_hash, role, created_at) VALUES (?, ?, 'x', ?, ?)").run(`${n}-${tag}@t`, n, role, now).lastInsertRowid);
  const admin = u("admin", "admin");
  const dev = u("dev", "member");
  const viewer = u("viewer", "member");
  const stranger = u("stranger", "member");
  const pid = Number(db.prepare("INSERT INTO projects (name, description, created_at) VALUES (?, '', ?)").run(`p-${tag}`, now).lastInsertRowid);
  db.prepare("INSERT INTO project_members (project_id, user_id, role, created_at) VALUES (?, ?, 'developer', ?), (?, ?, 'viewer', ?)").run(pid, dev, now, pid, viewer, now);
  return { admin, dev, viewer, stranger };
}
const su = (id: number, role: "admin" | "member") => ({ id, email: "", name: "", role, mustChangePassword: false });

test("yükleme yetkisi: yönetici ve en az bir projede developer olan üye (O9)", () => {
  const s = users();
  assert.equal(canUpload(su(s.admin, "admin")), true);
  assert.equal(canUpload(su(s.dev, "member")), true);
  assert.equal(canUpload(su(s.viewer, "member")), false);
  assert.equal(canUpload(su(s.stranger, "member")), false);
});

test("POST /api/uploads: projesiz/izleyici üye 403, yetkili üye yuvayı sızdırmadan çalışır", async () => {
  const s = users();
  const h = new Hono<AppEnv>();
  let current = su(s.dev, "member");
  h.use("*", async (c, next) => { c.set("user", current); await next(); });
  h.route("/api/uploads", uploadRoutes);
  h.onError((e, c) => (e instanceof HttpError ? c.json({ error: e.message }, e.status) : c.json({ error: "x" }, 500)));
  const post = () => h.request("/api/uploads", { method: "POST", body: "bu zip degil" });
  current = su(s.stranger, "member");
  assert.equal((await post()).status, 403);
  current = su(s.viewer, "member");
  assert.equal((await post()).status, 403);
  current = su(s.dev, "member");
  // Geçersiz arşiv: 400; ardından yuva serbest kalmalı (art arda istekler 429 olmamalı).
  for (let i = 0; i < 3; i++) assert.equal((await post()).status, 400);
});

test("yükleme kotası: aynı anda tek yükleme ve saatte en fazla N yükleme", () => {
  const id = 900_000 + Math.floor(Math.random() * 1000);
  const t0 = Date.now();
  const a = beginUpload(id, t0);
  assert.throws(() => beginUpload(id, t0), UploadLimitError); // eşzamanlı ikinci yükleme
  a.finish(10, t0);
  for (let i = 1; i < UPLOADS_PER_HOUR; i++) beginUpload(id, t0).finish(10, t0);
  assert.throws(() => beginUpload(id, t0 + 1000), /Saatte en fazla/);
  // Bir saat sonra pencere kayar.
  const later = beginUpload(id, t0 + 3_600_001);
  later.finish(0, t0 + 3_600_001);
});

test("yükleme kotası: saatlik bayt sınırı aşılınca reddedilir", () => {
  const id = 910_000 + Math.floor(Math.random() * 1000);
  const t0 = Date.now();
  const a = beginUpload(id, t0);
  a.finish(1024 ** 3, t0);
  assert.throws(() => beginUpload(id, t0 + 1), UploadLimitError);
});

test("zip açma: beyan edilenden bağımsız, gerçek yazılan toplam sınırlanır", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xb-zip-"));
  try {
    fs.writeFileSync(path.join(dir, "buyuk.bin"), Buffer.alloc(3 * 1024 * 1024, 1));
    const zip = path.join(dir, "a.zip");
    execFileSync("zip", ["-q", "-j", zip, path.join(dir, "buyuk.bin")]);
    const ok = path.join(dir, "ok");
    await unzipWithLimit(zip, ok, 10 * 1024 * 1024, 20);
    assert.ok(fs.existsSync(path.join(ok, "buyuk.bin")));
    const out = path.join(dir, "out");
    await assert.rejects(unzipWithLimit(zip, out, 1024 * 1024, 20), /sınırı aşıldı/);
    assert.equal(fs.existsSync(out), false, "yarım klasör silinmeli");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("konteyner sınırları: PidsLimit her zaman, bellek yalnız ayarlıysa", () => {
  assert.deepEqual(resourceLimits({ memory_limit: null, cpu_limit: null }), { PidsLimit: DEFAULT_PIDS_LIMIT });
  assert.equal(DEFAULT_PIDS_LIMIT, 512);
  assert.deepEqual(resourceLimits({ memory_limit: 256, cpu_limit: 0.5 }), { PidsLimit: 512, Memory: 268435456, MemorySwap: 268435456, NanoCpus: 500000000 });
  assert.deepEqual(resourceLimits({ memory_limit: 256, cpu_limit: null }, { swap: false }), { PidsLimit: 512, Memory: 268435456 });
});
