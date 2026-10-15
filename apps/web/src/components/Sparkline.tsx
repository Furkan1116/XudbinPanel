import { useId } from "react";

/** 0–100 arası değerleri küçük bir alan grafiği olarak çizer. */
export function Sparkline({ values, className = "" }: { values: number[]; className?: string }) {
  const id = useId();
  if (values.length < 2) return <div className={className} />;

  const w = 100;
  const h = 32;
  const step = w / (values.length - 1);
  const points = values.map((v, i) => [i * step, h - (Math.min(Math.max(v, 0), 100) / 100) * h] as const);
  const line = points.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(2)},${y.toFixed(2)}`).join(" ");

  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className={className} aria-hidden>
      <defs>
        <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="var(--color-accent)" stopOpacity="0.25" />
          <stop offset="100%" stopColor="var(--color-accent)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${line} L${w},${h} L0,${h} Z`} fill={`url(#${id})`} />
      <path d={line} fill="none" stroke="var(--color-accent)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
