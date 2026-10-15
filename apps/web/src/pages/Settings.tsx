import { useQuery } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { useSearchParams } from "react-router";
import { Button, ConfirmDialog, CopyField, Dialog, Field, Notice, PageHeader, PageLoading, Section, Tabs, Toggle, useAction } from "@/components/ui";
import { api } from "@/lib/api";
import { timeAgo } from "@/lib/format";

type Tab = "panel" | "account" | "notifications" | "keys";

export function SettingsPage() {
  const [params, setParams] = useSearchParams();
  const tab = (params.get("tab") as Tab) || "panel";
  return (
    <>
      <PageHeader title="Ayarlar" />
      <Tabs
        value={tab}
        onChange={(t) => setParams({ tab: t }, { replace: true })}
        tabs={[
          { id: "panel", label: "Panel" },
          { id: "account", label: "Hesap" },
          { id: "notifications", label: "Bildirimler" },
          { id: "keys", label: "SSH anahtarları" },
        ]}
      />
      {tab === "panel" && <PanelSettings />}
      {tab === "account" && <Account />}
      {tab === "notifications" && <Notifications />}
      {tab === "keys" && <SshKeys />}
    </>
  );
}

function PanelSettings() {
  const { data } = useQuery({ queryKey: ["settings"], queryFn: () => api.get<{ panelDomain: string; panelHttps: boolean; localServerIp: string | null; version: string }>("/settings") });
  const [form, setForm] = useState<{ panelDomain: string; panelHttps: boolean } | null>(null);
  const f = form ?? (data ? { panelDomain: data.panelDomain, panelHttps: data.panelHttps } : null);
  const save = useAction(() => api.put("/settings/panel", f), { success: "Panel adresi güncellendi", invalidate: [["settings"]] });
  if (!data || !f) return <PageLoading />;
  return (
    <>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
        className="panel space-y-4 p-5"
      >
        <Field
          label="Panelin alan adı"
          hint={data.localServerIp ? `DNS'te bu alan adını ${data.localServerIp} adresine yönlendir. Boş bırakırsan kurulumdaki sslip.io adresi kullanılmaya devam eder.` : "Panelin açılacağı adres."}
        >
          <input className="input" value={f.panelDomain} onChange={(e) => setForm({ ...f, panelDomain: e.target.value.trim().toLowerCase() })} placeholder="panel.ornek.com" />
        </Field>
        <Toggle checked={f.panelHttps} onChange={(v) => setForm({ ...f, panelHttps: v })} label="HTTPS" description="Ücretsiz Let's Encrypt sertifikası otomatik alınır." />
        <div className="flex justify-end">
          <Button type="submit" variant="primary" loading={save.isPending}>Kaydet</Button>
        </div>
      </form>
      <p className="mt-6 text-[13px] text-faint">Xudbin {data.version}</p>
    </>
  );
}

type AccountData = {
  user: { id: number; name: string; email: string };
  totpEnabled: boolean;
  sessions: { id: string; ip: string | null; userAgent: string | null; createdAt: number; current: boolean }[];
};

function Account() {
  const { data } = useQuery({ queryKey: ["account"], queryFn: () => api.get<AccountData>("/settings/account") });
  if (!data) return <PageLoading />;
  return (
    <div className="space-y-9">
      <Profile user={data.user} />
      <Password />
      <TwoFactor enabled={data.totpEnabled} />
      <Sessions sessions={data.sessions} />
    </div>
  );
}

function Profile({ user }: { user: AccountData["user"] }) {
  const [form, setForm] = useState({ name: user.name, email: user.email });
  const save = useAction(() => api.put("/settings/account/profile", form), { success: "Profil güncellendi", invalidate: [["account"], ["auth"]] });
  return (
    <Section title="Profil" className="!mt-0">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
        className="panel grid gap-4 p-5 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
      >
        <Field label="Ad">
          <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <Field label="E-posta">
          <input className="input" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </Field>
        <Button type="submit" loading={save.isPending}>Kaydet</Button>
      </form>
    </Section>
  );
}

