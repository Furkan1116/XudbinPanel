import {
  siAstro, siBun, siDeno, siDjango, siDocker, siDotnet, siFastapi, siFlask, siGo, siHtml5, siLaravel, siNestjs,
  siNextdotjs, siNodedotjs, siNuxt, siPhp, siPython, siReact, siRemix, siRubyonrails, siRust, siSpringboot, siSvelte,
} from "simple-icons";

type Icon = { path: string; hex: string };
const ICONS: Record<string, Icon> = {
  django: siDjango, flask: siFlask, fastapi: siFastapi, python: siPython,
  nextjs: siNextdotjs, nuxt: siNuxt, sveltekit: siSvelte, astro: siAstro, remix: siRemix, nestjs: siNestjs,
  spa: siReact, node: siNodedotjs, bun: siBun, deno: siDeno,
  laravel: siLaravel, php: siPhp, dotnet: siDotnet, go: siGo, rust: siRust, java: siSpringboot, rails: siRubyonrails,
  static: siHtml5, dockerfile: siDocker,
};

/** Siyah logolar (Next.js, Bun, Rust...) koyu temada görünmez; onlar metin rengini kullanır. */
export function FrameworkLogo({ id, className = "size-6" }: { id: string; className?: string }) {
  const icon = ICONS[id];
  if (!icon) return <span className={`${className} rounded bg-surface-2`} />;
  const dark = parseInt(icon.hex, 16) < 0x333333;
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden fill={dark ? "currentColor" : `#${icon.hex}`}>
      <path d={icon.path} />
    </svg>
  );
}
