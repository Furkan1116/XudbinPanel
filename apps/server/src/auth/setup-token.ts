import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";

/**
 * Panel internete açıldığı an ile yönetici hesabının oluşturulması arasında başkasının
 * kurulumu ele geçirmesini önler: hesap yalnızca sunucuda üretilen bu anahtarla oluşturulabilir.
 * Anahtar DATA_DIR/setup-token dosyasında durur; kurulum bitince silinir.
 */
const tokenFile = path.join(config.dataDir, "setup-token");

export function ensureSetupToken(): string {
  if (fs.existsSync(tokenFile)) return fs.readFileSync(tokenFile, "utf8").trim();
  const token = randomBytes(18).toString("base64url");
  fs.writeFileSync(tokenFile, token, { mode: 0o600 });
  return token;
}

export function checkSetupToken(candidate: unknown): boolean {
  if (typeof candidate !== "string" || !fs.existsSync(tokenFile)) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(fs.readFileSync(tokenFile, "utf8").trim());
  return a.length === b.length && timingSafeEqual(a, b);
}

export function clearSetupToken() {
  fs.rmSync(tokenFile, { force: true });
}
