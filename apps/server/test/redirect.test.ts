import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import { db } from "../src/db.js";
import { HttpError } from "../src/lib/http.js";
import type { AppEnv } from "../src/lib/types.js";
import { analyticsRoutes } from "../src/routes/analytics.js";
import { appRoutes } from "../src/routes/apps.js";
import { overviewRoutes } from "../src/routes/overview.js";
import { buildCaddyConfig } from "../src/services/caddy.js";
import { fillPlaceholders } from "../src/services/deploy.js";
import { primaryDomain, REDIRECT_DELETE_ERROR, redirectProblem, servingDomains } from "../src/services/domain-policy.js";
import type { ServerRow } from "../src/services/docker.js";

/** Alan adı yönlendirmeleri (www → çıplak alan adı gibi). */
const SERVER_ID = 987301;
const now = () => Date.now();
const tag = () => Math.random().toString(36).slice(2, 8);

function fakeServer(over: Partial<ServerRow> = {}): ServerRow {
  return { id: SERVER_ID, name: "t", kind: "ssh", host: null, port: 22, username: "root", ssh_key_id: null, host_key: null, apps_domain: null, tunnel_token: null, relay_ca: null, public_ip: null, https_mode: "auto", acme_email: null, status: "ready", status_detail: null, setup_log: "", log_offset: 0, log_inode: null, created_at: 0, ...over };
}

