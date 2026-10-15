import { useQuery } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { Link, useNavigate } from "react-router";
import { ServerMeters } from "@/components/ServerMeters";
import { Button, Dialog, Field, PageHeader, PageLoading, StatusBadge, useAction } from "@/components/ui";
import { api, type Server, type ServerOverview } from "@/lib/api";

export function ServersPage() {
  const [adding, setAdding] = useState(false);
  const { data } = useQuery({ queryKey: ["servers", "overview"], queryFn: () => api.get<{ servers: ServerOverview[] }>("/servers/overview"), refetchInterval: 5000 });
  if (!data) return <PageLoading />;

  return (
    <>
      <PageHeader
        title="Sunucular"
        description="Uygulamalarını istediğin sunucuda çalıştır. Her sunucuya SSH ile bağlanılır, Docker ve Caddy otomatik kurulur."
        actions={<Button variant="primary" onClick={() => setAdding(true)}>Sunucu ekle</Button>}
      />
      <div className="panel divide-y divide-line">
        {data.servers.map((s) => (
          <Link key={s.id} to={`/servers/${s.id}`} className="grid gap-4 px-5 py-4 hover:bg-surface-2/50 md:grid-cols-[minmax(0,14rem)_1fr_auto] md:items-center">
            <div className="min-w-0">
              <div className="truncate font-medium">{s.name}</div>
              <div className="truncate text-[13px] text-faint">{s.kind === "local" ? "Panelin çalıştığı sunucu" : `${s.username}@${s.host}:${s.port}`}</div>
              <div className="mt-1 text-[13px] text-muted">
                {s.apps} uygulama, {s.databases} veritabanı
              </div>
            </div>
            <div>{s.stats ? <ServerMeters stats={s.stats} /> : <p className="text-[13px] text-muted">{s.status === "ready" ? (s.statsError ?? "Bilgi alınamadı") : "Kurulum tamamlanınca kaynak kullanımı görünecek."}</p>}</div>
            <StatusBadge status={s.status} />
          </Link>
        ))}
      </div>
      <AddServerDialog open={adding} onClose={() => setAdding(false)} />
    </>
  );
}

function AddServerDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const [form, setForm] = useState({ name: "", host: "", port: "22", username: "root" });
  const create = useAction(
    () => api.post<{ server: Server }>("/servers", { ...form, port: Number(form.port) || 22 }),
    {
      invalidate: [["servers"]],
      onSuccess: (r) => {
        onClose();
        navigate(`/servers/${r.server.id}?new=1`);
      },
    },
  );
  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };
  return (
    <Dialog open={open} onClose={onClose} title="Sunucu ekle" description="Ubuntu veya Debian bir sunucu. Sonraki adımda sunucuya ekleyeceğin SSH anahtarını vereceğiz.">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Ad" hint="Panelde görünecek isim, ör. istanbul-1.">
          <input className="input" required autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <div className="grid grid-cols-[1fr_6rem] gap-3">
          <Field label="IP adresi veya alan adı">
            <input className="input" required value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value.trim() })} placeholder="203.0.113.10" />
          </Field>
          <Field label="SSH portu">
            <input className="input" inputMode="numeric" value={form.port} onChange={(e) => setForm({ ...form, port: e.target.value.replace(/\D/g, "") })} />
          </Field>
        </div>
        <Field label="Kullanıcı" hint="root önerilir. Başka bir kullanıcı şifresiz sudo yetkisine sahip olmalı.">
          <input className="input" required value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value.trim() })} />
        </Field>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>Vazgeç</Button>
          <Button type="submit" variant="primary" loading={create.isPending}>Devam et</Button>
        </div>
      </form>
    </Dialog>
  );
}
