import fs from "node:fs";
import path from "node:path";
import { resolveInside } from "../../lib/paths.js";

/**
 * Kaynak klasörün sınırlı, salt okunur görünümü. Klasör güvenilmez girdidir: kısayollar (symlink) izlenmez,
 * klasör dışına çıkılmaz, dosya sayısı/derinlik/süre ve okunan bayt sınırlıdır, ikili dosyalar metin olarak okunmaz.
 */

export const LIMITS = {
  maxFiles: 20_000,
  maxDepth: 12,
  /** Tek dosyadan okunan en fazla bayt (metin kontrolleri için). */
  maxFileRead: 512 * 1024,
  /** Bir kontrolde okunan toplam bayt. */
  maxTotalRead: 32 * 1024 * 1024,
  timeMs: 2500,
  bigFile: 50 * 1024 * 1024,
};

export type Limits = typeof LIMITS;

export type FileEntry = { rel: string; name: string; size: number };

/** İçine girilmeyen, ayrıca raporlanan klasörler (bağımlılık ve önbellek klasörleri). */
export type HeavyDir = { rel: string; kind: "node_modules" | "venv" | "pycache" };

/** İçine girilmeyen, raporlanmayan klasörler (derleme çıktısı, başka paket yöneticileri, önbellekler). */
const QUIET_DIRS = new Set([".git", ".hg", ".svn", "vendor", "bower_components", ".next", ".nuxt", ".svelte-kit", ".output", ".cache", ".tox", ".mypy_cache", ".pytest_cache", ".ruff_cache", "site-packages", ".gradle", ".idea", ".vscode"]);

export class SourceTree {
  readonly files: FileEntry[] = [];
  readonly heavyDirs: HeavyDir[] = [];
  truncated = false;
  readBytes = 0;
  readLimited = false;
  /** Süre sınırı taramayı da içerik okumayı da kapsar: yavaş diskte (ağ diski, bulut eşitlemesi) kontrol yayını bekletmesin. */
  private deadline = Infinity;
  private readonly index = new Map<string, FileEntry>();

  private constructor(
    readonly root: string,
    readonly limits: Limits,
  ) {}

  /** Klasörü sınırlar içinde dolaşır. Kısayollar ne dosya ne klasör olarak izlenir. */
  static scan(root: string, limits: Limits = LIMITS): SourceTree {
    const tree = new SourceTree(fs.realpathSync(root), limits);
    const deadline = Date.now() + limits.timeMs;
    tree.deadline = deadline;
    const stack: { dir: string; rel: string; depth: number }[] = [{ dir: tree.root, rel: "", depth: 0 }];
    while (stack.length) {
      const { dir, rel, depth } = stack.pop()!;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (tree.files.length >= limits.maxFiles || Date.now() > deadline) {
          tree.truncated = true;
          return tree;
        }
        const childRel = rel ? `${rel}/${entry.name}` : entry.name;
        const full = path.join(dir, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          const heavy = heavyKind(entry.name, full);
          if (heavy) tree.heavyDirs.push({ rel: childRel, kind: heavy });
          else if (QUIET_DIRS.has(entry.name)) continue;
          else if (depth + 1 > limits.maxDepth) tree.truncated = true;
          else stack.push({ dir: full, rel: childRel, depth: depth + 1 });
          continue;
        }
        if (!entry.isFile()) continue;
        let size = 0;
        try {
          size = fs.lstatSync(full).size;
        } catch {
          continue;
        }
        const file = { rel: childRel, name: entry.name, size };
        tree.files.push(file);
        tree.index.set(childRel, file);
      }
    }
    return tree;
  }

  has(rel: string) {
    return this.index.has(normalize(rel));
  }

  get(rel: string) {
    return this.index.get(normalize(rel));
  }

  /** Klasördeki (alt klasörler hariç) dosyalar. */
  filesIn(dir: string) {
    const prefix = normalize(dir);
    return this.files.filter((f) => (prefix ? f.rel.startsWith(`${prefix}/`) && !f.rel.slice(prefix.length + 1).includes("/") : !f.rel.includes("/")));
  }

  /**
   * Dosyayı metin olarak okur; yoksa, klasör dışındaysa, ikiliyse ya da okuma bütçesi bittiyse null.
   * En fazla `max` bayt okunur. Dosya O_NOFOLLOW ile açılır: dolaşma ile okuma arasında kısayola çevrilse de izlenmez.
   */
  text(rel: string, max = this.limits.maxFileRead): string | null {
    const buf = this.bytes(rel, max);
    if (!buf) return null;
    if (buf.subarray(0, 8000).includes(0)) return null;
    return buf.toString("utf8");
  }

  /** Dosyanın ilk `max` baytı (ör. SQLite başlığı). */
  bytes(rel: string, max: number): Buffer | null {
    const file = this.get(rel);
    if (!file) return null;
    const want = Math.min(max, file.size);
    if (this.readBytes + want > this.limits.maxTotalRead || Date.now() > this.deadline) {
      this.readLimited = true;
      return null;
    }
    const full = resolveInside(this.root, file.rel);
    if (!full) return null;
    let fd: number | null = null;
    try {
      fd = fs.openSync(full, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      if (!fs.fstatSync(fd).isFile()) return null;
      const buf = Buffer.alloc(want);
      const n = fs.readSync(fd, buf, 0, want, 0);
      this.readBytes += n;
      return buf.subarray(0, n);
    } catch {
      return null;
    } finally {
      if (fd !== null) fs.closeSync(fd);
    }
  }

  /** JSON dosyası (okunamazsa ya da geçersizse null). */
  json<T>(rel: string): T | null {
    const raw = this.text(rel);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }
}

/** Klasör adı ve içeriğine göre bağımlılık/önbellek klasörü mü: venv `pyvenv.cfg` dosyasından tanınır. */
function heavyKind(name: string, full: string): HeavyDir["kind"] | null {
  if (name === "node_modules") return "node_modules";
  if (name === "__pycache__") return "pycache";
  if (name === "venv" || name === ".venv") return "venv";
  try {
    if (fs.lstatSync(path.join(full, "pyvenv.cfg")).isFile()) return "venv";
  } catch {}
  return null;
}

/** "./a//b/" → "a/b"; kök için "". */
export function normalize(rel: string) {
  return rel
    .split(/[\\/]+/)
    .filter((p) => p && p !== ".")
    .join("/");
}

/** Bağlam klasörüne göre göreli yolu kökten göreli yola çevirir. */
export function joinRel(base: string, rel: string) {
  return normalize(`${normalize(base)}/${rel}`);
}
