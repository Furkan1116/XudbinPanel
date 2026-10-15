/**
 * `xudbin restore` yedeği data/restore klasörüne hazırlar; panel bir sonraki açılışta, veritabanını
 * açmadan önce dosyaları yerine koyar. Eski dosyalar data/pre-restore-<zaman> klasöründe saklanır.
 * index.ts'de ilk import olmalı (ESM importları sırayla değerlendirir, db.js'den önce çalışır).
 */
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

const stage = path.join(config.dataDir, "restore");
if (fs.existsSync(path.join(stage, "xudbin.db")) && fs.existsSync(path.join(stage, "secret.key"))) {
  const keep = path.join(config.dataDir, `pre-restore-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`);
  fs.mkdirSync(keep, { recursive: true });
  for (const f of ["xudbin.db", "xudbin.db-wal", "xudbin.db-shm", "secret.key"]) {
    const p = path.join(config.dataDir, f);
    if (fs.existsSync(p)) fs.renameSync(p, path.join(keep, f));
  }
  fs.renameSync(path.join(stage, "xudbin.db"), path.join(config.dataDir, "xudbin.db"));
  fs.renameSync(path.join(stage, "secret.key"), path.join(config.dataDir, "secret.key"));
  fs.rmSync(stage, { recursive: true, force: true });
  console.log(`Panel yedekten geri yüklendi. Önceki dosyalar: ${keep}`);
}
