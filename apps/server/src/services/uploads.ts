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
/** Geçici (henüz uygulamaya bağlanmamış) yüklemelerin toplam disk sınırı; dolunca yeni yükleme reddedilir. */
export const MAX_TMP_BYTES = 2 * 1024 * 1024 * 1024;
/** Kullanıcı başına saatlik kota ve eşzamanlılık (O9). */
export const UPLOADS_PER_HOUR = 20;
export const UPLOAD_BYTES_PER_HOUR = 1024 * 1024 * 1024;
const MAX_CONCURRENT_PER_USER = 1;
const MAX_CONCURRENT_TOTAL = 3;
const ROOT = path.join(config.dataDir, "uploads");
const TMP = path.join(ROOT, "tmp");

export const appUploadDir = (slug: string) => path.join(ROOT, slug);

export class UploadLimitError extends Error {
  constructor(message: string, readonly status: 429 | 507 = 429) {
    super(message);
  }
}

const active = new Map<number, number>();
let activeTotal = 0;
const history = new Map<number, { at: number; bytes: number }[]>();

/** Geçici yükleme klasörünün şu anki toplam boyutu. */
export function tmpUsedBytes() {
  if (!fs.existsSync(TMP)) return 0;
  let total = 0;
  for (const f of fs.readdirSync(TMP)) total += fs.statSync(path.join(TMP, f), { throwIfNoEntry: false })?.size ?? 0;
  return total;
}

/**
 * Yükleme başlamadan önce çağrılır: kullanıcının aynı anda tek yüklemesi, sunucuda en fazla 3 eşzamanlı yükleme,
 * saatte 20 yükleme / 1 GB sınırı ve geçici klasör doluluğu denetlenir. Dönen `finish(bytes)` her durumda çağrılmalı;
 * alınan bayt sayısı kotaya yazılır. Sayaçlar bellektedir (panel yeniden başlayınca sıfırlanır).
 */
export function beginUpload(userId: number, now = Date.now()) {
  const recent = (history.get(userId) ?? []).filter((h) => h.at > now - 3_600_000);
  history.set(userId, recent);
  if ((active.get(userId) ?? 0) >= MAX_CONCURRENT_PER_USER) throw new UploadLimitError("Zaten devam eden bir yüklemen var; bitmesini bekle");
  if (activeTotal >= MAX_CONCURRENT_TOTAL) throw new UploadLimitError("Sunucu şu an çok sayıda yükleme alıyor; biraz sonra tekrar dene");
  if (recent.length >= UPLOADS_PER_HOUR) throw new UploadLimitError(`Saatte en fazla ${UPLOADS_PER_HOUR} yükleme yapabilirsin; biraz sonra tekrar dene`);
  const used = recent.reduce((n, h) => n + h.bytes, 0);
  if (used >= UPLOAD_BYTES_PER_HOUR) throw new UploadLimitError(`Saatte en fazla ${UPLOAD_BYTES_PER_HOUR / 1024 ** 3} GB yükleyebilirsin; biraz sonra tekrar dene`);
  const tmpFree = MAX_TMP_BYTES - tmpUsedBytes();
  if (tmpFree <= 0) throw new UploadLimitError("Geçici yükleme alanı dolu; birkaç saat sonra tekrar dene", 507);
  active.set(userId, (active.get(userId) ?? 0) + 1);
  activeTotal++;
  let done = false;
  return {
    /** Bu yüklemenin alabileceği en fazla bayt (dosya, saatlik kota ve geçici klasör boşluğunun en küçüğü). */
    maxBytes: Math.min(MAX_UPLOAD_BYTES, UPLOAD_BYTES_PER_HOUR - used, tmpFree),
    finish(bytes: number, at = Date.now()) {
      if (done) return;
      done = true;
      activeTotal--;
      const n = (active.get(userId) ?? 1) - 1;
      if (n <= 0) active.delete(userId);
      else active.set(userId, n);
      history.set(userId, [...(history.get(userId) ?? []), { at, bytes }]);
    },
  };
}

