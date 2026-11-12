import assert from "node:assert/strict";
import { Duplex } from "node:stream";
import { test } from "node:test";
import { Hono } from "hono";
import { createApiToken } from "../src/auth/api-tokens.js";
import { enforceRoles, requireAuth } from "../src/auth/middleware.js";
import { createSession } from "../src/auth/session.js";
import { db } from "../src/db.js";
import { errorResponse } from "../src/lib/http.js";
import type { AppEnv } from "../src/lib/types.js";
import { makeTerminalRoutes } from "../src/routes/terminal.js";
import { projectAccess } from "../src/services/access.js";
import { auditTrail } from "../src/services/audit.js";
import { DEFAULT_LIMITS, encodeChunk, killScript, splitChunk, TerminalManager, type ExecHandle, type TerminalBackend, type TerminalLimits } from "../src/services/terminal.js";

/** Sahte TTY akışı: yazılan girdi `written`'a düşer, `out()` ile çıktı üretilir. */
class FakeTty extends Duplex {
  written: Buffer[] = [];
  _read() {}
  _write(chunk: Buffer, _enc: BufferEncoding, cb: () => void) {
    this.written.push(Buffer.from(chunk));
    cb();
  }
  out(b: Buffer | string) {
    this.push(typeof b === "string" ? Buffer.from(b) : b);
  }
  exit() {
    this.push(null);
  }
}

function fakeBackend(opts: { fail?: boolean; containers?: string[] } = {}) {
  const opened: { container: string; id: string; tty: FakeTty; kills: number; sizes: [number, number][] }[] = [];
  const backend: TerminalBackend = {
    async containers() {
      return (opts.containers ?? ["xb-demo", "xb-demo-r1"]).map((name) => ({ name, label: name }));
    },
    async open(_app, container, { id, cols, rows }) {
      if (opts.fail) throw new Error("docker yok");
      const rec = { container, id, tty: new FakeTty(), kills: 0, sizes: [[cols, rows]] as [number, number][] };
      opened.push(rec);
      const h: ExecHandle = {
        stream: rec.tty,
        resize: async (c, r) => void rec.sizes.push([c, r]),
        kill: async () => void rec.kills++,
      };
      return h;
    },
  };
  return { backend, opened };
}

function seed() {
  const now = Date.now();
  const tag = Math.random().toString(36).slice(2, 8);
  const u = (name: string, role: string) =>
    Number(db.prepare("INSERT INTO users (email, name, password_hash, role, created_at) VALUES (?, ?, 'x', ?, ?)").run(`${name}-${tag}@t`, name, role, now).lastInsertRowid);
  const admin = u("admin", "admin");
  const dev = u("dev", "member");
  const dev2 = u("dev2", "member");
  const viewer = u("viewer", "member");
  const stranger = u("stranger", "member");
  const pid = Number(db.prepare("INSERT INTO projects (name, description, created_at) VALUES (?, '', ?)").run(`tp-${tag}`, now).lastInsertRowid);
  const server =
    (db.prepare("SELECT id FROM servers LIMIT 1").get() as { id: number } | undefined)?.id ??
    Number(db.prepare("INSERT INTO servers (name, kind, status, created_at) VALUES ('local', 'local', 'ready', ?)").run(now).lastInsertRowid);
  const app = (slug: string) =>
    Number(
      db
        .prepare("INSERT INTO apps (project_id, server_id, name, slug, source_type, webhook_token, container, created_at) VALUES (?, ?, ?, ?, 'image', ?, ?, ?)")
        .run(pid, server, slug, `${slug}-${tag}`, `w-${slug}-${tag}`, `xb-${slug}-${tag}`, now).lastInsertRowid,
    );
  const a1 = app("t1");
  const a2 = app("t2");
  const m = db.prepare("INSERT INTO project_members (project_id, user_id, role, created_at) VALUES (?, ?, ?, ?)");
  m.run(pid, dev, "developer", now);
  m.run(pid, dev2, "developer", now);
  m.run(pid, viewer, "viewer", now);
  return { admin, dev, dev2, viewer, stranger, a1, a2 };
}

function harness(limits: Partial<TerminalLimits> = {}, backendOpts: Parameters<typeof fakeBackend>[0] = {}) {
  const { backend, opened } = fakeBackend(backendOpts);
  const mgr = new TerminalManager(backend, { ...DEFAULT_LIMITS, ...limits });
  const h = new Hono<AppEnv>();
  h.use("/api/*", requireAuth, enforceRoles, projectAccess, auditTrail);
  h.route("/api/apps", makeTerminalRoutes(mgr));
  h.onError(errorResponse);
  // İşlem kaydı istemci IP'sini bağlantıdan okur; testte sahte bir bağlantı verilir.
  const env = { incoming: { socket: { remoteAddress: "127.0.0.1", remotePort: 1, remoteFamily: "IPv4" } } };
  const request = h.request.bind(h);
  h.request = ((input: string, init?: RequestInit) => request(input, init, env)) as typeof h.request;
  return { h, mgr, opened };
}

