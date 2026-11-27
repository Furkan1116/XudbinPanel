import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import { RegExpRouter } from "hono/router/reg-exp-router";
import { createApp } from "../src/app.js";
import { SESSION_COOKIE } from "../src/auth/middleware.js";
import { createSession } from "../src/auth/session.js";
import { db } from "../src/db.js";
import { normalizeAllowList, panelIpAllowed, selfLockoutError } from "../src/lib/panel-access.js";
import { getSettings, updateSettings } from "../src/lib/settings.js";
import { buildCaddyConfig } from "../src/services/caddy.js";
import type { ServerRow } from "../src/services/docker.js";

const env = (ip: string) => ({ incoming: { socket: { remoteAddress: ip } } });

function fakeServer(over: Partial<ServerRow> = {}): ServerRow {
  return { id: 987101, name: "t", kind: "local", host: null, port: 22, username: "root", ssh_key_id: null, host_key: null, apps_domain: null, tunnel_token: null, relay_ca: null, public_ip: "203.0.113.24", https_mode: "auto", acme_email: null, status: "ready", status_detail: null, setup_log: "", log_offset: 0, log_inode: null, created_at: 0, ...over };
}

function adminCookie() {
  const tag = Math.random().toString(36).slice(2, 8);
  const id = Number(db.prepare("INSERT INTO users (email, name, password_hash, role, created_at) VALUES (?, 'A', 'x', 'admin', ?)").run(`pa-${tag}@t`, Date.now()).lastInsertRowid);
  return { id, cookie: `${SESSION_COOKIE}=${createSession(id, {}).token}` };
}

/** Panel sunucusu "ready" ise kayıt Caddy'yi (Docker) uygulamaya çalışır; testte bu adım atlanır. */
function withoutReadyLocal<T>(fn: () => Promise<T>) {
  const ready = db.prepare("SELECT id FROM servers WHERE kind = 'local' AND status = 'ready'").all() as { id: number }[];
  for (const r of ready) db.prepare("UPDATE servers SET status = 'setup' WHERE id = ?").run(r.id);
  return fn().finally(() => {
    for (const r of ready) db.prepare("UPDATE servers SET status = 'ready' WHERE id = ?").run(r.id);
  });
}

type Route = { match?: Record<string, unknown>[]; handle?: { handler: string; routes?: Route[] }[] };

/** Panel rotalarının (alan adı ve IP girişi) alt rotaları. */
function panelSubroutes(cfg: ReturnType<typeof buildCaddyConfig>, server: string, host?: string): Route[] {
  const routes = (cfg.apps.http.servers as Record<string, { routes: Route[] }>)[server]!.routes;
  const r = host ? routes.find((x) => (x.match?.[0]?.host as string[] | undefined)?.[0] === host) : routes[0];
  return r!.handle![0]!.routes!;
}

test("GHSA-h7mg-cq63-vhpq: kodlanmış satır sonu ve benzeri yollar oturumsuz 401 alır", async () => {
  const app = createApp();
  for (const p of ["/api/users", "/api/users%0A", "/api/users%0D", "/api/users%0D%0A", "/api/users/%0A", "/api/%75sers", "/api/settings%0A", "/api/servers%0A", "/api/security%0A/blocked"]) {
    const res = await app.request(p, {}, env("198.51.100.1"));
    assert.equal(res.status, 401, `${p} oturumsuz ${res.status} döndü`);
  }
});

// Panelin ana uygulaması bugün SmartRouter üzerinden TrieRouter'a düşüyor (açık orada tetiklenmiyor); rotalar değişip
// RegExpRouter seçilirse de giriş kontrolü atlanmasın diye aynı zincir RegExpRouter ile ayrıca denenir.
test("GHSA-h7mg-cq63-vhpq: RegExpRouter'da /api/* giriş kontrolü kodlanmış satır sonunda da çalışır", async () => {
  const app = new Hono({ router: new RegExpRouter() });
  app.use("/api/*", async (c, next) => (c.req.header("x-auth") ? next() : c.json({ error: "Oturum açmanız gerekiyor" }, 401)));
  app.get("/api/users", (c) => c.text("liste"));
  app.get("/api/users/:id", (c) => c.text("kullanıcı"));
  app.get("/api/settings/*", (c) => c.text("ayar"));
  app.use("/admin/*", async (c, next) => (c.req.header("x-auth") ? next() : c.text("kapalı", 401)));
  app.get("/admin*", (c) => c.text("yönetim"));
  for (const p of ["/api/users", "/api/users%0A", "/api/users%0D", "/api/users%E2%80%A8", "/api/users%E2%80%A9", "/api/settings/%0A", "/api/users/%0A", "/admin/x"]) {
    assert.equal((await app.request(p)).status, 401, `${p} giriş kontrolünü atladı`);
  }
});

test("panel izin listesi: boşken Caddy'de kural yok (bugünkü davranış)", () => {
  updateSettings({ panelDomain: "panel.test", panelHttps: true, panelAllowIps: [] });
  const cfg = buildCaddyConfig(fakeServer());
  assert.ok(!JSON.stringify(cfg).includes("panel-allowlist"));
  updateSettings({ panelDomain: "" });
});

