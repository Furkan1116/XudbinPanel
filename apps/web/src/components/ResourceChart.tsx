import { useRef, useState } from "react";
import { t } from "@/lib/i18n";

type Point = { t: number; cpu: number; mem: number };

const WINDOW_MS = 2 * 60 * 1000;
const H = 160;

/** Son iki dakikanın işlemci ve bellek kullanımını çizer; üzerine gelince o anın değerlerini gösterir. */
export function ResourceChart({ history }: { history: Point[] }) {
  const ref = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  const end = history.at(-1)?.t ?? Date.now();
  const start = end - WINDOW_MS;
  const x = (t: number) => ((t - start) / WINDOW_MS) * 100;
  const y = (v: number) => H - (Math.min(Math.max(v, 0), 100) / 100) * H;
  const path = (key: "cpu" | "mem") =>
    history.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(2)},${y(p[key]).toFixed(2)}`).join(" ");

  const onMove = (e: React.PointerEvent) => {
    const box = ref.current?.getBoundingClientRect();
    if (!box || history.length === 0) return;
    const t = start + ((e.clientX - box.left) / box.width) * WINDOW_MS;
    let best = 0;
    history.forEach((p, i) => {
      if (Math.abs(p.t - t) < Math.abs(history[best]!.t - t)) best = i;
    });
    setHover(best);
  };

  const active = hover !== null ? history[hover] : history.at(-1);
  const secondsAgo = active ? Math.round((end - active.t) / 1000) : 0;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-baseline gap-x-5 gap-y-1 text-[13px]">
        <Legend color="bg-accent" label={t("İşlemci")} value={active?.cpu} />
        <Legend color="bg-[var(--chart-2)]" label={t("Bellek")} value={active?.mem} />
        <span className="ml-auto text-faint">{hover !== null && secondsAgo > 0 ? t("{s} sn önce", { s: secondsAgo }) : t("Son 2 dakika")}</span>
      </div>

      <div className="relative" style={{ height: H }}>
        {[100, 50, 0].map((v) => (
          <div key={v} className="absolute inset-x-0 border-t border-dashed border-line" style={{ top: y(v) }}>
            <span className="absolute -top-2.5 right-0 bg-surface pl-1.5 text-[11px] text-faint tabular-nums">{v}%</span>
          </div>
        ))}
        <svg
          ref={ref}
          viewBox={`0 0 100 ${H}`}
          preserveAspectRatio="none"
          className="absolute inset-0 h-full w-[calc(100%-2.25rem)] touch-none overflow-visible"
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
          role="img"
          aria-label={t("İşlemci %{cpu}, bellek %{mem}", { cpu: active?.cpu ?? 0, mem: active?.mem ?? 0 })}
        >
          <path d={path("mem")} fill="none" stroke="var(--chart-2)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
          <path d={path("cpu")} fill="none" stroke="var(--accent)" strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
          {hover !== null && history[hover] && (
            <line x1={x(history[hover].t)} x2={x(history[hover].t)} y1={0} y2={H} stroke="var(--line-strong)" vectorEffect="non-scaling-stroke" />
          )}
        </svg>
      </div>
    </div>
  );
}

function Legend({ color, label, value }: { color: string; label: string; value?: number }) {
  return (
    <span className="inline-flex items-baseline gap-2">
      <span className={`inline-block h-[3px] w-3.5 -translate-y-[3px] rounded-full ${color}`} />
      <span className="text-muted">{label}</span>
      <span className="font-medium tabular-nums">{value !== undefined ? `${value.toFixed(0)}%` : "–"}</span>
    </span>
  );
}
