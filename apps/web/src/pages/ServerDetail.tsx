import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { LogViewer } from "@/components/LogViewer";
import { ResourceChart } from "@/components/ResourceChart";
import { ServerMeters } from "@/components/ServerMeters";
import { Button, ConfirmDialog, CopyField, Field, Notice, PageHeader, PageLoading, Section, StatusBadge, Tabs, useAction } from "@/components/ui";
import { api, type Container, type DockerInfo, type Server, type ServerStats } from "@/lib/api";
import { formatUptime } from "@/lib/format";

type Tab = "overview" | "setup" | "containers" | "settings";

export function ServerDetailPage() {
  const id = Number(useParams().id);
  const [params, setParams] = useSearchParams();
  const tab = (params.get("tab") as Tab) || (params.get("new") ? "setup" : "overview");
  const setTab = (t: Tab) => setParams({ tab: t }, { replace: true });
  const { data } = useQuery({ queryKey: ["server", id], queryFn: () => api.get<{ server: Server; setupLog: string }>(`/servers/${id}`), refetchInterval: (q) => (q.state.data?.server.setupRunning ? 2000 : 10_000) });
  if (!data) return <PageLoading />;
  const s = data.server;

  return (
    <>
      <PageHeader
        back={{ to: "/servers", label: "Sunucular" }}
        title={s.name}
        description={
          <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
            <StatusBadge status={s.status} />
            <span>{s.kind === "local" ? "Panelin çalıştığı sunucu" : `${s.username}@${s.host}:${s.port}`}</span>
            {s.publicIp && <span>IP {s.publicIp}</span>}
          </span>
        }
      />
      {s.status === "error" && s.statusDetail && (
        <div className="mb-6">
          <Notice tone="danger" title="Kurulum tamamlanamadı">{s.statusDetail}</Notice>
        </div>
      )}
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "overview", label: "Durum" },
          { id: "setup", label: "Kurulum" },
          { id: "containers", label: "Konteynerler" },
          { id: "settings", label: "Ayarlar" },
        ]}
      />
      {tab === "overview" && <Overview server={s} />}
      {tab === "setup" && <Setup server={s} />}
      {tab === "containers" && <Containers server={s} />}
      {tab === "settings" && <Settings server={s} />}
    </>
  );
}

function Overview({ server }: { server: Server }) {
  const { data, error } = useQuery({
    queryKey: ["server", server.id, "stats"],
    queryFn: () => api.get<{ stats: (ServerStats & { history?: ServerStats["history"] }) | null; statsError: string | null; docker: DockerInfo }>(`/servers/${server.id}/stats`),
    refetchInterval: 4000,
    enabled: server.status === "ready" || server.kind === "local",
  });
  const [history, setHistory] = useState<{ t: number; cpu: number; mem: number }[]>([]);
  // Uzak sunucuların geçmişi tarayıcıda biriktirilir (yerel sunucu geçmişi sunucudan gelir).
  useEffect(() => {
    const st = data?.stats;
    if (!st || st.history) return;
    const mem = (st.memory.used / st.memory.total) * 100;
    setHistory((h) => [...h.slice(-59), { t: Date.now(), cpu: st.cpu.usage, mem: Math.round(mem * 10) / 10 }]);
  }, [data]);

  if (server.status !== "ready" && server.kind !== "local")
    return <Notice tone="info" title="Sunucu henüz hazır değil">Kurulum sekmesinden SSH anahtarını ekleyip kurulumu başlat.</Notice>;
  if (error) return <Notice tone="danger" title="Sunucuya ulaşılamadı">{error.message}</Notice>;
  if (!data) return <PageLoading />;
  if (!data.stats) return <Notice tone="danger" title="Sunucu bilgileri okunamadı">{data.statsError}</Notice>;

  const st = data.stats;
  return (
    <>
      <section className="panel">
        <div className="border-b border-line px-5 py-4">
          <ServerMeters stats={st} />
        </div>
        <div className="px-5 pt-4 pb-5">
          <ResourceChart history={st.history ?? history} />
        </div>
      </section>
      <dl className="mt-6 grid gap-x-8 gap-y-3 text-[14px] sm:grid-cols-2">
        <Info label="İşletim sistemi" value={st.platform} />
        <Info label="Çalışma süresi" value={formatUptime(st.uptime)} />
        <Info label="İşlemci" value={[st.cpu.model && st.cpu.model !== "Bilinmiyor" ? st.cpu.model : null, `${st.cpu.cores} çekirdek`].filter(Boolean).join(", ")} />
        <Info label="Yük ortalaması" value={st.cpu.load.map((n) => n.toFixed(2)).join("  ")} />
        <Info label="Docker" value={data.docker.available ? `${data.docker.version}, ${data.docker.containers.running}/${data.docker.containers.total} konteyner çalışıyor` : `Ulaşılamıyor: ${data.docker.error}`} />
      </dl>
      {server.kind === "ssh" && <Hardening server={server} />}
    </>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4 border-b border-line pb-3">
      <dt className="text-muted">{label}</dt>
      <dd className="text-right">{value}</dd>
    </div>
  );
}

