import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Check } from "lucide-react";
import { type FormEvent, useState } from "react";
import { useNavigate } from "react-router";
import { Button, Dialog, Field, Notice, useAction } from "@/components/ui";
import { api, type App, type DetectResult, type Server } from "@/lib/api";
import { DropZone, type Packed, uploadZip } from "./DropZone";
import { EnvSuggestions, FrameworkFields, FrameworkPicker, FrameworkSteps, frameworkById, useFrameworks } from "./FrameworkSetup";
import { t } from "@/lib/i18n";

type Source = App["sourceType"];
type Step = "source" | "framework" | "settings";

const SOURCES: { id: Source; label: string; text: string }[] = [
  { id: "git", label: t("Git reposu"), text: t("GitHub, GitLab, Gitea...") },
  { id: "upload", label: t("Dosya yükle"), text: t("Klasörü sürükle bırak") },
  { id: "image", label: t("Docker imajı"), text: t("Hazır bir imajı çalıştır") },
  { id: "compose", label: t("Docker Compose"), text: t("Birden çok servis") },
];

/** Uygulama ekleme sihirbazı: kaynak → framework (algılamalı) → ayarlar ve ortam değişkenleri. */
export function CreateAppWizard({ open, onClose, projectId }: { open: boolean; onClose: () => void; projectId: number }) {
  const navigate = useNavigate();
  const frameworks = useFrameworks();
  const servers = useQuery({ queryKey: ["servers", "list"], queryFn: () => api.get<{ servers: Server[] }>("/servers") });
  const serverList = servers.data?.servers ?? [];
  const defaultServer = serverList.find((s) => s.status === "ready")?.id ?? serverList[0]?.id ?? null;

  const [step, setStep] = useState<Step>("source");
  const [source, setSource] = useState<Source>("git");
  const [serverId, setServerId] = useState<number | null>(null);
  const [name, setName] = useState("");
  const [git, setGit] = useState({ url: "", branch: "main", token: "", context: "." });
  const githubRepos = useQuery({
    queryKey: ["github-repos"],
    queryFn: () => api.get<{ connected: boolean; repos: { fullName: string; url: string; defaultBranch: string; private: boolean }[] }>("/settings/github/repos"),
    enabled: open && (source === "git" || source === "compose"),
    staleTime: 60_000,
    retry: false,
  });
  const [image, setImage] = useState("");
  const [composeFile, setComposeFile] = useState("");
  const [packed, setPacked] = useState<Packed | null>(null);
  const [uploadId, setUploadId] = useState<string | null>(null);
  const [detect, setDetect] = useState<DetectResult | null>(null);
  const [framework, setFramework] = useState("auto");
  const [opts, setOpts] = useState<Record<string, string | boolean>>({});
  const [port, setPort] = useState("");
  const [env, setEnv] = useState("");

  const server = serverList.find((s) => s.id === (serverId ?? defaultServer));
  const fw = frameworkById(frameworks.data?.frameworks, framework);

  const reset = () => {
    setStep("source");
    setDetect(null);
    setFramework("auto");
    setOpts({});
    setPacked(null);
    setUploadId(null);
    setEnv("");
    setPort("");
  };
  const close = () => {
    onClose();
    reset();
  };

  const chooseFramework = (id: string, d = detect) => {
    setFramework(id);
    const match = d?.matches.find((m) => m.id === id);
    setOpts(match?.options ?? {});
    const f = frameworkById(frameworks.data?.frameworks, id);
    setPort(id === "dockerfile" && d?.dockerfilePort ? String(d.dockerfilePort) : f && id !== "auto" ? String(f.defaultPort) : "");
  };

  const analyze = useAction(
    async () => {
      if (source === "upload") {
        if (!packed) throw new Error(t("Önce proje klasörünü veya zip dosyasını bırak"));
        const r = await uploadZip<{ uploadId: string; detect: DetectResult }>("/uploads", packed.blob);
        setUploadId(r.uploadId);
        return r.detect;
      }
      return api.post<DetectResult>("/frameworks/detect", { gitUrl: git.url, gitBranch: git.branch || "main", gitToken: git.token || undefined, buildContext: git.context || "." });
    },
    {
      onSuccess: (d) => {
        setDetect(d);
        chooseFramework(d.matches[0]?.id ?? "auto", d);
        setStep("framework");
      },
    },
  );

  const create = useAction(
    async () => {
      const r = await api.post<{ app: App }>("/apps", {
        projectId,
        serverId: serverId ?? defaultServer,
        name: name || packed?.name.replace(/\.zip$/i, "") || "uygulama",
        sourceType: source,
        gitUrl: source === "git" || source === "compose" ? git.url || undefined : undefined,
        gitBranch: git.branch || undefined,
        gitToken: git.token || undefined,
        buildContext: git.context || ".",
        image: image || undefined,
        composeFile: composeFile || undefined,
        uploadId: uploadId ?? undefined,
        framework: source === "git" || source === "upload" ? framework : undefined,
        buildOptions: opts,
        port: port ? Number(port) : undefined,
        env: env || undefined,
      });
      if (server?.status === "ready" && source !== "compose") await api.post(`/apps/${r.app.id}/deploy`);
      return r.app;
    },
    {
      invalidate: [["project", projectId]],
      onSuccess: (a) => {
        close();
        navigate(`/apps/${a.id}${server?.status === "ready" && source !== "compose" ? "?tab=deployments" : ""}`);
      },
    },
  );

  const next = (e: FormEvent) => {
    e.preventDefault();
    if (step === "source") {
      if (source === "git" || source === "upload") analyze.mutate();
      else {
        setPort(source === "image" ? "80" : "");
        setStep("settings");
      }
    } else if (step === "framework") setStep("settings");
    else create.mutate();
  };

  const stepsShown: Step[] = source === "git" || source === "upload" ? ["source", "framework", "settings"] : ["source", "settings"];
  const titles: Record<Step, string> = { source: t("Kaynak"), framework: t("Framework"), settings: t("Ayarlar") };

  return (
    <Dialog open={open} onClose={close} title={t("Uygulama ekle")} wide>
      <ol className="-mt-2 mb-5 flex items-center gap-2 text-[13px]">
        {stepsShown.map((s, i) => {
          const done = stepsShown.indexOf(step) > i;
          return (
            <li key={s} className={`flex items-center gap-1.5 ${s === step ? "font-medium text-fg" : done ? "text-ok" : "text-faint"}`}>
              <span className={`grid size-5 place-items-center rounded-full text-[11px] ${s === step ? "bg-accent text-accent-fg" : done ? "bg-ok/15" : "bg-surface-2"}`}>
                {done ? <Check className="size-3" /> : i + 1}
              </span>
              {titles[s]}
              {i < stepsShown.length - 1 && <span className="ml-1 text-faint">/</span>}
            </li>
          );
        })}
      </ol>

      <form onSubmit={next} className="space-y-4">
        {step === "source" && (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t("Ad")}>
                <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={source === "upload" ? t("Boşsa klasör adı kullanılır") : "blog"} required={source !== "upload"} />
              </Field>
              <Field label={t("Sunucu")} hint={server && server.status !== "ready" ? t("Bu sunucunun kurulumu tamamlanmamış; deploy edilemez.") : undefined}>
                <select className="input" value={serverId ?? defaultServer ?? ""} onChange={(e) => setServerId(Number(e.target.value))}>
                  {serverList.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}{s.status !== "ready" ? t(" (hazır değil)") : ""}</option>
                  ))}
                </select>
              </Field>
            </div>
            <fieldset>
              <legend className="mb-1.5 text-[14px] font-medium">{t("Kaynak")}</legend>
              <div className="grid gap-2 sm:grid-cols-4">
                {SOURCES.map((s) => (
                  <label key={s.id} className={`cursor-pointer rounded-md border px-3 py-2.5 transition-colors ${source === s.id ? "border-accent bg-accent-soft/40" : "border-line-strong hover:bg-surface-2"}`}>
                    <input type="radio" name="source" className="sr-only" checked={source === s.id} onChange={() => setSource(s.id)} />
                    <div className="text-[14px] font-medium">{s.label}</div>
                    <div className="text-[12px] text-muted">{s.text}</div>
                  </label>
                ))}
              </div>
            </fieldset>

            {(source === "git" || source === "compose") && (
              <>
                {githubRepos.data?.repos.length ? (
                  <Field label={t("GitHub'dan seç")} hint={t("GitHub App'e erişim verilen repolar; token gerekmez.")}>
                    <select
                      className="input"
                      value={githubRepos.data.repos.find((r) => r.url === git.url)?.url ?? ""}
                      onChange={(e) => {
                        const r = githubRepos.data!.repos.find((x) => x.url === e.target.value);
                        if (r) {
                          setGit({ ...git, url: r.url, branch: r.defaultBranch, token: "" });
                          if (!name) setName(r.fullName.split("/")[1]!);
                        }
                      }}
                    >
                      <option value="">{t("Repo seç...")}</option>
                      {githubRepos.data.repos.map((r) => (
                        <option key={r.url} value={r.url}>
                          {r.fullName}
                          {r.private ? " 🔒" : ""}
                        </option>
                      ))}
                    </select>
                  </Field>
                ) : null}
                <div className="grid gap-3 sm:grid-cols-[1fr_9rem]">
                  <Field label={t("Repo adresi")} hint={source === "compose" ? t("Boş bırakırsan compose dosyasını sonraki adımda yapıştırırsın.") : t("https:// ile başlamalı.")}>
                    <input className="input" required={source === "git"} value={git.url} onChange={(e) => setGit({ ...git, url: e.target.value.trim() })} placeholder={t("https://github.com/kullanici/repo")} />
                  </Field>
                  <Field label={t("Dal")}>
                    <input className="input" value={git.branch} onChange={(e) => setGit({ ...git, branch: e.target.value.trim() })} />
                  </Field>
                </div>
                <div className="grid gap-3 sm:grid-cols-[1fr_12rem]">
                  <Field label={t("Erişim token'ı")} hint={t("Yalnız özel (private) repolar için, şifrelenerek saklanır. GitHub App erişimi yalnız yöneticiye ya da projede zaten bağlı repoya verilir; yeni bir özel repo için kendi token'ını gir.")}>
                    <input className="input" type="password" autoComplete="off" value={git.token} onChange={(e) => setGit({ ...git, token: e.target.value.trim() })} />
                  </Field>
                  {source === "git" && (
                    <Field label={t("Proje klasörü")} hint={t("Monorepo'da alt klasör, ör. apps/web")}>
                      <input className="input font-mono text-[13px]" value={git.context} onChange={(e) => setGit({ ...git, context: e.target.value.trim() || "." })} />
                    </Field>
                  )}
                </div>
              </>
            )}
            {source === "upload" &&
              (packed ? (
                <div className="flex items-center justify-between gap-3 rounded-md border border-line bg-surface-2 px-4 py-3 text-[14px]">
                  <span>
                    <span className="font-medium">{packed.name}</span>
                    <span className="text-muted"> ({packed.files ? `${packed.files} dosya, ` : ""}{(packed.blob.size / 1024 / 1024).toFixed(1)} MB)</span>
                    {packed.skippedEnv && <span className="block text-[13px] text-warn">{t(".env dosyası yüklenmedi; değerlerini sonraki adımda ortam değişkenlerine gir.")}</span>}
                  </span>
                  <Button type="button" size="sm" variant="ghost" onClick={() => setPacked(null)}>{t("Değiştir")}</Button>
                </div>
              ) : (
                <DropZone onReady={setPacked} />
              ))}
            {source === "image" && (
              <Field label={t("İmaj")} hint={t("Docker Hub veya başka bir kayıttan, ör. ghcr.io/kullanici/uygulama:latest")}>
                <input className="input font-mono" required value={image} onChange={(e) => setImage(e.target.value.trim())} placeholder="nginx:alpine" />
              </Field>
            )}
          </>
        )}

        {step === "framework" && <FrameworkPicker value={framework} onChange={(id) => chooseFramework(id)} detected={detect?.matches} />}

        {step === "settings" && (
          <>
            {fw && (source === "git" || source === "upload") && (
              <div className="rounded-md border border-line p-4">
                <div className="mb-3 text-[14px] font-medium">{t("{name}: deploy'da ne olacak", { name: fw.name })}</div>
                <FrameworkSteps fw={fw} />
                {fw.fields.length > 0 && (
                  <div className="mt-4 border-t border-line pt-4">
                    <FrameworkFields fw={fw} values={opts} onChange={setOpts} />
                  </div>
                )}
              </div>
            )}
            {source === "compose" && !git.url && (
              <Field label={t("docker-compose.yml")}>
                <textarea className="input h-48 font-mono text-[13px]" required value={composeFile} onChange={(e) => setComposeFile(e.target.value)} placeholder={"services:\n  web:\n    image: nginx:alpine"} />
              </Field>
            )}
            {source !== "compose" && (
              <Field label={t("Uygulamanın dinlediği port")} hint={framework !== "auto" && framework !== "dockerfile" && source !== "image" ? t("Framework'e göre ayarlandı; derlemede otomatik doğrulanır.") : t("Konteynerin içindeki port.")}>
                <input className="input max-w-32" inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ""))} placeholder="3000" />
              </Field>
            )}
            <Field label={t("Ortam değişkenleri")} hint={t("Her satıra ANAHTAR=değer. Şifrelenerek saklanır; sonra da değiştirebilirsin.")}>
              <textarea className="input h-36 font-mono text-[13px]" spellCheck={false} value={env} onChange={(e) => setEnv(e.target.value)} placeholder="DATABASE_URL=..." />
            </Field>
            {(source === "git" || source === "upload") && fw && (
              <EnvSuggestions hints={fw.envHints} detect={detect} env={env} onChange={setEnv} ctx={{ hosts: [], https: server?.httpsMode !== "off" }} />
            )}
            {server && server.status !== "ready" && <Notice tone="warn" title={t("Sunucu hazır değil")}>{t("Uygulama oluşturulur, sunucu kurulumu bitince deploy edebilirsin.")}</Notice>}
          </>
        )}

        <div className="flex items-center justify-between gap-2 pt-1">
          {step !== "source" ? (
            <Button type="button" variant="ghost" onClick={() => setStep(step === "settings" && stepsShown.includes("framework") ? "framework" : "source")}>
              <ArrowLeft className="size-4" /> {t("Geri")}
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button type="button" variant="ghost" onClick={close}>{t("Vazgeç")}</Button>
            <Button type="submit" variant="primary" loading={analyze.isPending || create.isPending} disabled={step === "source" && source === "upload" && !packed}>
              {step === "settings" ? (server?.status === "ready" && source !== "compose" ? t("Oluştur ve deploy et") : t("Oluştur")) : step === "source" && (source === "git" || source === "upload") ? t("Repoyu incele") : t("Devam")}
            </Button>
          </div>
        </div>
      </form>
    </Dialog>
  );
}
