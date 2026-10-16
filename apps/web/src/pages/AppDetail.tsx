import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Plus, Trash2 } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { CronJobs } from "@/components/CronJobs";
import { DeployDoctor } from "@/components/DeployDoctor";
import { DropZone, uploadZip } from "@/components/DropZone";
import { ImageScan } from "@/components/ImageScan";
import { UptimeCard } from "@/components/UptimeCard";
import { FrameworkLogo } from "@/components/FrameworkLogo";
import { EnvSuggestions, FrameworkFields, FrameworkPicker, FrameworkSteps, frameworkById, useFrameworks } from "@/components/FrameworkSetup";
import { LogViewer } from "@/components/LogViewer";
import { Button, ConfirmDialog, CopyField, Field, Notice, PageHeader, PageLoading, Section, StatusBadge, Tabs, Toggle, useAction } from "@/components/ui";
import { api, type App, type DetectResult, type Deployment } from "@/lib/api";
import { useAuthStatus } from "@/lib/auth";
import { dateTime, duration, formatBytes, timeAgo } from "@/lib/format";
import { t } from "@/lib/i18n";

type Tab = "overview" | "deployments" | "logs" | "env" | "domains" | "cron" | "security" | "settings";
type AppData = { app: App; env: string; deployments: Deployment[] };

export function AppDetailPage() {
  const id = Number(useParams().id);
  const [params, setParams] = useSearchParams();
  const tab = (params.get("tab") as Tab) || "overview";
  const setTab = (t: Tab) => setParams({ tab: t }, { replace: true });
  const { data } = useQuery({
    queryKey: ["app", id],
    queryFn: () => api.get<AppData>(`/apps/${id}`),
    refetchInterval: (q) => (q.state.data?.app.status === "deploying" || q.state.data?.app.scan.status === "running" ? 2000 : 8000),
  });
  const deploy = useAction(() => api.post<{ deploymentId: number }>(`/apps/${id}/deploy`), {
    invalidate: [["app", id]],
    onSuccess: (r) => setParams({ tab: "deployments", d: String(r.deploymentId) }, { replace: true }),
  });
  if (!data) return <PageLoading />;
  const { app } = data;
  const primary = app.domains[0];

  return (
    <>
      <PageHeader
        back={{ to: `/projects/${app.projectId}`, label: t("Proje") }}
        title={app.name}
        description={
          <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
            <StatusBadge status={app.status} />
            <span>{app.server.name}</span>
            {primary && app.status === "running" && (
              <a href={primary.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-fg hover:underline">
                {primary.host}
                <ExternalLink className="size-3.5" />
              </a>
            )}
          </span>
        }
        actions={
          <>
            {app.container && <AppPower app={app} />}
            <Button variant="primary" onClick={() => deploy.mutate()} loading={deploy.isPending} disabled={app.server.status !== "ready"}>
              {app.container ? t("Yeniden deploy et") : t("Deploy et")}
            </Button>
          </>
        }
      />
      {app.server.status !== "ready" && (
        <div className="mb-6">
          <Notice tone="warn" title={t("\"{name}\" sunucusu hazır değil", { name: app.server.name })}>{t("Deploy yapabilmek için önce sunucu kurulumunu tamamla.")}</Notice>
        </div>
      )}
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "overview", label: t("Genel") },
          { id: "deployments", label: t("Deploylar") },
          { id: "logs", label: t("Loglar") },
          { id: "env", label: t("Ortam değişkenleri") },
          { id: "domains", label: t("Domainler") },
          { id: "cron", label: t("Zamanlanmış görevler") },
          { id: "security", label: t("Güvenlik") },
          { id: "settings", label: t("Ayarlar") },
        ]}
      />
      {tab === "overview" && <Overview data={data} onDeploy={() => deploy.mutate()} />}
      {tab === "deployments" && <Deployments data={data} />}
      {tab === "logs" && <LogViewer url={`/api/apps/${id}/logs/stream`} emptyText={t("Log bekleniyor...")} />}
      {tab === "env" && <Env data={data} />}
      {tab === "domains" && <Domains app={app} />}
      {tab === "cron" && <CronJobs app={app} />}
      {tab === "security" && <Security app={app} />}
      {tab === "settings" && <Settings app={app} />}
    </>
  );
}

function AppPower({ app }: { app: App }) {
  const act = useAction((a: "start" | "stop" | "restart") => api.post(`/apps/${app.id}/${a}`), {
    success: t("İşlem tamamlandı"),
    invalidate: [["app", app.id]],
  });
  if (app.status === "stopped") return <Button onClick={() => act.mutate("start")} loading={act.isPending}>{t("Başlat")}</Button>;
  return (
    <>
      <Button variant="ghost" onClick={() => act.mutate("restart")} loading={act.isPending && act.variables === "restart"}>{t("Yeniden başlat")}</Button>
      <Button variant="ghost" onClick={() => act.mutate("stop")} loading={act.isPending && act.variables === "stop"}>{t("Durdur")}</Button>
    </>
  );
}

