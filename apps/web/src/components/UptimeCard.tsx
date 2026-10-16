import { useQuery } from "@tanstack/react-query";
import { Activity } from "lucide-react";
import { useState } from "react";
import { api, type App } from "@/lib/api";
import { duration, timeAgo } from "@/lib/format";
import { t } from "@/lib/i18n";

type Uptime = {
  up24h: number | null;
  up7d: number | null;
  up30d: number | null;
  down: boolean;
  recent: { at: number; ok: number; status: number | null; ms: number }[];
  incidents: { startedAt: number; endedAt: number | null; reason: string }[];
};

const pct = (v: number | null) => (v === null ? "–" : `%${(v * 100).toFixed(v === 1 ? 0 : 2)}`);

/** Uygulamanın erişilebilirliği: dakikada bir dışarıdan yapılan kontroller, yanıt süresi ve kesintiler. */
export function UptimeCard({ app }: { app: App }) {
  const { data } = useQuery({ queryKey: ["app", app.id, "uptime"], queryFn: () => api.get<Uptime>(`/apps/${app.id}/uptime`), refetchInterval: 30_000 });
  const [hover, setHover] = useState<number | null>(null);
  if (!app.uptimeEnabled || !app.domains.length) return null;
  if (!data) return <div className="panel h-28 animate-pulse" />;

  // Son 24 saati 48 dilime böl: her dilim o yarım saatteki kontrollerin durumu.
  const now = Date.now();
  const buckets = Array.from({ length: 48 }, (_, i) => {
    const from = now - (48 - i) * 30 * 60_000;
    const rows = data.recent.filter((r) => r.at >= from && r.at < from + 30 * 60_000);
    const fails = rows.filter((r) => !r.ok).length;
    const avg = rows.length ? Math.round(rows.reduce((s, r) => s + r.ms, 0) / rows.length) : null;
    return { from, n: rows.length, fails, avg };
  });
  const last = data.recent.at(-1);
  const active = hover !== null ? buckets[hover] : null;
  const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });

  return (
    <div className="panel px-5 py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Activity className="size-4 text-muted" />
          <h3 className="font-medium">{t("Erişilebilirlik")}</h3>
          <span className={`ml-1 inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[12px] ${data.down ? "bg-accent/15 text-accent" : "bg-ok/15 text-ok"}`}>
            <span className={`size-1.5 rounded-full ${data.down ? "bg-accent" : "bg-ok"}`} />
            {data.down ? t("Erişilemiyor") : t("Çalışıyor")}
          </span>
        </div>
        <dl className="flex gap-5 text-[13px]">
          {(
            [
              ["24 saat", data.up24h],
              ["7 gün", data.up7d],
              ["30 gün", data.up30d],
            ] as const
          ).map(([label, v]) => (
            <div key={label} className="text-right">
              <dt className="text-faint">{t(label)}</dt>
              <dd className="font-medium tabular-nums">{pct(v)}</dd>
            </div>
          ))}
        </dl>
      </div>

      <div className="mt-3 flex h-8 gap-[2px]" onPointerLeave={() => setHover(null)}>
        {buckets.map((b, i) => (
          <div
            key={b.from}
            onPointerEnter={() => setHover(i)}
            className={`flex-1 rounded-[2px] ${b.n === 0 ? "bg-line" : b.fails === 0 ? "bg-ok/70" : b.fails === b.n ? "bg-accent" : "bg-warn"}`}
          />
        ))}
      </div>
      <p className="mt-2 text-[12px] text-muted">
        {active
          ? active.n === 0
            ? t("{t}: kontrol yok", { t: timeFmt.format(active.from) })
            : t("{t}: {n} kontrol, {f} başarısız, ortalama {ms} ms", { t: timeFmt.format(active.from), n: active.n, f: active.fails, ms: active.avg ?? 0 })
          : last
            ? t("Son kontrol {ago}: {status}, {ms} ms. Dakikada bir, gerçek alan adıyla dışarıdan denenir.", { ago: timeAgo(last.at), status: last.status ?? t("yanıt yok"), ms: last.ms })
            : t("Henüz kontrol yapılmadı.")}
      </p>

      {data.incidents.length > 0 && (
        <ul className="mt-3 space-y-1 border-t border-line pt-3 text-[13px]">
          {data.incidents.slice(0, 5).map((inc) => (
            <li key={inc.startedAt} className="flex flex-wrap justify-between gap-2">
              <span className={inc.endedAt ? "text-muted" : "text-accent"}>
                {inc.endedAt ? t("Kesinti") : t("Devam eden kesinti")}: {inc.reason}
              </span>
              <span className="text-faint tabular-nums">
                {new Date(inc.startedAt).toLocaleString()} · {inc.endedAt ? duration(inc.startedAt, inc.endedAt) : timeAgo(inc.startedAt)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
