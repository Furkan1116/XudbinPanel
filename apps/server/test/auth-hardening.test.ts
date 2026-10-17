import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { Hono } from "hono";
import { createHash } from "node:crypto";
import { authRoutes } from "../src/routes/auth.js";
import { settingsRoutes } from "../src/routes/settings.js";
import { ensureSetupToken } from "../src/auth/setup-token.js";
import { hashPassword } from "../src/auth/password.js";
import { codeAt, generateTotpSecret } from "../src/auth/totp.js";
import { finishLogin, ssoMayLogInto, startLogin } from "../src/auth/oidc.js";
import { createSession } from "../src/auth/session.js";
import { db } from "../src/db.js";
import { encrypt } from "../src/lib/crypto.js";
import { errorResponse, HttpError } from "../src/lib/http.js";
import { createRateLimiter } from "../src/lib/rate-limit.js";
import { updateSettings } from "../src/lib/settings.js";
import type { AppEnv } from "../src/lib/types.js";

const env = (ip: string) => ({ incoming: { socket: { remoteAddress: ip } } });
const json = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function addUser(email: string, opts: { password?: string; role?: string; totp?: string } = {}) {
  db.prepare("DELETE FROM users WHERE email = ?").run(email);
  const hash = opts.password === undefined ? "!sso" : "";
  return Number(
    db
      .prepare("INSERT INTO users (email, name, password_hash, role, totp_secret, created_at) VALUES (?, 'T', ?, ?, ?, ?)")
      .run(email, hash || "x", opts.role ?? "member", opts.totp ? encrypt(opts.totp) : null, Date.now()).lastInsertRowid,
  );
}

