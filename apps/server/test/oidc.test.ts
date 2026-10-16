import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { verifyIdToken } from "../src/auth/oidc.js";

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
function jwt(payload: Record<string, unknown>, key = privateKey, kid = "k1") {
  const head = `${b64({ alg: "RS256", kid, typ: "JWT" })}.${b64(payload)}`;
  return `${head}.${sign("RSA-SHA256", Buffer.from(head), key).toString("base64url")}`;
}

test("id_token doğrulaması: imza, sağlayıcı, alıcı, süre ve nonce", async (t) => {
  const srv = createServer((_req, res) => res.end(JSON.stringify({ keys: [jwk] }))).listen(0);
  t.after(() => srv.close());
  await new Promise((r) => srv.once("listening", r));
  const jwks = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/jwks`;
  const cfg = { issuer: "https://idp.test/realm", clientId: "xudbin" };
  const now = Math.floor(Date.now() / 1000);
  const good = { iss: cfg.issuer, aud: "xudbin", exp: now + 300, nonce: "n1", email: "a@b.c" };

  const claims = await verifyIdToken(jwt(good), cfg, jwks, "n1");
  assert.equal(claims.email, "a@b.c");

  await assert.rejects(verifyIdToken(jwt(good, other.privateKey), cfg, jwks, "n1"), /imzası geçersiz/);
  await assert.rejects(verifyIdToken(jwt({ ...good, email: "admin@b.c" }).replace(/\.[^.]+\./, `.${b64({ ...good, email: "admin@b.c", x: 1 })}.`), cfg, jwks, "n1"), /imzası geçersiz/);
  await assert.rejects(verifyIdToken(jwt({ ...good, iss: "https://evil.test" }), cfg, jwks, "n1"), /başka bir sağlayıcı/);
  await assert.rejects(verifyIdToken(jwt({ ...good, aud: "baska-uygulama" }), cfg, jwks, "n1"), /bu uygulama için/);
  await assert.rejects(verifyIdToken(jwt({ ...good, exp: now - 3600 }), cfg, jwks, "n1"), /süresi dolmuş/);
  await assert.rejects(verifyIdToken(jwt(good), cfg, jwks, "n2"), /nonce/);
  await assert.rejects(verifyIdToken(jwt(good, privateKey, "bilinmeyen"), cfg, jwks, "n1"), /anahtarı bulunamadı/);
  const none = `${b64({ alg: "none" })}.${b64(good)}.x`;
  await assert.rejects(verifyIdToken(none, cfg, jwks, "n1"), /Desteklenmeyen/);
});