function Hardening({ server }: { server: Server }) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["server", server.id, "security"],
    queryFn: () => api.get<{ security: { firewall: boolean; fail2ban: boolean; sshBanned: number; passwordAuth: boolean; rootLogin: string } | null; error?: string }>(`/servers/${server.id}/security`),
  });
  const harden = useAction(() => api.post(`/servers/${server.id}/harden`), {
    success: "Sıkılaştırma başladı. Çıktıyı Kurulum sekmesinde görebilirsin.",
    onSuccess: () => setTimeout(() => qc.invalidateQueries({ queryKey: ["server", server.id, "security"] }), 60_000),
  });
  const sec = data?.security;
  const rows = sec
    ? [
        { ok: sec.firewall, label: "Güvenlik duvarı (UFW)", text: sec.firewall ? "Açık; yalnız SSH, 80 ve 443 izinli" : "Kapalı; tüm portlar dışarıya açık olabilir" },
        { ok: sec.fail2ban, label: "SSH kaba kuvvet koruması (fail2ban)", text: sec.fail2ban ? `Çalışıyor, şu an ${sec.sshBanned} IP banlı` : "Çalışmıyor" },
        { ok: !sec.passwordAuth, label: "SSH şifreyle giriş", text: sec.passwordAuth ? "Açık. Yalnız anahtarla giriş daha güvenli." : "Kapalı, yalnız anahtarla giriş" },
      ]
    : [];
  return (
    <Section
      title="Sunucu güvenliği"
      description="Uygulamalara gelen saldırılar Caddy'de, sunucuya gelenler güvenlik duvarı ve fail2ban ile engellenir."
      actions={<Button onClick={() => harden.mutate()} loading={harden.isPending}>Sıkılaştır</Button>}
    >
      {isLoading ? (
        <div className="panel h-28 animate-pulse" />
      ) : !sec ? (
        <Notice tone="warn" title="Güvenlik durumu okunamadı">{data?.error}</Notice>
      ) : (
        <div className="panel divide-y divide-line">
          {rows.map((r) => (
            <div key={r.label} className="flex items-start gap-3 px-5 py-3.5">
              <span className={`mt-1.5 size-2 shrink-0 rounded-full ${r.ok ? "bg-ok" : "bg-warn"}`} />
              <div>
                <div className="text-[14px] font-medium">{r.label}</div>
                <div className="text-[13px] text-muted">{r.text}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

function Setup({ server }: { server: Server }) {
  const qc = useQueryClient();
  const [test, setTest] = useState<{ ok: boolean; output: string } | null>(null);
  const testConn = useAction(() => api.post<{ ok: boolean; output: string }>(`/servers/${server.id}/test`), { onSuccess: setTest });
  const setup = useAction(() => api.post(`/servers/${server.id}/setup`), { invalidate: [["server", server.id]] });
  const installCmd = server.sshKey
    ? `mkdir -p ~/.ssh && echo '${server.sshKey.publicKey}' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys`
    : "";

  return (
    <div className="space-y-8">
      {server.kind === "ssh" && server.sshKey && (
        <ol className="space-y-6">
          <li>
            <h3 className="mb-1 font-medium">1. SSH anahtarını sunucuya ekle</h3>
            <p className="mb-3 text-[14px] text-muted">Sunucuna şu anki yöntemle bağlan ({server.username} kullanıcısıyla) ve bu komutu çalıştır:</p>
            <CopyField value={installCmd} />
          </li>
          <li>
            <h3 className="mb-1 font-medium">2. Bağlantıyı dene</h3>
            <p className="mb-3 text-[14px] text-muted">Panel sunucuya bu anahtarla bağlanabiliyor mu kontrol eder.</p>
            <Button onClick={() => testConn.mutate()} loading={testConn.isPending}>Bağlantıyı dene</Button>
            {test && (
              <pre className={`mt-3 rounded-md border px-4 py-3 font-mono text-[13px] whitespace-pre-wrap ${test.ok ? "border-ok/40 text-fg" : "border-accent/40 text-accent"}`}>{test.output}</pre>
            )}
          </li>
          <li>
            <h3 className="mb-1 font-medium">3. Kurulumu başlat</h3>
            <p className="mb-3 text-[14px] text-muted">Docker yoksa kurulur, ardından WAF ve hız sınırı modülleriyle Caddy hazırlanır. İlk kurulum 3-6 dakika sürebilir.</p>
          </li>
        </ol>
      )}
      <div>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h3 className="font-medium">Kurulum çıktısı</h3>
          <Button variant={server.status === "ready" ? "secondary" : "primary"} onClick={() => setup.mutate()} loading={setup.isPending || server.setupRunning} disabled={server.setupRunning}>
            {server.status === "ready" ? "Kurulumu tekrar çalıştır" : "Kurulumu başlat"}
          </Button>
        </div>
        <LogViewer url={`/api/servers/${server.id}/setup/stream`} height="h-80" emptyText="Kurulum henüz çalıştırılmadı." onDone={() => qc.invalidateQueries({ queryKey: ["server", server.id] })} />
      </div>
    </div>
  );
}

function Containers({ server }: { server: Server }) {
  const { data, error } = useQuery({ queryKey: ["server", server.id, "containers"], queryFn: () => api.get<{ containers: Container[] }>(`/servers/${server.id}/containers`), refetchInterval: 8000 });
  if (error) return <Notice tone="danger" title="Konteynerler alınamadı">{error.message}</Notice>;
  if (!data) return <div className="panel h-40 animate-pulse" />;
  return (
    <div className="panel overflow-x-auto">
      <table className="w-full text-left text-[14px]">
        <thead className="border-b border-line text-[13px] text-muted">
          <tr>
            <th className="px-5 py-2.5 font-normal">Ad</th>
            <th className="hidden px-5 py-2.5 font-normal md:table-cell">İmaj</th>
            <th className="px-5 py-2.5 text-right font-normal">Durum</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {data.containers.map((c) => (
            <tr key={c.id}>
              <td className="px-5 py-3">
                <div className="font-medium">{c.name}</div>
                <div className="text-[12px] text-faint">{c.managed ? "Xudbin tarafından yönetiliyor" : "Xudbin dışında oluşturulmuş"}</div>
              </td>
              <td className="hidden max-w-[16rem] truncate px-5 py-3 font-mono text-[13px] text-muted md:table-cell">{c.image}</td>
              <td className="px-5 py-3 text-right">
                <StatusBadge status={c.state} label={c.status} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Settings({ server }: { server: Server }) {
  const navigate = useNavigate();
  const [form, setForm] = useState({
    name: server.name,
    host: server.host ?? "",
    port: String(server.port),
    username: server.username,
    publicIp: server.publicIp ?? "",
    httpsMode: server.httpsMode,
    acmeEmail: server.acmeEmail ?? "",
  });
  const [confirm, setConfirm] = useState(false);
  const save = useAction(
    () =>
      api.patch(`/servers/${server.id}`, {
        name: form.name,
        publicIp: form.publicIp,
        httpsMode: form.httpsMode,
        acmeEmail: form.acmeEmail,
        ...(server.kind === "ssh" ? { host: form.host, port: Number(form.port), username: form.username } : {}),
      }),
    { success: "Sunucu ayarları kaydedildi", invalidate: [["server", server.id], ["servers"]] },
  );
  const del = useAction(() => api.del(`/servers/${server.id}`), {
    success: "Sunucu kaldırıldı",
    invalidate: [["servers"]],
    onSuccess: () => navigate("/servers"),
  });

  return (
    <>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
        className="panel space-y-4 p-5"
      >
        <Field label="Ad">
          <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        {server.kind === "ssh" && (
          <div className="grid gap-3 sm:grid-cols-[1fr_6rem_10rem]">
            <Field label="Adres">
              <input className="input" value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} />
            </Field>
            <Field label="Port">
              <input className="input" value={form.port} onChange={(e) => setForm({ ...form, port: e.target.value.replace(/\D/g, "") })} />
            </Field>
            <Field label="Kullanıcı">
              <input className="input" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
            </Field>
          </div>
        )}
        <Field label="Dış IP adresi" hint="Otomatik alan adları (uygulama.1-2-3-4.sslip.io) bu IP ile üretilir.">
          <input className="input" value={form.publicIp} onChange={(e) => setForm({ ...form, publicIp: e.target.value.trim() })} placeholder="203.0.113.10" />
        </Field>
        <Field label="HTTPS">
          <select className="input" value={form.httpsMode} onChange={(e) => setForm({ ...form, httpsMode: e.target.value as Server["httpsMode"] })}>
            <option value="auto">Let's Encrypt ile otomatik (önerilen)</option>
            <option value="internal">Kendi imzalı sertifika (iç ağ, test)</option>
            <option value="off">Kapalı, yalnız HTTP</option>
          </select>
        </Field>
        {form.httpsMode === "auto" && (
          <Field label="Sertifika e-postası" hint="İsteğe bağlı. Let's Encrypt sertifika sorunlarında buraya yazar.">
            <input className="input" type="email" value={form.acmeEmail} onChange={(e) => setForm({ ...form, acmeEmail: e.target.value })} />
          </Field>
        )}
        <div className="flex justify-end">
          <Button type="submit" variant="primary" loading={save.isPending}>Kaydet</Button>
        </div>
      </form>

      {server.kind === "ssh" && (
        <Section title="Sunucuyu kaldır" description="Sunucu panelden kaldırılır; sunucudaki konteynerler ve veriler silinmez.">
          <Button variant="danger" onClick={() => setConfirm(true)}>Sunucuyu kaldır</Button>
          <ConfirmDialog
            open={confirm}
            onClose={() => setConfirm(false)}
            title="Sunucu kaldırılsın mı?"
            description="Bu sunucudaki uygulamaları ve veritabanlarını önce silmen gerekir."
            confirmLabel="Kaldır"
            loading={del.isPending}
            onConfirm={() => del.mutate()}
          />
        </Section>
      )}
    </>
  );
}
