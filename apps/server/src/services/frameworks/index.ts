import { astro, bun, deno, nestjs, nextjs, node, nuxt, remix, spa, sveltekit } from "./node.js";
import { django, fastapi, flask, python } from "./python.js";
import { dockerfileFw, dotnet, go, java, laravel, php, rails, rust, staticSite } from "./others.js";
import type { EnvHint, Framework, Options, Repo } from "./types.js";
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

/** Otomatik değerli ortam değişkeni önerilerini uygulamanın alan adlarına göre doldurur. */
export function resolveHintValue(h: EnvHint, ctx: { hosts: string[]; https: boolean }, random: (n: number) => string): string {
  const scheme = ctx.https ? "https" : "http";
  switch (h.auto) {
    case "secret":
      return random(50);
    case "laravel-key":
      return `base64:${Buffer.from(random(32)).toString("base64")}`;
    case "domains":
      return ctx.hosts.join(",");
    case "url":
      return ctx.hosts[0] ? `${scheme}://${ctx.hosts[0]}` : "";
    case "https-origins":
      return ctx.hosts.map((h2) => `${scheme}://${h2}`).join(",");
    default:
      return h.value ?? "";
  }
}

export { openRepo as _openRepo };
