import { getFramework } from "../frameworks/index.js";
import { type BuildPlan, startText } from "./build.js";
import { FindingList } from "./findings.js";
import type { PreflightFinding } from "./types.js";
import { joinRel, type SourceTree } from "./tree.js";

/** Node.js ve Next.js kontrolü. Kritik yalnız başlatma komutunun bilinen bir geliştirme sunucusu olması. */

type Pkg = { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string>; engines?: { node?: string } };

/** Bilinen geliştirme sunucuları (üretimde çalıştırılmamalı). */
const DEV_SERVERS: [RegExp, string][] = [
  [/\bnext\s+dev\b/, "next dev"],
  [/\b(?:nuxt|nuxi)\s+dev\b/, "nuxt dev"],
  [/\bastro\s+dev\b/, "astro dev"],
  [/\b(?:remix|react-router)\s+dev\b/, "remix dev"],
  [/\bsvelte-kit\s+dev\b/, "svelte-kit dev"],
  [/\bgatsby\s+develop\b/, "gatsby develop"],
  [/\breact-scripts\s+start\b/, "react-scripts start"],
  [/\bng\s+serve\b/, "ng serve"],
  [/\bvue-cli-service\s+serve\b/, "vue-cli-service serve"],
  [/\bwebpack(?:-dev-server|\s+serve)\b/, "webpack serve"],
  [/(?:^|[\s;&|/])vite(?![\w.-])(?!\s+(?:build|preview|optimize)\b)/, "vite"],
];
/** Dosya izleyip yeniden başlatanlar: çalışır ama üretim için değildir. */
const WATCHERS = /\b(nodemon|ts-node-dev|tsx\s+watch|node\s+--watch|bun\s+--watch|bun\s+--hot)\b/;
/** Derleme gerektiren araçlar. */
const BUILD_DEPS = ["next", "nuxt", "vite", "astro", "@sveltejs/kit", "@remix-run/dev", "@react-router/dev", "react-scripts", "@angular/core", "@nestjs/cli", "@vue/cli-service", "gatsby"];
const LOCKFILES = ["package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb", "bun.lock"];

export function devServer(command: string): string | null {
  return DEV_SERVERS.find(([re]) => re.test(command))?.[1] ?? null;
}

/** Node grubu: bağlamda package.json var ve proje JavaScript ön ayarıyla ya da depodaki Dockerfile ile derleniyor. */
export function isNodeProject(tree: SourceTree, plan: BuildPlan) {
  if (!tree.has(joinRel(plan.context, "package.json"))) return false;
  if (plan.dockerfile) return true;
  return getFramework(plan.frameworkId ?? "")?.category === "JavaScript";
}