function Password() {
  const [form, setForm] = useState({ current: "", next: "" });
  const save = useAction(() => api.put("/settings/account/password", form), {
    success: "Şifre değişti. Diğer cihazlardaki oturumlar kapatıldı.",
    invalidate: [["account"]],
    onSuccess: () => setForm({ current: "", next: "" }),
  });
  return (
    <Section title="Şifre">
      <form
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          save.mutate();
        }}
        className="panel grid gap-4 p-5 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
      >
        <Field label="Mevcut şifre">
          <input className="input" type="password" autoComplete="current-password" required value={form.current} onChange={(e) => setForm({ ...form, current: e.target.value })} />
        </Field>
        <Field label="Yeni şifre">
          <input className="input" type="password" autoComplete="new-password" required minLength={10} value={form.next} onChange={(e) => setForm({ ...form, next: e.target.value })} />
        </Field>
        <Button type="submit" loading={save.isPending}>Değiştir</Button>
      </form>
    </Section>
  );
}

function TwoFactor({ enabled }: { enabled: boolean }) {
  const [setup, setSetup] = useState<{ secret: string; qr: string } | null>(null);
  const [code, setCode] = useState("");
  const [disabling, setDisabling] = useState(false);
  const start = useAction(() => api.post<{ secret: string; qr: string }>("/settings/account/totp/setup"), { onSuccess: setSetup });
  const enable = useAction(() => api.post("/settings/account/totp/enable", { code }), {
    success: "İki adımlı doğrulama açıldı",
    invalidate: [["account"]],
    onSuccess: () => {
      setSetup(null);
      setCode("");
    },
  });
  const disable = useAction(() => api.post("/settings/account/totp/disable", { code }), {
    success: "İki adımlı doğrulama kapatıldı",
    invalidate: [["account"]],
    onSuccess: () => {
      setDisabling(false);
      setCode("");
    },
  });
  const codeInput = (
    <input className="input w-36 font-mono tracking-[0.3em]" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} placeholder="000000" />
  );
  return (
    <Section title="İki adımlı doğrulama" description="Girişte şifreye ek olarak telefonundaki uygulamanın ürettiği kod istenir.">
      <div className="panel p-5">
        {enabled ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="inline-flex items-center gap-2 text-[14px]">
              <span className="size-2 rounded-full bg-ok" /> Açık
            </span>
            <Button variant="danger" onClick={() => setDisabling(true)}>Kapat</Button>
          </div>
        ) : setup ? (
          <div className="grid gap-5 sm:grid-cols-[auto_1fr]">
            <img src={setup.qr} alt="Kimlik doğrulama uygulamasıyla okut" className="size-44 rounded-md bg-white p-1" />
            <div className="space-y-3">
              <p className="text-[14px] text-muted">Google Authenticator, 1Password, Bitwarden gibi bir uygulamayla kodu okut, ardından uygulamanın gösterdiği 6 haneli kodu gir.</p>
              <CopyField value={setup.secret} />
              <div className="flex items-center gap-2">
                {codeInput}
                <Button variant="primary" onClick={() => enable.mutate()} loading={enable.isPending} disabled={code.length !== 6}>Doğrula ve aç</Button>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="text-[14px] text-muted">Kapalı</span>
            <Button variant="primary" onClick={() => start.mutate()} loading={start.isPending}>Aç</Button>
          </div>
        )}
      </div>
      <Dialog open={disabling} onClose={() => setDisabling(false)} title="İki adımlı doğrulama kapatılsın mı?" description="Onaylamak için uygulamadaki güncel kodu gir.">
        <div className="flex items-center gap-2">
          {codeInput}
          <Button variant="primary" onClick={() => disable.mutate()} loading={disable.isPending} disabled={code.length !== 6}>Kapat</Button>
        </div>
      </Dialog>
    </Section>
  );
}

