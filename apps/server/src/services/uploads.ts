import { spawn } from "node:child_process";
import fs from "node:fs";
import { removeEscapingSymlinks } from "../lib/paths.js";
import path from "node:path";
import { config } from "../config.js";
import { randomAlnum } from "../lib/crypto.js";

/**
 * Sürükle-bırak ile yüklenen proje arşivleri. Tarayıcı klasörü zip'ler; zip dosyası doğrudan da yüklenebilir.
 * Geçici yüklemeler (uygulama henüz oluşturulmadan algılama için) 2 saat sonra silinir.
 */
export const MAX_UPLOAD_BYTES = 300 * 1024 * 1024;
const ROOT = path.join(config.dataDir, "uploads");
const TMP = path.join(ROOT, "tmp");

export const appUploadDir = (slug: string) => path.join(ROOT, slug);

/** İstek gövdesini diske akıtır; sınırı aşarsa yarım dosyayı silip hata verir. */
export async function saveUpload(stream: ReadableStream<Uint8Array>, dest: string) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const out = fs.createWriteStream(dest);
  let size = 0;
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_UPLOAD_BYTES) throw new Error(`Dosya ${MAX_UPLOAD_BYTES / 1024 / 1024} MB sınırını aşıyor`);
      if (!out.write(value)) await new Promise((r) => out.once("drain", r));
    }
    await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
  } catch (err) {
    out.destroy();
    fs.rmSync(dest, { force: true });
    throw err;
  }
  if (size === 0) {
    fs.rmSync(dest, { force: true });
    throw new Error("Boş dosya");
  }
  return size;
}

export function newTempUpload() {
  cleanTemp();
  const id = randomAlnum(16);
  return { id, file: path.join(TMP, `${id}.zip`) };
}

export function tempUploadFile(id: string) {
  if (!/^[A-Za-z0-9]{16}$/.test(id)) return null;
  const f = path.join(TMP, `${id}.zip`);
  return fs.existsSync(f) ? f : null;
}

function cleanTemp() {
  if (!fs.existsSync(TMP)) return;
  const cutoff = Date.now() - 2 * 3_600_000;
  for (const f of fs.readdirSync(TMP)) {
    const p = path.join(TMP, f);
    if (fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p, { recursive: true, force: true });
  }
}

/** Uygulamanın yükleme klasörüne yeni sürüm olarak taşır; son 3 sürüm tutulur. */
export function storeAppUpload(slug: string, file: string) {
  const dir = appUploadDir(slug);
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `${Date.now()}.zip`);
  fs.renameSync(file, dest);
  const all = fs.readdirSync(dir).filter((f) => f.endsWith(".zip")).sort();
  for (const old of all.slice(0, -3)) fs.rmSync(path.join(dir, old), { force: true });
  return dest;
}

export function latestAppUpload(slug: string) {
  const dir = appUploadDir(slug);
  if (!fs.existsSync(dir)) return null;
  const last = fs.readdirSync(dir).filter((f) => f.endsWith(".zip")).sort().pop();
  return last ? path.join(dir, last) : null;
}

/**
 * Zip'i açar. Tek bir üst klasörden oluşuyorsa (ör. proje-main/) o klasörü kök kabul eder.
 * unzip, ../ içeren yolları dışarı yazmaz.
 */
/** Arşiv açılınca en fazla bu kadar yer kaplayabilir; küçük bir "zip bombası" diski dolduramasın. */
export const MAX_EXTRACTED_BYTES = 3 * 1024 * 1024 * 1024;
const MAX_FILES = 200_000;

/** unzip -Zt özeti: "N files, X bytes uncompressed, Y bytes compressed". */
async function zipTotals(zip: string): Promise<{ files: number; bytes: number }> {
  const out = await new Promise<string>((resolve, reject) => {
    const p = spawn("unzip", ["-Zt", zip]);
    let text = "";
    p.stdout.on("data", (d) => (text += d));
    p.on("error", () => reject(new Error("unzip bulunamadı")));
    p.on("close", () => resolve(text));
  });
  const m = out.match(/(\d+) files?, (\d+) bytes uncompressed/);
  if (!m) throw new Error("Arşiv okunamadı; geçerli bir zip dosyası değil");
  return { files: Number(m[1]), bytes: Number(m[2]) };
}

export async function extractZip(zip: string, dest: string): Promise<string> {
  const totals = await zipTotals(zip);
  if (totals.bytes > MAX_EXTRACTED_BYTES) throw new Error(`Arşiv açıldığında ${(totals.bytes / 1024 ** 3).toFixed(1)} GB yer kaplıyor; sınır ${MAX_EXTRACTED_BYTES / 1024 ** 3} GB`);
  if (totals.files > MAX_FILES) throw new Error(`Arşivde ${totals.files} dosya var; sınır ${MAX_FILES}`);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const p = spawn("unzip", ["-q", "-o", zip, "-d", dest]);
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("error", () => reject(new Error("unzip bulunamadı")));
    p.on("close", (code) => (code === 0 || code === 1 ? resolve() : reject(new Error(`Arşiv açılamadı: ${err.trim().split("\n").pop() || code}`))));
  });
  // Zip'teki kısayollar (symlink) klasör dışını gösteremez.
  removeEscapingSymlinks(dest);
  const entries = fs.readdirSync(dest).filter((n) => n !== "__MACOSX" && n !== ".DS_Store");
  if (entries.length === 1 && fs.statSync(path.join(dest, entries[0]!)).isDirectory()) return path.join(dest, entries[0]!);
  return dest;
}