const cookie = (userId: number) => ({ Cookie: `xudbin_session=${createSession(userId, {}).token}` });
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const json = (headers: Record<string, string>, data: unknown = {}) => ({
  method: "POST",
  headers: { ...headers, "content-type": "application/json" },
  body: JSON.stringify(data),
});
const open = (h: Hono<AppEnv>, headers: Record<string, string>, appId: number, extra: Record<string, unknown> = {}) =>
  h.request(`/api/apps/${appId}/terminal`, json(headers, { cols: 80, rows: 24, ...extra }));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** SSE gövdesinden olayları okur; `until` doğru dönünce durur. */
async function readEvents(res: Response, until: (evs: { event: string; data: string }[]) => boolean, timeoutMs = 2000) {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let text = "";
  const evs: { event: string; data: string }[] = [];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !until(evs)) {
    const r = await Promise.race([reader.read(), sleep(deadline - Date.now()).then(() => null)]);
    if (!r || r.done) break;
    text += dec.decode(r.value, { stream: true });
    let i: number;
    while ((i = text.indexOf("\n\n")) >= 0) {
      const block = text.slice(0, i);
      text = text.slice(i + 2);
      const ev = { event: "message", data: "" };
      for (const line of block.split("\n")) {
        if (line.startsWith("event: ")) ev.event = line.slice(7);
        if (line.startsWith("data: ")) ev.data += line.slice(6);
      }
      evs.push(ev);
    }
  }
  return { evs, cancel: () => reader.cancel().catch(() => {}) };
}

test("terminal: yönetici ve geliştirici açar; izleyici, yabancı ve her türlü API anahtarı açamaz", async () => {
  const s = seed();
  const { h, mgr } = harness();
  assert.equal((await open(h, cookie(s.dev), s.a1)).status, 201);
  assert.equal((await open(h, cookie(s.admin), s.a1)).status, 201);
  // İzleyici: POST zaten proje katmanında, GET uçları (liste, akış) terminal kuralıyla reddedilir.
  assert.equal((await open(h, cookie(s.viewer), s.a1)).status, 403);
  const vList = await h.request(`/api/apps/${s.a1}/terminal`, { headers: cookie(s.viewer) });
  assert.equal(vList.status, 403);
  assert.match(((await vList.json()) as { error: string }).error, /geliştirici/);
  assert.equal((await h.request(`/api/apps/${s.a1}/terminal/${"x".repeat(32)}/stream`, { headers: cookie(s.viewer) })).status, 403);
  // Yabancı: kaynak "yok" görünür.
  assert.equal((await open(h, cookie(s.stranger), s.a1)).status, 404);
  assert.equal((await h.request(`/api/apps/${s.a1}/terminal`, { headers: cookie(s.stranger) })).status, 404);
  // API anahtarı: yazma yetkili de olsa, sahibi yönetici de olsa reddedilir.
  for (const token of [createApiToken(s.dev, "rw").token, createApiToken(s.admin, "admin-rw").token]) {
    const r = await open(h, bearer(token), s.a1);
    assert.equal(r.status, 403);
    assert.match(((await r.json()) as { error: string }).error, /API anahtarıyla açılamaz/);
    assert.equal((await h.request(`/api/apps/${s.a1}/terminal`, { headers: bearer(token) })).status, 403);
  }
  const ro = createApiToken(s.admin, "ro", { readOnly: true }).token;
  assert.equal((await h.request(`/api/apps/${s.a1}/terminal`, { headers: bearer(ro) })).status, 403);
  assert.equal((await open(h, bearer(ro), s.a1)).status, 403);
  assert.equal(mgr.size, 2);
  await mgr.closeAll();
});