/** Sunucu "ready" değil: rotalar Caddy'yi uygulamaya çalışmaz (Docker yok). */
function seedApp(security: object = {}) {
  if (!db.prepare("SELECT 1 FROM servers WHERE id = ?").get(SERVER_ID))
    db.prepare("INSERT INTO servers (id, name, kind, status, https_mode, created_at) VALUES (?, 'yt', 'ssh', 'setup', 'auto', ?)").run(SERVER_ID, now());
  const t = tag();
  const pid = Number(db.prepare("INSERT INTO projects (name, description, created_at) VALUES (?, '', ?)").run(`yp-${t}`, now()).lastInsertRowid);
  const app = Number(
    db.prepare("INSERT INTO apps (project_id, server_id, name, slug, source_type, container, port, status, security, webhook_token, created_at) VALUES (?, ?, 'a', ?, 'image', 'c1', 80, 'running', ?, ?, ?)").run(pid, SERVER_ID, `y-${t}`, JSON.stringify(security), `w-${t}`, now()).lastInsertRowid,
  );
  const domain = (host: string, opts: { https?: boolean; generated?: boolean; redirectTo?: number | null } = {}) =>
    Number(
      db.prepare("INSERT INTO domains (app_id, host, https, generated, redirect_to, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(app, host, opts.https === false ? 0 : 1, opts.generated ? 1 : 0, opts.redirectTo ?? null, now()).lastInsertRowid,
    );
  return { app, domain, t };
}

function api() {
  const h = new Hono<AppEnv>();
  h.use("*", async (c, next) => {
    c.set("user", { id: 1, email: "t@t", name: "t", role: "admin", mustChangePassword: false } as AppEnv["Variables"]["user"]);
    await next();
  });
  h.route("/apps", appRoutes);
  h.route("/overview", overviewRoutes);
  h.route("/analytics", analyticsRoutes);
  h.onError((err, c) => c.json({ error: err.message }, err instanceof HttpError ? err.status : 500));
  return h;
}
const json = (method: string, body: unknown) => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

type CaddyRoute = { match?: { host?: string[] }[]; handle: { handler: string; routes?: unknown[] }[]; terminal?: boolean };
function routeFor(cfg: unknown, host: string) {
  const servers = (cfg as { apps: { http: { servers: Record<string, { routes: CaddyRoute[] }> } } }).apps.http.servers;
  for (const [name, s] of Object.entries(servers)) {
    const r = s.routes.find((x) => x.match?.[0]?.host?.includes(host));
    if (r) return { server: name, route: r };
  }
  return null;
}

test("yönlendirme doğrulaması: yalnız aynı uygulama, zincir ve döngü yok", () => {
  const a = seedApp();
  const b = seedApp();
  const apex = a.domain(`${a.t}.test`);
  const www = a.domain(`www.${a.t}.test`);
  const old = a.domain(`eski-${a.t}.test`);
  const foreign = b.domain(`${b.t}.test`);

  assert.equal(redirectProblem(a.app, www, apex), null);
  assert.equal(redirectProblem(a.app, www, null), null, "yönlendirmeyi kaldırmak her zaman serbest");
  assert.match(redirectProblem(a.app, www, www)!, /kendisine/);
  // Başka uygulamanın alan adı hedef olamaz (açık yönlendirici olmasın); başka uygulamanın alan adı da değiştirilemez.
  assert.match(redirectProblem(a.app, www, foreign)!, /bu uygulamanın/);
  assert.equal(redirectProblem(a.app, foreign, apex), "Alan adı bulunamadı");
  assert.match(redirectProblem(a.app, www, 999_999_999)!, /bu uygulamanın/);

  db.prepare("UPDATE domains SET redirect_to = ? WHERE id = ?").run(apex, www);
  // Zincir: eski → www → apex olamaz (hedef kendisi yönlendirme).
  assert.match(redirectProblem(a.app, old, www)!, /zaten başka bir adrese/);
  // Döngü: apex → www olamaz (apex'e yönlendiren var, www de yönlendirme).
  assert.ok(redirectProblem(a.app, apex, www));
  // Hedef olan alan adı başka yere de yönlendirilemez (eski servis ediyor olsa bile zincir oluşurdu).
  assert.match(redirectProblem(a.app, apex, old)!, /yönlendiren adresler var/);
  // Aynı hedefe birden çok adres yönlendirebilir.
  assert.equal(redirectProblem(a.app, old, apex), null);
});

test("yönlendirme API'si: ayarla, kaldır, ekleme sırasında hedef ve silme engeli", async () => {
  const a = seedApp();
  const b = seedApp();
  const apex = a.domain(`${a.t}.test`);
  const www = a.domain(`www.${a.t}.test`);
  const foreign = b.domain(`${b.t}.test`);
  const h = api();

  let res = await h.request(`/apps/${a.app}/domains/${www}`, json("PUT", { redirectTo: apex }));
  assert.equal(res.status, 200);
  const body = (await res.json()) as { app: { domains: { id: number; redirectTo: number | null; redirectHost: string | null }[] } };
  const d = body.app.domains.find((x) => x.id === www)!;
  assert.equal(d.redirectTo, apex);
  assert.equal(d.redirectHost, `${a.t}.test`);

  assert.equal((await h.request(`/apps/${a.app}/domains/${www}`, json("PUT", { redirectTo: foreign }))).status, 422);
  assert.equal((await h.request(`/apps/${a.app}/domains/${apex}`, json("PUT", { redirectTo: www }))).status, 422);
  assert.equal((await h.request(`/apps/${a.app}/domains/${foreign}`, json("PUT", { redirectTo: apex }))).status, 404);

  // Hedefi olan alan adı silinemez; yönlendirme bozulmadan kalır.
  res = await h.request(`/apps/${a.app}/domains/${apex}`, { method: "DELETE" });
  assert.equal(res.status, 409);
  assert.equal(((await res.json()) as { error: string }).error, REDIRECT_DELETE_ERROR);
  assert.ok(db.prepare("SELECT 1 FROM domains WHERE id = ?").get(apex));

  // Yönlendiren alan adı silinebilir; ardından hedef de silinebilir.
  assert.equal((await h.request(`/apps/${a.app}/domains/${www}`, { method: "DELETE" })).status, 200);
  assert.equal((await h.request(`/apps/${a.app}/domains/${apex}`, { method: "DELETE" })).status, 200);

  // Eklerken hedef: başka uygulamanın ya da yönlendiren alan adı olamaz.
  const target = a.domain(`yeni-${a.t}.test`);
  const redirecting = a.domain(`r-${a.t}.test`, { redirectTo: target });
  for (const bad of [foreign, redirecting]) {
    assert.equal((await h.request(`/apps/${a.app}/domains`, json("POST", { host: `x${bad}-${a.t}.test`, redirectTo: bad }))).status, 422);
  }
  res = await h.request(`/apps/${a.app}/domains`, json("POST", { host: `www.yeni-${a.t}.test`, redirectTo: target }));
  assert.equal(res.status, 201);
  assert.equal((db.prepare("SELECT redirect_to FROM domains WHERE host = ?").get(`www.yeni-${a.t}.test`) as { redirect_to: number }).redirect_to, target);

  // Uygulama silinince (domains CASCADE) kendi kendine başvuran yabancı anahtar sorun çıkarmaz.
  db.prepare("DELETE FROM apps WHERE id = ?").run(a.app);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM domains WHERE app_id = ?").get(a.app) as { n: number }).n, 0);
});

test("asıl adres seçimi yönlendiren alan adını atlar (XUDBIN_URL, XUDBIN_DOMAINS, izleme)", () => {
  // Otomatik adres + kendi alan adı: kendi alan adı önde.
  const a = seedApp();
  a.domain(`gen-${a.t}.sslip.io`, { generated: true });
  a.domain(`${a.t}.test`);
  // Önce eklenen (daha küçük kimlikli) www yönlendirme olsa bile asıl adres seçilmez.
  const c = seedApp();
  const cWww = c.domain(`www.${c.t}.test`);
  const cApex = c.domain(`${c.t}.test`);
  db.prepare("UPDATE domains SET redirect_to = ? WHERE id = ?").run(cApex, cWww);
  // Hedef yalnız HTTP: adresin şeması hedefin ayarından gelir.
  const b = seedApp();
  const bApex = b.domain(`${b.t}.test`, { https: false });
  b.domain(`www.${b.t}.test`, { redirectTo: bApex });

  assert.equal(primaryDomain(a.app)?.host, `${a.t}.test`);
  assert.deepEqual(servingDomains(a.app).map((d) => d.host), [`${a.t}.test`, `gen-${a.t}.sslip.io`]);

  assert.equal(primaryDomain(c.app)?.host, `${c.t}.test`);
  const filled = fillPlaceholders({ U: "{{XUDBIN_URL}}", D: "{{XUDBIN_DOMAINS}}", O: "{{XUDBIN_ORIGINS}}", H: "{{XUDBIN_HOST}}" }, c.app, true);
  assert.deepEqual(filled.env, { U: `https://${c.t}.test`, D: `${c.t}.test`, O: `https://${c.t}.test`, H: `${c.t}.test` });

  assert.equal(primaryDomain(b.app)?.host, `${b.t}.test`);
  assert.equal(fillPlaceholders({ U: "{{XUDBIN_URL}}" }, b.app, true).env.U, `http://${b.t}.test`);
});

test("Caddy: yönlendiren alan adı 301 + Location (yol ve sorgu korunur), IP engelleri önce, WAF/şifre/hız sınırı yok", () => {
  // Test veritabanı kalıcıdır; başka testlerden kalan banlar beklenen rotayı değiştirmesin.
  db.prepare("DELETE FROM blocked_ips").run();
  const a = seedApp({ waf: true, rateLimit: 100, denyIps: ["198.51.100.7"], allowIps: [], basicAuth: { username: "u", hash: "x" } });
  const apex = a.domain(`${a.t}.test`);
  a.domain(`www.${a.t}.test`, { redirectTo: apex });
  a.domain(`http-${a.t}.test`, { https: false, redirectTo: apex });
  const httpTarget = a.domain(`duz-${a.t}.test`, { https: false });
  a.domain(`eski-${a.t}.test`, { redirectTo: httpTarget });

  const cfg = buildCaddyConfig(fakeServer());
  const www = routeFor(cfg, `www.${a.t}.test`)!;
  assert.equal(www.server, "https", "yönlendiren alan adı da kendi sertifikasını alır");
  assert.deepEqual(www.route, {
    match: [{ host: [`www.${a.t}.test`] }],
    handle: [
      {
        handler: "subroute",
        routes: [
          {
            match: [{ client_ip: { ranges: ["198.51.100.7"] } }],
            handle: [{ handler: "static_response", status_code: 403, headers: { "X-Xudbin-Block": ["deny"] }, body: "Erişim engellendi." }],
            terminal: true,
          },
          { handle: [{ handler: "static_response", status_code: 301, headers: { Location: [`https://${a.t}.test{http.request.uri}`] } }] },
        ],
      },
    ],
    terminal: true,
  });
  // Yalnız HTTP olan yönlendirme :80'de; hedef HTTPS'liyse Location https.
  const http = routeFor(cfg, `http-${a.t}.test`)!;
  assert.equal(http.server, "http");
  assert.ok(JSON.stringify(http.route).includes(`"Location":["https://${a.t}.test{http.request.uri}"]`));
  // Hedef yalnız HTTP ise Location http.
  assert.ok(JSON.stringify(routeFor(cfg, `eski-${a.t}.test`)!.route).includes(`"Location":["http://duz-${a.t}.test{http.request.uri}"]`));
  // Hedef alan adı uygulamayı WAF, şifre ve hız sınırıyla servis etmeye devam eder.
  const target = JSON.stringify(routeFor(cfg, `${a.t}.test`)!.route);
  assert.ok(target.includes('"handler":"reverse_proxy"') && target.includes('"handler":"waf"') && target.includes('"handler":"authentication"'));
  const redirectText = JSON.stringify(www.route);
  for (const h of ["waf", "authentication", "rate_limit", "reverse_proxy", "headers"]) assert.ok(!redirectText.includes(`"handler":"${h}"`), h);
  // Yönlendiren alan adının sertifikası da alınır (automatic_https.skip'te değil).
  const skip = (cfg as { apps: { http: { servers: { https: { automatic_https: { skip: string[] } } } } } }).apps.http.servers.https.automatic_https.skip;
  assert.ok(!skip.includes(`www.${a.t}.test`) && skip.includes(`http-${a.t}.test`));

  // HTTPS kapalı sunucu: her şey :80'de, Location http.
  const off = buildCaddyConfig(fakeServer({ https_mode: "off" }));
  const offRoute = routeFor(off, `www.${a.t}.test`)!;
  assert.equal(offRoute.server, "http");
  assert.ok(JSON.stringify(offRoute.route).includes(`"Location":["http://${a.t}.test{http.request.uri}"]`));
});

test("Caddy: geçersiz kayıt (başka uygulamaya ya da zincire yönlendirme) yönlendirme üretmez, uygulamayı servis eder", () => {
  const a = seedApp();
  const b = seedApp();
  const foreign = b.domain(`${b.t}.test`);
  const apex = a.domain(`${a.t}.test`);
  const www = a.domain(`www.${a.t}.test`, { redirectTo: apex });
  // API'yi atlayarak veritabanına doğrudan yazılmış bozuk kayıtlar.
  a.domain(`kacak-${a.t}.test`, { redirectTo: foreign });
  a.domain(`zincir-${a.t}.test`, { redirectTo: www });
  const cfg = JSON.stringify(buildCaddyConfig(fakeServer()));
  assert.ok(!cfg.includes(`"Location":["https://${b.t}.test`), "başka uygulamanın adresine yönlendirme olmamalı");
  assert.ok(!cfg.includes(`"Location":["https://www.${a.t}.test`), "zincir olmamalı");
  for (const host of [`kacak-${a.t}.test`, `zincir-${a.t}.test`]) {
    assert.ok(JSON.stringify(routeFor(JSON.parse(cfg), host)!.route).includes('"handler":"reverse_proxy"'), host);
  }
});

test("izleme ve analitik site listesi yönlendiren alan adını adres olarak göstermez", async () => {
  const a = seedApp();
  const www = a.domain(`www.${a.t}.test`);
  const apex = a.domain(`${a.t}.test`);
  db.prepare("UPDATE domains SET redirect_to = ? WHERE id = ?").run(apex, www);
  const h = api();
  const mon = (await (await h.request("/overview/monitoring")).json()) as { apps: { id: number; url: string | null }[] };
  assert.equal(mon.apps.find((x) => x.id === a.app)?.url, `https://${a.t}.test`);
  const sites = (await (await h.request("/analytics/sites")).json()) as { sites: { id: number; host: string | null }[] };
  assert.equal(sites.sites.find((x) => x.id === a.app)?.host, `${a.t}.test`);
});
