import { detectFrameworks, getFramework, openRepo } from "../frameworks/index.js";
import type { PreflightContext } from "./types.js";
import { joinRel, type SourceTree } from "./tree.js";

/**
 * Deploy'un bu kaynakla ne yapacağının statik kestirimi: hangi framework (ön ayar) ya da depodaki hangi Dockerfile
 * kullanılacak ve konteyner hangi komutla başlayacak. deploy.ts'deki seçim sırası izlenir; kod çalıştırılmaz.
 */

export type Instr = { op: string; args: string; line: number; stage: number };
export type Stage = { image: string; alias: string | null; line: number };
export type Dockerfile = { rel: string; instrs: Instr[]; stages: Stage[] };

export type StartCommand = {
  command: string;
  /** Komutun nereden geldiği. */
  source: "panel" | "dockerfile" | "preset";
  file?: string;
  line?: number;
  /** Komut bir package.json betiğini çağırıyorsa: betiğin adı ve (varsa) içeriği. */
  script?: { name: string; body: string | null };
};

export type BuildPlan = {
  /** Çözülen framework kimliği ("dockerfile" depodaki Dockerfile demek); tanınamadıysa null. */
  frameworkId: string | null;
  frameworkName: string | null;
  options: Record<string, string | boolean | undefined>;
  /** Depodaki Dockerfile kullanılacaksa ayrıştırılmış hâli. */
  dockerfile: Dockerfile | null;
  /** Ön ayar kullanılıyorsa panelin üreteceği Dockerfile'ın ayrıştırılmış hâli. */
  generated: Dockerfile | null;
  start: StartCommand | null;
  /** Bağlam klasörü (kökten göreli). */
  context: string;
};

/** Dockerfile'ı komutlara ayırır: satır devamı (\), yorumlar ve çok aşamalı yapı (FROM ... AS ad). */
export function parseDockerfile(text: string, rel = "Dockerfile"): Dockerfile {
  const instrs: Instr[] = [];
  const stages: Stage[] = [];
  const lines = text.split(/\r?\n/);
  let buf = "";
  let startLine = 0;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const trimmed = raw.trim();
    if (!buf && (!trimmed || trimmed.startsWith("#"))) continue;
    if (buf && trimmed.startsWith("#")) continue;
    if (!buf) startLine = i + 1;
    if (trimmed.endsWith("\\")) {
      buf += `${trimmed.slice(0, -1)} `;
      continue;
    }
    buf += trimmed;
    const m = buf.match(/^(\w+)\s*(.*)$/s);
    buf = "";
    if (!m) continue;
    const op = m[1]!.toUpperCase();
    const args = m[2]!.trim();
    if (op === "FROM") {
      const parts = args.split(/\s+/).filter((p) => !p.startsWith("--"));
      const asIndex = parts.findIndex((p) => p.toLowerCase() === "as");
      stages.push({ image: parts[0] ?? "", alias: asIndex > 0 ? (parts[asIndex + 1] ?? null) : null, line: startLine });
    }
    instrs.push({ op, args, line: startLine, stage: Math.max(stages.length - 1, 0) });
  }
  return { rel, instrs, stages };
}

/** Exec biçimini (["sh", "-c", "..."]) düz komut metnine çevirir. */
function commandText(args: string) {
  if (!args.startsWith("[")) return args;
  try {
    const parts = JSON.parse(args) as unknown;
    if (Array.isArray(parts)) return parts.map(String).join(" ");
  } catch {}
  return args;
}

/** Son aşamanın aşama zinciri (FROM <önceki aşama> ile miras alınanlar dahil), sondan başa. */
export function finalChain(df: Dockerfile): number[] {
  const chain: number[] = [];
  let index = df.stages.length - 1;
  while (index >= 0 && !chain.includes(index)) {
    chain.push(index);
    const image = df.stages[index]!.image.toLowerCase();
    index = df.stages.findIndex((s, i) => i < index && s.alias?.toLowerCase() === image);
  }
  return chain;
}

/** Son aşamada geçerli olan komut (zincirde en yakın aşamadaki son komut). */
export function lastInChain(df: Dockerfile, op: string): Instr | null {
  for (const stage of finalChain(df)) {
    const found = df.instrs.filter((i) => i.stage === stage && i.op === op).at(-1);
    if (found) return found;
  }
  return null;
}

