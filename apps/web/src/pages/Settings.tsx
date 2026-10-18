import { useQuery } from "@tanstack/react-query";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Navigate, useSearchParams } from "react-router";
import { ApiTokens } from "@/components/ApiTokens";
import { AuditLog } from "@/components/AuditLog";
import { BackupSettings } from "@/components/BackupSettings";
import { SsoSettings } from "@/components/SsoSettings";
import { Button, ConfirmDialog, CopyField, Dialog, Field, Notice, PageHeader, PageLoading, Section, Tabs, Toggle, useAction } from "@/components/ui";
import { api } from "@/lib/api";
import { useAuthStatus } from "@/lib/auth";
import { timeAgo } from "@/lib/format";
import { t } from "@/lib/i18n";

type Tab = "panel" | "account" | "users" | "notifications" | "backup" | "audit";

export function SettingsPage() {
  const [params, setParams] = useSearchParams();
  const auth = useAuthStatus();
  const admin = auth.data?.user?.role === "admin";
  const tab = (params.get("tab") as Tab) || (admin ? "panel" : "account");
  // Eski bağlantılar (ve GitHub'ın App kurulumundan dönüşü) yeni sayfalara yönlenir.
  if ((params.get("tab") as string) === "github") return <Navigate to={`/git?${params.toString()}`} replace />;
  if ((params.get("tab") as string) === "keys") return <Navigate to="/ssh-keys" replace />;
  return (
    <>
      <PageHeader title={t("Ayarlar")} />
      <Tabs
        value={tab}
        onChange={(t) => setParams({ tab: t }, { replace: true })}
        tabs={
          admin
            ? [
                { id: "panel", label: t("Panel") },
                { id: "account", label: t("Hesap") },
                { id: "users", label: t("Kullanıcılar") },
                { id: "notifications", label: t("Bildirimler") },
                { id: "backup", label: t("Yedekleme") },
                { id: "audit", label: t("İşlem kaydı") },
              ]
            : [{ id: "account", label: t("Hesap") }]
        }
      />
      {tab === "panel" && admin && <PanelSettings />}
      {tab === "users" && admin && <Users />}
      {tab === "account" && <Account />}
      {tab === "notifications" && admin && <Notifications />}
      {tab === "backup" && admin && <BackupSettings />}

      {tab === "audit" && admin && <AuditLog />}
    </>
  );
}

