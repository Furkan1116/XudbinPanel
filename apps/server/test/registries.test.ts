import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Hono } from "hono";
import { enforceRoles } from "../src/auth/middleware.js";
import { config } from "../src/config.js";
import { db } from "../src/db.js";
import { HttpError } from "../src/lib/http.js";
import type { AppEnv } from "../src/lib/types.js";
import { registryRoutes } from "../src/routes/registries.js";
import { actionLabel } from "../src/services/audit.js";
import {
  buildRegistryConfig,
  DOCKER_HUB_AUTH_KEY,
  normalizeRegistryHost,
  prepareComposeDockerConfig,
  pullAuthFor,
  registryHostOf,
  registryLogins,
} from "../src/services/registries.js";

/** Özel imaj kayıt depoları: adres eşleme, yalnız yönetici API'si, Compose için geçici config.json. */
const tag = () => Math.random().toString(36).slice(2, 8);

test("kayıt deposu adresi normalize edilir, Docker Hub'ın bütün adları tek adrestir", () => {
  assert.equal(normalizeRegistryHost("ghcr.io"), "ghcr.io");
  assert.equal(normalizeRegistryHost("  GHCR.IO/ "), "ghcr.io");
  assert.equal(normalizeRegistryHost("https://registry.gitlab.com/grup/proje"), "registry.gitlab.com");
  assert.equal(normalizeRegistryHost("ornek.com:5000"), "ornek.com:5000");
  assert.equal(normalizeRegistryHost("localhost:5000"), "localhost:5000");
  for (const hub of ["docker.io", "index.docker.io", "https://index.docker.io/v1/", "registry-1.docker.io", "registry.hub.docker.com", "hub.docker.com"]) {
    assert.equal(normalizeRegistryHost(hub), "docker.io", hub);
  }
  for (const bad of ["", "kullanici@ghcr.io", "ghcr.io:99999", "a b.com", "-x.com", "ghcr..io"]) assert.equal(normalizeRegistryHost(bad), null, bad);
});

test("imaj adresinden kayıt deposu bulunur (Docker'ın örtük Docker Hub kuralı)", () => {
  assert.equal(registryHostOf("nginx"), "docker.io");
  assert.equal(registryHostOf("nginx:1.27-alpine"), "docker.io");
  assert.equal(registryHostOf("kullanici/uygulama:1"), "docker.io");
  assert.equal(registryHostOf("library/redis@sha256:abc"), "docker.io");
  assert.equal(registryHostOf("docker.io/kullanici/uygulama"), "docker.io");
  assert.equal(registryHostOf("index.docker.io/kullanici/uygulama"), "docker.io");
  assert.equal(registryHostOf("ghcr.io/sirket/api:latest"), "ghcr.io");
  assert.equal(registryHostOf("GHCR.io/sirket/api"), "ghcr.io");
  assert.equal(registryHostOf("registry.gitlab.com/grup/alt/proje:v2"), "registry.gitlab.com");
  assert.equal(registryHostOf("ornek.com:5000/uygulama"), "ornek.com:5000");
  assert.equal(registryHostOf("localhost/uygulama"), "localhost");
  assert.equal(registryHostOf("localhost:5000/uygulama:1"), "localhost:5000");
});

test("giriş yalnız imajın deposuyla birebir eşleşince kullanılır", () => {
  const logins = [
    { host: "ghcr.io", username: "u1", password: "ghp_gizli1" },
    { host: "docker.io", username: "u2", password: "dckr_gizli2" },
  ];
  assert.deepEqual(pullAuthFor("ghcr.io/sirket/api", logins), { username: "u1", password: "ghp_gizli1", serveraddress: "ghcr.io" });
  assert.deepEqual(pullAuthFor("sirket/api", logins), { username: "u2", password: "dckr_gizli2", serveraddress: DOCKER_HUB_AUTH_KEY });
  assert.equal(pullAuthFor("index.docker.io/sirket/api", logins)?.username, "u2");
  // Benzer görünen başka depolara giriş gitmez.
  assert.equal(pullAuthFor("ghcr.io.saldirgan.com/x", logins), undefined);
  assert.equal(pullAuthFor("saldirgan.com/ghcr.io/x", logins), undefined);
  assert.equal(pullAuthFor("registry.gitlab.com/x/y", logins), undefined);
  assert.equal(pullAuthFor("ghcr.io:8443/x", logins), undefined);

  const rc = buildRegistryConfig(logins)!;
  assert.deepEqual(Object.keys(rc).sort(), ["ghcr.io", DOCKER_HUB_AUTH_KEY].sort());
  assert.equal(buildRegistryConfig([]), undefined);
});

