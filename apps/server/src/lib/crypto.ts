import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";

/**
 * Veritabanındaki hassas alanlar (SSH anahtarları, git token'ları, ortam değişkenleri,
 * veritabanı şifreleri) AES-256-GCM ile şifrelenir. Anahtar DATA_DIR/secret.key dosyasındadır;
 * veritabanı dosyası tek başına sızarsa bu değerler okunamaz.
 */
const keyFile = path.join(config.dataDir, "secret.key");
fs.mkdirSync(config.dataDir, { recursive: true });
if (!fs.existsSync(keyFile)) fs.writeFileSync(keyFile, randomBytes(32), { mode: 0o600 });
const KEY = fs.readFileSync(keyFile);

export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", KEY, iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), data.toString("base64url")].join(".");
}

export function decrypt(payload: string | null | undefined): string {
  if (!payload) return "";
  const [v, iv, tag, data] = payload.split(".");
  if (v !== "v1" || !iv || !tag || !data) throw new Error("Şifreli veri bozuk");
  const decipher = createDecipheriv("aes-256-gcm", KEY, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
}

export const randomToken = (bytes = 24) => randomBytes(bytes).toString("base64url");

/** Harf ve rakamdan oluşan, URL/kullanıcı adı/şifre olarak güvenle kullanılabilecek rastgele dize. */
export function randomAlnum(length: number) {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const bytes = randomBytes(length);
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}

/** Sunucuda tutulmayan, imzalı ve süreli değer (ör. OAuth state); panel yeniden başlasa da doğrulanır. */
export function signedToken(purpose: string) {
  const body = `${Date.now()}.${randomBytes(12).toString("base64url")}`;
  return `${body}.${createHmac("sha256", KEY).update(`${purpose}:${body}`).digest("base64url")}`;
}

export function verifySignedToken(purpose: string, token: string, maxAgeMs: number) {
  const [ts, rand, sig] = token.split(".");
  if (!ts || !rand || !sig) return false;
  const expected = Buffer.from(createHmac("sha256", KEY).update(`${purpose}:${ts}.${rand}`).digest("base64url"));
  const got = Buffer.from(sig);
  return got.length === expected.length && timingSafeEqual(got, expected) && Date.now() - Number(ts) < maxAgeMs;
}