function PanelSettings() {
  const { data } = useQuery({
    queryKey: ["settings"],
    queryFn: () => api.get<{ panelDomain: string; panelHttps: boolean; panelWaf: "off" | "detect" | "block"; panelIpAccess: boolean; panelIpPort: number; panelIpAvailable: boolean; localServerIp: string | null; version: string; timezone: string; uptimeEnabled: boolean }>("/settings"),
  });
  const [form, setForm] = useState<{ panelDomain: string; panelHttps: boolean; panelWaf: "off" | "detect" | "block"; panelIpAccess: boolean; timezone: string; uptimeEnabled: boolean } | null>(null);
  const f = form ?? (data ? { panelDomain: data.panelDomain, panelHttps: data.panelHttps, panelWaf: data.panelWaf, panelIpAccess: data.panelIpAccess, timezone: data.timezone, uptimeEnabled: data.uptimeEnabled } : null);
  const save = useAction(() => api.put("/settings/panel", f), { success: t("Ayarlar kaydedildi"), invalidate: [["settings"]] });
  const zones = useMemo(() => {
    try {
      return Intl.supportedValuesOf("timeZone");
    } catch {
      return ["Europe/Istanbul", "UTC"];
    }
  }, []);
  if (!data || !f) return <PageLoading />;
  return (
    <div className="space-y-9">
      <UpdateCard version={data.version} />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
        className="panel space-y-4 p-5"
      >
        <Field
          label={t("Panelin alan adı")}
          hint={data.localServerIp ? t("DNS'te bu alan adını {ip} adresine yönlendir. Boş bırakırsan kurulumdaki sslip.io adresi kullanılmaya devam eder.", { ip: data.localServerIp }) : t("Panelin açılacağı adres.")}
        >
          <input className="input" value={f.panelDomain} onChange={(e) => setForm({ ...f, panelDomain: e.target.value.trim().toLowerCase() })} placeholder="panel.ornek.com" />
        </Field>
        <Toggle checked={f.panelHttps} onChange={(v) => setForm({ ...f, panelHttps: v })} label={t("HTTPS")} description={t("Ücretsiz Let's Encrypt sertifikası otomatik alınır.")} />
        {data.panelIpAvailable && data.localServerIp && (
          <Toggle
            checked={f.panelIpAccess}
            onChange={(v) => setForm({ ...f, panelIpAccess: v })}
            label={t("IP ile giriş")}
            description={t("Panel https://{ip}:{port} adresinden de açılır. Bu adresin sertifikası kendinden imzalı olduğu için tarayıcı ilk girişte uyarı verir. Alan adındaki korumalar (WAF, hız sınırı, IP engeli) burada da geçerli.", { ip: data.localServerIp, port: String(data.panelIpPort) })}
          />
        )}
        <Field label={t("Panel WAF")} hint={t("Panelin adresini OWASP kurallarıyla (Coraza, paranoya 1) denetler. \"Yalnız tespit\" istekleri kesmez; panelin sorunsuz çalıştığını gördükten sonra \"Engelle\"ye geç.")}>
          <select className="input" value={f.panelWaf} onChange={(e) => setForm({ ...f, panelWaf: e.target.value as "off" | "detect" | "block" })}>
            <option value="off">{t("Kapalı")}</option>
            <option value="detect">{t("Yalnız tespit")}</option>
            <option value="block">{t("Engelle")}</option>
          </select>
        </Field>
        <Field label={t("Saat dilimi")} hint={t("Analitikteki gün sınırları ve zamanlanmış görevler bu saat dilimine göre.")}>
          <select className="input" value={f.timezone} onChange={(e) => setForm({ ...f, timezone: e.target.value })}>
            {zones.map((z) => (
              <option key={z} value={z}>{z}</option>
            ))}
          </select>
        </Field>
        <Toggle checked={f.uptimeEnabled} onChange={(v) => setForm({ ...f, uptimeEnabled: v })} label={t("Erişilebilirlik izleme")} description={t("Tüm siteler dakikada bir denenir; çökme ve düzelme bildirimleri gönderilir.")} />
        <div className="flex justify-end">
          <Button type="submit" variant="primary" loading={save.isPending}>{t("Kaydet")}</Button>
        </div>
      </form>
      <SsoSettings />
    </div>
  );
}

/** Sürüm ve panelden güncelleme: güncelleme sunucuda ayrı bir iş olarak çalışır, panel yeni sürümle geri gelince sayfa yenilenir. */
function UpdateCard({ version }: { version: string }) {
  const waitingRef = useRef(false);
  const { data } = useQuery({ queryKey: ["update"], queryFn: () => api.get<{ current: string; latest: string | null; updateAvailable: boolean; url: string; canSelfUpdate: boolean; lastUpdate: { state: string; tag: string } | null }>("/settings/update"), refetchInterval: (q) => (q.state.data && waitingRef.current ? 5000 : false) });
  const failed = data?.lastUpdate && data.lastUpdate.state !== "ok" && data.lastUpdate.tag === `v${data.latest}` ? data.lastUpdate : null;
  const [waiting, setWaiting] = useState(false);
  waitingRef.current = waiting;
  // Güncelleme imza doğrulamasında ya da indirmede durduysa beklemeyi bırak.
  useEffect(() => {
    if (waiting && failed) setWaiting(false);
  }, [waiting, failed]);
  const apply = useAction(() => api.post("/settings/update/apply"), {
    success: t("Güncelleme başladı; panel birkaç dakika içinde yeniden başlayacak."),
    onSuccess: () => setWaiting(true),
  });
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(async () => {
      try {
        const s = await api.get<{ version: string }>("/settings");
        if (s.version !== version) location.reload();
      } catch {}
    }, 5000);
    return () => clearInterval(timer);
  }, [waiting, version]);
  return (
    <section className="panel flex flex-wrap items-center justify-between gap-4 px-5 py-4">
      <div>
        <div className="font-medium">Xudbin {version}</div>
        <div className="text-[13px] text-muted">
          {waiting
            ? t("Güncelleniyor... Sayfa yeni sürüm hazır olunca kendiliğinden yenilenecek.")
            : data?.updateAvailable
              ? t("Yeni sürüm yayında: {v}", { v: data.latest ?? "" })
              : data?.latest
                ? t("Güncel.")
                : t("Yeni sürüm bilgisi alınamadı.")}{" "}
          {data?.url && (
            <a href={data.url} target="_blank" rel="noreferrer" className="underline">{t("Sürüm notları")}</a>
          )}
        </div>
        {failed && (
          <div className="mt-1 text-[13px] text-accent">
            {failed.state === "verify-failed"
              ? t("{v} kurulmadı: imajın imzası doğrulanamadı. Mevcut sürüm çalışmaya devam ediyor.", { v: failed.tag })
              : t("{v} kurulmadı: imaj indirilemedi. Mevcut sürüm çalışmaya devam ediyor.", { v: failed.tag })}
          </div>
        )}
      </div>
      {data?.updateAvailable && !waiting && (
        data.canSelfUpdate ? (
          <Button variant="primary" onClick={() => apply.mutate()} loading={apply.isPending}>{t("Güncelle")}</Button>
        ) : (
          <code className="font-mono text-[13px] text-muted">sudo xudbin update</code>
        )
      )}
    </section>
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
      <ApiTokens />
    </div>
  );
}