function Sessions({ sessions }: { sessions: AccountData["sessions"] }) {
  const end = useAction((id: string) => api.del(`/settings/account/sessions/${id}`), { success: "Oturum kapatıldı", invalidate: [["account"]] });
  return (
    <Section title="Açık oturumlar">
      <div className="panel divide-y divide-line">
        {sessions.map((s) => (
          <div key={s.id} className="flex items-center gap-3 px-5 py-3">
            <div className="min-w-0 flex-1">
              <div className="truncate text-[14px]">{describeAgent(s.userAgent)}</div>
              <div className="text-[13px] text-faint">{s.ip ?? "IP bilinmiyor"}, {timeAgo(s.createdAt)} açıldı</div>
            </div>
            {s.current ? <span className="text-[13px] text-ok">Bu cihaz</span> : <Button size="sm" variant="ghost" onClick={() => end.mutate(s.id)}>Kapat</Button>}
          </div>
        ))}
      </div>
    </Section>
  );
}

function describeAgent(ua: string | null) {
  if (!ua) return "Bilinmeyen cihaz";
  const browser = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : /curl/i.test(ua) ? "curl" : "Tarayıcı";
  const os = /iPhone|iPad/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser}, ${os}` : browser;
}

// ---------------------------------------------------------------------------

type Channel = { id: number; name: string; kind: "discord" | "telegram" | "slack" | "webhook"; events: string[]; enabled: boolean };
const KINDS = { discord: "Discord", telegram: "Telegram", slack: "Slack", webhook: "Webhook" };

function Notifications() {
  const { data } = useQuery({ queryKey: ["notifications"], queryFn: () => api.get<{ notifications: Channel[]; events: Record<string, string> }>("/settings/notifications") });
  const [adding, setAdding] = useState(false);
  const toggle = useAction((c: Channel) => api.patch(`/settings/notifications/${c.id}`, { enabled: !c.enabled }), { invalidate: [["notifications"]] });
  const del = useAction((id: number) => api.del(`/settings/notifications/${id}`), { success: "Kanal silindi", invalidate: [["notifications"]] });
  if (!data) return <PageLoading />;
  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-xl text-[14px] text-muted">Deploy sonuçları, banlanan IP'ler, başarısız yedekler ve erişilemeyen sunucular için bildirim al.</p>
        <Button variant="primary" onClick={() => setAdding(true)}>Kanal ekle</Button>
      </div>
      {data.notifications.length === 0 ? (
        <div className="panel px-5 py-6 text-[14px] text-muted">Bildirim kanalı yok.</div>
      ) : (
        <div className="panel divide-y divide-line">
          {data.notifications.map((c) => (
            <div key={c.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3">
              <div className="min-w-0 flex-1">
                <div className="font-medium">{c.name}</div>
                <div className="text-[13px] text-faint">{KINDS[c.kind]}, {c.events.map((e) => data.events[e]).join(", ")}</div>
              </div>
              <Toggle checked={c.enabled} onChange={() => toggle.mutate(c)} label={c.enabled ? "Açık" : "Kapalı"} />
              <Button size="sm" variant="ghost" onClick={() => del.mutate(c.id)}>Sil</Button>
            </div>
          ))}
        </div>
      )}
      <AddChannel open={adding} onClose={() => setAdding(false)} events={data.events} />
    </>
  );
}

function AddChannel({ open, onClose, events }: { open: boolean; onClose: () => void; events: Record<string, string> }) {
  const [form, setForm] = useState({ name: "", kind: "discord" as Channel["kind"], url: "", botToken: "", chatId: "", events: Object.keys(events) });
  const config = form.kind === "telegram" ? { botToken: form.botToken, chatId: form.chatId } : { url: form.url };
  const test = useAction(() => api.post("/settings/notifications/test", { kind: form.kind, config }), { success: "Test bildirimi gönderildi" });
  const create = useAction(() => api.post("/settings/notifications", { name: form.name || KINDS[form.kind], kind: form.kind, config, events: form.events }), {
    success: "Kanal eklendi",
    invalidate: [["notifications"]],
    onSuccess: onClose,
  });
  return (
    <Dialog open={open} onClose={onClose} title="Bildirim kanalı ekle">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
        className="space-y-4"
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Tür">
            <select className="input" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as Channel["kind"] })}>
              {Object.entries(KINDS).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </select>
          </Field>
          <Field label="Ad">
            <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={KINDS[form.kind]} />
          </Field>
        </div>
        {form.kind === "telegram" ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Bot token" hint="@BotFather'dan alınır.">
              <input className="input font-mono text-[13px]" required value={form.botToken} onChange={(e) => setForm({ ...form, botToken: e.target.value.trim() })} />
            </Field>
            <Field label="Chat ID">
              <input className="input font-mono text-[13px]" required value={form.chatId} onChange={(e) => setForm({ ...form, chatId: e.target.value.trim() })} />
            </Field>
          </div>
        ) : (
          <Field label="Webhook adresi" hint={form.kind === "discord" ? "Kanal ayarları > Entegrasyonlar > Webhook'lar" : form.kind === "slack" ? "Slack Incoming Webhook adresi" : "JSON POST isteği gönderilir."}>
            <input className="input font-mono text-[13px]" required value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value.trim() })} placeholder="https://" />
          </Field>
        )}
        <fieldset>
          <legend className="mb-2 text-[14px] font-medium">Hangi olaylarda</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {Object.entries(events).map(([k, v]) => (
              <label key={k} className="flex items-center gap-2 text-[14px]">
                <input
                  type="checkbox"
                  className="size-4 accent-[var(--accent)]"
                  checked={form.events.includes(k)}
                  onChange={(e) => setForm({ ...form, events: e.target.checked ? [...form.events, k] : form.events.filter((x) => x !== k) })}
                />
                {v}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="flex flex-wrap justify-between gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={() => test.mutate()} loading={test.isPending}>Test gönder</Button>
          <div className="flex gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>Vazgeç</Button>
            <Button type="submit" variant="primary" loading={create.isPending}>Ekle</Button>
          </div>
        </div>
      </form>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------

type Key = { id: number; name: string; publicKey: string; createdAt: number; servers: number };

function SshKeys() {
  const { data } = useQuery({ queryKey: ["ssh-keys"], queryFn: () => api.get<{ keys: Key[] }>("/ssh-keys") });
  const [del, setDel] = useState<Key | null>(null);
  const remove = useAction((id: number) => api.del(`/ssh-keys/${id}`), { success: "Anahtar silindi", invalidate: [["ssh-keys"]], onSuccess: () => setDel(null) });
  if (!data) return <PageLoading />;
  return (
    <>
      <p className="mb-4 max-w-2xl text-[14px] text-muted">Panel sunuculara bu anahtarlarla bağlanır. Her yeni sunucu için otomatik bir anahtar üretilir; gizli anahtarlar şifrelenerek saklanır ve hiçbir yerde gösterilmez.</p>
      {data.keys.length === 0 ? (
        <Notice tone="info" title="Henüz anahtar yok">Sunucu eklediğinde burada görünür.</Notice>
      ) : (
        <div className="space-y-3">
          {data.keys.map((k) => (
            <div key={k.id} className="panel space-y-3 p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="font-medium">{k.name}</div>
                  <div className="text-[13px] text-faint">{k.servers} sunucuda kullanılıyor, {timeAgo(k.createdAt)} oluşturuldu</div>
                </div>
                {k.servers === 0 && <Button size="sm" variant="ghost" onClick={() => setDel(k)}>Sil</Button>}
              </div>
              <CopyField value={k.publicKey} />
            </div>
          ))}
        </div>
      )}
      <ConfirmDialog open={Boolean(del)} onClose={() => setDel(null)} title="Anahtar silinsin mi?" description="Hiçbir sunucu bu anahtarı kullanmıyor." confirmLabel="Sil" loading={remove.isPending} onConfirm={() => del && remove.mutate(del.id)} />
    </>
  );
}