test("kurulum: eşzamanlı iki istek yalnız bir yönetici oluşturur (D1)", async () => {
  db.exec("DELETE FROM users");
  const token = ensureSetupToken();
  const body = (email: string) => json({ email, name: "A", password: "uzun-bir-sifre-123", setupToken: token });
  const [a, b] = await Promise.all([
    authRoutes.request("/setup", body("a@x.test"), env("10.0.0.1")),
    authRoutes.request("/setup", body("b@x.test"), env("10.0.0.2")),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n, 1);
});

test("giriş: başarılı giriş IP sayacını sıfırlamaz, hesap başına da sınır var (D1)", async () => {
  db.exec("DELETE FROM users");
  const hash = await hashPassword("dogru-sifre-123");
  db.prepare("INSERT INTO users (email, name, password_hash, created_at) VALUES ('me@x.test', 'Me', ?, ?)").run(hash, Date.now());
  db.prepare("INSERT INTO users (email, name, password_hash, created_at) VALUES ('victim@x.test', 'V', ?, ?)").run(hash, Date.now());
  const login = (email: string, password: string, ip: string) => authRoutes.request("/login", json({ email, password }), env(ip));

  // Saldırgan 9 hatalı deneme yapar, kendi hesabıyla girerek sayacı sıfırlamayı dener; sınır yine dolar.
  for (let i = 0; i < 9; i++) assert.equal((await login("victim@x.test", "yanlis", "9.9.9.9")).status, 401);
  assert.equal((await login("me@x.test", "dogru-sifre-123", "9.9.9.9")).status, 200);
  assert.equal((await login("victim@x.test", "yanlis", "9.9.9.9")).status, 401); // 10. hata
  assert.equal((await login("victim@x.test", "dogru-sifre-123", "9.9.9.9")).status, 429);

  // Hesap başına sınır: farklı IP'lerden gelen hatalı denemeler de sayılır.
  let last = 0;
  for (let i = 0; i < 21; i++) last = (await login("victim@x.test", "yanlis", `8.8.${i}.1`)).status;
  assert.equal(last, 429);
  assert.equal((await login("victim@x.test", "dogru-sifre-123", "7.7.7.7")).status, 429);
  // Başka hesap etkilenmez.
  assert.equal((await login("me@x.test", "dogru-sifre-123", "7.7.7.8")).status, 200);
});

test("hız sınırlayıcı: check/fail ve anahtar üst sınırı", () => {
  const l = createRateLimiter({ windowMs: 60_000, max: 2, maxKeys: 2 });
  assert.equal(l.check("a"), null);
  l.fail("a");
  assert.equal(l.check("a"), null);
  l.fail("a");
  assert.ok(l.check("a")! > 0);
  l.reset("a");
  assert.equal(l.check("a"), null);
  l.fail("x");
  l.fail("y");
  l.fail("z"); // x atılır
  l.fail("z");
  assert.ok(l.check("z")! > 0);
});

function settingsApp(id: number, email: string) {
  const app = new Hono<AppEnv>()
    .use(async (c, next) => {
      c.set("user", { id, email, name: "T", role: "member", mustChangePassword: false });
      await next();
    })
    .route("/", settingsRoutes);
  app.onError(errorResponse);
  return app;
}

test("2FA kapatma parola ister, diğer oturumlar kapanır (D2)", async () => {
  const secret = generateTotpSecret();
  const id = addUser("totp@x.test", { password: "p", totp: secret });
  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(await hashPassword("dogru-sifre-123"), id);
  const mine = createSession(id, {});
  createSession(id, {});
  const app = settingsApp(id, "totp@x.test");
  const post = (b: unknown) =>
    app.request("/account/totp/disable", { method: "POST", headers: { cookie: `xudbin_session=${mine.token}`, "content-type": "application/json" }, body: JSON.stringify(b) });
  const enabled = () => (db.prepare("SELECT totp_secret FROM users WHERE id = ?").get(id) as { totp_secret: string | null }).totp_secret !== null;
  const code = codeAt(secret, Math.floor(Date.now() / 30_000));

  assert.equal((await post({ code })).status, 400); // parolasız
  assert.equal((await post({ code, password: "yanlis" })).status, 400);
  assert.equal(enabled(), true);
  assert.equal((await post({ code, password: "dogru-sifre-123" })).status, 200);
  assert.equal(enabled(), false);
  assert.deepEqual((db.prepare("SELECT id FROM sessions WHERE user_id = ?").all(id) as { id: string }[]).map((r) => r.id), [sha(mine.token)]);
});

test("2FA kapatma denemeleri sınırlanır (D2)", async () => {
  const secret = generateTotpSecret();
  const id = addUser("totp2@x.test", { password: "p", totp: secret });
  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(await hashPassword("dogru-sifre-123"), id);
  const app = settingsApp(id, "totp2@x.test");
  const post = (b: unknown) => app.request("/account/totp/disable", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
  for (let i = 0; i < 5; i++) assert.equal((await post({ code: "000000", password: "dogru-sifre-123" })).status, 400);
  // Doğru parola ve doğru kod bile 5 hatadan sonra engellenir.
  assert.equal((await post({ code: codeAt(secret, Math.floor(Date.now() / 30_000)), password: "dogru-sifre-123" })).status, 403);
  assert.notEqual((db.prepare("SELECT totp_secret FROM users WHERE id = ?").get(id) as { totp_secret: string | null }).totp_secret, null);
});

test("e-posta değişince diğer oturumlar kapanır (D2)", async () => {
  const id = addUser("mail@x.test", { password: "p" });
  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(await hashPassword("dogru-sifre-123"), id);
  const mine = createSession(id, {});
  createSession(id, {});
  const app = settingsApp(id, "mail@x.test");
  const res = await app.request("/account/profile", {
    method: "PUT",
    headers: { cookie: `xudbin_session=${mine.token}`, "content-type": "application/json" },
    body: JSON.stringify({ name: "T", email: "mail2@x.test", password: "dogru-sifre-123" }),
  });
  assert.equal(res.status, 200);
  const rows = db.prepare("SELECT id FROM sessions WHERE user_id = ?").all(id) as { id: string }[];
  assert.deepEqual(rows.map((r) => r.id), [sha(mine.token)]);
});

test("500 hatalarında ayrıntı istemciye gitmez, HttpError mesajı kalır (D4)", async () => {
  const app = new Hono()
    .get("/boom", () => {
      throw new Error("ENOENT: /srv/xudbin/data/secret.key");
    })
    .get("/user", () => {
      throw new HttpError(404, "Uygulama bulunamadı");
    });
  app.onError(errorResponse);
  const log = console.error;
  console.error = () => {};
  try {
    const boom = await app.request("/boom");
    assert.equal(boom.status, 500);
    assert.doesNotMatch(await boom.text(), /ENOENT|secret\.key/);
  } finally {
    console.error = log;
  }
  const user = await app.request("/user");
  assert.equal(user.status, 404);
  assert.deepEqual(await user.json(), { error: "Uygulama bulunamadı" });
});

test("SSO: yerel şifreli yönetici/2FA'lı hesaba bağlanmaz, üye yalnız açık ayarla (D3)", () => {
  const local = { password_hash: "pbkdf2$x", role: "member", totp_secret: null };
  assert.equal(ssoMayLogInto({ ...local, password_hash: "!sso" }, {}), true);
  assert.equal(ssoMayLogInto({ ...local, password_hash: "!sso", role: "admin" }, {}), true);
  assert.equal(ssoMayLogInto(local, {}), false);
  assert.equal(ssoMayLogInto(local, { linkExisting: true }), true);
  assert.equal(ssoMayLogInto({ ...local, role: "admin" }, { linkExisting: true }), false);
  assert.equal(ssoMayLogInto({ ...local, totp_secret: "enc" }, { linkExisting: true }), false);
});

test("SSO akışı: state tarayıcıya bağlı, email_verified true olmalı, bekleyen sayısı sınırlı (D3)", async (t) => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const claims: Record<string, unknown> = {};
  let nonce = "";
  let origin = "";
  const srv = createServer((req, res) => {
    const url = req.url ?? "";
    if (url.includes("openid-configuration")) {
      return res.end(JSON.stringify({ issuer: origin, authorization_endpoint: `${origin}/auth`, token_endpoint: `${origin}/token`, jwks_uri: `${origin}/jwks` }));
    }
    if (url.startsWith("/jwks")) return res.end(JSON.stringify({ keys: [jwk] }));
    const head = `${b64({ alg: "RS256", kid: "k1" })}.${b64({ iss: origin, aud: "xudbin", exp: Math.floor(Date.now() / 1000) + 300, nonce, email: "u@idp.test", ...claims })}`;
    res.end(JSON.stringify({ id_token: `${head}.${sign("RSA-SHA256", Buffer.from(head), privateKey).toString("base64url")}` }));
  }).listen(0);
  t.after(() => srv.close());
  await new Promise((r) => srv.once("listening", r));
  origin = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  updateSettings({ oidc: { issuer: origin, clientId: "xudbin", clientSecret: encrypt("s"), label: "", autoCreate: false, allowedDomains: "" } });
  t.after(() => updateSettings({ oidc: null }));
  const begin = async () => {
    const { url, state } = await startLogin("http://panel.test/cb");
    nonce = new URL(url).searchParams.get("nonce")!;
    return state;
  };

  // Çerez yok ya da başka bir tarayıcının state'i: reddedilir.
  await assert.rejects(finishLogin(await begin(), "c", ""), /bu tarayıcıdan başlatılmamış/);
  await assert.rejects(finishLogin(await begin(), "c", "baska-state"), /bu tarayıcıdan başlatılmamış/);
  // email_verified yok ya da "true" metni: reddedilir; yalnız boolean true geçer.
  let s = await begin();
  await assert.rejects(finishLogin(s, "c", s), /doğrulanmamış/);
  claims.email_verified = "true";
  s = await begin();
  await assert.rejects(finishLogin(s, "c", s), /doğrulanmamış/);
  claims.email_verified = true;
  s = await begin();
  assert.equal((await finishLogin(s, "c", s)).email, "u@idp.test");
  // State tek kullanımlık.
  await assert.rejects(finishLogin(s, "c", s), /süresi doldu/);

  // Yetkisiz /start ile bekleyen harita şişirilemez.
  await assert.rejects(async () => {
    for (let i = 0; i < 600; i++) await startLogin("http://panel.test/cb");
  }, /Çok fazla bekleyen/);
});
