import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import { db } from "../src/db.js";
import { HttpError } from "../src/lib/http.js";
import { cronMatches, nextRun, parseCron } from "../src/lib/cron.js";
import type { AppEnv } from "../src/lib/types.js";
import { appRoutes } from "../src/routes/apps.js";

const at = (iso: string) => Date.parse(iso);

test("cron ayrıştırma ve eşleşme", () => {
  const tz = "UTC";
  assert.ok(cronMatches(parseCron("*/15 * * * *"), at("2026-10-16T10:30:00Z"), tz));
  assert.ok(!cronMatches(parseCron("*/15 * * * *"), at("2026-10-16T10:31:00Z"), tz));
  assert.ok(cronMatches(parseCron("0 3 * * *"), at("2026-10-16T03:00:00Z"), tz));
  assert.ok(cronMatches(parseCron("0 9 * * 1-5"), at("2026-10-16T09:00:00Z"), tz)); // Cuma
  assert.ok(!cronMatches(parseCron("0 9 * * 1-5"), at("2026-10-17T09:00:00Z"), tz)); // Cumartesi
  assert.ok(cronMatches(parseCron("0 0 * * 7"), at("2026-10-18T00:00:00Z"), tz)); // Pazar = 7
  assert.ok(cronMatches(parseCron("@daily"), at("2026-10-16T00:00:00Z"), tz));
  assert.ok(cronMatches(parseCron("30 2 1,15 * *"), at("2026-10-15T02:30:00Z"), tz));
  assert.throws(() => parseCron("* * *"));
  assert.throws(() => parseCron("61 * * * *"));
  assert.throws(() => parseCron("*/0 * * * *"));
});

test("saat dilimi ve sonraki çalışma", () => {
  // İstanbul UTC+3: yerel 03:00 = 00:00 UTC
  assert.ok(cronMatches(parseCron("0 3 * * *"), at("2026-10-16T00:00:00Z"), "Europe/Istanbul"));
  assert.equal(nextRun("0 3 * * *", at("2026-10-16T00:00:00Z"), "UTC"), at("2026-10-16T03:00:00Z"));
  assert.equal(nextRun("*/5 * * * *", at("2026-10-16T10:02:30Z"), "UTC"), at("2026-10-16T10:05:00Z"));
});

test("nextRun: seyrek ifadeler olay döngüsünü kilitlemez ve 29 Şubat bulunur", () => {
  const from = Date.UTC(2026, 9, 27, 12, 0);
  const s = performance.now();
  assert.equal(nextRun("0 0 29 2 *", from, "UTC"), Date.UTC(2028, 1, 29, 0, 0));
  assert.equal(nextRun("0 3 1 1 *", from, "Europe/Istanbul"), Date.UTC(2027, 0, 1, 0, 0));
  assert.equal(nextRun("0 0 31 2 *", from, "UTC"), null); // hiç gelmeyen gün
  assert.ok(performance.now() - s < 500, "toplam hesap yarım saniyenin altında kalmalı");
});

test("nextRun: atlamalı arama, dakika dakika aramayla aynı sonucu verir (yaz saati geçişleri dahil)", () => {
  const brute = (expr: string, from: number, tz: string) => {
    const c = parseCron(expr);
    let t = Math.floor(from / 60_000) * 60_000 + 60_000;
    for (let i = 0; i < 60 * 24 * 60; i++, t += 60_000) if (cronMatches(c, t, tz)) return t;
    return null;
  };
  const exprs = ["30 2 * * *", "0 0 * * *", "59 23 * * *", "15 1,3 * * 0", "0 0 1 * *", "*/20 */7 * * *", "0 12 15 * 1", "45 2 * * 0"];
  const zones = ["UTC", "Europe/Istanbul", "Europe/Berlin", "America/New_York", "Asia/Kolkata", "Australia/Lord_Howe"];
  // Yaz saati geçişlerinin hemen öncesi + rastgele anlar.
  const starts = [Date.UTC(2026, 2, 28, 22, 37), Date.UTC(2026, 2, 7, 23, 59), Date.UTC(2026, 9, 24, 22, 10), Date.UTC(2026, 10, 1, 4, 30), Date.UTC(2026, 3, 4, 14, 0)];
  let seed = 7;
  for (let i = 0; i < 5; i++) starts.push(Date.UTC(2026, 0, 1) + ((seed = (seed * 48271) % 2147483647) % (365 * 24 * 60)) * 60_000);
  for (const e of exprs) for (const tz of zones) for (const f of starts) assert.equal(nextRun(e, f, tz), brute(e, f, tz), `${e} ${tz} ${new Date(f).toISOString()}`);
});