test("terminal: sunucu erişimi açık uygulamada yalnız yönetici açar; açık oturum da kullanılamaz", async () => {
  const s = seed();
  const { h, mgr } = harness();
  // Onaydan önce geliştiricinin açtığı oturum.
  const before = (await (await open(h, cookie(s.dev), s.a1)).json()) as { sessionId: string };
  db.prepare("UPDATE apps SET host_access = 1 WHERE id = ?").run(s.a1);
  const r = await open(h, cookie(s.dev), s.a1);
  assert.equal(r.status, 403);
  assert.match(((await r.json()) as { error: string }).error, /sunucu erişimi açık/);
  assert.equal((await h.request(`/api/apps/${s.a1}/terminal`, { headers: cookie(s.dev) })).status, 403);
  const input = await h.request(`/api/apps/${s.a1}/terminal/${before.sessionId}/input`, json(cookie(s.dev), { data: Buffer.from("id\n").toString("base64") }));
  assert.equal(input.status, 403);
  assert.equal((await h.request(`/api/apps/${s.a1}/terminal/${before.sessionId}/stream`, { headers: cookie(s.dev) })).status, 403);
  // Yönetici açabilir; erişimi kapalı diğer uygulamada geliştirici açmaya devam eder.
  assert.equal((await open(h, cookie(s.admin), s.a1)).status, 201);
  assert.equal((await open(h, cookie(s.dev), s.a2)).status, 201);
  await mgr.closeAll();
});

test("terminal: başkasının oturum kimliği ve başka uygulamanın yolu kullanılamaz", async () => {
  const s = seed();
  const { h, mgr, opened } = harness();
  const { sessionId } = (await (await open(h, cookie(s.dev), s.a1)).json()) as { sessionId: string };
  assert.ok(sessionId.length >= 32);
  const input = { data: Buffer.from("id\n").toString("base64") };
  // Aynı projenin başka geliştiricisi ve yönetici bile başkasının oturumuna bağlanamaz.
  for (const other of [s.dev2, s.admin]) {
    assert.equal((await h.request(`/api/apps/${s.a1}/terminal/${sessionId}/stream`, { headers: cookie(other) })).status, 404);
    assert.equal((await h.request(`/api/apps/${s.a1}/terminal/${sessionId}/input`, json(cookie(other), input))).status, 404);
    assert.equal((await h.request(`/api/apps/${s.a1}/terminal/${sessionId}/close`, json(cookie(other)))).status, 404);
  }
  // Sahibi ama başka uygulamanın yolundan: yok.
  assert.equal((await h.request(`/api/apps/${s.a2}/terminal/${sessionId}/input`, json(cookie(s.dev), input))).status, 404);
  assert.equal(opened[0]!.tty.written.length, 0);
  // Sahibi doğru yoldan yazar.
  assert.equal((await h.request(`/api/apps/${s.a1}/terminal/${sessionId}/input`, json(cookie(s.dev), input))).status, 200);
  assert.equal(Buffer.concat(opened[0]!.tty.written).toString(), "id\n");
  assert.equal((await h.request(`/api/apps/${s.a1}/terminal/${sessionId}/input`, json(cookie(s.dev), { data: "!!" }))).status, 400);
  // Sonradan izleyiciye düşürülen geliştirici artık yazamaz.
  db.prepare("UPDATE project_members SET role = 'viewer' WHERE user_id = ?").run(s.dev);
  assert.equal((await h.request(`/api/apps/${s.a1}/terminal/${sessionId}/input`, json(cookie(s.dev), input))).status, 403);
  await mgr.closeAll();
});

test("terminal: konteyner yalnız uygulamanın listesinden seçilir; hata olursa oturum sızmaz", async () => {
  const s = seed();
  const { h, mgr, opened } = harness();
  const list = (await (await h.request(`/api/apps/${s.a1}/terminal`, { headers: cookie(s.dev) })).json()) as { containers: { name: string }[] };
  assert.deepEqual(list.containers.map((c) => c.name), ["xb-demo", "xb-demo-r1"]);
  assert.equal((await open(h, cookie(s.dev), s.a1, { container: "caddy" })).status, 404);
  const r = (await (await open(h, cookie(s.dev), s.a1, { container: "xb-demo-r1" })).json()) as { container: string };
  assert.equal(r.container, "xb-demo-r1");
  assert.equal(opened[0]!.container, "xb-demo-r1");
  assert.equal(mgr.size, 1);
  await mgr.closeAll();

  const failing = harness({}, { fail: true });
  assert.equal((await open(failing.h, cookie(s.dev), s.a1)).status, 500);
  assert.equal(failing.mgr.size, 0);
  const empty = harness({}, { containers: [] });
  const e = await open(empty.h, cookie(s.dev), s.a1);
  assert.equal(e.status, 409);
  assert.equal(empty.mgr.size, 0);
});

