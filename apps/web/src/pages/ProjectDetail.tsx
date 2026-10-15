import { useQuery } from "@tanstack/react-query";
import { Database as DbIcon, ExternalLink, FolderUp, GitBranch, Layers, Package } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { CreateAppWizard } from "@/components/CreateAppWizard";
import { FrameworkLogo } from "@/components/FrameworkLogo";
import { Button, ConfirmDialog, Dialog, Empty, Field, Notice, PageHeader, PageLoading, Section, StatusBadge, useAction } from "@/components/ui";
import { api, type App, type Server } from "@/lib/api";
import { t } from "@/lib/i18n";

type ProjectApp = Pick<App, "id" | "name" | "sourceType" | "status" | "server" | "domains" | "gitUrl" | "image" | "framework">;
type ProjectDb = { id: number; name: string; engine: string; version: string; status: string; serverName: string };
type ProjectData = { project: { id: number; name: string; description: string }; apps: ProjectApp[]; databases: ProjectDb[] };

const SOURCE_ICON = { git: GitBranch, image: Package, compose: Layers, upload: FolderUp };

export function ProjectDetailPage() {
  const id = Number(useParams().id);
  const navigate = useNavigate();
  const [dialog, setDialog] = useState<"app" | "db" | "delete" | "edit" | null>(null);
  const { data } = useQuery({ queryKey: ["project", id], queryFn: () => api.get<ProjectData>(`/projects/${id}`), refetchInterval: 5000 });
  const del = useAction(() => api.del(`/projects/${id}`), { success: t("Proje silindi"), invalidate: [["projects"]], onSuccess: () => navigate("/projects") });
  if (!data) return <PageLoading />;
  const { project, apps, databases } = data;

  return (
    <>
      <PageHeader
        back={{ to: "/projects", label: t("Projeler") }}
        title={project.name}
        description={project.description || undefined}
        actions={
          <>
            <Button variant="ghost" onClick={() => setDialog("edit")}>{t("Düzenle")}</Button>
            <Button onClick={() => setDialog("db")}>{t("Veritabanı ekle")}</Button>
            <Button variant="primary" onClick={() => setDialog("app")}>{t("Uygulama ekle")}</Button>
          </>
        }
      />

      <Section title={t("Uygulamalar")}>
        {apps.length === 0 ? (
          <Empty action={<Button variant="primary" onClick={() => setDialog("app")}>{t("Uygulama ekle")}</Button>}>
            {t("Git reposu, Docker imajı veya Compose dosyasıyla bir uygulama ekle. Her uygulamaya otomatik bir adres ve HTTPS verilir.")}
          </Empty>
        ) : (
          <div className="panel divide-y divide-line">
            {apps.map((a) => {
              const Icon = SOURCE_ICON[a.sourceType];
              const logo = a.framework && a.framework !== "auto" && (a.sourceType === "git" || a.sourceType === "upload");
              const domain = a.domains[0];
              return (
                <div key={a.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3.5">
                  {logo ? <FrameworkLogo id={a.framework} className="size-4 shrink-0" /> : <Icon className="size-4 shrink-0 text-faint" strokeWidth={1.8} />}
                  <div className="min-w-0 flex-1">
                    <Link to={`/apps/${a.id}`} className="font-medium hover:underline">{a.name}</Link>
                    <div className="truncate text-[13px] text-faint">{a.server.name}, {a.gitUrl?.replace(/^https:\/\//, "") ?? a.image ?? (a.sourceType === "upload" ? t("Yüklenen dosyalar") : t("Docker Compose"))}</div>
                  </div>
                  {domain && a.status === "running" && (
                    <a href={domain.url} target="_blank" rel="noreferrer" className="inline-flex max-w-[16rem] items-center gap-1.5 truncate text-[13px] text-muted hover:text-fg">
                      <span className="truncate">{domain.host}</span>
                      <ExternalLink className="size-3.5 shrink-0" />
                    </a>
                  )}
                  <StatusBadge status={a.status} />
                </div>
              );
            })}
          </div>
        )}
      </Section>

      <Section title={t("Veritabanları")}>
        {databases.length === 0 ? (
          <Empty action={<Button onClick={() => setDialog("db")}>{t("Veritabanı ekle")}</Button>}>PostgreSQL, MySQL, MariaDB, MongoDB veya Redis; tek tıkla kurulur, otomatik yedeklenebilir.</Empty>
        ) : (
          <div className="panel divide-y divide-line">
            {databases.map((d) => (
              <Link key={d.id} to={`/databases/${d.id}`} className="flex items-center gap-4 px-5 py-3.5 hover:bg-surface-2/50">
                <DbIcon className="size-4 shrink-0 text-faint" strokeWidth={1.8} />
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{d.name}</div>
                  <div className="text-[13px] text-faint">{d.serverName}, {d.engine} {d.version}</div>
                </div>
                <StatusBadge status={d.status} />
              </Link>
            ))}
          </div>
        )}
      </Section>

      {apps.length === 0 && databases.length === 0 && (
        <Section title={t("Projeyi sil")}>
          <Button variant="danger" onClick={() => setDialog("delete")}>{t("Projeyi sil")}</Button>
        </Section>
      )}

      <CreateAppWizard open={dialog === "app"} onClose={() => setDialog(null)} projectId={id} />
      <CreateDbDialog open={dialog === "db"} onClose={() => setDialog(null)} projectId={id} />
      <EditProjectDialog open={dialog === "edit"} onClose={() => setDialog(null)} project={project} />
      <ConfirmDialog open={dialog === "delete"} onClose={() => setDialog(null)} title={t("Proje silinsin mi?")} description={t("Proje boş; silmek hiçbir uygulamayı etkilemez.")} confirmLabel={t("Sil")} loading={del.isPending} onConfirm={() => del.mutate()} />
    </>
  );
}

function useServers() {
  return useQuery({ queryKey: ["servers", "list"], queryFn: () => api.get<{ servers: Server[] }>("/servers") });
}

function ServerSelect({ value, onChange }: { value: number | null; onChange: (id: number) => void }) {
  const { data } = useServers();
  const servers = data?.servers ?? [];
  return (
    <Field label={t("Sunucu")} hint={servers.some((s) => s.status !== "ready") ? t("Kurulumu tamamlanmamış sunucularda deploy yapılamaz.") : undefined}>
      <select className="input" value={value ?? ""} onChange={(e) => onChange(Number(e.target.value))} required>
        <option value="" disabled>{t("Seç")}</option>
        {servers.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}{s.status !== "ready" ? t(" (hazır değil)") : ""}
          </option>
        ))}
      </select>
    </Field>
  );
}

