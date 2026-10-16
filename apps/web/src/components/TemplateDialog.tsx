import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router";
import { siAdminer, siDirectus, siGhost, siGitea, siGrafana, siListmonk, siMatomo, siMetabase, siN8n, siNextcloud, siUptimekuma, siVaultwarden, siWordpress } from "simple-icons";
import { Button, Dialog, Field, useAction } from "@/components/ui";
import { api, type Server } from "@/lib/api";
import { t } from "@/lib/i18n";

type Template = { id: string; name: string; description: string; category: string; icon?: string; notes?: string; vars: { key: string; label: string; secret: boolean }[] };

// Yalnız kullanılan logolar içe aktarılır (tüm paket arayüzü megabaytlarca büyütürdü).
const ICONS: Record<string, { path: string; hex: string }> = {
  wordpress: siWordpress, ghost: siGhost, n8n: siN8n, uptimekuma: siUptimekuma, vaultwarden: siVaultwarden, gitea: siGitea,
  metabase: siMetabase, nextcloud: siNextcloud, matomo: siMatomo, directus: siDirectus, grafana: siGrafana, adminer: siAdminer, listmonk: siListmonk,
};

/** Siyaha yakın marka renkleri koyu temada görünmez; o zaman yazı rengi kullanılır. */
const dark = (hex: string) => {
  const n = Number.parseInt(hex, 16);
  return ((n >> 16) & 255) * 0.299 + ((n >> 8) & 255) * 0.587 + (n & 255) * 0.114 < 60;
};

function Logo({ icon, name }: { icon?: string; name: string }) {
  const si = icon ? ICONS[icon] : undefined;
  if (!si) return <span className="grid size-9 place-items-center rounded-md bg-surface-2 text-[14px] font-semibold text-muted">{name.slice(0, 1)}</span>;
  return (
    <span className="grid size-9 place-items-center rounded-md bg-surface-2">
      <svg viewBox="0 0 24 24" className="size-5" fill={dark(si.hex) ? "currentColor" : `#${si.hex}`} aria-hidden="true">
        <path d={si.path} />
      </svg>
    </span>
  );
}

/** Tek tıkla kurulan hazır uygulamalar (WordPress, n8n, Nextcloud...). */
export function TemplateDialog({ open, onClose, projectId }: { open: boolean; onClose: () => void; projectId: number }) {
  const navigate = useNavigate();
  const templates = useQuery({ queryKey: ["templates"], queryFn: () => api.get<{ templates: Template[] }>("/templates"), enabled: open });
  const servers = useQuery({ queryKey: ["servers"], queryFn: () => api.get<{ servers: Server[] }>("/servers"), enabled: open });
  const [picked, setPicked] = useState<Template | null>(null);
  const [name, setName] = useState("");
  const [serverId, setServerId] = useState<number | null>(null);
  const ready = servers.data?.servers.filter((s) => s.status === "ready") ?? [];
  const install = useAction(
    () => api.post<{ appId: number }>(`/templates/${picked!.id}/install`, { projectId, serverId: serverId ?? ready[0]?.id, name: name.trim() || undefined }),
    { success: t("Kurulum başladı"), invalidate: [["project", projectId]], onSuccess: (r) => navigate(`/apps/${r.appId}?tab=deployments`) },
  );
  const close = () => {
    setPicked(null);
    setName("");
    onClose();
  };
  const groups = new Map<string, Template[]>();
  for (const tpl of templates.data?.templates ?? []) groups.set(tpl.category, [...(groups.get(tpl.category) ?? []), tpl]);

  return (
    <Dialog open={open} onClose={close} title={picked ? picked.name : t("Hazır uygulama kur")} description={picked ? undefined : t("Şifreler otomatik üretilir, alan adı ve HTTPS hazır gelir; kurulumdan sonra her şeyi değiştirebilirsin.")} wide>
      {!picked ? (
        <div className="max-h-[60vh] space-y-5 overflow-y-auto pr-1">
          {[...groups].map(([cat, list]) => (
            <div key={cat}>
              <h3 className="mb-2 text-[13px] font-medium text-muted">{t(cat)}</h3>
              <div className="grid gap-2 sm:grid-cols-2">
                {list.map((tpl) => (
                  <button key={tpl.id} type="button" onClick={() => setPicked(tpl)} className="panel flex items-start gap-3 p-3 text-left transition-colors hover:border-line-strong">
                    <Logo icon={tpl.icon} name={tpl.name} />
                    <span className="min-w-0">
                      <span className="block font-medium">{tpl.name}</span>
                      <span className="block text-[13px] leading-snug text-muted">{t(tpl.description)}</span>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            install.mutate();
          }}
        >
          <div className="flex items-start gap-3">
            <Logo icon={picked.icon} name={picked.name} />
            <p className="text-[14px] text-muted">{t(picked.description)}</p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t("Ad")}>
              <input className="input" placeholder={picked.name} value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label={t("Sunucu")}>
              <select className="input" value={serverId ?? ready[0]?.id ?? ""} onChange={(e) => setServerId(Number(e.target.value))}>
                {ready.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </Field>
          </div>
          {picked.vars.some((v) => v.secret) && (
            <p className="text-[13px] text-muted">
              {t("Otomatik üretilecek: {list}. Hepsi uygulamanın ortam değişkenleri sekmesinde görünür.", { list: picked.vars.filter((v) => v.secret).map((v) => t(v.label)).join(", ") })}
            </p>
          )}
          {picked.notes && <p className="rounded-md border border-line bg-surface-2/50 p-3 text-[13px]">{t(picked.notes)}</p>}
          <div className="flex justify-between gap-2">
            <Button type="button" variant="ghost" onClick={() => setPicked(null)}>{t("Geri")}</Button>
            <Button type="submit" variant="primary" loading={install.isPending} disabled={!ready.length}>{t("Kur")}</Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