function api(role: "admin" | "member") {
  const h = new Hono<AppEnv>();
  h.use("*", async (c, next) => {
    c.set("user", { id: 1, email: "t@t", name: "t", role, mustChangePassword: false } as AppEnv["Variables"]["user"]);
    await next();
  });
  h.use("/api/*", enforceRoles);
  h.route("/api/settings/registries", registryRoutes);
  h.onError((err, c) => c.json({ error: err.message }, err instanceof HttpError ? err.status : 500));
  return h;
}
const json = (method: string, body: unknown) => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

test("kayıt deposu API'si yalnız yöneticiye açık", async () => {
  const member = api("member");
  for (const [method, p, b] of [
    ["GET", "/api/settings/registries", undefined],
    ["POST", "/api/settings/registries", { host: "ghcr.io", username: "u", password: "p", verify: false }],
    ["POST", "/api/settings/registries/test", { host: "ghcr.io", username: "u", password: "p" }],
    ["PATCH", "/api/settings/registries/1", { name: "x", verify: false }],
    ["POST", "/api/settings/registries/1/test", {}],
    ["DELETE", "/api/settings/registries/1", undefined],
  ] as const) {
    const res = await member.request(p, b === undefined ? { method } : json(method, b));
    assert.equal(res.status, 403, `${method} ${p}`);
  }
});

test("şifre şifreli saklanır ve hiçbir yanıtta dönmez", async () => {
  const admin = api("admin");
  const host = `reg-${tag()}.ornek.com`;
  const secret = `tok_${tag()}${tag()}`;
  const created = await admin.request("/api/settings/registries", json("POST", { name: "Şirket", host: `https://${host.toUpperCase()}/`, username: "ci", password: secret, verify: false }));
  assert.equal(created.status, 201);
  const createdText = await created.text();
  assert.ok(!createdText.includes(secret));
  const { registry } = JSON.parse(createdText) as { registry: { id: number; host: string; verifiedAt: number | null } };
  assert.equal(registry.host, host);
  assert.equal(registry.verifiedAt, null);

  const row = db.prepare("SELECT secret FROM registry_credentials WHERE id = ?").get(registry.id) as { secret: string };
  assert.ok(row.secret.startsWith("v1.") && !row.secret.includes(secret));
  assert.ok(registryLogins().some((l) => l.host === host && l.password === secret));

  const list = await admin.request("/api/settings/registries");
  const listText = await list.text();
  assert.ok(!listText.includes(secret) && !listText.includes(row.secret));
  const item = (JSON.parse(listText) as { registries: Record<string, unknown>[] }).registries.find((r) => r.host === host)!;
  assert.deepEqual(Object.keys(item).sort(), ["createdAt", "host", "id", "name", "username", "verifiedAt"]);

  // Aynı depo ikinci kez eklenemez (Docker Hub'ın başka adıyla da).
  const dup = await admin.request("/api/settings/registries", json("POST", { host, username: "x", password: "y", verify: false }));
  assert.equal(dup.status, 409);
  const bad = await admin.request("/api/settings/registries", json("POST", { host: "kötü adres", username: "x", password: "y", verify: false }));
  assert.equal(bad.status, 400);

  // Şifre boş bırakılırsa eskisi kalır; yanıt yine şifre içermez.
  const patched = await admin.request(`/api/settings/registries/${registry.id}`, json("PATCH", { name: "Yeni ad", password: "", verify: false }));
  const patchedText = await patched.text();
  assert.equal(patched.status, 200);
  assert.ok(!patchedText.includes(secret));
  assert.ok(registryLogins().some((l) => l.host === host && l.password === secret));

  assert.equal((await admin.request(`/api/settings/registries/${registry.id}`, { method: "DELETE" })).status, 200);
  assert.ok(!registryLogins().some((l) => l.host === host));
  assert.equal((await admin.request(`/api/settings/registries/${registry.id}`, { method: "DELETE" })).status, 404);
});