function Profile({ user }: { user: AccountData["user"] }) {
  const [form, setForm] = useState({ name: user.name, email: user.email, password: "" });
  const emailChanged = form.email.trim() !== user.email;
  const save = useAction(() => api.put("/settings/account/profile", { name: form.name, email: form.email, ...(emailChanged ? { password: form.password } : {}) }), {
    success: t("Profil güncellendi"),
    invalidate: [["account"], ["auth"]],
    onSuccess: () => setForm((f) => ({ ...f, password: "" })),
  });
  return (
    <Section title={t("Profil")} className="!mt-0">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
        className="panel grid gap-4 p-5 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
      >
        <Field label={t("Ad")}>
          <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <Field label={t("E-posta")}>
          <input className="input" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </Field>
        <Button type="submit" loading={save.isPending}>{t("Kaydet")}</Button>
        {emailChanged && (
          <Field label={t("Mevcut şifre")} hint={t("E-postanı değiştirmek için şifreni gir.")}>
            <input className="input" type="password" autoComplete="current-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
          </Field>
        )}
      </form>
    </Section>
  );
}

function Password() {
  const [form, setForm] = useState({ current: "", next: "" });
  const save = useAction(() => api.put("/settings/account/password", form), {
    success: t("Şifre değişti. Diğer cihazlardaki oturumlar kapatıldı."),
    invalidate: [["account"]],
    onSuccess: () => setForm({ current: "", next: "" }),
  });
  return (
    <Section title={t("Şifre")}>
      <form
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          save.mutate();
        }}
        className="panel grid gap-4 p-5 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
      >
        <Field label={t("Mevcut şifre")}>
          <input className="input" type="password" autoComplete="current-password" required value={form.current} onChange={(e) => setForm({ ...form, current: e.target.value })} />
        </Field>
        <Field label={t("Yeni şifre")}>
          <input className="input" type="password" autoComplete="new-password" required minLength={10} value={form.next} onChange={(e) => setForm({ ...form, next: e.target.value })} />
        </Field>
        <Button type="submit" loading={save.isPending}>{t("Değiştir")}</Button>
      </form>
    </Section>
  );
}