test("terminal: kullanıcı başına ve genel oturum sınırı", async () => {
  const s = seed();
  const { h, mgr } = harness({ perUser: 2, global: 3 });
  assert.equal((await open(h, cookie(s.dev), s.a1)).status, 201);
  assert.equal((await open(h, cookie(s.dev), s.a2)).status, 201);
  assert.equal((await open(h, cookie(s.dev), s.a1)).status, 429);
  assert.equal((await open(h, cookie(s.dev2), s.a1)).status, 201);
  assert.equal((await open(h, cookie(s.admin), s.a1)).status, 503);
  assert.equal(mgr.size, 3);
  await mgr.closeAll();
  assert.equal(mgr.size, 0);
});

test("terminal: boşta kalma, en uzun süre, kopuk akış ve kabuk çıkışı oturumu bitirir ve süreci öldürür", async () => {
  const s = seed();
  const user = s.dev;
  const fakeApp = { id: s.a1 } as never;
  // Hiç bağlanılmazsa (akış yok) kısa süre sonra kapanır.
  {
    const { backend, opened } = fakeBackend();
    const mgr = new TerminalManager(backend, { ...DEFAULT_LIMITS, graceMs: 30 });
    await mgr.create(user, fakeApp, { cols: 80, rows: 24 });
    await sleep(80);
    assert.equal(mgr.size, 0);
    assert.equal(opened[0]!.kills, 1);
    assert.ok(opened[0]!.tty.destroyed);
  }
  // Girdi geldikçe boşta sayacı yenilenir, gelmezse kapanır.
  {
    const { backend, opened } = fakeBackend();
    const mgr = new TerminalManager(backend, { ...DEFAULT_LIMITS, idleMs: 60 });
    const ends: string[] = [];
    const { id } = await mgr.create(user, fakeApp, { cols: 80, rows: 24 });
    mgr.attach(user, s.a1, id, { output: async () => {}, end: (r) => ends.push(r) });
    await sleep(40);
    mgr.input(user, s.a1, id, Buffer.from("a"));
    await sleep(40);
    assert.equal(mgr.size, 1);
    await sleep(60);
    assert.equal(mgr.size, 0);
    assert.deepEqual(ends, ["idle"]);
    assert.equal(opened[0]!.kills, 1);
  }
  // En uzun ömür, girdi gelse bile.
  {
    const { backend, opened } = fakeBackend();
    const mgr = new TerminalManager(backend, { ...DEFAULT_LIMITS, maxMs: 60 });
    const { id } = await mgr.create(user, fakeApp, { cols: 80, rows: 24 });
    mgr.attach(user, s.a1, id, { output: async () => {}, end: () => {} });
    for (let i = 0; i < 4; i++) {
      await sleep(25);
      if (mgr.size) mgr.input(user, s.a1, id, Buffer.from("x"));
    }
    assert.equal(mgr.size, 0);
    assert.equal(opened[0]!.kills, 1);
  }
  // Kabuk çıkınca (akış biter) oturum kapanır; kill yine çağrılır (tek sefer).
  {
    const { backend, opened } = fakeBackend();
    const mgr = new TerminalManager(backend);
    const ends: string[] = [];
    const { id } = await mgr.create(user, fakeApp, { cols: 80, rows: 24 });
    mgr.attach(user, s.a1, id, { output: async () => {}, end: (r) => ends.push(r) });
    opened[0]!.tty.exit();
    opened[0]!.tty.resume();
    await sleep(20);
    assert.equal(mgr.size, 0);
    assert.deepEqual(ends, ["exit"]);
    assert.equal(opened[0]!.kills, 1);
    assert.throws(() => mgr.input(user, s.a1, id, Buffer.from("x")), /bulunamadı/);
  }
  // Akış kopar, süre içinde yeniden bağlanılırsa oturum sürer ve aradaki çıktı kaybolmaz.
  {
    const { backend, opened } = fakeBackend();
    const mgr = new TerminalManager(backend, { ...DEFAULT_LIMITS, graceMs: 60 });
    const { id } = await mgr.create(user, fakeApp, { cols: 80, rows: 24 });
    const detach = mgr.attach(user, s.a1, id, { output: async () => {}, end: () => {} });
    detach();
    opened[0]!.tty.out("arada");
    await sleep(30);
    const got: Buffer[] = [];
    mgr.attach(user, s.a1, id, { output: async (b) => void got.push(b), end: () => {} });
    await sleep(80);
    assert.equal(mgr.size, 1);
    assert.equal(Buffer.concat(got).toString(), "arada");
    await mgr.close(user, s.a1, id);
    assert.equal(opened[0]!.kills, 1);
  }
});

