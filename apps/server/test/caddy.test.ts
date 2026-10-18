import assert from "node:assert/strict";
import { test } from "node:test";
import { db } from "../src/db.js";
import { updateSettings } from "../src/lib/settings.js";
import { pickForwardedIp } from "../src/lib/client-ip.js";
import { parseIpPort } from "../src/config.js";
import { buildCaddyConfig, CLIENT_IP_HEADER, panelIpUrl } from "../src/services/caddy.js";
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

test("O5: panel rotasında WAF var; varsayılan yalnız tespit, gövde denetimi /api/'de kapalı", () => {
  updateSettings({ panelDomain: "panel.test", panelHttps: false });
  const wafOf = (mode: "off" | "detect" | "block") => {
    updateSettings({ panelWaf: mode });
    const cfg = JSON.stringify(buildCaddyConfig(fakeServer()));
    const routes = Object.values(JSON.parse(cfg).apps.http.servers as Record<string, { routes: { match?: { host?: string[] }[] }[] }>).flatMap((x) => x.routes);
    const panel = routes.find((r) => r.match?.[0]?.host?.[0] === "panel.test");
    const m = /"handler":"waf","load_owasp_crs":true,"directives":"((?:[^"\\]|\\.)*)"/.exec(JSON.stringify(panel));
    return m ? (JSON.parse(`"${m[1]}"`) as string) : null;
  };
  assert.equal(wafOf("off"), null);
  const detect = wafOf("detect")!;
  assert.ok(detect.includes("SecRuleEngine DetectionOnly") && !detect.includes("SecRuleEngine On"));
  assert.ok(detect.includes("ctl:requestBodyAccess=Off") && detect.includes("/api/"));
  assert.ok(detect.includes("blocking_paranoia_level=1"));
  assert.ok(wafOf("block")!.includes("SecRuleEngine On"));
  // kurallar CRS yüklenmeden önce tanımlanmalı
  assert.ok(detect.indexOf("id:100002") < detect.indexOf("@owasp_crs"));
  assert.equal(updateSettings({}).panelWaf, "block");
  updateSettings({ panelDomain: "", panelWaf: "detect" });
});

test("Panel IP girişi: https://<ip>:8443 iç CA sertifikasıyla, alan adıyla aynı korumalar", () => {
  updateSettings({ panelDomain: "", panelWaf: "detect", panelIpAccess: true });
  const server = fakeServer({ id: 987002, https_mode: "auto", public_ip: "203.0.113.10" });
  const cfg = buildCaddyConfig(server) as unknown as {
    apps: { http: { servers: Record<string, { listen: string[]; routes: unknown[]; tls_connection_policies?: { default_sni: string }[] }> }; tls?: { certificates?: { automate: string[] }; automation: { policies: { subjects?: string[]; issuers: { module: string }[] }[] } } };
  };
  const ipServer = cfg.apps.http.servers.panel_ip!;
  assert.deepEqual(ipServer.listen, [":8443"]);
  // Tarayıcı IP için SNI göndermez; sertifika default_sni ile seçilir.
  assert.deepEqual(ipServer.tls_connection_policies, [{ default_sni: "203.0.113.10" }]);
  const route = JSON.stringify(ipServer.routes);
  assert.ok(route.includes('"handler":"reverse_proxy"') && route.includes('"handler":"rate_limit"') && route.includes('"handler":"waf"'));
  assert.ok(route.includes(`"${CLIENT_IP_HEADER}":["{http.vars.client_ip}"]`));
  assert.ok(cfg.apps.tls?.certificates?.automate.includes("203.0.113.10"));
  const policy = cfg.apps.tls!.automation.policies.find((p) => p.subjects?.includes("203.0.113.10"));
  assert.deepEqual(policy?.issuers, [{ module: "internal" }], "IP sertifikası Let's Encrypt'ten değil, iç CA'dan");
  assert.equal(panelIpUrl(server), "https://203.0.113.10:8443");
  assert.equal(panelIpUrl(fakeServer({ https_mode: "auto", public_ip: "2001:db8::1" })), "https://[2001:db8::1]:8443");

  // Ayardan kapalı, HTTPS kapalı, uzak sunucu ya da IP bilinmiyorsa IP girişi yok.
  for (const [over, settings] of [
    [{}, { panelIpAccess: false }],
    [{ https_mode: "off" }, {}],
    [{ kind: "ssh" }, {}],
    [{ public_ip: null }, {}],
  ] as [Partial<ServerRow>, object][]) {
    updateSettings({ panelIpAccess: true, ...settings });
    const s2 = fakeServer({ id: 987002, https_mode: "auto", public_ip: "203.0.113.10", ...over });
    const text = JSON.stringify(buildCaddyConfig(s2));
    assert.ok(!text.includes("panel_ip") && !text.includes("203.0.113.10"), JSON.stringify(over));
    assert.equal(panelIpUrl(s2), null);
  }
  updateSettings({ panelIpAccess: true });
});

test("XUDBIN_IP_PORT: varsayılan 8443, 0/geçersiz/80/443 kapatır", () => {
  assert.equal(parseIpPort(undefined), 8443);
  assert.equal(parseIpPort(""), 8443);
  assert.equal(parseIpPort("9443"), 9443);
  for (const bad of ["0", "443", "80", "70000", "abc", "84 43"]) assert.equal(parseIpPort(bad), 0, bad);
});
