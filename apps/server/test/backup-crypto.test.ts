import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { test } from "node:test";
import { createGzip, gunzipSync, gzipSync } from "node:zlib";
import { config } from "../src/config.js";
import { MAGIC, deriveFromKeyFile, assertBackupIntact, decryptBackupFile, decryptStream, encryptStream, isEncryptedBackup, openBackupPlain, type Derive } from "../src/lib/backup-crypto.js";

const master = randomBytes(32);
const derive: Derive = (salt) => createHmac("sha256", master).update(salt).digest();
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "xb-bc-"));
const collect = async (r: Readable) => {
  const parts: Buffer[] = [];
  for await (const c of r) parts.push(c as Buffer);
  return Buffer.concat(parts);
};
const enc = async (plain: Buffer, file: string) => {
  // Küçük parçalarla besle: blok sınırları parça sınırlarıyla çakışmasın.
  const chunks = Array.from({ length: Math.ceil(plain.length / 7919) }, (_, i) => plain.subarray(i * 7919, (i + 1) * 7919));
  await pipeline(Readable.from(chunks), encryptStream(derive), fs.createWriteStream(file));
};
const dec = (file: string) => collect(fs.createReadStream(file).pipe(decryptStream(derive)));

for (const size of [0, 1, 65535, 65536, 65537, 200_000, 1_000_003]) {
  test(`yedek şifreleme: gidiş-dönüş (${size} bayt)`, async () => {
    const f = path.join(tmp(), "a.xbe");
    const plain = randomBytes(size);
    await enc(plain, f);
    assert.ok(isEncryptedBackup(f));
    assert.ok(fs.readFileSync(f).subarray(0, MAGIC.length).equals(MAGIC));
    assert.deepEqual(await dec(f), plain);
  });
}

test("yedek şifreleme: düz metin diskte görünmez", async () => {
  const f = path.join(tmp(), "a.xbe");
  await enc(Buffer.from("PAROLA=cok-gizli ".repeat(5000)), f);
  assert.ok(!fs.readFileSync(f).includes("cok-gizli"));
});

test("yedek şifreleme: bozuk bayt, kesilmiş ve eklenmiş dosya reddedilir", async () => {
  const dir = tmp();
  const f = path.join(dir, "a.xbe");
  await enc(randomBytes(300_000), f);
  const good = fs.readFileSync(f);
  const cases: Record<string, Buffer> = {
    "bozuk bayt": Buffer.concat([good.subarray(0, 100_000), Buffer.from([good[100_000]! ^ 1]), good.subarray(100_001)]),
    "sondan kesilmiş": good.subarray(0, good.length - 20),
    "blok sınırında kesilmiş": good.subarray(0, 30 + 2 * (65536 + 16)),
    "eklenmiş": Buffer.concat([good, randomBytes(40)]),
    "yalnız başlık": good.subarray(0, 20),
  };
  for (const [name, data] of Object.entries(cases)) {
    const p = path.join(dir, "x.xbe");
    fs.writeFileSync(p, data);
    await assert.rejects(() => dec(p), name);
    await assert.rejects(() => assertBackupIntact(p, derive), name);
  }
});

test("yedek şifreleme: yanlış anahtarla açılmaz", async () => {
  const f = path.join(tmp(), "a.xbe");
  await enc(randomBytes(1000), f);
  const other: Derive = (salt) => createHmac("sha256", randomBytes(32)).update(salt).digest();
  await assert.rejects(() => collect(fs.createReadStream(f).pipe(decryptStream(other))));
});

test("eski şifresiz (gzip) yedek okunur, şifreli olarak tanınmaz", async () => {
  const f = path.join(tmp(), "eski.sql.gz");
  fs.writeFileSync(f, gzipSync(Buffer.from("select 1;")));
  assert.ok(!isEncryptedBackup(f));
  assert.equal((await collect(await openBackupPlain(f, derive))).toString(), "select 1;");
  await assert.rejects(() => decryptBackupFile(f, fs.createWriteStream(path.join(tmp(), "o")), derive));
});

test("şifreli yedek geri yükleme akışı gzip'i açılmış içeriği verir; bozuksa akış başlamadan reddeder", async () => {
  const dir = tmp();
  const f = path.join(dir, "y.sql.gz.xbe");
  const sql = Buffer.from("create table t(x);\n".repeat(20000));
  await pipeline(Readable.from([sql]), createGzip(), encryptStream(derive), fs.createWriteStream(f));
  assert.deepEqual(await collect(await openBackupPlain(f, derive)), sql);
  const bad = fs.readFileSync(f);
  bad[bad.length - 1]! ^= 1;
  fs.writeFileSync(f, bad);
  await assert.rejects(() => openBackupPlain(f, derive));
});

test("decryptBackupFile: çözülen çıktı gzip'tir", async () => {
  const dir = tmp();
  const f = path.join(dir, "y.xbe");
  await pipeline(Readable.from([Buffer.from("merhaba")]), createGzip(), encryptStream(derive), fs.createWriteStream(f));
  const out = path.join(dir, "y.gz");
  await decryptBackupFile(f, fs.createWriteStream(out), derive);
  assert.equal(gunzipSync(fs.readFileSync(out)).toString(), "merhaba");
});

test("varsayılan anahtar secret.key'den türetilir; --key-file kopyası aynı anahtarı verir", async () => {
  const dir = tmp();
  const f = path.join(dir, "d.xbe");
  const plain = randomBytes(150_000);
  await pipeline(Readable.from([plain]), encryptStream(), fs.createWriteStream(f));
  assert.deepEqual(await collect(fs.createReadStream(f).pipe(decryptStream())), plain);
  const keyCopy = path.join(dir, "secret.key");
  fs.copyFileSync(path.join(config.dataDir, "secret.key"), keyCopy);
  assert.deepEqual(await collect(fs.createReadStream(f).pipe(decryptStream(deriveFromKeyFile(keyCopy)))), plain);
  fs.writeFileSync(keyCopy, randomBytes(32));
  await assert.rejects(() => collect(fs.createReadStream(f).pipe(decryptStream(deriveFromKeyFile(keyCopy)))));
});
