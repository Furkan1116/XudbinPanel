import { VERSION } from "./version.js";

/**
 * Yeni sürüm kontrolü: GitHub'daki v* etiketlerinin en büyüğü (6 saatte bir).
 * Yalnız sürüm numarası okunur; panel hakkında hiçbir bilgi gönderilmez.
 */
const REPO = process.env.XUDBIN_REPO_SLUG ?? "Furkan1116/XudbinPanel";
let cache: { at: number; latest: string | null } = { at: 0, latest: null };

const parse = (v: string) => v.replace(/^v/, "").split(".").map((n) => Number.parseInt(n, 10) || 0);
export function newer(a: string, b: string) {
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
}

export async function updateInfo() {
  if (Date.now() - cache.at > 6 * 3_600_000) {
    cache.at = Date.now();
    try {
      const res = await fetch(`https://api.github.com/repos/${REPO}/tags?per_page=50`, { signal: AbortSignal.timeout(10_000), headers: { Accept: "application/vnd.github+json" } });
      if (res.ok) {
        const tags = ((await res.json()) as { name: string }[]).map((t) => t.name).filter((n) => /^v\d+\.\d+\.\d+$/.test(n));
        cache.latest = tags.reduce<string | null>((best, t) => (!best || newer(t, best) ? t : best), null);
      }
    } catch {}
  }
  const latest = cache.latest?.replace(/^v/, "") ?? null;
  return { current: VERSION, latest, updateAvailable: Boolean(latest && newer(latest, VERSION)), url: `https://github.com/${REPO}/releases` };
}