function TwoFactor({ enabled }: { enabled: boolean }) {
  const [setup, setSetup] = useState<{ secret: string; qr: string } | null>(null);
  const [code, setCode] = useState("");
  const [disabling, setDisabling] = useState(false);
  const [password, setPassword] = useState("");
  const start = useAction(() => api.post<{ secret: string; qr: string }>("/settings/account/totp/setup"), { onSuccess: setSetup });
  const enable = useAction(() => api.post("/settings/account/totp/enable", { code }), {
    success: t("İki adımlı doğrulama açıldı"),
    invalidate: [["account"]],
    onSuccess: () => {
      setSetup(null);
      setCode("");
    },
  });
  const disable = useAction(() => api.post("/settings/account/totp/disable", { code, password }), {
    success: t("İki adımlı doğrulama kapatıldı"),
    invalidate: [["account"]],
    onSuccess: () => {
      setDisabling(false);
      setCode("");
      setPassword("");
    },
  });
  const codeInput = (
    <input className="input w-36 font-mono tracking-[0.3em]" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} placeholder="000000" />
  );
  return (
    <Section title={t("İki adımlı doğrulama")} description={t("Girişte şifreye ek olarak telefonundaki uygulamanın ürettiği kod istenir.")}>
      <div className="panel p-5">
        {enabled ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="inline-flex items-center gap-2 text-[14px]">
              <span className="size-2 rounded-full bg-ok" /> {t("Açık")}
            </span>
            <Button variant="danger" onClick={() => setDisabling(true)}>{t("Kapat")}</Button>
          </div>
        ) : setup ? (
          <div className="grid gap-5 sm:grid-cols-[auto_1fr]">
            <img src={setup.qr} alt={t("Kimlik doğrulama uygulamasıyla okut")} className="size-44 rounded-md bg-white p-1" />
            <div className="space-y-3">
              <p className="text-[14px] text-muted">{t("Google Authenticator, 1Password, Bitwarden gibi bir uygulamayla kodu okut, ardından uygulamanın gösterdiği 6 haneli kodu gir.")}</p>
              <CopyField value={setup.secret} />
              <div className="flex items-center gap-2">
                {codeInput}
                <Button variant="primary" onClick={() => enable.mutate()} loading={enable.isPending} disabled={code.length !== 6}>{t("Doğrula ve aç")}</Button>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="text-[14px] text-muted">{t("Kapalı")}</span>
            <Button variant="primary" onClick={() => start.mutate()} loading={start.isPending}>{t("Aç")}</Button>
          </div>
        )}
      </div>
      <Dialog open={disabling} onClose={() => setDisabling(false)} title={t("İki adımlı doğrulama kapatılsın mı?")} description={t("Onaylamak için şifreni ve uygulamadaki güncel kodu gir.")}>
        <div className="flex flex-wrap items-center gap-2">
          <input className="input w-56" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={t("Şifren")} />
          {codeInput}
          <Button variant="primary" onClick={() => disable.mutate()} loading={disable.isPending} disabled={code.length !== 6 || !password}>{t("Kapat")}</Button>
        </div>
      </Dialog>
    </Section>
  );
}

function Sessions({ sessions }: { sessions: AccountData["sessions"] }) {
  const end = useAction((id: string) => api.del(`/settings/account/sessions/${id}`), { success: t("Oturum kapatıldı"), invalidate: [["account"]] });
  return (
    <Section title={t("Açık oturumlar")}>
      <div className="panel divide-y divide-line">
        {sessions.map((s) => (
          <div key={s.id} className="flex items-center gap-3 px-5 py-3">
            <div className="min-w-0 flex-1">
              <div className="truncate text-[14px]">{describeAgent(s.userAgent)}</div>
              <div className="text-[13px] text-faint">{s.ip ?? t("IP bilinmiyor")}, {t("{ago} açıldı", { ago: timeAgo(s.createdAt) })}</div>
            </div>
            {s.current ? <span className="text-[13px] text-ok">{t("Bu cihaz")}</span> : <Button size="sm" variant="ghost" onClick={() => end.mutate(s.id)}>{t("Kapat")}</Button>}
          </div>
        ))}
      </div>
    </Section>
  );
}

function describeAgent(ua: string | null) {
  if (!ua) return "Bilinmeyen cihaz";
  const browser = /Edg\//.test(ua) ? t("Edge") : /Chrome\//.test(ua) ? t("Chrome") : /Firefox\//.test(ua) ? t("Firefox") : /Safari\//.test(ua) ? t("Safari") : /curl/i.test(ua) ? "curl" : "Tarayıcı";
  const os = /iPhone|iPad/.test(ua) ? "iOS" : /Android/.test(ua) ? t("Android") : /Mac OS X/.test(ua) ? "macOS" : /Windows/.test(ua) ? t("Windows") : /Linux/.test(ua) ? t("Linux") : "";
  return os ? `${browser}, ${os}` : browser;
}

// ---------------------------------------------------------------------------

type Channel = { id: number; name: string; kind: "discord" | "telegram" | "slack" | "webhook" | "email"; events: string[]; enabled: boolean };
const KINDS = { email: t("E-posta"), discord: t("Discord"), telegram: t("Telegram"), slack: t("Slack"), webhook: t("Webhook") };