test("zamanlanmış görev: sunucu erişimi açık uygulamada ekleme, düzenleme ve çalıştırma yalnız yöneticiye", async () => {
  const now = Date.now();
  const tag = Math.random().toString(36).slice(2, 8);
  const user = (role: string) => Number(db.prepare("INSERT INTO users (email, name, password_hash, role, created_at) VALUES (?, 'u', 'x', ?, ?)").run(`cron-${role}-${tag}@t`, role, now).lastInsertRowid);
  const server =
    (db.prepare("SELECT id FROM servers LIMIT 1").get() as { id: number } | undefined)?.id ??
    Number(db.prepare("INSERT INTO servers (name, kind, status, created_at) VALUES ('local', 'local', 'pending', ?)").run(now).lastInsertRowid);
  const project = Number(db.prepare("INSERT INTO projects (name, description, created_at) VALUES (?, '', ?)").run(`cp-${tag}`, now).lastInsertRowid);
  const app = (hostAccess: number) =>
    Number(db.prepare("INSERT INTO apps (project_id, server_id, name, slug, source_type, webhook_token, host_access, created_at) VALUES (?, ?, 'a', ?, 'image', ?, ?, ?)")
      .run(project, server, `c-${hostAccess}-${tag}`, `cw-${hostAccess}-${tag}`, hostAccess, now).lastInsertRowid);
  const api = (id: number, role: "admin" | "member") => {
    const h = new Hono<AppEnv>();
    h.use("*", async (c, next) => { c.set("user", { id, email: "t@t", name: "t", role, mustChangePassword: false } as AppEnv["Variables"]["user"]); await next(); });
    h.route("/apps", appRoutes);
    h.onError((err, c) => c.json({ error: err.message }, err instanceof HttpError ? err.status : 500));
    return h;
  };
  const req = (h: Hono<AppEnv>, method: string, url: string, body?: unknown) =>
    h.request(url, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const dev = api(user("member"), "member");
  const admin = api(user("admin"), "admin");
  const job = { name: "kabuk", schedule: "0 3 * * *", command: "chroot /host sh" };

  const locked = app(1);
  const created = await req(admin, "POST", `/apps/${locked}/cron`, job);
  assert.equal(created.status, 201);
  const jobId = ((await created.json()) as { id: number }).id;
  for (const [method, url] of [["POST", `/apps/${locked}/cron`], ["PUT", `/apps/${locked}/cron/${jobId}`], ["POST", `/apps/${locked}/cron/${jobId}/run`]] as const) {
    const r = await req(dev, method, url, job);
    assert.equal(r.status, 403, `${method} ${url}`);
    assert.match(((await r.json()) as { error: string }).error, /sunucu erişimi açık/);
  }
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM cron_jobs WHERE app_id = ?").get(locked) as { n: number }).n, 1);
  // Listeleme açık; yönetici düzenleyebilir. Erişimi kapalı uygulamada geliştirici görev ekler.
  assert.equal((await req(dev, "GET", `/apps/${locked}/cron`)).status, 200);
  assert.equal((await req(admin, "PUT", `/apps/${locked}/cron/${jobId}`, job)).status, 200);
  assert.equal((await req(dev, "POST", `/apps/${app(0)}/cron`, job)).status, 201);
});
