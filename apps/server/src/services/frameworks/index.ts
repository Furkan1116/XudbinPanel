import { astro, bun, deno, nestjs, nextjs, node, nuxt, remix, spa, sveltekit } from "./node.js";
import { django, fastapi, flask, python } from "./python.js";
import { dockerfileFw, dotnet, go, java, laravel, php, rails, rust, staticSite } from "./others.js";
import type { Framework, Options, Repo } from "./types.js";
import { openRepo, readEnvExample, scanEnvNames } from "./util.js";

export type { Framework, Options } from "./types.js";
export { openRepo } from "./util.js";

export const FRAMEWORKS: Framework[] = [
  dockerfileFw,
  django, flask, fastapi, python,
  nextjs, nuxt, sveltekit, astro, remix, nestjs, spa, node, bun, deno,
  laravel, php,
  dotnet, go, rust, java, rails,
  staticSite,
];

export const getFramework = (id: string) => FRAMEWORKS.find((f) => f.id === id);

/** Arayüze gönderilen, fonksiyon içermeyen katalog. */
export function publicCatalog() {
  return FRAMEWORKS.map(({ detect: _d, build: _b, ...rest }) => rest);
}

/** Kaynak dosyalarda okunan ortam değişkeni adlarını toplar (en fazla ~300 dosya). */
function scanRepoEnv(root: string, repo: Repo): string[] {
  const names = new Set<string>();
  const exts = /\.(py|js|mjs|cjs|ts|tsx|php|rb|go|rs|cs|java|kt|ex|exs)$/;
  let budget = 300;
  const walk = (dir: string, depth: number) => {
    if (depth > 4 || budget <= 0) return;
    for (const name of repo.list(dir)) {
      if (budget <= 0) return;
      if (/^(\.|node_modules|vendor|dist|build|target|bin|obj|venv|\.venv|__pycache__|public|static|staticfiles|migrations|tests?)$/.test(name)) continue;
      const rel = dir === "." ? name : `${dir}/${name}`;
      if (exts.test(name)) {
        budget--;
        scanEnvNames(repo.read(rel)).forEach((n) => names.add(n));
      } else if (!name.includes(".")) walk(rel, depth + 1);
    }
  };
  void root;
  walk(".", 0);
  return [...names];
}

export type DetectResult = {
  matches: { id: string; score: number; reason: string; options: Options }[];
  envFromCode: string[];
  envExample: { key: string; value: string }[];
  dockerfilePort?: number;
};

export function detectFrameworks(root: string): DetectResult {
  const repo = openRepo(root);
  const matches = FRAMEWORKS.map((f) => {
    const d = f.detect?.(repo);
    return d ? { id: f.id, score: d.score, reason: d.reason, options: Object.fromEntries(Object.entries(d.options ?? {}).filter(([, v]) => v !== undefined)) } : null;
  })
    .filter((m): m is NonNullable<typeof m> => Boolean(m))
    .sort((a, b) => b.score - a.score);
  const port = Number(repo.read("Dockerfile").match(/^\s*EXPOSE\s+(\d+)/im)?.[1]);
  return { matches, envFromCode: scanRepoEnv(root, repo), envExample: readEnvExample(repo), dockerfilePort: port || undefined };
}

const DOMAIN_PLACEHOLDERS = { domains: "{{XUDBIN_DOMAINS}}", url: "{{XUDBIN_URL}}", "https-origins": "{{XUDBIN_ORIGINS}}" } as const;

/**
 * Deploy sırasında env'de eksikse otomatik eklenecek öneriler: zorunlu olanlar ve alan adına bağlı olanlar.
 * Alan adına bağlı değerler yer tutucu olarak yazılır; her deploy'da uygulamanın güncel alan adlarıyla doldurulur.
 */
export function missingDefaultEnv(fw: Framework, env: Record<string, string>, random: (n: number) => string): { key: string; value: string }[] {
  return fw.envHints
    .filter((h) => !(h.key in env) && (h.required || (h.auto && h.auto in DOMAIN_PLACEHOLDERS)))
    .map((h) => {
      switch (h.auto) {
        case "secret":
          return { key: h.key, value: random(50) };
        case "laravel-key":
          return { key: h.key, value: `base64:${Buffer.from(random(32)).toString("base64")}` };
        case "domains":
        case "url":
        case "https-origins":
          return { key: h.key, value: DOMAIN_PLACEHOLDERS[h.auto] };
        default:
          return { key: h.key, value: h.value ?? "" };
      }
    })
    .filter((e) => e.value !== "");
}

export { openRepo as _openRepo };
