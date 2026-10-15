import { useQuery } from "@tanstack/react-query";
import { Box, Cpu, HardDrive, MemoryStick, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Sparkline } from "@/components/Sparkline";
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
  const diskPct = system.disk ? percent(system.disk.used, system.disk.total) : 0;

  return (
    <div className="mx-auto max-w-6xl">
      <header className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="mb-1 flex items-center gap-2 text-xs text-muted">
            <span className="size-1.5 rounded-full bg-accent shadow-[0_0_8px] shadow-accent" />
            Çevrimiçi · Çalışma süresi {formatUptime(system.uptime)}
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">{system.hostname}</h1>
        </div>
        <div className="font-mono text-xs text-faint">
          {system.platform} · {system.arch}
        </div>
      </header>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard icon={Cpu} label="İşlemci" value={`${system.cpu.usage.toFixed(0)}%`} pct={system.cpu.usage}
          detail={`${system.cpu.cores} çekirdek · yük ${system.cpu.load[0]?.toFixed(2)}`}>
          <Sparkline values={system.history.map((h) => h.cpu)} className="mt-4 h-10 w-full" />
        </StatCard>
        <StatCard icon={MemoryStick} label="Bellek" value={`${memPct.toFixed(0)}%`} pct={memPct}
          detail={`${formatBytes(system.memory.used)} / ${formatBytes(system.memory.total)}`}>
          <Sparkline values={system.history.map((h) => h.mem)} className="mt-4 h-10 w-full" />
        </StatCard>
        <StatCard icon={HardDrive} label="Disk" value={system.disk ? `${diskPct.toFixed(0)}%` : "—"} pct={diskPct}
          detail={system.disk ? `${formatBytes(system.disk.used)} / ${formatBytes(system.disk.total)}` : "Okunamadı"}>
          <Meter pct={diskPct} />
        </StatCard>
        <StatCard icon={Box} label="Docker"
          value={docker.available ? `${docker.containers.running}/${docker.containers.total}` : "Yok"}
          detail={docker.available ? `v${docker.version} · ${docker.images} imaj` : "Bağlanılamadı"}>
          <Meter pct={docker.available ? percent(docker.containers.running, docker.containers.total) : 0} />
        </StatCard>
      </div>

      <section className="mt-10">
        <h2 className="mb-4 text-sm font-medium text-muted">Konteynerler</h2>
        {docker.available ? (
          <ContainerList />
        ) : (
          <Notice tone="warn" title="Docker'a ulaşılamıyor">
            Uygulama çalıştırabilmek için sunucuda Docker kurulu olmalı. Kurulum scripti bunu otomatik yapar; panel
            konteyner içinde çalışıyorsa <code className="font-mono text-fg">/var/run/docker.sock</code> bağlı olmalı.
            <div className="mt-2 font-mono text-xs text-faint">{docker.error}</div>
          </Notice>
        )}
      </section>
    </div>
  );
}

function StatCard(props: { icon: LucideIcon; label: string; value: string; detail: string; pct?: number; children?: ReactNode }) {
  const tone = (props.pct ?? 0) >= 90 ? "text-danger" : (props.pct ?? 0) >= 75 ? "text-warn" : "text-fg";
  return (
    <div className="card p-5">
      <div className="flex items-center gap-2 text-sm text-muted">
        <props.icon className="size-4" />
        {props.label}
      </div>
      <div className={`mt-3 font-mono text-3xl font-medium tracking-tight tabular-nums ${tone}`}>{props.value}</div>
      <div className="mt-1 truncate text-xs text-faint">{props.detail}</div>
      {props.children}
    </div>
  );
}

function Meter({ pct }: { pct: number }) {
  const color = pct >= 90 ? "bg-danger" : pct >= 75 ? "bg-warn" : "bg-accent";
  return (
    <div className="mt-4 flex h-10 items-end">
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
        <div className={`h-full rounded-full ${color} transition-[width] duration-700`} style={{ width: `${Math.min(pct, 100)}%` }} />
      </div>
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
  if (!data) return <div className="card h-32 animate-pulse" />;
  if (data.containers.length === 0)
    return <div className="card px-5 py-10 text-center text-sm text-muted">Henüz çalışan bir konteyner yok.</div>;

  return (
    <div className="card divide-y divide-line overflow-hidden">
      {data.containers.map((c) => (
        <div key={c.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3.5">
          <span className={`size-2 shrink-0 rounded-full ${c.state === "running" ? "bg-accent" : c.state === "restarting" ? "bg-warn" : "bg-faint"}`} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">{c.name}</div>
            <div className="truncate font-mono text-xs text-faint">{c.image}</div>
          </div>
          {c.ports.length > 0 && <div className="font-mono text-xs text-muted">{c.ports.join(", ")}</div>}
          <div className="w-full text-xs text-muted sm:w-40 sm:text-right">{c.status}</div>
        </div>
      ))}
    </div>
  );
}

function Notice({ tone, title, children }: { tone: "warn" | "danger"; title: string; children: ReactNode }) {
  const styles = tone === "warn" ? "border-warn/25 bg-warn/5" : "border-danger/25 bg-danger/5";
  return (
    <div className={`rounded-xl border px-5 py-4 ${styles}`}>
      <div className={`text-sm font-medium ${tone === "warn" ? "text-warn" : "text-danger"}`}>{title}</div>
      <div className="mt-1.5 text-sm leading-relaxed text-muted">{children}</div>
    </div>
  );
}

function DashboardSkeleton() {
  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-8 h-12 w-64 animate-pulse rounded-lg bg-surface" />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => <div key={i} className="card h-44 animate-pulse" />)}
      </div>
    </div>
  );
}