type EngineInfo = { id: string; label: string; versions: string[]; port: number };

function CreateDbDialog({ open, onClose, projectId }: { open: boolean; onClose: () => void; projectId: number }) {
  const navigate = useNavigate();
  const servers = useServers();
  const engines = useQuery({ queryKey: ["db-engines"], queryFn: () => api.get<{ engines: EngineInfo[] }>("/databases/engines") });
  const readyServers = servers.data?.servers.filter((s) => s.status === "ready") ?? [];
  const [serverId, setServerId] = useState<number | null>(null);
  const [form, setForm] = useState({ name: "", engine: "postgres", version: "", externalPort: "" });
  const engine = engines.data?.engines.find((e) => e.id === form.engine);
  const create = useAction(
    () =>
      api.post<{ database: { id: number } }>("/databases", {
        projectId,
        serverId: serverId ?? readyServers[0]?.id,
        name: form.name,
        engine: form.engine,
        version: form.version || undefined,
        externalPort: form.externalPort ? Number(form.externalPort) : null,
      }),
    {
      invalidate: [["project", projectId]],
      onSuccess: (r) => {
        onClose();
        navigate(`/databases/${r.database.id}`);
      },
    },
  );
  return (
    <Dialog open={open} onClose={onClose} title={t("Veritabanı ekle")} description={t("Kullanıcı adı ve güçlü bir şifre otomatik oluşturulur.")}>
      {readyServers.length === 0 ? (
        <Notice tone="warn" title={t("Hazır sunucu yok")}>{t("Veritabanı oluşturmak için önce bir sunucunun kurulumunu tamamla.")}</Notice>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
          className="space-y-4"
        >
          <Field label={t("Ad")}>
            <input className="input" required autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="blog-db" />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t("Motor")}>
              <select className="input" value={form.engine} onChange={(e) => setForm({ ...form, engine: e.target.value, version: "" })}>
                {engines.data?.engines.map((e) => (
                  <option key={e.id} value={e.id}>{e.label}</option>
                ))}
              </select>
            </Field>
            <Field label={t("Sürüm")}>
              <select className="input" value={form.version || engine?.versions[0] || ""} onChange={(e) => setForm({ ...form, version: e.target.value })}>
                {engine?.versions.map((v) => (
                  <option key={v} value={v}>{v}</option>
                ))}
              </select>
            </Field>
          </div>
          <Field label={t("Sunucu")}>
            <select className="input" value={serverId ?? readyServers[0]?.id} onChange={(e) => setServerId(Number(e.target.value))}>
              {readyServers.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </Field>
          <Field label={t("Dışarıya açık port")} hint={t("Boş bırakırsan veritabanına yalnız aynı sunucudaki uygulamalar ulaşır (önerilen).")}>
            <input className="input" inputMode="numeric" value={form.externalPort} onChange={(e) => setForm({ ...form, externalPort: e.target.value.replace(/\D/g, "") })} placeholder={engine ? String(engine.port + 10000) : ""} />
          </Field>
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" onClick={onClose}>{t("Vazgeç")}</Button>
            <Button type="submit" variant="primary" loading={create.isPending}>{t("Oluştur")}</Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

function EditProjectDialog({ open, onClose, project }: { open: boolean; onClose: () => void; project: { id: number; name: string; description: string } }) {
  const [form, setForm] = useState({ name: project.name, description: project.description });
  const save = useAction(() => api.patch(`/projects/${project.id}`, form), { success: t("Proje güncellendi"), invalidate: [["project", project.id], ["projects"]], onSuccess: onClose });
  return (
    <Dialog open={open} onClose={onClose} title={t("Projeyi düzenle")}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
        className="space-y-4"
      >
        <Field label={t("Ad")}>
          <input className="input" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <Field label={t("Açıklama")}>
          <input className="input" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>{t("Vazgeç")}</Button>
          <Button type="submit" variant="primary" loading={save.isPending}>{t("Kaydet")}</Button>
        </div>
      </form>
    </Dialog>
  );
}
