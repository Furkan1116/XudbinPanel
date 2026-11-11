import { useQuery } from "@tanstack/react-query";
import { Container } from "lucide-react";
import { useEffect, useState } from "react";
import { Button, ConfirmDialog, Dialog, Field, Notice, Section, useAction } from "@/components/ui";
import { api } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import { t } from "@/lib/i18n";

export type Registry = { id: number; name: string; host: string; username: string; createdAt: number; verifiedAt: number | null };

const HOSTS = [
  { host: "ghcr.io", hint: "GitHub: read:packages izni olan bir token" },
  { host: "docker.io", hint: "Docker Hub: salt okunur erişim token'ı" },
  { host: "registry.gitlab.com", hint: "GitLab: read_registry izni olan deploy token" },
];

/** Özel imaj kayıt depoları için yönetici girişleri. Panel imaj çekerken ve derlerken bunları kendisi kullanır. */
export function RegistrySettings() {
  const { data } = useQuery({ queryKey: ["settings", "registries"], queryFn: () => api.get<{ registries: Registry[] }>("/settings/registries") });
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Registry | null>(null);
  const [removing, setRemoving] = useState<Registry | null>(null);
  const test = useAction((id: number) => api.post(`/settings/registries/${id}/test`), { success: t("Giriş doğrulandı"), invalidate: [["settings", "registries"]] });
  const remove = useAction((id: number) => api.del(`/settings/registries/${id}`), {
    success: t("Giriş silindi"),
    invalidate: [["settings", "registries"]],
    onSuccess: () => setRemoving(null),
  });
  if (!data) return null;
  return (
    <Section
      title={t("İmaj kayıt depoları")}
      description={t("Özel Docker imajlarını (GHCR, Docker Hub, GitLab, kendi registry'n) çekebilmek için giriş ekle. Panel bir imajı çekerken, temel imajı özel olan bir projeyi derlerken ve Compose deploy'larında imajın adresine göre girişi kendisi kullanır.")}
      actions={<Button variant="primary" size="sm" onClick={() => setAdding(true)}>{t("Giriş ekle")}</Button>}
    >
      <Notice tone="info" title={t("Üyeler de bu girişlerle imaj çekebilir")}>
        {t("Uygulama deploy edebilen herkes, burada girişi olan bir depodaki (token'ın erişebildiği) her imajı deploy edebilir. Şifre ve token kimseye gösterilmez. Yalnız gereken repolara okuma izni olan bir token kullan.")}
      </Notice>
      {data.registries.length === 0 ? (
        <div className="panel mt-3 p-5 text-sm text-muted">{t("Henüz giriş yok. Herkese açık imajlar girişsiz çekilir.")}</div>
      ) : (
        <div className="panel mt-3 divide-y divide-line">
          {data.registries.map((r) => (
            <div key={r.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
              <Container className="size-5 shrink-0 text-faint" aria-hidden />
              <div className="min-w-0 flex-1">
                <div className="font-medium">
                  {r.name} <span className="font-mono text-[13px] text-muted">{r.host}</span>
                </div>
                <div className="text-[13px] text-faint">
                  {t("Kullanıcı: {user}", { user: r.username })} ·{" "}
                  {r.verifiedAt ? t("{ago} doğrulandı", { ago: timeAgo(r.verifiedAt) }) : <span className="text-warn">{t("Doğrulanmadı")}</span>}
                </div>
              </div>
              <div className="flex gap-1">
                <Button size="sm" variant="ghost" loading={test.isPending && test.variables === r.id} onClick={() => test.mutate(r.id)}>{t("Dene")}</Button>
                <Button size="sm" variant="ghost" onClick={() => setEditing(r)}>{t("Düzenle")}</Button>
                <Button size="sm" variant="ghost" onClick={() => setRemoving(r)}>{t("Sil")}</Button>
              </div>
            </div>
          ))}
        </div>
      )}
      <RegistryDialog open={adding} onClose={() => setAdding(false)} />
      <RegistryDialog open={Boolean(editing)} editing={editing} onClose={() => setEditing(null)} />
      <ConfirmDialog
        open={Boolean(removing)}
        onClose={() => setRemoving(null)}
        title={t("Giriş silinsin mi?")}
        description={t("{host} deposundaki özel imajlar artık çekilemez; çalışan uygulamalar etkilenmez, sonraki deploy'ları başarısız olur.", { host: removing?.host ?? "" })}
        confirmLabel={t("Sil")}
        loading={remove.isPending}
        onConfirm={() => removing && remove.mutate(removing.id)}
      />
    </Section>
  );
}

function RegistryDialog({ open, onClose, editing }: { open: boolean; onClose: () => void; editing?: Registry | null }) {
  const empty = { name: "", host: "", username: "", password: "", verify: true };
  const [form, setForm] = useState(empty);
  useEffect(() => {
    if (open) setForm(editing ? { ...empty, name: editing.name, host: editing.host, username: editing.username } : empty);
  }, [open, editing]);
  const close = () => {
    setForm(empty);
    onClose();
  };
  const test = useAction(() => api.post("/settings/registries/test", { host: form.host, username: form.username, password: form.password }), { success: t("Giriş doğrulandı") });
  const save = useAction(
    () =>
      editing
        ? api.patch(`/settings/registries/${editing.id}`, { name: form.name, username: form.username, password: form.password, verify: form.verify })
        : api.post("/settings/registries", form),
    { success: editing ? t("Giriş güncellendi") : t("Giriş eklendi"), invalidate: [["settings", "registries"]], onSuccess: close },
  );
  const hint = HOSTS.find((h) => h.host === form.host.trim().toLowerCase())?.hint;
  return (
    <Dialog open={open} onClose={close} title={editing ? t("Girişi düzenle") : t("Kayıt deposu girişi ekle")} description={t("Şifre veya token şifrelenerek saklanır ve bir daha gösterilmez.")}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
        className="space-y-4"
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t("Kayıt deposu")} hint={editing ? t("Adres değiştirilemez; başka bir depo için yeni giriş ekle.") : t("Ör. ghcr.io, docker.io, registry.gitlab.com, registry.ornek.com:5000")}>
            <input className="input font-mono text-[13px]" required disabled={Boolean(editing)} list="xudbin-registry-hosts" value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value.trim() })} placeholder="ghcr.io" />
          </Field>
          <Field label={t("Ad")}>
            <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={form.host || "GHCR"} />
          </Field>
          <Field label={t("Kullanıcı adı")}>
            <input className="input" required autoComplete="off" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value.trim() })} />
          </Field>
          <Field label={t("Şifre veya token")} hint={editing ? t("Boş bırakırsan mevcut değer kalır.") : hint ? t(hint) : undefined}>
            <input className="input font-mono text-[13px]" type="password" required={!editing} autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
          </Field>
        </div>
        <datalist id="xudbin-registry-hosts">
          {HOSTS.map((h) => (
            <option key={h.host} value={h.host} />
          ))}
        </datalist>
        <label className="flex items-start gap-2 text-[14px]">
          <input type="checkbox" className="mt-0.5 size-4 accent-[var(--accent)]" checked={form.verify} onChange={(e) => setForm({ ...form, verify: e.target.checked })} />
          <span>
            {t("Kaydetmeden önce doğrula")}
            <span className="block text-[13px] text-muted">{t("Panelin sunucusundan depoya giriş denenir. Depoya yalnız uzak sunuculardan ulaşılabiliyorsa kapat.")}</span>
          </span>
        </label>
        <div className="flex flex-wrap justify-between gap-2 pt-1">
          {!editing ? (
            <Button type="button" variant="ghost" onClick={() => test.mutate()} loading={test.isPending} disabled={!form.host || !form.username || !form.password}>{t("Dene")}</Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button type="button" variant="ghost" onClick={close}>{t("Vazgeç")}</Button>
            <Button type="submit" variant="primary" loading={save.isPending}>{editing ? t("Kaydet") : t("Ekle")}</Button>
          </div>
        </div>
      </form>
    </Dialog>
  );
}
