import { flag, opt, publicBuildEnv, shCmd, staticCaddyfile } from "./util.js";
import type { Framework, Options, Repo } from "./types.js";

type Pkg = { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string>; engines?: { node?: string }; packageManager?: string; main?: string };

const pkgOf = (repo: Repo) => repo.json<Pkg>("package.json") ?? {};
const depsOf = (repo: Repo) => ({ ...pkgOf(repo).dependencies, ...pkgOf(repo).devDependencies });
const hasDep = (repo: Repo, name: string) => Boolean(depsOf(repo)[name]);

const NODE_VERSIONS = ["24", "22", "20"].map((v) => ({ value: v, label: `Node.js ${v}` }));

function nodeVersion(repo: Repo): string | undefined {
  const raw = (repo.read(".nvmrc") || repo.read(".node-version") || pkgOf(repo).engines?.node || "").trim();
  const majors = [...raw.matchAll(/(\d{2})/g)].map((m) => Number(m[1])).filter((n) => n >= 18 && n <= 30);
  return majors.length ? String(Math.max(...majors)) : undefined;
}

type PM = "npm" | "pnpm" | "yarn" | "bun";
function packageManager(repo: Repo): PM {
  const declared = pkgOf(repo).packageManager?.split("@")[0];
  if (declared === "pnpm" || declared === "yarn" || declared === "bun") return declared;
  if (repo.has("pnpm-lock.yaml")) return "pnpm";
  if (repo.has("yarn.lock")) return "yarn";
  if (repo.has("bun.lockb") || repo.has("bun.lock")) return "bun";
  return "npm";
}

function installCmd(repo: Repo, pm: PM) {
  return {
    npm: repo.has("package-lock.json") ? "npm ci" : "npm install",
    pnpm: "corepack enable && pnpm install --frozen-lockfile",
    yarn: "corepack enable && yarn install --frozen-lockfile",
    bun: "npm install -g bun && bun install",
  }[pm];
}
const runScript = (pm: PM, s: string) => ({ npm: `npm run ${s}`, pnpm: `pnpm run ${s}`, yarn: `yarn ${s}`, bun: `bun run ${s}` })[pm];

const nodeFields = [
  { key: "nodeVersion", label: "Node.js sürümü", type: "select" as const, options: NODE_VERSIONS },
  { key: "installCommand", label: "Kurulum komutu", type: "text" as const, hint: "Boşsa kilit dosyasına göre seçilir (npm ci, pnpm, yarn, bun)." },
  { key: "buildCommand", label: "Derleme komutu", type: "text" as const, hint: "Boşsa package.json'daki build betiği çalışır." },
];

/** Bağımlılıkları kurup derleyen ortak aşama. */
function buildStage(repo: Repo, opts: Options, env: Record<string, string>, as = "build") {
  const pm = packageManager(repo);
  const v = opt(opts.nodeVersion, nodeVersion(repo) ?? "22");
  const build = opt(opts.buildCommand, pkgOf(repo).scripts?.build ? runScript(pm, "build") : "");
  return {
    pm,
    v,
    text: `FROM node:${v}-alpine AS ${as}
WORKDIR /app
RUN apk add --no-cache libc6-compat
COPY . .
RUN ${opt(opts.installCommand, installCmd(repo, pm))}
${publicBuildEnv(env)}ENV NODE_ENV=production
${build ? `RUN ${build}` : ""}`,
  };
}

/** Derlenen statik klasörü SPA yönlendirmesiyle Caddy'de sunan son aşama. */
function staticStage(outDir: string) {
  return `
FROM caddy:2.11-alpine
COPY --from=build /app/${outDir} /srv
COPY Caddyfile.xudbin /etc/caddy/Caddyfile
EXPOSE 80
`;
}

