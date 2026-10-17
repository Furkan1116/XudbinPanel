import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import fs from "node:fs";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { deriveKey } from "./crypto.js";

/**
 * Veritabanı ve volume yedeklerinin şifrelenmesi (varsayılan, kapatılamaz).
 *
 * Biçim ("XBE1"): MAGIC | tuz(16) | nonce öneki(4) | blok* ; her blok ≤ 64 KiB düz metin + 16 bayt GCM etiketi.
 * Blok nonce'u = önek + 8 baytlık sıra sayısı; son blok AAD ile işaretlenir, böylece blok silme/ekleme/sıra
 * değiştirme ve dosya kesilmesi çözmede hata verir. Anahtar, panelin secret.key dosyasından dosya başına
 * ayrı türetilir (HKDF); yani yedek yalnız aynı secret.key ile açılır (panel yedeği secret.key'i taşır).
 * Dosya akış halinde işlenir, belleğe alınmaz. Eski (şifresiz) yedekler gzip başlığıyla ayırt edilip olduğu gibi okunur.
 */
export const MAGIC = Buffer.from("XUDBINBE1\n");
export const ENCRYPTED_EXT = ".xbe";
export const PURPOSE = "xudbin-backup-v1";
const CHUNK = 64 * 1024;
const TAG = 16;
const HEADER = MAGIC.length + 16 + 4;

export type Derive = (salt: Buffer) => Buffer;
export const defaultDerive: Derive = (salt) => deriveKey(PURPOSE, salt);

/** secret.key dosyasının bir kopyasından (ör. panel yedeğinden çıkarılan) anahtar türetir; başka makinede açmak için. */
export const deriveFromKeyFile =
  (keyFile: string): Derive =>
  (salt) =>
    Buffer.from(hkdfSync("sha256", fs.readFileSync(keyFile), salt, PURPOSE, 32));

const nonce = (prefix: Buffer, index: number) => {
  const n = Buffer.alloc(12);
  prefix.copy(n, 0);
  n.writeBigUInt64BE(BigInt(index), 4);
  return n;
};
const aad = (last: boolean) => Buffer.from([last ? 1 : 0]);

export function encryptStream(derive: Derive = defaultDerive): Transform {
  const salt = randomBytes(16);
  const prefix = randomBytes(4);
  const key = derive(salt);
  let buf: Buffer = Buffer.alloc(0);
  let index = 0;
  let started = false;
  const seal = (plain: Buffer, last: boolean) => {
    const c = createCipheriv("aes-256-gcm", key, nonce(prefix, index++), { authTagLength: TAG });
    c.setAAD(aad(last));
    return Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
  };
  const head = () => {
    if (started) return [];
    started = true;
    return [MAGIC, salt, prefix];
  };
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      const out = head();
      // Son blok flush'ta kapatılır; bu yüzden en az bir bayt hep geride tutulur.
      while (buf.length > CHUNK) {
        out.push(seal(buf.subarray(0, CHUNK), false));
        buf = buf.subarray(CHUNK);
      }
      cb(null, out.length ? Buffer.concat(out) : undefined);
    },
    flush(cb) {
      cb(null, Buffer.concat([...head(), seal(buf, true)]));
    },
  });
}

export function decryptStream(derive: Derive = defaultDerive): Transform {
  let buf: Buffer = Buffer.alloc(0);
  let key: Buffer | null = null;
  let prefix: Buffer = Buffer.alloc(0);
  let index = 0;
  const open = (block: Buffer, last: boolean) => {
    const d = createDecipheriv("aes-256-gcm", key!, nonce(prefix, index++), { authTagLength: TAG });
    d.setAAD(aad(last));
    d.setAuthTag(block.subarray(block.length - TAG));
    return Buffer.concat([d.update(block.subarray(0, block.length - TAG)), d.final()]);
  };
  const bad = () => new Error("Yedek şifresi çözülemedi: dosya bozuk, kesilmiş ya da başka bir secret.key ile şifrelenmiş");
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      try {
        buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
        if (!key) {
          if (buf.length < HEADER) return cb();
          if (!buf.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("Bu bir şifreli Xudbin yedeği değil");
          key = derive(buf.subarray(MAGIC.length, MAGIC.length + 16));
          prefix = buf.subarray(MAGIC.length + 16, HEADER);
          buf = buf.subarray(HEADER);
        }
        const out: Buffer[] = [];
        // Tam bir bloktan fazlası varsa baştaki blok kesinlikle son değildir.
        while (buf.length > CHUNK + TAG) {
          out.push(open(buf.subarray(0, CHUNK + TAG), false));
          buf = buf.subarray(CHUNK + TAG);
        }
        cb(null, out.length ? Buffer.concat(out) : undefined);
      } catch (e) {
        cb(e instanceof Error && e.message.startsWith("Bu bir") ? e : bad());
      }
    },
    flush(cb) {
      try {
        if (!key || buf.length < TAG) throw bad();
        cb(null, open(buf, true));
      } catch {
        cb(bad());
      }
    },
  });
}

export function isEncryptedBackup(file: string): boolean {
  const fd = fs.openSync(file, "r");
  try {
    const head = Buffer.alloc(MAGIC.length);
    const n = fs.readSync(fd, head, 0, head.length, 0);
    return n === MAGIC.length && head.equals(MAGIC);
  } finally {
    fs.closeSync(fd);
  }
}

/** Yedeğin tamamını çözerek (tüm GCM etiketleri) bütünlüğünü doğrular; şifresiz eski yedekte bir şey yapmaz. */
export async function assertBackupIntact(file: string, derive: Derive = defaultDerive) {
  if (!isEncryptedBackup(file)) return;
  await pipeline(fs.createReadStream(file), decryptStream(derive), new Transform({ transform: (_c, _e, cb) => cb() }));
}

/** Yedek dosyasının gzip'i açılmış düz içeriği. Şifreliyse önce bütünlük doğrulanır, böylece yarım/bozuk veri geri yüklemeye akmaz. */
export async function openBackupPlain(file: string, derive: Derive = defaultDerive): Promise<Readable> {
  const src = fs.createReadStream(file);
  if (!isEncryptedBackup(file)) return src.pipe(createGunzip());
  await assertBackupIntact(file, derive);
  const dec = decryptStream(derive);
  src.on("error", (e) => dec.destroy(e));
  return src.pipe(dec).pipe(createGunzip());
}

/** Şifreli yedeği çözüp gzip olarak yazar (CLI `backup decrypt`). */
export async function decryptBackupFile(file: string, out: NodeJS.WritableStream, derive: Derive = defaultDerive) {
  if (!isEncryptedBackup(file)) throw new Error("Bu dosya şifreli bir Xudbin yedeği değil (eski yedekler zaten yalnız gzip'tir)");
  // Önce bütünlük: bozuk dosya çıktıya yarım yazılmasın.
  await assertBackupIntact(file, derive);
  await pipeline(fs.createReadStream(file), decryptStream(derive), out as never);
}
