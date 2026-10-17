import fs from "node:fs";
import path from "node:path";

/**
 * `rel` yolunu `root` içinde çözer; `../` veya klasör dışını gösteren bir kısayolla (symlink) dışarı çıkıyorsa null döner.
 * Repo ve zip'ler kullanıcıdan geldiği için içlerindeki dosyalar ancak bu kontrolden sonra okunur.
 */
export function resolveInside(root: string, rel: string): string | null {
  const base = fs.realpathSync(root);
  const inside = (p: string) => p === base || p.startsWith(base + path.sep);
  const target = path.resolve(base, rel);
  if (!inside(target)) return null;
  let real = target;
  try {
    real = fs.realpathSync(target);
  } catch {
    // Henüz var olmayan dosya: en yakın var olan üst klasörün gerçek yolu kontrol edilir.
    let parent = path.dirname(target);
    while (!fs.existsSync(parent) && parent !== base) parent = path.dirname(parent);
    if (!inside(fs.realpathSync(parent))) return null;
  }
  return inside(real) ? real : null;
}

/**
 * `rel` dosyasını `root` içine yazar; yol bir kısayolsa (symlink) onu izlemez, yerine gerçek dosya
 * koyar. Repo ve zip'ler kullanıcıdan geldiği için `.env` gibi dosyaları yazarken `path.join`
 * yeterli değil: repodaki `.env -> /app/...` bağı yazmayı panelin kendi dosyalarına yönlendirirdi.
 */
export function writeInside(root: string, rel: string, content: string, mode = 0o644): string {
  const base = fs.realpathSync(root);
  const target = path.resolve(base, rel);
  if (target !== base && !target.startsWith(base + path.sep)) throw new Error(`Dosya klasör dışına yazılamaz: ${rel}`);
  const parent = path.dirname(target);
  fs.mkdirSync(parent, { recursive: true });
  const realParent = fs.realpathSync(parent);
  if (realParent !== base && !realParent.startsWith(base + path.sep)) throw new Error(`Dosya klasör dışına yazılamaz: ${rel}`);
  const finalPath = path.join(realParent, path.basename(target));
  try {
    if (fs.lstatSync(finalPath).isSymbolicLink()) fs.unlinkSync(finalPath);
  } catch {
    // dosya yok: yeni oluşturulacak
  }
  const { O_WRONLY, O_CREAT, O_TRUNC, O_NOFOLLOW } = fs.constants;
  const fd = fs.openSync(finalPath, O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW, mode);
  try {
    fs.writeSync(fd, content);
  } finally {
    fs.closeSync(fd);
  }
  return finalPath;
}

/**
 * Klasör dışını (ya da hiçbir yeri) gösteren kısayolları siler; klasör içi kısayollar kalır.
 * Klonlanan repo ve açılan zip'ten hemen sonra çağrılır. Dönen değer silinen kısayol sayısı.
 */
export function removeEscapingSymlinks(root: string): number {
  const base = fs.realpathSync(root);
  const inside = (p: string) => p === base || p.startsWith(base + path.sep);
  let removed = 0;
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        let real: string | null = null;
        try {
          real = fs.realpathSync(full);
        } catch {
          real = null;
        }
        if (!real || !inside(real)) {
          fs.unlinkSync(full);
          removed++;
        }
      } else if (entry.isDirectory() && entry.name !== ".git") {
        walk(full);
      }
    }
  };
  walk(base);
  return removed;
}