function Notifications() {
  const { data } = useQuery({ queryKey: ["notifications"], queryFn: () => api.get<{ notifications: Channel[]; events: Record<string, string> }>("/settings/notifications") });
  const [adding, setAdding] = useState(false);
  const toggle = useAction((c: Channel) => api.patch(`/settings/notifications/${c.id}`, { enabled: !c.enabled }), { invalidate: [["notifications"]] });
  const del = useAction((id: number) => api.del(`/settings/notifications/${id}`), { success: t("Kanal silindi"), invalidate: [["notifications"]] });
  if (!data) return <PageLoading />;
  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-xl text-[14px] text-muted">{t("Deploy sonuçları, banlanan IP'ler, başarısız yedekler ve erişilemeyen sunucular için bildirim al.")}</p>
        <Button variant="primary" onClick={() => setAdding(true)}>{t("Kanal ekle")}</Button>
      </div>
      {data.notifications.length === 0 ? (
        <div className="panel px-5 py-6 text-[14px] text-muted">{t("Bildirim kanalı yok.")}</div>
      ) : (
        <div className="panel divide-y divide-line">
          {data.notifications.map((c) => (
            <div key={c.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3">
              <div className="min-w-0 flex-1">
                <div className="font-medium">{c.name}</div>
                <div className="text-[13px] text-faint">{KINDS[c.kind]}, {c.events.map((e) => t(data.events[e] ?? e)).join(", ")}</div>
              </div>
              <Toggle checked={c.enabled} onChange={() => toggle.mutate(c)} label={c.enabled ? t("Açık") : t("Kapalı")} />
              <Button size="sm" variant="ghost" onClick={() => del.mutate(c.id)}>{t("Sil")}</Button>
            </div>
          ))}
        </div>
      )}
      <AddChannel open={adding} onClose={() => setAdding(false)} events={data.events} />
    </>
  );
}

