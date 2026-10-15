import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { ResourceChart } from "@/components/ResourceChart";
import { api, type Container, type SystemStats } from "@/lib/api";
import { formatBytes, formatUptime, percent } from "@/lib/format";

export function DashboardPage() {
  const { data, error } = useQuery({
    queryKey: ["stats"],
    queryFn: () => api.get<SystemStats>("/system/stats"),
    refetchInterval: 2000,
  });

  if (error) return <Notice tone="danger" title="Sunucu bilgileri alınamadı">{error.message}</Notice>;
  if (!data) return <DashboardSkeleton />;

  const { system, docker } = data;
  const memPct = percent(system.memory.used, system.memory.total);
  const diskPct = system.disk ? percent(system.disk.used, system.disk.total) : null;

  return (
    <div className="mx-auto max-w-5xl">
      <header className="mb-7">
        <h1 className="text-[28px] leading-tight font-semibold tracking-[-0.02em]">{system.hostname}</h1>
        <p className="mt-1.5 flex flex-wrap items-center gap-x-2 text-[14px] text-muted">
          <span className="inline-flex items-center gap-1.5 text-ok">
            <span className="size-2 rounded-full bg-ok" />
            Çalışıyor
          </span>
          <span>{formatUptime(system.uptime)} önce açıldı, {system.platform} ({system.arch})</span>
        </p>
      </header>

      <section className="panel" aria-label="Kaynak kullanımı">
        <dl className="grid grid-cols-2 border-b border-line lg:grid-cols-4 [&>div]:border-line max-lg:[&>div:nth-child(-n+2)]:border-b [&>div:not(:last-child)]:lg:border-r max-lg:[&>div:nth-child(odd)]:border-r">
          <Metric label="İşlemci" value={`${system.cpu.usage.toFixed(0)}%`} pct={system.cpu.usage}
            detail={`${system.cpu.cores} çekirdek, yük ${system.cpu.load[0]?.toFixed(2)}`} />
          <Metric label="Bellek" value={`${memPct.toFixed(0)}%`} pct={memPct}
            detail={`${formatBytes(system.memory.used)} / ${formatBytes(system.memory.total)}`} bar />
          <Metric label="Disk" value={diskPct === null ? "–" : `${diskPct.toFixed(0)}%`} pct={diskPct ?? 0}
            detail={system.disk ? `${formatBytes(system.disk.total - system.disk.used)} boş` : "Okunamadı"} bar />
          <Metric label="Konteyner" value={docker.available ? `${docker.containers.running}` : "–"}
            detail={docker.available ? `${docker.containers.total} konteynerden çalışan` : "Docker bulunamadı"} />
        </dl>
        <div className="px-5 pt-4 pb-5">
          <ResourceChart history={system.history} />
        </div>
      </section>

      <section className="mt-9" aria-labelledby="containers-title">
        <div className="mb-3 flex items-baseline justify-between">
          <h2 id="containers-title" className="text-[17px] font-semibold tracking-[-0.01em]">Konteynerler</h2>
          {docker.available && <span className="text-[13px] text-faint">Docker {docker.version}</span>}
        </div>
        {docker.available ? (
          <ContainerList />
        ) : (
          <Notice tone="warn" title="Docker'a bağlanılamadı">
            Uygulama çalıştırmak için sunucuda Docker kurulu olmalı. install.sh Docker'ı kendisi kurar. Panel
            konteyner içinde çalışıyorsa <code className="font-mono text-[13px] text-fg">/var/run/docker.sock</code> bağlı
            olmalı.
          </Notice>
        )}
      </section>
    </div>
  );
}

function Metric(props: { label: string; value: string; detail: string; pct?: number; bar?: boolean }) {
  const pct = props.pct ?? 0;
  const level = pct >= 90 ? "critical" : pct >= 75 ? "high" : "normal";
  const valueColor = level === "critical" ? "text-accent" : level === "high" ? "text-warn" : "text-fg";
  const barColor = level === "critical" ? "bg-accent" : level === "high" ? "bg-warn" : "bg-fg/70";
  return (
    <div className="px-5 py-4">
      <dt className="text-[13px] text-muted">{props.label}</dt>
      <dd className={`mt-1 text-[28px] leading-none font-medium tracking-[-0.02em] tabular-nums ${valueColor}`}>{props.value}</dd>
      <dd className="mt-2 truncate text-[13px] text-faint">{props.detail}</dd>
      {props.bar && (
        <dd className="mt-3 h-1 overflow-hidden rounded-full bg-surface-2">
          <div className={`h-full rounded-full ${barColor} transition-[width] duration-700`} style={{ width: `${Math.min(pct, 100)}%` }} />
        </dd>
      )}
    </div>
  );
}

function ContainerList() {
  const { data, error } = useQuery({
    queryKey: ["containers"],
    queryFn: () => api.get<{ containers: Container[] }>("/system/containers"),
    refetchInterval: 5000,
  });

  if (error) return <Notice tone="danger" title="Konteynerler alınamadı">{error.message}</Notice>;
  if (!data) return <div className="panel h-28 animate-pulse" />;
  if (data.containers.length === 0)
    return (
      <div className="panel px-5 py-8 text-[14px] text-muted">
        Bu sunucuda henüz konteyner yok. Uygulamalar bölümü hazır olunca ilk uygulamanı buradan yayınlayabileceksin.
      </div>
    );

  return (
    <div className="panel overflow-hidden">
      <table className="w-full text-left text-[14px]">
        <thead className="border-b border-line text-[13px] text-muted">
          <tr>
            <th className="px-5 py-2.5 font-normal">Ad</th>
            <th className="hidden px-5 py-2.5 font-normal md:table-cell">İmaj</th>
            <th className="hidden px-5 py-2.5 font-normal sm:table-cell">Port</th>
            <th className="px-5 py-2.5 text-right font-normal">Durum</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {data.containers.map((c) => (
            <tr key={c.id}>
              <td className="max-w-0 truncate px-5 py-3 font-medium">{c.name}</td>
              <td className="hidden max-w-0 truncate px-5 py-3 font-mono text-[13px] text-muted md:table-cell">{c.image}</td>
              <td className="hidden px-5 py-3 font-mono text-[13px] text-muted sm:table-cell">{c.ports.join(", ") || "–"}</td>
              <td className="px-5 py-3 text-right whitespace-nowrap">
                <span className={`inline-flex items-center gap-1.5 ${c.state === "running" ? "text-ok" : c.state === "restarting" ? "text-warn" : "text-faint"}`}>
                  <span className="size-1.5 rounded-full bg-current" />
                  {STATE_LABELS[c.state] ?? c.state}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const STATE_LABELS: Record<string, string> = {
  running: "Çalışıyor",
  exited: "Durdu",
  restarting: "Yeniden başlıyor",
  paused: "Duraklatıldı",
  created: "Oluşturuldu",
  dead: "Çöktü",
};

function Notice({ tone, title, children }: { tone: "warn" | "danger"; title: string; children: ReactNode }) {
  return (
    <div className={`panel border-l-[3px] px-5 py-4 ${tone === "warn" ? "border-l-warn" : "border-l-accent"}`}>
      <div className="text-[15px] font-medium">{title}</div>
      <div className="mt-1 text-[14px] leading-relaxed text-muted">{children}</div>
    </div>
  );
}

function DashboardSkeleton() {
  return (
    <div className="mx-auto max-w-5xl animate-pulse">
      <div className="mb-7 h-9 w-56 rounded-md bg-surface-2" />
      <div className="panel h-80" />
    </div>
  );
}
