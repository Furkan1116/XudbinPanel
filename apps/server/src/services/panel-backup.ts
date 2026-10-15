import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import tarStream from "tar-stream";
import { config } from "../config.js";
import { db } from "../db.js";
import { decrypt } from "../lib/crypto.js";
import { getSettings, updateSettings } from "../lib/settings.js";
import { s3Delete, s3Upload } from "../lib/s3.js";
import { notify } from "./notify.js";
import { offsiteTarget } from "./offsite.js";

/**
 * Panelin kendi yedeği: veritabanı (sunucular, uygulamalar, şifreli env'ler...) ve şifreleme anahtarı.
 * Yöneticinin belirlediği yedek şifresiyle AES-256-GCM ile şifrelenir; sunucu tamamen giderse
 * yeni bir kurulumda `xudbin restore` ile geri yüklenir.
 */
const MAGIC = Buffer.from("XUDBINBK1\n");
export const PANEL_BACKUP_DIR = path.join(config.dataDir, "backups", "_panel");

const kdf = (pass: string, salt: Buffer) => scryptSync(pass, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });

export function encryptArchive(plain: Buffer, pass: string) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", kdf(pass, salt), iv);
  const data = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([MAGIC, salt, iv, data, cipher.getAuthTag()]);
}

export function decryptArchive(file: Buffer, pass: string) {
  if (!file.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("Bu bir Xudbin panel yedeği değil");
  let o = MAGIC.length;
  const salt = file.subarray(o, (o += 16));
  const iv = file.subarray(o, (o += 12));
  const tag = file.subarray(file.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", kdf(pass, salt), iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(file.subarray(o, file.length - 16)), decipher.final()]);
  } catch {
    throw new Error("Yedek şifresi yanlış veya dosya bozuk");
  }
}

async function packTar(files: Record<string, Buffer>) {
  const pack = tarStream.pack();
  const chunks: Buffer[] = [];
  pack.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise((r) => pack.on("end", r));
  for (const [name, content] of Object.entries(files)) pack.entry({ name, mode: 0o600 }, content);
  pack.finalize();
  await done;
  return Buffer.concat(chunks);
}

export async function unpackTar(buf: Buffer) {
  const extract = tarStream.extract();
  const out: Record<string, Buffer> = {};
  await new Promise<void>((resolve, reject) => {
    extract.on("entry", (header, stream, next) => {
      const parts: Buffer[] = [];
      stream.on("data", (c: Buffer) => parts.push(c));
      stream.on("end", () => {
        out[header.name] = Buffer.concat(parts);
        next();
      });
      stream.resume();
    });
    extract.on("finish", resolve);
    extract.on("error", reject);
    extract.end(buf);
  });
  return out;
}

export async function createPanelBackup() {
  const s = getSettings();
  if (!s.panelBackupPassphrase) throw new Error("Önce panel yedeği için bir şifre belirle");
  const pass = decrypt(s.panelBackupPassphrase);
  fs.mkdirSync(PANEL_BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const file = `xudbin-panel-${stamp}.xbk`;
  const id = Number(db.prepare("INSERT INTO panel_backups (file, status, created_at) VALUES (?, 'running', ?)").run(file, Date.now()).lastInsertRowid);
  const snapshot = path.join(PANEL_BACKUP_DIR, `.snapshot-${id}.db`);
  try {
    // Çalışan veritabanının tutarlı bir kopyası.
    db.exec(`VACUUM INTO '${snapshot.replace(/'/g, "''")}'`);
    const tar = await packTar({
      "xudbin.db": fs.readFileSync(snapshot),
      "secret.key": fs.readFileSync(path.join(config.dataDir, "secret.key")),
      "manifest.json": Buffer.from(JSON.stringify({ format: 1, createdAt: Date.now() })),
    });
    const full = path.join(PANEL_BACKUP_DIR, file);
    fs.writeFileSync(full, encryptArchive(gzipSync(tar), pass), { mode: 0o600 });
    const size = fs.statSync(full).size;
    db.prepare("UPDATE panel_backups SET status = 'success', size = ? WHERE id = ?").run(size, id);
    updateSettings({ lastPanelBackupAt: Date.now() });
    const target = offsiteTarget();
    if (target) {
      try {
        const key = await s3Upload(target, `panel/${file}`, full);
        db.prepare("UPDATE panel_backups SET remote_key = ? WHERE id = ?").run(key, id);
      } catch (e) {
        db.prepare("UPDATE panel_backups SET remote_error = ? WHERE id = ?").run((e as Error).message, id);
        notify("backup_failed", "Panel yedeği uzak depolamaya yüklenemedi", (e as Error).message);
      }
    }
    await prunePanelBackups();
    return id;
  } catch (e) {
    db.prepare("UPDATE panel_backups SET status = 'failed', error = ? WHERE id = ?").run((e as Error).message, id);
    notify("backup_failed", "Panel yedeği alınamadı", (e as Error).message);
    throw e;
  } finally {
    fs.rmSync(snapshot, { force: true });
  }
}

async function prunePanelBackups() {
  const keep = Math.max(1, getSettings().panelBackupKeep);
  const old = db.prepare("SELECT id, file, remote_key FROM panel_backups WHERE status = 'success' ORDER BY id DESC LIMIT -1 OFFSET ?").all(keep) as {
    id: number;
    file: string;
    remote_key: string | null;
  }[];
  const target = offsiteTarget();
  for (const b of old) {
    fs.rmSync(path.join(PANEL_BACKUP_DIR, b.file), { force: true });
    if (b.remote_key && target) await s3Delete(target, b.remote_key).catch(() => {});
    db.prepare("DELETE FROM panel_backups WHERE id = ?").run(b.id);
  }
  db.prepare("DELETE FROM panel_backups WHERE status = 'failed' AND id NOT IN (SELECT id FROM panel_backups ORDER BY id DESC LIMIT 20)").run();
}

export function startPanelBackupScheduler() {
  setInterval(() => {
    const s = getSettings();
    if (!s.panelBackupPassphrase || s.panelBackupIntervalH <= 0) return;
    if (s.lastPanelBackupAt && s.lastPanelBackupAt + s.panelBackupIntervalH * 3_600_000 > Date.now()) return;
    updateSettings({ lastPanelBackupAt: Date.now() });
    createPanelBackup().catch((e) => console.error("Panel yedeği alınamadı:", (e as Error).message));
  }, 5 * 60_000).unref();
}