// ---------------------------------------------------------------------------

function Overview({ data, onDeploy }: { data: AppData; onDeploy: () => void }) {
  const { app, deployments } = data;
  const stats = useQuery({
    queryKey: ["app", app.id, "stats"],
    queryFn: () => api.get<{ stats: { cpu: number; memory: number; memoryLimit: number } | null }>(`/apps/${app.id}/stats`),
    refetchInterval: 5000,
    enabled: app.status === "running" && app.sourceType !== "compose",
  });
  const last = deployments[0];
  const webhook = `${location.origin}${app.webhookPath}`;
  const source =
    app.sourceType === "git"
      ? `${app.gitUrl} (${app.gitBranch})`
      : app.sourceType === "image"
        ? app.image
        : app.sourceType === "upload"
          ? t("Yüklenen dosyalar")
          : app.gitUrl
            ? `Compose, ${app.gitUrl}`
            : t("Compose dosyası");

  if (!last && app.sourceType === "upload") return <UploadNewVersion app={app} first />;
  if (!last)
    return (
      <div className="panel px-5 py-6">
        <h2 className="font-medium">{t("İlk deploy'a hazır")}</h2>
        <p className="mt-1 max-w-xl text-[14px] leading-relaxed text-muted">
          {app.sourceType === "git"
            ? t("Repo klonlanacak; Dockerfile varsa o kullanılacak, yoksa proje türü (Node, Python, Django, Go, statik site) tanınıp Dockerfile üretilecek.")
            : app.sourceType === "image"
              ? t("İmaj çekilip çalıştırılacak.")
              : t("Compose servisleri başlatılacak.")}{" "}
          {t("Ortam değişkenleri gerekiyorsa önce onları gir.")}
        </p>
        <Button variant="primary" className="mt-4" onClick={onDeploy}>{t("Deploy et")}</Button>
      </div>
    );

  return (
    <div className="space-y-8">
      <div className="panel divide-y divide-line">
        {app.domains.map((d) => (
          <div key={d.id} className="flex items-center justify-between gap-3 px-5 py-3">
            <a href={d.url} target="_blank" rel="noreferrer" className="inline-flex min-w-0 items-center gap-1.5 truncate font-medium hover:underline">
              <span className="truncate">{d.url}</span>
              <ExternalLink className="size-3.5 shrink-0 text-faint" />
            </a>
            <span className="shrink-0 text-[13px] text-faint">{d.generated ? t("Otomatik adres") : t("Alan adı")}{d.https ? t(", HTTPS") : ""}</span>
          </div>
        ))}
        {app.domains.length === 0 && <div className="px-5 py-3 text-[14px] text-muted">{t("Alan adı yok. Domainler sekmesinden ekle.")}</div>}
      </div>

      <dl className="grid gap-x-8 gap-y-3 text-[14px] sm:grid-cols-2">
        <Row label={t("Kaynak")} value={source ?? ""} mono />
        <Row label={t("Son deploy")} value={`${timeAgo(last.startedAt)}, ${last.status === "success" ? t("başarılı") : last.status === "failed" ? t("başarısız") : t("sürüyor")}`} />
        {stats.data?.stats && <Row label={t("İşlemci")} value={`%${stats.data.stats.cpu.toFixed(1)}`} />}
        {stats.data?.stats && <Row label={t("Bellek")} value={formatBytes(stats.data.stats.memory)} />}
        <Row label={t("İç adres")} value={`${app.internalHost}:${app.port}`} hint={t("Aynı sunucudaki diğer uygulamalar bu adresle ulaşır.")} mono />
      </dl>

      <UptimeCard app={app} />
      <DeployDoctor app={app} last={last} />
      <ImageScan app={app} />

      {app.sourceType === "upload" && <UploadNewVersion app={app} />}

      {(app.sourceType === "git" || app.sourceType === "compose") && (
        <Section title={t("Otomatik deploy")} description={t("Git sağlayıcında bu adresi push webhook'u olarak ekle; her push'ta uygulama yeniden deploy edilir.")}>
          <div className="space-y-3">
            <Field label={t("Webhook adresi")}>
              <CopyField value={webhook} secret />
            </Field>
            {app.webhookSecret && (
              <Field label={t("Gizli anahtar (Secret)")} hint={t("GitHub, Gitea ve GitLab'de webhook'un Secret / Secret token alanına yaz. İstek bu anahtarla imzalanmadıysa deploy başlamaz.")}>
                <CopyField value={app.webhookSecret} secret />
              </Field>
            )}
            {!app.webhookSigned && <Notice tone="warn" title={t("Bu uygulamada imzasız webhook istekleri de kabul ediliyor. Secret'ı git sağlayıcına ekledikten sonra ayarlardan imzayı zorunlu yap.")} />}
          </div>
        </Section>
      )}
    </div>
  );
}

