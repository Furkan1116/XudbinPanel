import assert from "node:assert/strict";
import { test } from "node:test";
import { db } from "../src/db.js";
import { ipInCidr, ipInList, isValidIpOrCidr } from "../src/lib/cidr.js";
import { autoBan, classify, isBlocked } from "../src/services/security.js";
import { buildCaddyConfig } from "../src/services/caddy.js";

test("O13: CIDR eşleşmesi IPv4 ve IPv6 için çalışır", () => {
  assert.ok(ipInCidr("10.1.2.3", "10.0.0.0/8"));
  assert.ok(!ipInCidr("11.1.2.3", "10.0.0.0/8"));
  assert.ok(ipInCidr("203.0.113.5", "203.0.113.5"));
  assert.ok(ipInCidr("::ffff:10.1.2.3", "10.0.0.0/8"));
  assert.ok(ipInCidr("2001:db8:1::5", "2001:db8::/32"));
  assert.ok(!ipInCidr("2001:db9::1", "2001:db8::/32"));
  assert.ok(ipInCidr("::1", "::1"));
  assert.ok(ipInList("192.168.1.9", ["1.1.1.1", "192.168.0.0/16"]));
  assert.ok(!ipInCidr("1.2.3.4", "geçersiz"));
  assert.ok(isValidIpOrCidr("2001:db8::/32") && isValidIpOrCidr("10.0.0.0/8"));
  assert.ok(!isValidIpOrCidr("10.0.0.0/33") && !isValidIpOrCidr("a.b.c.d") && !isValidIpOrCidr("1.2.3.4/"));
});

test("O13: isBlocked engel listesindeki CIDR'i tanır", () => {
  db.prepare("INSERT OR IGNORE INTO blocked_ips (ip, reason, auto, expires_at, created_at) VALUES ('198.18.0.0/15', 't', 0, NULL, ?), ('2001:db8:ff::/48', 't', 0, NULL, ?)").run(Date.now(), Date.now());
  assert.ok(isBlocked("198.19.4.4"));
  assert.ok(isBlocked("2001:db8:ff::9"));
  assert.ok(!isBlocked("198.20.0.1"));
  db.prepare("DELETE FROM blocked_ips WHERE reason = 't'").run();
});

test("O13: yalnız WAF işaretli 403 'waf' sayılır; uygulamanın 401/403/429'u ban kaynağı değildir", () => {
  const e = (status: number, block?: string) => ({ status, resp_headers: block ? { "X-Xudbin-Block": [block] } : {}, request: {} }) as never;
  assert.equal(classify(e(403, "waf")), "waf");
  assert.equal(classify(e(403)), null);
  assert.equal(classify(e(403, "blocklist")), "blocked");
  assert.equal(classify(e(401)), "auth");
});

test("O13: autoBan yalnız waf/panel_login sayar ve izin listesindeki IP'yi banlamaz", async () => {
  const now = Date.now();
  const ins = db.prepare("INSERT INTO security_events (ip, kind, method, path, status, created_at) VALUES (?, ?, 'GET', '/', 403, ?)");
  const flood = (ip: string, kind: string, n = 40) => { for (let i = 0; i < n; i++) ins.run(ip, kind, now); };
  flood("192.0.2.10", "auth");       // uygulamanın 401'leri
  flood("192.0.2.11", "ratelimit");
  flood("192.0.2.12", "waf");        // gerçek saldırgan
  flood("192.0.2.13", "panel_login");
  flood("203.0.113.77", "waf");      // izin listesinde
  const tag = Math.random().toString(36).slice(2, 8);
  const sid = (db.prepare("SELECT id FROM servers LIMIT 1").get() as { id: number } | undefined)?.id ??
    Number(db.prepare("INSERT INTO servers (name, kind, status, created_at) VALUES ('l','local','ready',?)").run(now).lastInsertRowid);
  const pid = Number(db.prepare("INSERT INTO projects (name, description, created_at) VALUES (?, '', ?)").run(`bp-${tag}`, now).lastInsertRowid);
  db.prepare("INSERT INTO apps (project_id, server_id, name, slug, source_type, security, webhook_token, created_at) VALUES (?, ?, 'a', ?, 'image', ?, ?, ?)").run(pid, sid, `b-${tag}`, JSON.stringify({ allowIps: ["203.0.113.0/24"] }), `w-${tag}`, now);
  const banned = await autoBan();
  assert.ok(banned.includes("192.0.2.12") && banned.includes("192.0.2.13"));
  for (const ip of ["192.0.2.10", "192.0.2.11", "203.0.113.77"]) assert.ok(!banned.includes(ip), ip);
  db.prepare("DELETE FROM blocked_ips WHERE auto = 1").run();
  db.prepare("DELETE FROM security_events WHERE ip LIKE '192.0.2.%' OR ip = '203.0.113.77'").run();
});

test("O13: Caddy hata rotası WAF 403'ünü işaretler", () => {
  const s = { id: 987002, name: "t", kind: "local", https_mode: "off", tunnel_token: null } as never;
  const text = JSON.stringify(buildCaddyConfig(s));
  assert.ok(text.includes('"errors":{"routes":[{"match":[{"expression":"{http.error.status_code} == 403"}]'));
  assert.ok(text.includes('"X-Xudbin-Block":["waf"]'));
});