export const nextjs: Framework = {
  id: "nextjs",
  name: "Next.js",
  language: "JavaScript",
  category: "JavaScript",
  description: "next start ile; next.config'de output: 'standalone' varsa küçük imajla çalışır.",
  defaultPort: 3000,
  fields: nodeFields,
  envHints: [{ key: "NEXT_PUBLIC_SITE_URL", description: "Tarayıcıda kullanılan site adresi (varsa). NEXT_PUBLIC_ ile başlayanlar derlemeye girer.", auto: "url" }],
  steps: [
    "Bağımlılıklar kilit dosyasına göre kurulur, next build çalışır.",
    "NEXT_PUBLIC_ ile başlayan değişkenler derlemeye aktarılır; diğerleri yalnız çalışırken kullanılır.",
    "Uygulama next start (veya standalone sunucu) ile çalışır.",
  ],
  detect: (repo) => (hasDep(repo, "next") ? { score: 95, reason: "next bağımlılığı bulundu", options: { nodeVersion: nodeVersion(repo) } } : null),
  build(repo, opts, env) {
    const b = buildStage(repo, opts, env);
    const standalone = /output\s*:\s*["']standalone["']/.test(repo.read("next.config.js") + repo.read("next.config.mjs") + repo.read("next.config.ts"));
    const run = standalone
      ? `FROM node:${b.v}-alpine
WORKDIR /app
ENV NODE_ENV=production HOSTNAME=0.0.0.0 PORT=3000
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
EXPOSE 3000
CMD ["node", "server.js"]`
      : `FROM build
ENV HOSTNAME=0.0.0.0 PORT=3000
EXPOSE 3000
${shCmd("exec ./node_modules/.bin/next start -H 0.0.0.0 -p $PORT")}`;
    if (standalone && !repo.has("public")) return { port: 3000, dockerfile: `${b.text}\nRUN mkdir -p public\n\n${run}\n` };
    return { port: 3000, dockerfile: `${b.text}\n\n${run}\n`, notes: [standalone ? "Standalone çıktı kullanılıyor." : "next start kullanılıyor."] };
  },
};

export const nuxt: Framework = {
  id: "nuxt",
  name: "Nuxt",
  language: "JavaScript",
  category: "JavaScript",
  description: "Nitro sunucusu (.output/server) ile çalışır.",
  defaultPort: 3000,
  fields: nodeFields,
  envHints: [],
  steps: ["nuxt build çalışır.", "Sunucu .output/server/index.mjs ile başlar."],
  detect: (repo) => (hasDep(repo, "nuxt") ? { score: 95, reason: "nuxt bağımlılığı bulundu", options: { nodeVersion: nodeVersion(repo) } } : null),
  build(repo, opts, env) {
    const b = buildStage(repo, opts, env);
    return {
      port: 3000,
      dockerfile: `${b.text}

FROM node:${b.v}-alpine
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 NITRO_HOST=0.0.0.0 PORT=3000
COPY --from=build /app/.output ./.output
EXPOSE 3000
CMD ["node", ".output/server/index.mjs"]
`,
    };
  },
};

export const sveltekit: Framework = {
  id: "sveltekit",
  name: "SvelteKit",
  language: "JavaScript",
  category: "JavaScript",
  description: "adapter-node ile sunucu, adapter-static ile statik site olarak çalışır.",
  defaultPort: 3000,
  fields: nodeFields,
  envHints: [{ key: "ORIGIN", description: "Form gönderimleri için sitenin tam adresi (adapter-node).", auto: "url" }],
  steps: ["vite build çalışır.", "adapter-node ise node build ile, adapter-static ise Caddy ile sunulur."],
  detect: (repo) => (hasDep(repo, "@sveltejs/kit") ? { score: 95, reason: "@sveltejs/kit bulundu", options: { nodeVersion: nodeVersion(repo) } } : null),
  build(repo, opts, env) {
    const b = buildStage(repo, opts, env);
    if (hasDep(repo, "@sveltejs/adapter-static")) {
      return { port: 80, dockerfile: `${b.text}\n${staticStage("build")}`, files: { "Caddyfile.xudbin": staticCaddyfile(true) } };
    }
    return {
      port: 3000,
      dockerfile: `${b.text}
RUN npm prune --omit=dev || true

FROM node:${b.v}-alpine
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
COPY --from=build /app/build ./build
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
EXPOSE 3000
CMD ["node", "build"]
`,
      notes: hasDep(repo, "@sveltejs/adapter-node") ? [] : ["Uyarı: @sveltejs/adapter-node bulunamadı; svelte.config.js'de adapter-node kullanman gerekir."],
    };
  },
};

export const astro: Framework = {
  id: "astro",
  name: "Astro",
  language: "JavaScript",
  category: "JavaScript",
  description: "Statik çıktı Caddy ile; @astrojs/node varsa sunucu olarak çalışır.",
  defaultPort: 80,
  fields: nodeFields,
  envHints: [],
  steps: ["astro build çalışır.", "Statik ise dist/ Caddy ile sunulur, SSR ise node dist/server/entry.mjs çalışır."],
  detect: (repo) => (hasDep(repo, "astro") ? { score: 95, reason: "astro bağımlılığı bulundu", options: { nodeVersion: nodeVersion(repo) } } : null),
  build(repo, opts, env) {
    const b = buildStage(repo, opts, env);
    if (hasDep(repo, "@astrojs/node")) {
      return {
        port: 4321,
        dockerfile: `${b.text}

FROM build
ENV HOST=0.0.0.0 PORT=4321
EXPOSE 4321
CMD ["node", "./dist/server/entry.mjs"]
`,
      };
    }
    return { port: 80, dockerfile: `${b.text}\n${staticStage("dist")}`, files: { "Caddyfile.xudbin": staticCaddyfile(false) } };
  },
};

export const remix: Framework = {
  id: "remix",
  name: "Remix / React Router",
  language: "JavaScript",
  category: "JavaScript",
  description: "Derlenir ve package.json'daki start betiğiyle çalışır.",
  defaultPort: 3000,
  fields: nodeFields,
  envHints: [],
  steps: ["Derleme betiği çalışır.", "start betiğiyle sunucu başlatılır."],
  detect: (repo) =>
    hasDep(repo, "@remix-run/node") || hasDep(repo, "@react-router/serve") ? { score: 85, reason: "Remix / React Router sunucusu bulundu", options: { nodeVersion: nodeVersion(repo) } } : null,
  build(repo, opts, env) {
    const b = buildStage(repo, opts, env);
    return { port: 3000, dockerfile: `${b.text}\nENV HOST=0.0.0.0 PORT=3000\nEXPOSE 3000\n${shCmd(`exec ${runScript(b.pm, "start")}`)}\n` };
  },
};

export const nestjs: Framework = {
  id: "nestjs",
  name: "NestJS",
  language: "TypeScript",
  category: "JavaScript",
  description: "nest build sonrası node dist/main ile çalışır.",
  defaultPort: 3000,
  fields: nodeFields,
  envHints: [],
  steps: ["nest build çalışır.", "Uygulama node dist/main ile başlar; main.ts PORT değişkenini okumalı."],
  detect: (repo) => (hasDep(repo, "@nestjs/core") ? { score: 90, reason: "@nestjs/core bulundu", options: { nodeVersion: nodeVersion(repo) } } : null),
  build(repo, opts, env) {
    const b = buildStage(repo, opts, env);
    const main = repo.has("src/main.ts") ? "dist/main" : "dist/src/main";
    return { port: 3000, dockerfile: `${b.text}\nENV PORT=3000\nEXPOSE 3000\nCMD ["node", "${main}"]\n` };
  },
};

export const spa: Framework = {
  id: "spa",
  name: "React / Vue / Angular (SPA)",
  language: "JavaScript",
  category: "JavaScript",
  description: "Vite, Create React App, Vue CLI veya Angular ile derlenip statik olarak sunulur.",
  defaultPort: 80,
  fields: [
    ...nodeFields,
    { key: "outputDir", label: "Çıktı klasörü", type: "text", placeholder: "dist", hint: "Vite: dist, CRA: build, Angular: dist/<proje>/browser" },
    { key: "spa", label: "Tek sayfa uygulaması (bilinmeyen yollar index.html'e gitsin)", type: "toggle" },
  ],
  envHints: [{ key: "VITE_API_URL", description: "Örnek: tarayıcıdan çağrılan API adresi. VITE_ / REACT_APP_ ile başlayanlar derlemeye girer." }],
  steps: ["Bağımlılıklar kurulur ve derlenir.", "Çıktı klasörü Caddy ile sıkıştırılarak sunulur; sayfa yenilemede 404 olmaz."],
  detect(repo) {
    const out = spaOutDir(repo);
    if (hasDep(repo, "vite") || hasDep(repo, "react-scripts") || hasDep(repo, "@angular/core") || hasDep(repo, "@vue/cli-service")) {
      return { score: 60, reason: "Ön yüz derleme aracı bulundu", options: { outputDir: out, nodeVersion: nodeVersion(repo) } };
    }
    return null;
  },
  build(repo, opts, env) {
    const b = buildStage(repo, opts, env);
    const out = opt(opts.outputDir, spaOutDir(repo));
    const isSpa = flag(opts.spa, true);
    return { port: 80, dockerfile: `${b.text}\n${staticStage(out)}`, files: { "Caddyfile.xudbin": staticCaddyfile(isSpa) }, notes: [`Çıktı klasörü: ${out}`] };
  },
};

function spaOutDir(repo: Repo) {
  if (repo.has("angular.json")) {
    const a = repo.json<{ projects?: Record<string, { architect?: { build?: { options?: { outputPath?: string | { base?: string } } } } }> }>("angular.json");
    const p = Object.values(a?.projects ?? {})[0]?.architect?.build?.options?.outputPath;
    const base = typeof p === "string" ? p : p?.base;
    if (base) return `${base}/browser`;
  }
  if (hasDep(repo, "react-scripts")) return "build";
  return "dist";
}

export const node: Framework = {
  id: "node",
  name: "Node.js (Express, Fastify, Hono...)",
  language: "JavaScript",
  category: "JavaScript",
  description: "package.json'daki start betiğiyle çalışır.",
  defaultPort: 3000,
  fields: [...nodeFields, { key: "startCommand", label: "Başlatma komutu", type: "text", hint: "Boşsa start betiği (npm start) kullanılır." }],
  envHints: [],
  steps: ["Bağımlılıklar kurulur, varsa derleme betiği çalışır.", "start betiğiyle başlatılır; uygulama PORT değişkenini dinlemeli."],
  detect: (repo) => (repo.has("package.json") ? { score: 40, reason: "package.json bulundu", options: { nodeVersion: nodeVersion(repo) } } : null),
  build(repo, opts, env) {
    const b = buildStage(repo, opts, env);
    const pkg = pkgOf(repo);
    const start = opt(opts.startCommand, pkg.scripts?.start ? runScript(b.pm, "start") : `node ${pkg.main ?? "index.js"}`);
    return { port: 3000, dockerfile: `${b.text}\nENV PORT=3000 HOST=0.0.0.0\nEXPOSE 3000\n${shCmd(`exec ${start}`)}\n` };
  },
};

export const bun: Framework = {
  id: "bun",
  name: "Bun",
  language: "JavaScript",
  category: "JavaScript",
  description: "Bun çalışma zamanıyla çalışır.",
  defaultPort: 3000,
  fields: [{ key: "startCommand", label: "Başlatma komutu", type: "text", placeholder: "bun run start" }],
  envHints: [],
  steps: ["bun install çalışır, varsa build betiği çalışır.", "Başlatma komutu çalıştırılır."],
  detect: (repo) => (repo.has("bun.lockb") || repo.has("bun.lock") || repo.has("bunfig.toml") ? { score: 80, reason: "Bun kilit dosyası bulundu" } : null),
  build(repo, opts) {
    const pkg = pkgOf(repo);
    const start = opt(opts.startCommand, pkg.scripts?.start ? "bun run start" : `bun ${pkg.main ?? "index.ts"}`);
    return {
      port: 3000,
      dockerfile: `FROM oven/bun:1-alpine
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile || bun install
${pkg.scripts?.build ? "RUN bun run build" : ""}
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
${shCmd(`exec ${start}`)}
`,
    };
  },
};

export const deno: Framework = {
  id: "deno",
  name: "Deno",
  language: "TypeScript",
  category: "JavaScript",
  description: "deno.json'daki start görevi veya main dosyasıyla çalışır.",
  defaultPort: 8000,
  fields: [{ key: "startCommand", label: "Başlatma komutu", type: "text", placeholder: "deno task start" }],
  envHints: [],
  steps: ["Bağımlılıklar önbelleğe alınır.", "Başlatma komutu çalıştırılır."],
  detect: (repo) => (repo.has("deno.json") || repo.has("deno.jsonc") ? { score: 85, reason: "deno.json bulundu" } : null),
  build(repo, opts) {
    const cfg = repo.json<{ tasks?: Record<string, string> }>("deno.json") ?? {};
    const start = opt(opts.startCommand, cfg.tasks?.start ? "deno task start" : "deno run -A main.ts");
    return { port: 8000, dockerfile: `FROM denoland/deno:alpine\nWORKDIR /app\nCOPY . .\nRUN deno install || true\nENV PORT=8000\nEXPOSE 8000\n${shCmd(`exec ${start}`)}\n` };
  },
};