/** Dockerfile'ın başlatma komutu: ENTRYPOINT + CMD. */
function dockerfileStart(df: Dockerfile): { command: string; line: number } | null {
  const entry = lastInChain(df, "ENTRYPOINT");
  const cmd = lastInChain(df, "CMD");
  if (!entry && !cmd) return null;
  const command = [entry ? commandText(entry.args) : "", cmd ? commandText(cmd.args) : ""].filter(Boolean).join(" ");
  return { command, line: (cmd ?? entry)!.line };
}

type Pkg = { scripts?: Record<string, string> };

/** "npm run dev", "npm start", "yarn dev", "pnpm dev", "bun run dev" gibi betik çağrısındaki betik adı. */
export function scriptName(command: string): string | null {
  const m = command.match(/(?:^|[\s;&|(])(npm|pnpm|yarn|bun)\s+(?:run(?:-script)?\s+)?([\w:.-]+)/);
  if (!m) return null;
  const word = m[2]!;
  if (m[1] === "npm" && word === "start") return "start";
  // Paket yöneticisinin kendi alt komutları betik değildir.
  if (["install", "ci", "i", "add", "exec", "x", "dlx", "npx", "prune", "rebuild", "test", "node", "--version"].includes(word)) return null;
  // "bun index.ts" / "bun run server.js" betik değil dosya çalıştırır.
  if (/\.(?:[cm]?[jt]sx?)$/.test(word)) return null;
  if (m[1] === "npm" && !/\brun(?:-script)?\s/.test(m[0])) return null;
  return word;
}

/**
 * Kaynağın nasıl derlenip başlatılacağını kestirir. Ön ayarın Dockerfile üretimi saf bir işlevdir (yalnız dosya okur);
 * hata verirse kestirim başlatma komutu olmadan sürer.
 */
export function planBuild(tree: SourceTree, contextDir: string, contextRel: string, ctx: PreflightContext): BuildPlan {
  const options = { ...ctx.buildOptions };
  let frameworkId: string | null = ctx.framework || "auto";
  if (frameworkId === "auto") {
    const best = detectFrameworks(contextDir).matches[0];
    frameworkId = best?.id ?? null;
    if (best) Object.assign(options, { ...best.options, ...ctx.buildOptions });
  }
  const fw = frameworkId ? getFramework(frameworkId) : undefined;
  const plan: BuildPlan = { frameworkId, frameworkName: fw?.name ?? null, options, dockerfile: null, generated: null, start: null, context: contextRel };

  if (frameworkId === "dockerfile") {
    const name = (typeof options.dockerfilePath === "string" && options.dockerfilePath) || ctx.dockerfilePath || "Dockerfile";
    const rel = joinRel(contextRel, name);
    const text = tree.text(rel);
    if (text !== null) plan.dockerfile = parseDockerfile(text, rel);
  } else if (fw) {
    try {
      plan.generated = parseDockerfile(fw.build(openRepo(contextDir), options, {}).dockerfile, "Dockerfile.xudbin");
    } catch {
      plan.generated = null;
    }
  }

  if (ctx.command?.trim()) plan.start = { command: ctx.command.trim(), source: "panel" };
  else if (plan.dockerfile) {
    const s = dockerfileStart(plan.dockerfile);
    if (s) plan.start = { command: s.command, source: "dockerfile", file: plan.dockerfile.rel, line: s.line };
  } else if (plan.generated) {
    const s = dockerfileStart(plan.generated);
    if (s) plan.start = { command: s.command, source: "preset" };
  }

  if (plan.start) {
    const name = scriptName(plan.start.command);
    if (name) {
      const pkg = tree.json<Pkg>(joinRel(contextRel, "package.json"));
      plan.start.script = { name, body: pkg?.scripts?.[name] ?? null };
    }
  }
  return plan;
}

/** Başlatma komutunun asıl çalışan metni: betik çağrısıysa betiğin içeriği de eklenir. */
export function startText(start: StartCommand | null) {
  if (!start) return "";
  return start.script?.body ? `${start.command} ${start.script.body}` : start.command;
}
