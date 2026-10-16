import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Button, CopyField, Field, Notice, Section, Toggle, useAction } from "@/components/ui";
import { api } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import { t } from "@/lib/i18n";

type Token = { id: number; name: string; prefix: string; readOnly: number; lastUsedAt: number | null; expiresAt: number | null; createdAt: number };

/** CI/CD ve CLI için API anahtarları; anahtar yalnız oluşturulduğu an bir kez gösterilir. */
export function ApiTokens() {
  const { data } = useQuery({ queryKey: ["account", "tokens"], queryFn: () => api.get<{ tokens: Token[] }>("/settings/account/tokens") });
  const [form, setForm] = useState({ name: "", readOnly: false, expires: "90" });
  const [created, setCreated] = useState<string | null>(null);
  const create = useAction(
    () => api.post<{ token: string }>("/settings/account/tokens", { name: form.name, readOnly: form.readOnly, expiresInDays: Number(form.expires) || null }),
    { invalidate: [["account", "tokens"]], onSuccess: (r) => (setCreated(r.token), setForm({ name: "", readOnly: false, expires: "90" })) },
  );
  const revoke = useAction((id: number) => api.del(`/settings/account/tokens/${id}`), { success: t("Anahtar silindi"), invalidate: [["account", "tokens"]] });
  const origin = location.origin;

  return (
    <Section title={t("API anahtarları")} description={t("GitHub Actions gibi CI/CD araçlarından veya komut satırından (xb) paneli kullanmak için. Anahtar senin yetkilerinle çalışır.")}>
      {created && (
        <div className="mb-4 space-y-2">
          <Notice tone="warn" title={t("Anahtarı şimdi kopyala; bir daha gösterilmeyecek.")} />
          <CopyField value={created} />
          <p className="text-[13px] text-muted">{t("Örnek: bir uygulamayı deploy et")}</p>
          <CopyField value={`curl -X POST -H "Authorization: Bearer ${created}" -H "Content-Type: application/json" -d '{}' ${origin}/api/apps/<uygulama-no>/deploy`} />
        </div>
      )}
      <form
        className="panel grid gap-4 p-5 sm:grid-cols-[1fr_9rem_auto] sm:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <Field label={t("Ad")}>
          <input className="input" required placeholder={t("ör. GitHub Actions")} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <Field label={t("Geçerlilik")}>
          <select className="input" value={form.expires} onChange={(e) => setForm({ ...form, expires: e.target.value })}>
            <option value="30">{t("30 gün")}</option>
            <option value="90">{t("90 gün")}</option>
            <option value="365">{t("1 yıl")}</option>
            <option value="">{t("Süresiz")}</option>
          </select>
        </Field>
        <Button type="submit" loading={create.isPending}>{t("Oluştur")}</Button>
        <div className="sm:col-span-3">
          <Toggle checked={form.readOnly} onChange={(v) => setForm({ ...form, readOnly: v })} label={t("Salt okunur")} description={t("Yalnız bilgi okuyabilir; deploy başlatamaz, hiçbir şeyi değiştiremez.")} />
        </div>
      </form>
      {data && data.tokens.length > 0 && (
        <div className="panel mt-4 divide-y divide-line">
          {data.tokens.map((tk) => (
            <div key={tk.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
              <div className="min-w-0">
                <div className="font-medium">
                  {tk.name} {tk.readOnly ? <span className="ml-1 text-[12px] text-muted">{t("salt okunur")}</span> : null}
                </div>
                <div className="text-[13px] text-muted">
                  <code className="font-mono">{tk.prefix}…</code> · {tk.lastUsedAt ? t("son kullanım {ago}", { ago: timeAgo(tk.lastUsedAt) }) : t("hiç kullanılmadı")}
                  {tk.expiresAt ? ` · ${tk.expiresAt < Date.now() ? t("süresi doldu") : t("{d} bitiyor", { d: new Date(tk.expiresAt).toLocaleDateString() })}` : ""}
                </div>
              </div>
              <Button size="sm" variant="ghost" onClick={() => revoke.mutate(tk.id)}>{t("Sil")}</Button>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}
