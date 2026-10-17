import assert from "node:assert/strict";
import { test } from "node:test";
import { db } from "../src/db.js";
import { updateSettings } from "../src/lib/settings.js";
import { pickForwardedIp } from "../src/lib/client-ip.js";
import { buildCaddyConfig, CLIENT_IP_HEADER } from "../src/services/caddy.js";
import type { ServerRow } from "../src/services/docker.js";

function fakeServer(over: Partial<ServerRow> = {}): ServerRow {
  return { id: 987001, name: "t", kind: "local", host: null, port: 22, username: "root", ssh_key_id: null, host_key: null, apps_domain: null, tunnel_token: null, relay_ca: null, public_ip: null, https_mode: "off", acme_email: null, status: "ready", status_detail: null, setup_log: "", log_offset: 0, log_inode: null, created_at: 0, ...over };
}

function seedApp(serverId: number, security: object) {
  const now = Date.now();
  const tag = Math.random().toString(36).slice(2, 8);
  if (!db.prepare("SELECT 1 FROM servers WHERE id = ?").get(serverId))
    db.prepare("INSERT INTO servers (id, name, kind, status, created_at) VALUES (?, 'ct', 'ssh', 'ready', ?)").run(serverId, now);
  const pid = Number(db.prepare("INSERT INTO projects (name, description, created_at) VALUES (?, '', ?)").run(`cp-${tag}`, now).lastInsertRowid);
  const aid = Number(
    db.prepare("INSERT INTO apps (project_id, server_id, name, slug, source_type, container, port, security, webhook_token, created_at) VALUES (?, ?, 'a', ?, 'image', 'c1', 80, ?, ?, ?)").run(pid, serverId, `a-${tag}`, JSON.stringify(security), `w-${tag}`, now).lastInsertRowid,
  );
  db.prepare("INSERT INTO domains (app_id, host, https, created_at) VALUES (?, ?, 0, ?)").run(aid, `${tag}.test`, now);
}

test("O6: IP eşleyicileri ve hız sınırı anahtarı client_ip kullanır (tunnel açık/kapalı)", () => {
  seedApp(987001, { allowIps: ["203.0.113.0/24"], denyIps: ["198.51.100.7"], rateLimit: 100 });
  for (const tunnel of [null, "tok"]) {
    const text = JSON.stringify(buildCaddyConfig(fakeServer({ tunnel_token: tunnel })));
    assert.ok(!text.includes("remote_ip"), "remote_ip eşleyicisi kalmamalı");
    assert.ok(!text.includes("{http.request.remote.host}"), "hız sınırı remote.host kullanmamalı");
    assert.ok(text.includes('"client_ip":{"ranges":["203.0.113.0/24"]}'));
    assert.ok(text.includes('"client_ip":{"ranges":["198.51.100.7"]}'));
    assert.ok(text.includes('"key":"{http.vars.client_ip}"'));
    assert.equal(text.includes("trusted_proxies"), tunnel !== null);
  }
});

test("O6: panel rotası gerçek IP'yi başlıkla iletir, panel başlığı XFF'ye tercih eder", () => {
  updateSettings({ panelDomain: "panel.test", panelHttps: false });
  const text = JSON.stringify(buildCaddyConfig(fakeServer({ tunnel_token: "tok" })));
  assert.ok(text.includes(`"${CLIENT_IP_HEADER}":["{http.vars.client_ip}"]`));
  assert.equal(pickForwardedIp("203.0.113.9", "1.1.1.1, 172.18.0.5"), "203.0.113.9");
  assert.equal(pickForwardedIp(undefined, "1.1.1.1, 172.18.0.5"), "172.18.0.5");
  assert.equal(pickForwardedIp("sahte, değer", "1.2.3.4"), "1.2.3.4");
  updateSettings({ panelDomain: "" });
});