/** İstek gövdesini diske akıtır; sınırı aşarsa yarım dosyayı silip hata verir. `progress.bytes` alınan bayt sayısını yansıtır. */
export async function saveUpload(stream: ReadableStream<Uint8Array>, dest: string, opts: { maxBytes?: number; progress?: { bytes: number } } = {}) {
  const limit = Math.min(opts.maxBytes ?? MAX_UPLOAD_BYTES, MAX_UPLOAD_BYTES);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const out = fs.createWriteStream(dest);
  let size = 0;
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (opts.progress) opts.progress.bytes = size;
      if (size > limit) throw new Error(limit < MAX_UPLOAD_BYTES ? "Yükleme kotası ya da geçici alan sınırı aşıldı" : `Dosya ${MAX_UPLOAD_BYTES / 1024 / 1024} MB sınırını aşıyor`);
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

/** Klasörün gerçek toplam boyutu (kısayollar izlenmez). */
function dirBytes(dir: string): number {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop()!;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else total += fs.lstatSync(p, { throwIfNoEntry: false })?.size ?? 0;
    }
  }
  return total;
}

/**
 * unzip'i çalıştırır ve açma sürerken diske yazılan gerçek toplamı izler: arşivin beyan ettiği boyut yalan olsa bile
 * (zip bombası) sınır aşılınca süreç öldürülür ve yarım klasör silinir.
 */
export async function unzipWithLimit(zip: string, dest: string, maxBytes: number, pollMs = 500): Promise<void> {
  let exceeded = false;
  await new Promise<void>((resolve, reject) => {
    const p = spawn("unzip", ["-q", "-o", zip, "-d", dest]);
    let err = "";
    const watch = setInterval(() => {
      try {
        if (dirBytes(dest) > maxBytes) {
          exceeded = true;
          p.kill("SIGKILL");
        }
      } catch {}
    }, pollMs);
    p.stderr.on("data", (d) => (err += d));
    p.on("error", () => (clearInterval(watch), reject(new Error("unzip bulunamadı"))));
    p.on("close", (code) => {
      clearInterval(watch);
      if (exceeded) return resolve();
      code === 0 || code === 1 ? resolve() : reject(new Error(`Arşiv açılamadı: ${err.trim().split("\n").pop() || code}`));
    });
  });
  if (!exceeded && dirBytes(dest) > maxBytes) exceeded = true;
  if (exceeded) {
    fs.rmSync(dest, { recursive: true, force: true });
    throw new Error(`Arşiv açılırken ${(maxBytes / 1024 ** 3).toFixed(maxBytes >= 1024 ** 3 ? 1 : 3)} GB sınırı aşıldı; açma durduruldu`);
  }
}

export async function extractZip(zip: string, dest: string): Promise<string> {
  const totals = await zipTotals(zip);
  if (totals.bytes > MAX_EXTRACTED_BYTES) throw new Error(`Arşiv açıldığında ${(totals.bytes / 1024 ** 3).toFixed(1)} GB yer kaplıyor; sınır ${MAX_EXTRACTED_BYTES / 1024 ** 3} GB`);
  if (totals.files > MAX_FILES) throw new Error(`Arşivde ${totals.files} dosya var; sınır ${MAX_FILES}`);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  await unzipWithLimit(zip, dest, MAX_EXTRACTED_BYTES);
  // Zip'teki kısayollar (symlink) klasör dışını gösteremez.
  removeEscapingSymlinks(dest);
  const entries = fs.readdirSync(dest).filter((n) => n !== "__MACOSX" && n !== ".DS_Store");
  if (entries.length === 1 && fs.statSync(path.join(dest, entries[0]!)).isDirectory()) return path.join(dest, entries[0]!);
  return dest;
}
