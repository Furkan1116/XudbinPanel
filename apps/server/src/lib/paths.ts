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