export function checkNode(tree: SourceTree, plan: BuildPlan): PreflightFinding[] {
  const list = new FindingList("node");
  const pkgRel = joinRel(plan.context, "package.json");
  const pkg = tree.json<Pkg>(pkgRel);
  if (!pkg) {
    list.add({ id: "node-package-json", level: "warning", title: "package.json okunamadı", detail: "Dosya geçerli bir JSON değil ya da çok büyük; Node kontrolleri yapılamadı.", file: pkgRel });
    return list.result();
  }
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const scripts = pkg.scripts ?? {};

  // --- Başlatma komutu ------------------------------------------------------------------------
  const start = plan.start;
  const text = startText(start);
  const dev = start ? devServer(text) : null;
  if (start && dev) {
    list.add({
      id: "node-dev-server",
      level: "critical",
      title: "Başlatma komutu geliştirme sunucusu ({dev})",
      detail: start.script
        ? '{where} "{script}" betiğini çalıştırıyor, betik de {dev} başlatıyor. Geliştirme sunucusu yavaştır, kaynak haritalarını ve hata ayrıntılarını açar, yük altında çöker.'
        : "{where} {dev} başlatıyor. Geliştirme sunucusu yavaştır, kaynak haritalarını ve hata ayrıntılarını açar, yük altında çöker.",
      fix: "Üretim komutunu kullan (ör. next build sonrası next start, Vite için derlenmiş dosyaları statik sun) ya da panelin ön ayarına bırak.",
      vars: { dev, script: start.script?.name ?? "", where: whereText(start.source, start.file) },
      file: start.file,
      line: start.line,
    });
  } else if (start?.script?.name === "dev") {
    list.add({
      id: "node-dev-script",
      level: "warning",
      title: '"dev" betiğiyle başlatılıyor',
      detail: "{where} npm run dev çalıştırıyor. Betik bilinen bir geliştirme sunucusu değil, ama adı geliştirme için olduğunu düşündürüyor.",
      fix: "Üretim için ayrı bir start betiği tanımla ve onu kullan.",
      vars: { where: whereText(start.source, start.file) },
      file: start.file,
      line: start.line,
    });
  } else if (start && WATCHERS.test(text)) {
    list.add({
      id: "node-watcher",
      level: "warning",
      title: "Başlatma komutu dosya izleyici kullanıyor",
      detail: "{where} {tool} ile başlıyor. Dosya izleyiciler geliştirme içindir; gereksiz bellek harcar ve beklenmedik yeniden başlatmalara yol açar.",
      fix: "Doğrudan node ile başlat (ör. node dist/index.js).",
      vars: { where: whereText(start.source, start.file), tool: text.match(WATCHERS)![1]! },
      file: start.file,
      line: start.line,
    });
  }
  if (start?.script && start.script.body === null) {
    list.add({
      id: "node-missing-script",
      level: "warning",
      title: 'package.json\'da "{script}" betiği yok',
      detail: "{where} bu betiği çağırıyor; konteyner başlarken \"Missing script\" hatasıyla kapanır.",
      fix: "package.json'a betiği ekle ya da başlatma komutunu düzelt.",
      vars: { script: start.script.name, where: whereText(start.source, start.file) },
      file: pkgRel,
    });
  } else if (!start?.script && plan.frameworkId === "node" && !scripts.start && !plan.options.startCommand) {
    list.add({
      id: "node-no-start",
      level: "warning",
      title: "start betiği yok",
      detail: 'Panel bu durumda "node {main}" ile başlatmayı dener; dosya yoksa uygulama açılmaz.',
      fix: 'package.json\'a "start" betiği ekle ya da uygulama ayarlarından başlatma komutunu yaz.',
      vars: { main: "index.js" },
      file: pkgRel,
    });
  }

  // --- Kilit dosyası, derleme betiği, Node sürümü ------------------------------------------------------
  if (!LOCKFILES.some((f) => tree.has(joinRel(plan.context, f)))) {
    list.add({
      id: "node-no-lockfile",
      level: "warning",
      title: "Kilit dosyası yok",
      detail: "package-lock.json, yarn.lock ya da pnpm-lock.yaml olmadan her derleme bağımlılıkların farklı bir sürümünü kurabilir.",
      fix: "Yerelde npm install çalıştırıp oluşan package-lock.json'ı depoya ekle.",
      file: pkgRel,
    });
  }
  const needsBuild = BUILD_DEPS.find((d) => d in deps);
  const ownBuild = plan.dockerfile?.instrs.some((i) => i.op === "RUN" && /\bbuild\b/.test(i.args));
  if (needsBuild && !scripts.build && !plan.options.buildCommand && !ownBuild) {
    list.add({
      id: "node-no-build",
      level: "warning",
      title: "build betiği yok",
      detail: "Proje {dep} kullanıyor ve derlenmesi gerekiyor, ama package.json'da build betiği yok.",
      fix: 'package.json\'a "build" betiği ekle ya da uygulama ayarlarından derleme komutunu yaz.',
      vars: { dep: needsBuild },
      file: pkgRel,
    });
  }
  const versioned = Boolean(pkg.engines?.node) || tree.has(joinRel(plan.context, ".nvmrc")) || tree.has(joinRel(plan.context, ".node-version")) || Boolean(plan.options.nodeVersion);
  if (!versioned && !plan.dockerfile) {
    list.add({
      id: "node-no-version",
      level: "warning",
      title: "Node sürümü belirtilmemiş",
      detail: "package.json'da engines.node, .nvmrc ya da .node-version yok; panel en yeni desteklenen sürümle derler, yereldekinden farklı olabilir.",
      fix: '.nvmrc dosyası ekle (ör. 22) ya da package.json\'a "engines": { "node": ">=22" } yaz.',
      file: pkgRel,
    });
  }
  if ("next" in deps) {
    const config = ["next.config.js", "next.config.mjs", "next.config.ts", "next.config.cjs"].map((f) => tree.text(joinRel(plan.context, f)) ?? "").join("\n");
    if (!/output\s*:\s*["']standalone["']/.test(config)) {
      list.add({
        id: "next-standalone",
        level: "info",
        title: 'Next.js output: "standalone" kullanılmıyor',
        detail: "Standalone çıktı imajı küçültür ve geliştirme bağımlılıklarını dışarıda bırakır; panel ikisini de çalıştırabilir.",
        fix: 'next.config dosyasına output: "standalone" ekle.',
      });
    }
  }
  return list.result();
}

export function whereText(source: "panel" | "dockerfile" | "preset", file?: string) {
  if (source === "panel") return "Paneldeki başlatma komutu";
  if (source === "dockerfile") return file ?? "Dockerfile";
  return "Panelin ön ayarı";
}
