import fs from "node:fs";
import path from "node:path";
import { resolveInside } from "../../lib/paths.js";
import type { Repo } from "./types.js";

export function openRepo(root: string): Repo {
  // Repo dışını gösteren yollar ve kısayollar yokmuş gibi davranır (ör. .env.example -> /proc/self/environ).
  const abs = (f: string) => {
    const p = resolveInside(root, f);
    if (!p) throw new Error("Repo dışına erişim");
    return p;
  };
  return {
    has: (f) => {
      try {
        return fs.existsSync(abs(f));
      } catch {
        return false;
      }
    },
    read: (f) => {
      try {
        return fs.readFileSync(abs(f), "utf8");
      } catch {
        return "";
      }
    },
    list: (d = ".") => {
      try {
        return fs.readdirSync(abs(d));
      } catch {
        return [];
      }
    },
    json: (f) => {
      try {
        return JSON.parse(fs.readFileSync(abs(f), "utf8"));
      } catch {
        return null;
      }
    },
    find(re, d = ".") {
      const hit = this.list(d).find((n) => re.test(n));
      return hit ? (d === "." ? hit : `${d}/${hit}`) : null;
    },
  };
}

export const opt = (v: unknown, fallback: string) => (typeof v === "string" && v.trim() ? v.trim() : fallback);
export const flag = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : v === "true" ? true : v === "false" ? false : fallback);

/** Kabuk komutunu Dockerfile CMD için JSON dizisine çevirir. */
export const shCmd = (cmd: string) => `CMD ["sh", "-c", ${JSON.stringify(cmd)}]`;

/**
 * Yalnızca tarayıcıya gitmesi zaten beklenen (herkese açık) değişkenler derlemeye aktarılır.
 * Şifreler imaj katmanlarına girmesin diye diğerleri derlemede kullanılmaz.
 */
const PUBLIC_PREFIXES = ["NEXT_PUBLIC_", "VITE_", "NUXT_PUBLIC_", "PUBLIC_", "REACT_APP_", "VUE_APP_", "EXPO_PUBLIC_"];
export function publicBuildEnv(env: Record<string, string>) {
  const keys = Object.keys(env).filter((k) => PUBLIC_PREFIXES.some((p) => k.startsWith(p)));
  if (!keys.length) return "";
  return keys.map((k) => `ARG ${k}`).join("\n") + "\n" + `ENV ${keys.map((k) => `${k}=$${k}`).join(" ")}\n`;
}

/** Kaynak kodda okunan ortam değişkeni adlarını bulur (os.environ, process.env, env(), getenv...). */
export function scanEnvNames(text: string): string[] {
  const names = new Set<string>();
  const patterns = [
    /(?:environ(?:\.get)?|getenv|env(?:_[a-z]+)?|config|env\.(?:str|bool|int|list))\(\s*["']([A-Z][A-Z0-9_]{2,})["']/g,
    /os\.environ\[\s*["']([A-Z][A-Z0-9_]{2,})["']\s*\]/g,
    /process\.env\.([A-Z][A-Z0-9_]{2,})/g,
    /process\.env\[\s*["']([A-Z][A-Z0-9_]{2,})["']\s*\]/g,
    /import\.meta\.env\.([A-Z][A-Z0-9_]{2,})/g,
    /ENV\[\s*["']([A-Z][A-Z0-9_]{2,})["']\s*\]/g,
  ];
  for (const re of patterns) for (const m of text.matchAll(re)) names.add(m[1]!);
  for (const ignore of ["NODE_ENV", "PORT", "HOSTNAME", "HOME", "PATH", "PWD"]) names.delete(ignore);
  return [...names].sort();
}

/** .env.example / .env.sample dosyasındaki anahtarlar ve örnek değerler. */
export function readEnvExample(repo: Repo): { key: string; value: string }[] {
  const file = [".env.example", ".env.sample", ".env.dist", ".env.template", "env.example"].find((f) => repo.has(f));
  if (!file) return [];
  return repo
    .read(file)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return { key: l.slice(0, i).replace(/^export\s+/, "").trim(), value: l.slice(i + 1).trim().replace(/^["']|["']$/g, "") };
    })
    .filter((e) => /^[A-Z][A-Z0-9_]*$/.test(e.key));
}

/** Statik dosyaları SPA yönlendirmesiyle (bilinmeyen yol → index.html) sunan Caddyfile. */
export function staticCaddyfile(spa: boolean) {
  return `:80 {
	root * /srv
	encode zstd gzip
	header /assets/* Cache-Control "public, max-age=31536000, immutable"
${spa ? "\ttry_files {path} {path}/ /index.html\n" : ""}	file_server
}
`;
}

/**
 * Desteği biten Debian sürümlerine (buster, bullseye) dayanan eski dil imajlarında paket depoları
 * archive.debian.org'a taşınmıştır; apt-get bu satır olmadan 404 alır.
 */
export const DEBIAN_ARCHIVE_FIX = `RUN . /etc/os-release && case "$VERSION_CODENAME" in buster|bullseye) \\
    sed -i -e 's|deb.debian.org|archive.debian.org|g' -e 's|security.debian.org|archive.debian.org|g' -e '/-updates/d' /etc/apt/sources.list 2>/dev/null; \\
    rm -f /etc/apt/sources.list.d/debian.sources;; esac`;