function Row({ label, value, hint, mono }: { label: string; value: string; hint?: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-4 border-b border-line pb-3">
      <dt className="text-muted" title={hint}>{label}</dt>
      <dd className={`min-w-0 truncate text-right ${mono ? "font-mono text-[13px]" : ""}`}>{value}</dd>
    </div>
  );
}

// ---------------------------------------------------------------------------

function Deployments({ data }: { data: AppData }) {
  const { app, deployments } = data;
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const selected = Number(params.get("d")) || deployments[0]?.id;
  const dep = deployments.find((d) => d.id === selected);
  const rollback = useAction((depId: number) => api.post<{ deploymentId: number }>(`/apps/${app.id}/rollback/${depId}`), {
    success: t("Geri dönüş başladı"),
    invalidate: [["app", app.id]],
    onSuccess: (r) => setParams({ tab: "deployments", d: String(r.deploymentId) }, { replace: true }),
  });
  const cancel = useAction((depId: number) => api.post(`/deployments/${depId}/cancel`), { success: t("Deploy iptal edildi"), invalidate: [["app", app.id]] });

  if (!deployments.length) return <Notice tone="info" title={t("Henüz deploy yok")}>{t("Sağ üstteki \"Deploy et\" ile ilk sürümü yayınla.")}</Notice>;

  return (
    <div className="grid gap-6 lg:grid-cols-[17rem_1fr]">
      <div className="panel max-h-[34rem] divide-y divide-line overflow-auto">
        {deployments.map((d) => (
          <button
            key={d.id}
            onClick={() => setParams({ tab: "deployments", d: String(d.id) }, { replace: true })}
            className={`block w-full px-4 py-3 text-left transition-colors ${d.id === selected ? "bg-surface-2" : "hover:bg-surface-2/50"}`}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-[14px] font-medium">#{d.id}</span>
              <StatusBadge status={d.status} />
            </div>
            <div className="mt-0.5 truncate text-[13px] text-muted">{d.title || { manual: t("Elle başlatıldı"), webhook: t("Git push"), rollback: t("Geri dönüş") }[d.trigger]}</div>
            <div className="mt-0.5 text-[12px] text-faint">{dateTime(d.startedAt)}, {duration(d.startedAt, d.finishedAt)}</div>
          </button>
        ))}
      </div>
      {dep && (
        <div className="min-w-0">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div className="text-[14px] text-muted">
              {dep.commitSha && <span className="mr-3 font-mono text-fg">{dep.commitSha}</span>}
              {dep.image && <span className="font-mono text-[13px]">{dep.image}</span>}
            </div>
            <div className="flex gap-2">
              {(dep.status === "queued" || dep.status === "running") && <Button size="sm" variant="ghost" onClick={() => cancel.mutate(dep.id)}>{t("İptal et")}</Button>}
              {dep.status === "success" && dep.image && dep.image !== app.currentImage && app.sourceType !== "compose" && (
                <Button size="sm" onClick={() => rollback.mutate(dep.id)} loading={rollback.isPending}>{t("Bu sürüme dön")}</Button>
              )}
            </div>
          </div>
          <LogViewer url={`/api/deployments/${dep.id}/stream`} onDone={() => qc.invalidateQueries({ queryKey: ["app", app.id] })} />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function Env({ data }: { data: AppData }) {
  const [env, setEnv] = useState(data.env);
  const frameworks = useFrameworks();
  const fw = frameworkById(frameworks.data?.frameworks, data.app.framework);
  const save = useAction(() => api.put(`/apps/${data.app.id}/env`, { env }), { success: t("Kaydedildi. Geçerli olması için yeniden deploy et."), invalidate: [["app", data.app.id]] });
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <p className="mb-3 max-w-2xl text-[14px] text-muted">
        {t("Her satıra bir değişken:")} <code className="font-mono text-fg">{t("ANAHTAR=değer")}</code>{t(". Değerler şifrelenerek saklanır.")} {t("PORT otomatik eklenir.")}
      </p>
      <textarea
        className="input h-80 font-mono text-[13px] leading-relaxed"
        spellCheck={false}
        value={env}
        onChange={(e) => setEnv(e.target.value)}
        placeholder={"DATABASE_URL=postgresql://...\nSECRET_KEY=..."}
      />
      {fw && fw.envHints.length > 0 && (
        <div className="mt-3">
          <EnvSuggestions hints={fw.envHints} env={env} onChange={setEnv} ctx={{ hosts: data.app.domains.map((d) => d.host), https: data.app.domains[0]?.https ?? true }} />
        </div>
      )}
      <p className="mt-3 text-[13px] text-faint">
        <code className="font-mono">{"{{XUDBIN_URL}}"}</code>, <code className="font-mono">{"{{XUDBIN_DOMAINS}}"}</code> {t("ve")} <code className="font-mono">{"{{XUDBIN_ORIGINS}}"}</code> {t("deploy sırasında uygulamanın güncel alan adlarıyla doldurulur.")}
      </p>
      <div className="mt-3 flex justify-end">
        <Button type="submit" variant="primary" loading={save.isPending} disabled={env === data.env}>{t("Kaydet")}</Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------

function Domains({ app }: { app: App }) {
  const [host, setHost] = useState("");
  const [https, setHttps] = useState(true);
  const servers = useQuery({ queryKey: ["server", app.server.id], queryFn: () => api.get<{ server: { publicIp: string | null; httpsMode: string } }>(`/servers/${app.server.id}`) });
  const add = useAction(() => api.post(`/apps/${app.id}/domains`, { host, https }), { success: t("Alan adı eklendi"), invalidate: [["app", app.id]], onSuccess: () => setHost("") });
  const gen = useAction(() => api.post(`/apps/${app.id}/domains/generate`), { success: t("Yeni otomatik adres oluşturuldu"), invalidate: [["app", app.id]] });
  const del = useAction((domainId: number) => api.del(`/apps/${app.id}/domains/${domainId}`), { success: t("Alan adı kaldırıldı"), invalidate: [["app", app.id]] });
  const ip = servers.data?.server.publicIp;
  const httpsOff = servers.data?.server.httpsMode === "off";

  return (
    <div className="space-y-8">
      <div className="panel divide-y divide-line">
        {app.domains.map((d) => (
          <div key={d.id} className="flex items-center gap-3 px-5 py-3">
            <div className="min-w-0 flex-1">
              <a href={d.url} target="_blank" rel="noreferrer" className="block truncate font-medium hover:underline">{d.host}</a>
              <div className="text-[13px] text-faint">{d.generated ? t("Otomatik (sslip.io), DNS ayarı gerekmez") : t("Kendi alan adın")}, {d.https ? t("HTTPS otomatik") : t("yalnız HTTP")}</div>
            </div>
            <Button size="sm" variant="ghost" aria-label={t("Kaldır")} onClick={() => del.mutate(d.id)}>
              <Trash2 className="size-4" />
            </Button>
          </div>
        ))}
        {app.domains.length === 0 && <div className="px-5 py-4 text-[14px] text-muted">{t("Bu uygulamanın adresi yok.")}</div>}
      </div>

      <Section title={t("Alan adı bağla")} description={ip ? t("Alan adının DNS ayarlarında {ip} adresine bir A kaydı oluştur, sonra buraya ekle. Sertifika ilk ziyarette otomatik alınır.", { ip }) : t("Önce sunucunun dış IP adresini sunucu ayarlarından gir.")}>
        <form
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            add.mutate();
          }}
          className="panel space-y-4 p-5"
        >
          <Field label={t("Alan adı")}>
            <input className="input" required value={host} onChange={(e) => setHost(e.target.value.trim().toLowerCase())} placeholder="blog.ornek.com" />
          </Field>
          <Toggle checked={https && !httpsOff} disabled={httpsOff} onChange={setHttps} label={t("HTTPS")} description={httpsOff ? t("Bu sunucuda HTTPS kapalı.") : t("Let's Encrypt sertifikası otomatik alınır ve yenilenir, ücretsiz.")} />
          <div className="flex flex-wrap justify-between gap-2">
            <Button type="button" variant="ghost" onClick={() => gen.mutate()} loading={gen.isPending} disabled={!ip}>
              <Plus className="size-4" /> {t("Otomatik adres üret")}
            </Button>
            <Button type="submit" variant="primary" loading={add.isPending}>{t("Ekle")}</Button>
          </div>
        </form>
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------------------

function Security({ app }: { app: App }) {
  const s = app.security;
  const [form, setForm] = useState({
    waf: s.waf,
    rateLimitOn: s.rateLimit !== null,
    rateLimit: String(s.rateLimit ?? 600),
    headers: s.headers,
    authOn: Boolean(s.basicAuth),
    authUser: s.basicAuth?.username ?? "admin",
    authPass: "",
    allowIps: s.allowIps.join("\n"),
    denyIps: s.denyIps.join("\n"),
  });
  useEffect(() => setForm((f) => ({ ...f, authPass: "" })), [app.security]);
  const lines = (t: string) => t.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
  const save = useAction(
    () =>
      api.put(`/apps/${app.id}/security`, {
        waf: form.waf,
        rateLimit: form.rateLimitOn ? Number(form.rateLimit) || 600 : null,
        headers: form.headers,
        allowIps: lines(form.allowIps),
        denyIps: lines(form.denyIps),
        basicAuth: form.authOn ? { username: form.authUser, password: form.authPass || undefined } : null,
      }),
    { success: t("Güvenlik ayarları uygulandı"), invalidate: [["app", app.id]] },
  );

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
      className="space-y-6"
    >
      <div className="panel space-y-5 p-5">
        <Toggle
          checked={form.waf}
          onChange={(v) => setForm({ ...form, waf: v })}
          label={t("Web uygulama güvenlik duvarı (WAF)")}
          description={t("OWASP Core Rule Set ile SQL injection, XSS, dosya yolu saldırıları ve kötü niyetli tarayıcılar engellenir.")}
        />
        <div>
          <Toggle
            checked={form.rateLimitOn}
            onChange={(v) => setForm({ ...form, rateLimitOn: v })}
            label={t("Hız sınırı")}
            description={t("Aynı IP'den gelen istek sayısını sınırlar; kaba kuvvet ve küçük çaplı DoS denemelerini durdurur.")}
          />
          {form.rateLimitOn && (
            <div className="mt-3 ml-12 flex items-center gap-2 text-[14px]">
              <input className="input w-28" inputMode="numeric" value={form.rateLimit} onChange={(e) => setForm({ ...form, rateLimit: e.target.value.replace(/\D/g, "") })} />
              <span className="text-muted">{t("istek / dakika / IP")}</span>
            </div>
          )}
        </div>
        <Toggle checked={form.headers} onChange={(v) => setForm({ ...form, headers: v })} label={t("Güvenlik başlıkları")} description={t("Clickjacking ve MIME türü tahminine karşı başlıklar eklenir, sunucu bilgisi gizlenir.")} />
        <div>
          <Toggle checked={form.authOn} onChange={(v) => setForm({ ...form, authOn: v })} label={t("Şifre koruması")} description={t("Siteyi açmak için kullanıcı adı ve şifre istenir. Test ortamları için kullanışlı.")} />
          {form.authOn && (
            <div className="mt-3 ml-12 grid max-w-md gap-3 sm:grid-cols-2">
              <Field label={t("Kullanıcı adı")}>
                <input className="input" value={form.authUser} onChange={(e) => setForm({ ...form, authUser: e.target.value })} />
              </Field>
              <Field label={t("Şifre")} hint={s.basicAuth ? t("Değiştirmek istemiyorsan boş bırak.") : t("En az 8 karakter.")}>
                <input className="input" type="password" autoComplete="new-password" value={form.authPass} onChange={(e) => setForm({ ...form, authPass: e.target.value })} />
              </Field>
            </div>
          )}
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t("Yalnız bu IP'lere izin ver")} hint={t("Boşsa herkes erişebilir. Satır başına bir IP veya CIDR (ör. 10.0.0.0/8).")}>
          <textarea className="input h-28 font-mono text-[13px]" value={form.allowIps} onChange={(e) => setForm({ ...form, allowIps: e.target.value })} />
        </Field>
        <Field label={t("Bu IP'leri engelle")} hint={t("Tüm uygulamalar için engellemek istersen Güvenlik sayfasını kullan.")}>
          <textarea className="input h-28 font-mono text-[13px]" value={form.denyIps} onChange={(e) => setForm({ ...form, denyIps: e.target.value })} />
        </Field>
      </div>
      <div className="flex justify-end">
        <Button type="submit" variant="primary" loading={save.isPending}>{t("Kaydet ve uygula")}</Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------

function Settings({ app }: { app: App }) {
  const navigate = useNavigate();
  const [form, setForm] = useState({
    name: app.name,
    gitUrl: app.gitUrl ?? "",
    gitBranch: app.gitBranch,
    gitToken: "",
    buildType: app.buildType,
    framework: app.framework,
    buildOptions: app.buildOptions as Record<string, string | boolean>,
    dockerfilePath: app.dockerfilePath,
    buildContext: app.buildContext,
    image: app.image ?? "",
    composeFile: app.composeFile ?? "",
    composeService: app.composeService ?? "",
    port: String(app.port),
    command: app.command ?? "",
    autoDeploy: app.autoDeploy,
    hostAccess: app.hostAccess,
    webhookSigned: app.webhookSigned,
    cpuLimit: app.cpuLimit ? String(app.cpuLimit) : "",
    memoryLimit: app.memoryLimit ? String(app.memoryLimit) : "",
    httpCheck: app.httpCheck,
    uptimeEnabled: app.uptimeEnabled,
    kind: app.kind,
    replicas: String(app.replicas),
    healthPath: app.healthPath ?? "",
    volumes: app.volumes,
  });
  const isAdmin = useAuthStatus().data?.user?.role === "admin";
  const [confirm, setConfirm] = useState(false);
  const save = useAction(
    () =>
      api.patch(`/apps/${app.id}`, {
        name: form.name,
        gitUrl: form.gitUrl || null,
        gitBranch: form.gitBranch,
        ...(form.gitToken ? { gitToken: form.gitToken } : {}),
        framework: form.framework,
        buildOptions: form.buildOptions,
        dockerfilePath: form.dockerfilePath,
        buildContext: form.buildContext,
        image: form.image || null,
        composeFile: form.composeFile || null,
        composeService: form.composeService || null,
        port: Number(form.port) || app.port,
        command: form.command || null,
        autoDeploy: form.autoDeploy,
        ...(isAdmin ? { hostAccess: form.hostAccess } : {}),
        webhookSigned: form.webhookSigned,
        cpuLimit: Number(form.cpuLimit) || null,
        memoryLimit: Number(form.memoryLimit) || null,
        httpCheck: form.httpCheck,
        uptimeEnabled: form.uptimeEnabled,
        ...(app.sourceType !== "compose" ? { kind: form.kind, replicas: Number(form.replicas) || 1 } : {}),
        healthPath: form.healthPath.trim() || null,
        volumes: form.volumes.filter((v) => v.name && v.path),
      }),
    { success: t("Ayarlar kaydedildi"), invalidate: [["app", app.id]] },
  );
  const del = useAction(() => api.del(`/apps/${app.id}`), { success: t("Uygulama silindi"), onSuccess: () => navigate(`/projects/${app.projectId}`) });
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  return (
    <>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
        className="space-y-6"
      >
        <div className="panel space-y-4 p-5">
          <Field label={t("Ad")}>
            <input className="input" value={form.name} onChange={set("name")} />
          </Field>
          {(app.sourceType === "git" || app.sourceType === "compose") && (
            <>
              <div className="grid gap-3 sm:grid-cols-[1fr_10rem]">
                <Field label={t("Repo adresi")}>
                  <input className="input" value={form.gitUrl} onChange={set("gitUrl")} />
                </Field>
                <Field label={t("Dal")}>
                  <input className="input" value={form.gitBranch} onChange={set("gitBranch")} />
                </Field>
              </div>
              <Field label={t("Erişim token'ı")} hint={app.hasGitToken ? t("Kayıtlı bir token var. Değiştirmek için yenisini gir.") : t("Yalnız özel repolar için.")}>
                <input className="input" type="password" autoComplete="off" value={form.gitToken} onChange={set("gitToken")} />
              </Field>
            </>
          )}
          {(app.sourceType === "git" || app.sourceType === "upload") && (
            <FrameworkSection
              app={app}
              framework={form.framework}
              opts={form.buildOptions}
              context={form.buildContext}
              onChange={(framework, buildOptions, port) => setForm({ ...form, framework, buildOptions, ...(port ? { port: String(port) } : {}) })}
              onContext={(v) => setForm({ ...form, buildContext: v })}
            />
          )}
          {app.sourceType === "image" && (
            <Field label={t("İmaj")}>
              <input className="input font-mono" value={form.image} onChange={set("image")} />
            </Field>
          )}
          {app.sourceType === "compose" && (
            <>
              {form.gitUrl ? (
                <Field label={t("Compose dosyasının yolu")}>
                  <input className="input font-mono text-[13px]" value={form.dockerfilePath} onChange={set("dockerfilePath")} />
                </Field>
              ) : (
                <Field label={t("docker-compose.yml")}>
                  <textarea className="input h-56 font-mono text-[13px]" value={form.composeFile} onChange={set("composeFile")} />
                </Field>
              )}
              <Field label={t("Alan adının yönleneceği servis")} hint={t("Compose dosyasındaki servis adı, ör. web.")}>
                <input className="input" value={form.composeService} onChange={set("composeService")} />
              </Field>
              <Toggle
                checked={form.hostAccess}
                disabled={!isAdmin}
                onChange={(v) => setForm({ ...form, hostAccess: v })}
                label={t("Sunucu erişimi")}
                description={t("privileged, cap_add, sunucu klasörü bağlama, network_mode: host gibi ayarlara izin verir. Bu ayarlar konteynere sunucuda root yetkisi verebilir; yalnız yönetici açabilir.")}
              />
            </>
          )}
          <div className="grid gap-3 sm:grid-cols-[8rem_1fr]">
            <Field label={t("Port")}>
              <input className="input" inputMode="numeric" value={form.port} onChange={(e) => setForm({ ...form, port: e.target.value.replace(/\D/g, "") })} />
            </Field>
            {app.sourceType !== "compose" && (
              <Field label={t("Başlatma komutu")} hint={t("Boşsa imajın kendi komutu kullanılır.")}>
                <input className="input font-mono text-[13px]" value={form.command} onChange={set("command")} />
              </Field>
            )}
          </div>
          {app.sourceType !== "image" && <Toggle checked={form.autoDeploy} onChange={(v) => setForm({ ...form, autoDeploy: v })} label={t("Push'ta otomatik deploy")} description={t("Webhook çağrıldığında yeni sürüm otomatik yayınlanır.")} />}
          {app.sourceType !== "image" && (
            <Toggle checked={form.webhookSigned} onChange={(v) => setForm({ ...form, webhookSigned: v })} label={t("Webhook imzası zorunlu")} description={t("Yalnız gizli anahtarla imzalanmış istekler deploy başlatır; webhook adresi sızsa bile başkası deploy tetikleyemez.")} />
          )}
          {app.sourceType !== "compose" && (
            <>
              <div className="grid gap-3 sm:grid-cols-[1fr_9rem]">
                <Field label={t("Uygulama türü")} hint={t("Arka plan işçisi: web sunucusu olmayan, kuyruk/iş işleyen süreç (ör. Celery, Sidekiq, queue:work). Alan adı ve HTTP kontrolü kullanılmaz.")}>
                  <select className="input" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as App["kind"] })}>
                    <option value="web">{t("Web uygulaması")}</option>
                    <option value="worker">{t("Arka plan işçisi")}</option>
                  </select>
                </Field>
                <Field label={t("Kopya sayısı")} hint={t("1-10. Trafik kopyalara dağıtılır; bir sonraki deploy'da geçerli olur.")}>
                  <input className="input" inputMode="numeric" value={form.replicas} onChange={(e) => setForm({ ...form, replicas: e.target.value.replace(/\D/g, "").slice(0, 2) })} />
                </Field>
              </div>
              <Toggle checked={form.uptimeEnabled} onChange={(v) => setForm({ ...form, uptimeEnabled: v })} label={t("Erişilebilirlik izleme")} description={t("Site dakikada bir dışarıdan denenir; art arda iki denemede yanıt vermezse bildirim kanallarına \"site çöktü\", düzelince \"yeniden çalışıyor\" bildirimi gider.")} />
              <Toggle checked={form.httpCheck} onChange={(v) => setForm({ ...form, httpCheck: v })} label={t("Deploy'da HTTP kontrolü")} description={t("Yeni sürüme trafik geçmeden önce alan adıyla istek atılır; 400 veya 5xx dönerse eski sürüm yayında kalır ve Deploy Doktoru sebebi gösterir.")} />
              {form.httpCheck && (
                <Field label={t("Sağlık kontrolü yolu")} hint={t("Boşsa / kullanılır ve 404 de kabul edilir. Verilirse 2xx/3xx dönmeli, ör. /health.")}>
                  <input className="input font-mono text-[13px]" placeholder="/" value={form.healthPath} onChange={set("healthPath")} />
                </Field>
              )}
            </>
          )}
          {app.sourceType !== "compose" && (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t("Bellek sınırı (MB)")} hint={t("Boşsa sınırsız. Aşılırsa uygulama yeniden başlatılır, sunucunun geri kalanı etkilenmez.")}>
                <input className="input" inputMode="numeric" placeholder="1024" value={form.memoryLimit} onChange={(e) => setForm({ ...form, memoryLimit: e.target.value.replace(/\D/g, "") })} />
              </Field>
              <Field label={t("CPU sınırı (çekirdek)")} hint={t("Boşsa sınırsız. Ör. 0.5 yarım çekirdek. Bir sonraki deploy'da geçerli olur.")}>
                <input className="input" inputMode="decimal" placeholder="1" value={form.cpuLimit} onChange={(e) => setForm({ ...form, cpuLimit: e.target.value.replace(/[^\d.]/g, "") })} />
              </Field>
            </div>
          )}
        </div>

        {app.sourceType !== "compose" && (
          <Section title={t("Kalıcı depolama")} description={t("Deploylar arasında silinmemesi gereken klasörler (yüklenen dosyalar, SQLite veritabanı...).")}>
            <div className="space-y-2">
              {form.volumes.map((v, i) => (
                <div key={i} className="flex gap-2">
                  <input className="input" placeholder={t("ad (ör. uploads)")} value={v.name} onChange={(e) => setForm({ ...form, volumes: form.volumes.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} />
                  <input className="input font-mono text-[13px]" placeholder="/app/uploads" value={v.path} onChange={(e) => setForm({ ...form, volumes: form.volumes.map((x, j) => (j === i ? { ...x, path: e.target.value } : x)) })} />
                  <Button type="button" variant="ghost" aria-label={t("Kaldır")} onClick={() => setForm({ ...form, volumes: form.volumes.filter((_, j) => j !== i) })}>
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              ))}
              <Button type="button" size="sm" variant="ghost" onClick={() => setForm({ ...form, volumes: [...form.volumes, { name: "", path: "" }] })}>
                <Plus className="size-4" /> {t("Klasör ekle")}
              </Button>
            </div>
          </Section>
        )}
        <div className="flex justify-end">
          <Button type="submit" variant="primary" loading={save.isPending}>{t("Kaydet")}</Button>
        </div>
      </form>

      <Section title={t("Uygulamayı sil")} description={t("Konteynerler, imajlar ve alan adı bağlantıları silinir. Kalıcı depolama klasörleri sunucuda kalır.")}>
        <Button variant="danger" onClick={() => setConfirm(true)}>{t("Uygulamayı sil")}</Button>
      </Section>
      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title={t("Uygulama silinsin mi?")}
        description={t("Bu işlem geri alınamaz. Uygulama yayından kalkar.")}
        typeToConfirm={app.name}
        confirmLabel={t("Sil")}
        loading={del.isPending}
        onConfirm={() => del.mutate()}
      />
    </>
  );
}

function UploadNewVersion({ app, first }: { app: App; first?: boolean }) {
  const [, setParams] = useSearchParams();
  const up = useAction((blob: Blob) => uploadZip<{ deploymentId: number }>(`/apps/${app.id}/upload`, blob), {
    success: t("Dosyalar yüklendi, deploy başladı"),
    invalidate: [["app", app.id]],
    onSuccess: (r) => setParams({ tab: "deployments", d: String(r.deploymentId) }, { replace: true }),
  });
  return (
    <Section title={first ? t("Proje dosyalarını yükle") : t("Yeni sürüm yükle")} description={t("Klasörü veya zip'i bırakınca yüklenir ve hemen deploy edilir.")}>
      <DropZone busy={up.isPending} onReady={(p) => up.mutate(p.blob)} />
    </Section>
  );
}

/** Framework seçimi, ayarları ve repo yeniden algılama. */
function FrameworkSection(props: {
  app: App;
  framework: string;
  opts: Record<string, string | boolean>;
  context: string;
  onChange: (framework: string, opts: Record<string, string | boolean>, port?: number) => void;
  onContext: (v: string) => void;
}) {
  const frameworks = useFrameworks();
  const [picking, setPicking] = useState(false);
  const [detect, setDetect] = useState<DetectResult | null>(null);
  const fw = frameworkById(frameworks.data?.frameworks, props.framework);
  const analyze = useAction(() => api.post<DetectResult>("/frameworks/detect", { appId: props.app.id }), {
    onSuccess: (d) => {
      setDetect(d);
      setPicking(true);
    },
  });
  return (
    <div className="space-y-4 rounded-md border border-line p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          {props.framework !== "auto" && <FrameworkLogo id={props.framework} className="size-6" />}
          <div>
            <div className="text-[14px] font-medium">{fw?.name ?? props.framework}</div>
            <div className="text-[13px] text-muted">{fw?.description}</div>
          </div>
        </div>
        <div className="flex gap-2">
          {props.app.sourceType === "git" && (
            <Button type="button" size="sm" variant="ghost" onClick={() => analyze.mutate()} loading={analyze.isPending}>{t("Repoyu yeniden incele")}</Button>
          )}
          <Button type="button" size="sm" onClick={() => setPicking(!picking)}>{picking ? t("Kapat") : t("Değiştir")}</Button>
        </div>
      </div>
      {picking && (
        <FrameworkPicker
          value={props.framework}
          detected={detect?.matches}
          onChange={(id) => {
            const f = frameworkById(frameworks.data?.frameworks, id);
            const match = detect?.matches.find((m) => m.id === id);
            props.onChange(id, match?.options ?? {}, f && id !== "auto" && id !== "dockerfile" ? f.defaultPort : undefined);
            setPicking(false);
          }}
        />
      )}
      {fw && <FrameworkSteps fw={fw} />}
      {fw && fw.fields.length > 0 && <FrameworkFields fw={fw} values={props.opts} onChange={(v) => props.onChange(props.framework, v)} />}
      {props.app.sourceType === "git" && (
        <Field label={t("Proje klasörü")} hint={t("Monorepo'da derlenecek alt klasör.")}>
          <input className="input max-w-sm font-mono text-[13px]" value={props.context} onChange={(e) => props.onContext(e.target.value || ".")} />
        </Field>
      )}
    </div>
  );
}
