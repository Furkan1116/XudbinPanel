import { generateKeyPairSync, randomBytes } from "node:crypto";
import ssh2 from "ssh2";

const { Client, utils } = ssh2;
import { db } from "../db.js";
import { decrypt, encrypt } from "../lib/crypto.js";

export type SshTarget = { host: string; port: number; username: string; privateKey: string };

/**
 * Yeni bir ed25519 anahtar çifti üretir. Gizli anahtar OpenSSH biçiminde
 * ("-----BEGIN OPENSSH PRIVATE KEY-----") kodlanır; hem ssh2 hem de ssh istemcisi bunu okur.
 */
export function generateSshKey(name: string) {
  const comment = `xudbin-${name.trim().replace(/\s+/g, "-")}`;
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pub = Buffer.from(publicKey.export({ format: "jwk" }).x!, "base64url");
  const seed = Buffer.from(privateKey.export({ format: "jwk" }).d!, "base64url");

  const str = (b: Buffer | string) => {
    const buf = Buffer.isBuffer(b) ? b : Buffer.from(b);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(buf.length);
    return Buffer.concat([len, buf]);
  };
  const u32 = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n);
    return b;
  };
  const pubBlob = Buffer.concat([str("ssh-ed25519"), str(pub)]);
  const check = randomBytes(4).readUInt32BE();
  let priv = Buffer.concat([u32(check), u32(check), str("ssh-ed25519"), str(pub), str(Buffer.concat([seed, pub])), str(comment)]);
  const pad = (8 - (priv.length % 8)) % 8;
  priv = Buffer.concat([priv, Buffer.from(Array.from({ length: pad }, (_, i) => i + 1))]);
  const body = Buffer.concat([Buffer.from("openssh-key-v1\0"), str("none"), str("none"), str(""), u32(1), str(pubBlob), str(priv)]);
  const pem = `-----BEGIN OPENSSH PRIVATE KEY-----\n${body.toString("base64").replace(/.{1,70}/g, "$&\n")}-----END OPENSSH PRIVATE KEY-----\n`;

  const parsed = utils.parseKey(pem);
  if (parsed instanceof Error) throw parsed;
  const openSshPublic = `ssh-ed25519 ${pubBlob.toString("base64")} ${comment}`;
  const result = db
    .prepare("INSERT INTO ssh_keys (name, public_key, private_key, created_at) VALUES (?, ?, ?, ?)")
    .run(name, openSshPublic, encrypt(pem), Date.now());
  return { id: Number(result.lastInsertRowid), publicKey: openSshPublic };
}

export function getPrivateKey(keyId: number) {
  const row = db.prepare("SELECT private_key FROM ssh_keys WHERE id = ?").get(keyId) as { private_key: string } | undefined;
  if (!row) throw new Error("SSH anahtarı bulunamadı");
  return decrypt(row.private_key);
}

/** Uzak sunucuda tek bir komut çalıştırır; çıktıyı satır satır onLine'a verir. */
export function sshExec(
  target: SshTarget,
  command: string,
  opts: { onLine?: (line: string) => void; timeoutMs?: number; stdin?: string } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let stdout = "";
    let stderr = "";
    let buffer = "";
    const timer = setTimeout(() => {
      conn.end();
      reject(new Error("Komut zaman aşımına uğradı"));
    }, opts.timeoutMs ?? 60_000);

    const emit = (chunk: string) => {
      if (!opts.onLine) return;
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      lines.forEach((l) => opts.onLine!(l));
    };

    conn
      .on("ready", () => {
        conn.exec(command, (err, stream) => {
          if (err) {
            clearTimeout(timer);
            conn.end();
            return reject(err);
          }
          stream
            .on("close", (code: number | null) => {
              clearTimeout(timer);
              if (buffer && opts.onLine) opts.onLine(buffer);
              conn.end();
              resolve({ code: code ?? 0, stdout, stderr });
            })
            .on("data", (d: Buffer) => {
              stdout += d.toString();
              emit(d.toString());
            });
          stream.stderr.on("data", (d: Buffer) => {
            stderr += d.toString();
            emit(d.toString());
          });
          if (opts.stdin !== undefined) stream.end(opts.stdin);
        });
      })
      .on("error", (err) => {
        clearTimeout(timer);
        reject(friendlySshError(err));
      })
      .connect({
        host: target.host,
        port: target.port,
        username: target.username,
        privateKey: target.privateKey,
        readyTimeout: 15_000,
      });
  });
}

export function friendlySshError(err: Error & { level?: string; code?: string }) {
  if (err.level === "client-authentication")
    return new Error("SSH kimlik doğrulaması başarısız. Açık anahtarı sunucudaki ~/.ssh/authorized_keys dosyasına eklediğinden emin ol.");
  if (err.code === "ECONNREFUSED") return new Error("SSH bağlantısı reddedildi. Port doğru mu, sshd çalışıyor mu?");
  if (err.code === "ETIMEDOUT" || err.message.includes("Timed out")) return new Error("Sunucuya ulaşılamadı (zaman aşımı). IP ve güvenlik duvarını kontrol et.");
  if (err.code === "ENOTFOUND") return new Error("Sunucu adresi çözümlenemedi.");
  return err;
}