function AddChannel({ open, onClose, events }: { open: boolean; onClose: () => void; events: Record<string, string> }) {
  const [form, setForm] = useState({
    name: "",
    kind: "email" as Channel["kind"],
    url: "",
    botToken: "",
    chatId: "",
    smtpHost: "",
    smtpPort: "587",
    smtpUser: "",
    smtpPass: "",
    from: "",
    to: "",
    events: Object.keys(events),
  });
  const config =
    form.kind === "telegram"
      ? { botToken: form.botToken, chatId: form.chatId }
      : form.kind === "email"
        ? { host: form.smtpHost, port: form.smtpPort, user: form.smtpUser, pass: form.smtpPass, from: form.from, to: form.to }
        : { url: form.url };
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value.trim() });
  const test = useAction(() => api.post("/settings/notifications/test", { kind: form.kind, config }), { success: t("Test bildirimi gönderildi") });
  const create = useAction(() => api.post("/settings/notifications", { name: form.name || KINDS[form.kind], kind: form.kind, config, events: form.events }), {
    success: t("Kanal eklendi"),
    invalidate: [["notifications"]],
    onSuccess: onClose,
  });
  return (
    <Dialog open={open} onClose={onClose} title={t("Bildirim kanalı ekle")}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
        className="space-y-4"
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t("Tür")}>
            <select className="input" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as Channel["kind"] })}>
              {Object.entries(KINDS).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </select>
          </Field>
          <Field label={t("Ad")}>
            <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={KINDS[form.kind]} />
          </Field>
        </div>
        {form.kind === "email" ? (
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-[1fr_6rem]">
              <Field label={t("SMTP sunucusu")} hint={t("Ör. smtp.gmail.com, smtp.office365.com, smtp.yandex.com")}>
                <input className="input font-mono text-[13px]" required value={form.smtpHost} onChange={set("smtpHost")} />
              </Field>
              <Field label={t("Port")} hint={t("587 veya 465")}>
                <input className="input" inputMode="numeric" value={form.smtpPort} onChange={set("smtpPort")} />
              </Field>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t("Kullanıcı adı")}>
                <input className="input" autoComplete="off" value={form.smtpUser} onChange={set("smtpUser")} />
              </Field>
              <Field label={t("Şifre")} hint={t("Gmail'de uygulama şifresi kullan.")}>
                <input className="input" type="password" autoComplete="new-password" value={form.smtpPass} onChange={(e) => setForm({ ...form, smtpPass: e.target.value })} />
              </Field>
              <Field label={t("Gönderen")}>
                <input className="input" required placeholder="Xudbin <panel@ornek.com>" value={form.from} onChange={(e) => setForm({ ...form, from: e.target.value })} />
              </Field>
              <Field label={t("Alıcılar")} hint={t("Virgülle ayır.")}>
                <input className="input" required placeholder="sen@ornek.com" value={form.to} onChange={set("to")} />
              </Field>
            </div>
          </div>
        ) : form.kind === "telegram" ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t("Bot token")} hint={t("@BotFather'dan alınır.")}>
              <input className="input font-mono text-[13px]" required value={form.botToken} onChange={(e) => setForm({ ...form, botToken: e.target.value.trim() })} />
            </Field>
            <Field label={t("Chat ID")}>
              <input className="input font-mono text-[13px]" required value={form.chatId} onChange={(e) => setForm({ ...form, chatId: e.target.value.trim() })} />
            </Field>
          </div>
        ) : (
          <Field label={t("Webhook adresi")} hint={form.kind === "discord" ? t("Kanal ayarları > Entegrasyonlar > Webhook'lar") : form.kind === "slack" ? t("Slack Incoming Webhook adresi") : t("JSON POST isteği gönderilir.")}>
            <input className="input font-mono text-[13px]" required value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value.trim() })} placeholder="https://" />
          </Field>
        )}
        <fieldset>
          <legend className="mb-2 text-[14px] font-medium">{t("Hangi olaylarda")}</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {Object.entries(events).map(([k, v]) => (
              <label key={k} className="flex items-center gap-2 text-[14px]">
                <input
                  type="checkbox"
                  className="size-4 accent-[var(--accent)]"
                  checked={form.events.includes(k)}
                  onChange={(e) => setForm({ ...form, events: e.target.checked ? [...form.events, k] : form.events.filter((x) => x !== k) })}
                />
                {t(v)}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="flex flex-wrap justify-between gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={() => test.mutate()} loading={test.isPending}>{t("Test gönder")}</Button>
          <div className="flex gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>{t("Vazgeç")}</Button>
            <Button type="submit" variant="primary" loading={create.isPending}>{t("Ekle")}</Button>
          </div>
        </div>
      </form>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------

type Key = { id: number; name: string; publicKey: string; createdAt: number; servers: number };

export function SshKeys() {
  const { data } = useQuery({ queryKey: ["ssh-keys"], queryFn: () => api.get<{ keys: Key[] }>("/ssh-keys") });
  const [del, setDel] = useState<Key | null>(null);
  const remove = useAction((id: number) => api.del(`/ssh-keys/${id}`), { success: t("Anahtar silindi"), invalidate: [["ssh-keys"]], onSuccess: () => setDel(null) });
  if (!data) return <PageLoading />;
  return (
    <>
      <p className="mb-4 max-w-2xl text-[14px] text-muted">{t("Panel sunuculara bu anahtarlarla bağlanır. Her yeni sunucu için otomatik bir anahtar üretilir; gizli anahtarlar şifrelenerek saklanır ve hiçbir yerde gösterilmez.")}</p>
      {data.keys.length === 0 ? (
        <Notice tone="info" title={t("Henüz anahtar yok")}>{t("Sunucu eklediğinde burada görünür.")}</Notice>
      ) : (
        <div className="space-y-3">
          {data.keys.map((k) => (
            <div key={k.id} className="panel space-y-3 p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="font-medium">{k.name}</div>
                  <div className="text-[13px] text-faint">{t("{n} sunucuda kullanılıyor, {ago} oluşturuldu", { n: k.servers, ago: timeAgo(k.createdAt) })}</div>
                </div>
                {k.servers === 0 && <Button size="sm" variant="ghost" onClick={() => setDel(k)}>{t("Sil")}</Button>}
              </div>
              <CopyField value={k.publicKey} />
            </div>
          ))}
        </div>
      )}
      <ConfirmDialog open={Boolean(del)} onClose={() => setDel(null)} title={t("Anahtar silinsin mi?")} description={t("Hiçbir sunucu bu anahtarı kullanmıyor.")} confirmLabel={t("Sil")} loading={remove.isPending} onConfirm={() => del && remove.mutate(del.id)} />
    </>
  );
}

// ---------------------------------------------------------------------------

type UserItem = { id: number; email: string; name: string; role: "admin" | "member"; totpEnabled: boolean; mustChangePassword: boolean; createdAt: number };

function Users() {
  const { data } = useQuery({ queryKey: ["users"], queryFn: () => api.get<{ users: UserItem[]; me: number }>("/users") });
  const [adding, setAdding] = useState(false);
  const [shown, setShown] = useState<{ email: string; password: string } | null>(null);
  const [removing, setRemoving] = useState<UserItem | null>(null);
  const setRole = useAction((v: { id: number; role: string }) => api.patch(`/users/${v.id}`, { role: v.role }), { success: t("Rol güncellendi"), invalidate: [["users"]] });
  const reset = useAction((u: UserItem) => api.post<{ temporaryPassword: string }>(`/users/${u.id}/reset-password`).then((r) => ({ ...r, email: u.email })), {
    invalidate: [["users"]],
    onSuccess: (r) => setShown({ email: r.email, password: r.temporaryPassword }),
  });
  const remove = useAction((id: number) => api.del(`/users/${id}`), { success: t("Kullanıcı silindi"), invalidate: [["users"]], onSuccess: () => setRemoving(null) });
  if (!data) return <PageLoading />;
  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-xl text-[14px] text-muted">{t("Yöneticiler her şeyi yönetir. Üyeler yalnız proje, uygulama ve veritabanlarını yönetebilir; sunuculara, güvenliğe ve ayarlara erişemez.")}</p>
        <Button variant="primary" onClick={() => setAdding(true)}>{t("Kullanıcı ekle")}</Button>
      </div>
      <div className="panel divide-y divide-line">
        {data.users.map((u) => (
          <div key={u.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3">
            <div className="min-w-0 flex-1">
              <div className="font-medium">{u.name}{u.id === data.me && <span className="ml-2 text-[13px] font-normal text-faint">{t("sen")}</span>}</div>
              <div className="text-[13px] text-faint">
                {u.email}
                {u.totpEnabled ? t(", 2FA açık") : ""}
                {u.mustChangePassword ? t(", geçici şifreyle bekliyor") : ""}
              </div>
            </div>
            <select className="input w-auto" value={u.role} disabled={u.id === data.me} onChange={(e) => setRole.mutate({ id: u.id, role: e.target.value })} aria-label={t("Rol")}>
              <option value="admin">{t("Yönetici")}</option>
              <option value="member">{t("Üye")}</option>
            </select>
            {u.id !== data.me && (
              <>
                <Button size="sm" variant="ghost" onClick={() => reset.mutate(u)}>{t("Şifre sıfırla")}</Button>
                <Button size="sm" variant="ghost" onClick={() => setRemoving(u)}>{t("Sil")}</Button>
              </>
            )}
          </div>
        ))}
      </div>
      <AddUser open={adding} onClose={() => setAdding(false)} onCreated={(email, password) => setShown({ email, password })} />
      <Dialog open={Boolean(shown)} onClose={() => setShown(null)} title={t("Geçici şifre")} description={t("{email} bu şifreyle giriş yapacak ve ilk girişte kendi şifresini belirleyecek. Bu şifre bir daha gösterilmez.", { email: shown?.email ?? "" })}>
        {shown && <CopyField value={shown.password} />}
        <div className="mt-5 flex justify-end">
          <Button variant="primary" onClick={() => setShown(null)}>{t("Tamam")}</Button>
        </div>
      </Dialog>
      <ConfirmDialog open={Boolean(removing)} onClose={() => setRemoving(null)} title={t("Kullanıcı silinsin mi?")} description={t("{email} artık giriş yapamayacak.", { email: removing?.email ?? "" })} confirmLabel={t("Sil")} loading={remove.isPending} onConfirm={() => removing && remove.mutate(removing.id)} />
    </>
  );
}

function AddUser({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (email: string, password: string) => void }) {
  const [form, setForm] = useState({ email: "", name: "", role: "member" });
  const create = useAction(() => api.post<{ temporaryPassword: string }>("/users", form), {
    invalidate: [["users"]],
    onSuccess: (r) => {
      onClose();
      onCreated(form.email, r.temporaryPassword);
      setForm({ email: "", name: "", role: "member" });
    },
  });
  return (
    <Dialog open={open} onClose={onClose} title={t("Kullanıcı ekle")} description={t("Geçici bir şifre üretilir; kullanıcıya kendin iletirsin.")}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
        className="space-y-4"
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t("Ad")}>
            <input className="input" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
          <Field label={t("E-posta")}>
            <input className="input" type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </Field>
        </div>
        <Field label={t("Rol")}>
          <select className="input" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
            <option value="member">{t("Üye: proje, uygulama ve veritabanları")}</option>
            <option value="admin">{t("Yönetici: her şey")}</option>
          </select>
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>{t("Vazgeç")}</Button>
          <Button type="submit" variant="primary" loading={create.isPending}>{t("Ekle")}</Button>
        </div>
      </form>
    </Dialog>
  );
}