test("işlem kaydı yeni yazma isteklerini tanır", () => {
  assert.equal(actionLabel("POST", "/api/settings/registries"), "Kayıt deposu girişi ekledi");
  assert.equal(actionLabel("PATCH", "/api/settings/registries/3"), "Kayıt deposu girişini değiştirdi");
  assert.equal(actionLabel("DELETE", "/api/settings/registries/3"), "Kayıt deposu girişini sildi");
  assert.equal(actionLabel("POST", "/api/settings/registries/test"), "Kayıt deposu girişini denedi");
  assert.equal(actionLabel("POST", "/api/settings/registries/3/test"), "Kayıt deposu girişini denedi");
});

test("Compose için geçici DOCKER_CONFIG: yalnız config.json, dar izinler, deploy klasörü dışında, iş bitince silinir", () => {
  assert.equal(prepareComposeDockerConfig([]), null, "giriş yoksa DOCKER_CONFIG değişmez");

  const base = fs.mkdtempSync(path.join(os.tmpdir(), "xudbin-test-"));
  const plugins = path.join(base, "plugins");
  fs.mkdirSync(plugins);
  const logins = [
    { host: "docker.io", username: "hub", password: "dckr_pat_abc" },
    { host: "ghcr.io", username: "gh", password: "ghp_xyz" },
  ];
  const auth = prepareComposeDockerConfig(logins, { baseDir: base, pluginsFrom: plugins })!;
  try {
    assert.ok(auth.dir.startsWith(base));
    const cfg = JSON.parse(fs.readFileSync(path.join(auth.dir, "config.json"), "utf8")) as { auths: Record<string, { auth: string }> };
    assert.deepEqual(Object.keys(cfg.auths).sort(), [DOCKER_HUB_AUTH_KEY, "ghcr.io"].sort());
    assert.equal(Buffer.from(cfg.auths[DOCKER_HUB_AUTH_KEY]!.auth, "base64").toString(), "hub:dckr_pat_abc");
    assert.equal(Buffer.from(cfg.auths["ghcr.io"]!.auth, "base64").toString(), "gh:ghp_xyz");
    assert.equal(fs.statSync(auth.dir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(auth.dir, "config.json")).mode & 0o777, 0o600);
    assert.equal(fs.readlinkSync(path.join(auth.dir, "cli-plugins")), plugins);
    // Loglarda gizlenecek değerler: şifreler ve config.json'daki base64 halleri.
    for (const s of ["dckr_pat_abc", "ghp_xyz", cfg.auths["ghcr.io"]!.auth, cfg.auths[DOCKER_HUB_AUTH_KEY]!.auth]) assert.ok(auth.secrets.includes(s));
  } finally {
    auth.cleanup();
  }
  assert.ok(!fs.existsSync(auth.dir), "deploy bitince giriş dosyası kalmamalı");
  assert.ok(fs.existsSync(plugins), "temizlik eklenti klasörüne dokunmamalı");
  fs.rmSync(base, { recursive: true, force: true });

  // Varsayılan konum panelin veri ve derleme klasörlerinin dışında (compose dosyası oraya göreli yol veremez).
  const def = prepareComposeDockerConfig(logins, { pluginsFrom: null })!;
  try {
    assert.ok(!path.resolve(def.dir).startsWith(path.resolve(config.dataDir)));
    assert.deepEqual(fs.readdirSync(def.dir), ["config.json"]);
  } finally {
    def.cleanup();
  }
});