test("terminal: SSE akışı base64 olaylarla baytları bozmadan taşır; kapatma kaydedilir, tuşlar kaydedilmez", async () => {
  const s = seed();
  const { h, mgr, opened } = harness();
  const { sessionId } = (await (await open(h, cookie(s.dev), s.a1)).json()) as { sessionId: string };
  const tty = opened[0]!.tty;
  // Bağlanmadan önce gelen istem (prompt) de gönderilir.
  tty.out("$ ");
  const res = await h.request(`/api/apps/${s.a1}/terminal/${sessionId}/stream`, { headers: cookie(s.dev) });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
  // "ğ" (c4 9f) iki parçaya bölünür; kaçış dizileri, \r\n ve "data:" benzeri içerik olduğu gibi kalmalı.
  const tricky = Buffer.concat([Buffer.from("\x1b[31mkırmızı\x1b[0m\r\n\ndata: x\n\nevent: exit\r\n"), Buffer.from([0xc4])]);
  setTimeout(() => {
    tty.out(tricky);
    tty.out(Buffer.from([0x9f, 0x00, 0xff]));
  }, 10);
  const want = Buffer.concat([Buffer.from("$ "), tricky, Buffer.from([0x9f, 0x00, 0xff])]);
  const { evs, cancel } = await readEvents(res, (e) => Buffer.concat(e.filter((x) => x.event === "o").map((x) => Buffer.from(x.data, "base64"))).length >= want.length);
  const outs = evs.filter((e) => e.event === "o");
  assert.ok(outs.length >= 2);
  for (const e of outs) assert.match(e.data, /^[A-Za-z0-9+/]*={0,2}$/);
  assert.deepEqual(Buffer.concat(outs.map((e) => Buffer.from(e.data, "base64"))), want);
  // Aynı oturuma ikinci bağlantı öncekini "replaced" ile kapatır.
  const res2 = await h.request(`/api/apps/${s.a1}/terminal/${sessionId}/stream`, { headers: cookie(s.dev) });
  assert.equal(res2.status, 200);
  await cancel();

  const before = (db.prepare("SELECT COUNT(*) AS n FROM audit_log").get() as { n: number }).n;
  assert.equal((await h.request(`/api/apps/${s.a1}/terminal/${sessionId}/input`, json(cookie(s.dev), { data: Buffer.from("echo $SECRET\n").toString("base64") }))).status, 200);
  assert.equal((await h.request(`/api/apps/${s.a1}/terminal/${sessionId}/resize`, json(cookie(s.dev), { cols: 120, rows: 40 }))).status, 200);
  assert.deepEqual(opened[0]!.sizes.at(-1), [120, 40]);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM audit_log").get() as { n: number }).n, before);
  const ended = readEvents(res2, (e) => e.some((x) => x.event === "exit"));
  assert.equal((await h.request(`/api/apps/${s.a1}/terminal/${sessionId}/close`, json(cookie(s.dev)))).status, 200);
  const { evs: evs2 } = await ended;
  assert.equal(evs2.find((e) => e.event === "exit")?.data, "closed");
  assert.equal(opened[0]!.kills, 1);
  assert.equal(mgr.size, 0);
  // Kapalı oturuma bağlanmak: SSE değil 404 (tarayıcı yeniden denemeyi bırakır).
  assert.equal((await h.request(`/api/apps/${s.a1}/terminal/${sessionId}/stream`, { headers: cookie(s.dev) })).status, 404);

  const log = db.prepare("SELECT action, path FROM audit_log WHERE user_id = ? ORDER BY id").all(s.dev) as { action: string; path: string }[];
  assert.deepEqual(log.map((l) => l.action), ["Konteynerde terminal açtı", "Terminali kapattı"]);
  assert.ok(!log.some((l) => /input|resize/.test(l.path)));
});

test("terminal: parça kodlama ve süreç öldürme komutu", () => {
  const b = Buffer.from([0xe2, 0x82]);
  assert.equal(Buffer.from(encodeChunk(b), "base64").toString("hex"), "e282");
  assert.ok(!/[\r\n]/.test(encodeChunk(Buffer.from("a\nb\r\n"))));
  const big = Buffer.alloc(70_000, 1);
  const parts = splitChunk(big);
  assert.deepEqual(parts.map((p) => p.length), [32768, 32768, 4464]);
  assert.deepEqual(Buffer.concat(parts), big);
  const script = killScript("abc_DEF-123");
  assert.match(script, /XUDBIN_TERMINAL=abc_DEF-123/);
  assert.match(script, /kill -KILL/);
  assert.throws(() => killScript("a'; rm -rf /"), /Geçersiz/);
});