test("panel izin listesi: alan adı ve IP:8443 rotaları listede olmayana 403 verir, webhook'lar hariç", () => {
  updateSettings({ panelDomain: "panel.test", panelHttps: true, panelIpAccess: true, panelAllowIps: ["203.0.113.7", "10.8.0.0/24"] });
  for (const tunnel of [null, "tok"]) {
    const cfg = buildCaddyConfig(fakeServer({ tunnel_token: tunnel }));
    const domainRoutes = panelSubroutes(cfg, "https", "panel.test");
    const ipRoutes = panelSubroutes(cfg, "panel_ip");
    for (const routes of [domainRoutes, ipRoutes]) {
      const allow = routes.find((r) => JSON.stringify(r).includes("panel-allowlist"));
      assert.ok(allow, "izin listesi rotası olmalı");
      assert.deepEqual(allow.match, [{ not: [{ client_ip: { ranges: ["203.0.113.7", "10.8.0.0/24"] } }, { path: ["/api/webhooks/*"] }] }]);
      // İzin listesi ters vekilden önce gelmeli.
      const proxyAt = routes.findIndex((r) => JSON.stringify(r).includes("reverse_proxy"));
      assert.ok(routes.indexOf(allow) < proxyAt);
    }
    // Cloudflare Tunnel: client_ip gerçek ziyaretçi IP'si olsun diye güvenilir vekil ayarı her iki sunucuda da var.
    const servers = cfg.apps.http.servers as Record<string, Record<string, unknown>>;
    assert.equal("trusted_proxies" in servers.https!, tunnel !== null);
    assert.equal("trusted_proxies" in servers.panel_ip!, tunnel !== null);
  }
  updateSettings({ panelDomain: "", panelAllowIps: [] });
});

test("panel izin listesi: kendini kilitleme koruması ve normalleştirme", () => {
  assert.deepEqual(normalizeAllowList([" 203.0.113.7 ", "", "10.8.0.0/024", "203.0.113.7", "2001:DB8::/32"]), ["203.0.113.7", "10.8.0.0/24", "2001:db8::/32"]);
  assert.equal(selfLockoutError([], "198.51.100.1"), null);
  assert.equal(selfLockoutError(["10.8.0.0/24"], "10.8.0.9"), null);
  assert.equal(selfLockoutError(["10.8.0.0/24"], "::ffff:10.8.0.9"), null);
  assert.match(selfLockoutError(["10.8.0.0/24"], "198.51.100.1") ?? "", /198\.51\.100\.1.*listede yok/);
  assert.ok(selfLockoutError(["10.8.0.0/24"], "unknown"));
  assert.equal(panelIpAllowed("unknown", ["0.0.0.0/0"]), false);
});

test("panel izin listesi: kaydeden kendi IP'si listede değilse reddedilir, kaydedince işlem kaydına yazılır", async () => {
  const app = createApp();
  const { id, cookie } = adminCookie();
  const put = (allowIps: string[], ip: string) =>
    app.request("/api/settings/panel-access", { method: "PUT", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ allowIps }) }, env(ip));
  await withoutReadyLocal(async () => {
    updateSettings({ panelAllowIps: [] });
    const locked = await put(["203.0.113.0/24"], "198.51.100.1");
    assert.equal(locked.status, 422);
    assert.match(((await locked.json()) as { error: string }).error, /198\.51\.100\.1/);
    assert.deepEqual(getSettings().panelAllowIps, []);

    const bad = await put(["198.51.100.1", "bir-şey"], "198.51.100.1");
    assert.equal(bad.status, 422);

    const ok = await put(["198.51.100.0/24", "203.0.113.7"], "198.51.100.1");
    assert.equal(ok.status, 200);
    assert.deepEqual(getSettings().panelAllowIps, ["198.51.100.0/24", "203.0.113.7"]);
    const row = db.prepare("SELECT action, ip FROM audit_log WHERE user_id = ? ORDER BY id DESC LIMIT 1").get(id) as { action: string; ip: string };
    assert.match(row.action, /Panel IP izin listesini değiştirdi: 198\.51\.100\.0\/24, 203\.0\.113\.7/);
    assert.equal(row.ip, "198.51.100.1");

    // Liste doluyken listede olmayan adres panele hiç ulaşamaz; webhook yolu ve konteyner içi sağlık kontrolü hariç.
    assert.equal((await app.request("/api/auth/status", {}, env("192.0.2.50"))).status, 403);
    assert.equal((await app.request("/", {}, env("192.0.2.50"))).status, 403);
    assert.notEqual((await app.request("/api/webhooks/deploy/yok", { method: "POST" }, env("192.0.2.50"))).status, 403);
    assert.equal((await app.request("/api/auth/status", {}, env("127.0.0.1"))).status, 200);
    assert.equal((await app.request("/api/auth/status", {}, env("198.51.100.77"))).status, 200);

    // Listeyi boşaltmak her zaman serbest (kilitlenme riski yok).
    const clear = await put([], "198.51.100.1");
    assert.equal(clear.status, 200);
    assert.deepEqual(getSettings().panelAllowIps, []);
    const cleared = db.prepare("SELECT action FROM audit_log WHERE user_id = ? ORDER BY id DESC LIMIT 1").get(id) as { action: string };
    assert.match(cleared.action, /kaldırdı/);
    assert.equal((await app.request("/api/auth/status", {}, env("192.0.2.50"))).status, 200);
  });
});

test("configuredPanelUrl: install.sh güncellemede panelin kayıtlı adresini yoklar", async () => {
  const { configuredPanelUrl } = await import("../src/lib/settings.js");
  assert.equal(configuredPanelUrl({ panelDomain: "", panelHttps: true }), null);
  assert.equal(configuredPanelUrl({ panelDomain: "  ", panelHttps: true }), null);
  assert.equal(configuredPanelUrl({ panelDomain: "panel.example.com", panelHttps: true }), "https://panel.example.com");
  assert.equal(configuredPanelUrl({ panelDomain: " panel.example.com ", panelHttps: false }), "http://panel.example.com");
});
