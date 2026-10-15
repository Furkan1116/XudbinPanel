import type { ServerStats } from "@/lib/api";
import { formatBytes, percent } from "@/lib/format";
import { t } from "@/lib/i18n";

/** Sunucu kartlarında kullanılan küçük CPU/RAM/disk çubukları. */
export function ServerMeters({ stats }: { stats: ServerStats }) {
  const mem = percent(stats.memory.used, stats.memory.total);
  const disk = stats.disk ? percent(stats.disk.used, stats.disk.total) : null;
  return (
    <dl className="grid grid-cols-3 gap-4">
      <Meter label={t("İşlemci")} pct={stats.cpu.usage} detail={t("{n} çekirdek", { n: stats.cpu.cores })} />
      <Meter label={t("Bellek")} pct={mem} detail={`${formatBytes(stats.memory.used)} / ${formatBytes(stats.memory.total)}`} />
      <Meter label={t("Disk")} pct={disk} detail={stats.disk ? t("{n} boş", { n: formatBytes(stats.disk.total - stats.disk.used) }) : t("Okunamadı")} />
    </dl>
  );
}

function Meter({ label, pct, detail }: { label: string; pct: number | null; detail: string }) {
  const p = pct ?? 0;
  const color = p >= 90 ? "bg-accent" : p >= 75 ? "bg-warn" : "bg-fg/60";
  const text = p >= 90 ? "text-accent" : p >= 75 ? "text-warn" : "";
  return (
    <div className="min-w-0">
      <dt className="flex items-baseline justify-between gap-2 text-[13px] text-muted">
        {label}
        <span className={`font-medium text-fg tabular-nums ${text}`}>{pct === null ? "–" : `${p.toFixed(0)}%`}</span>
      </dt>
      <dd className="mt-1.5 h-1 overflow-hidden rounded-full bg-surface-2">
        <div className={`h-full rounded-full ${color} transition-[width] duration-700`} style={{ width: `${Math.min(p, 100)}%` }} />
      </dd>
      <dd className="mt-1.5 truncate text-[12px] text-faint">{detail}</dd>
    </div>
  );
}
