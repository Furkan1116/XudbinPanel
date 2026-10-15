import { useQuery } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { Link, useNavigate } from "react-router";
import { Button, Dialog, Empty, Field, PageHeader, PageLoading, useAction } from "@/components/ui";
import { api, type Project } from "@/lib/api";
import { timeAgo } from "@/lib/format";

export function ProjectsPage() {
  const [creating, setCreating] = useState(false);
  const { data } = useQuery({ queryKey: ["projects"], queryFn: () => api.get<{ projects: Project[] }>("/projects") });
  if (!data) return <PageLoading />;
  return (
    <>
      <PageHeader
        title="Projeler"
        description="Birbiriyle ilgili uygulama ve veritabanlarını bir arada tut."
        actions={<Button variant="primary" onClick={() => setCreating(true)}>Proje oluştur</Button>}
      />
      {data.projects.length === 0 ? (
        <Empty action={<Button variant="primary" onClick={() => setCreating(true)}>Proje oluştur</Button>}>
          Henüz proje yok. Bir proje oluştur, içine Git reposundan ya da Docker imajından uygulama ekle.
        </Empty>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {data.projects.map((p) => (
            <Link key={p.id} to={`/projects/${p.id}`} className="panel block px-5 py-4 transition-colors hover:border-line-strong">
              <div className="font-medium">{p.name}</div>
              {p.description && <p className="mt-1 line-clamp-2 text-[14px] text-muted">{p.description}</p>}
              <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-faint">
                <span>{p.apps} uygulama{p.apps > 0 && `, ${p.running} çalışıyor`}</span>
                <span>{p.databases} veritabanı</span>
                <span>{timeAgo(p.createdAt)} oluşturuldu</span>
              </div>
            </Link>
          ))}
        </div>
      )}
      <CreateProjectDialog open={creating} onClose={() => setCreating(false)} />
    </>
  );
}

function CreateProjectDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const [form, setForm] = useState({ name: "", description: "" });
  const create = useAction(() => api.post<{ project: { id: number } }>("/projects", form), {
    invalidate: [["projects"]],
    onSuccess: (r) => {
      onClose();
      setForm({ name: "", description: "" });
      navigate(`/projects/${r.project.id}`);
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };
  return (
    <Dialog open={open} onClose={onClose} title="Proje oluştur">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Ad">
          <input className="input" required autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Kişisel blog" />
        </Field>
        <Field label="Açıklama" hint="İsteğe bağlı.">
          <input className="input" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        </Field>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>Vazgeç</Button>
          <Button type="submit" variant="primary" loading={create.isPending}>Oluştur</Button>
        </div>
      </form>
    </Dialog>
  );
}
