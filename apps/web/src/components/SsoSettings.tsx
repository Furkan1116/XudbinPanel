import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Button, CopyField, Field, Section, Toggle, useAction } from "@/components/ui";
import { api } from "@/lib/api";
import { t } from "@/lib/i18n";

type Sso = { issuer: string; clientId: string; clientSecret: string; label: string; autoCreate: boolean; allowedDomains: string; hasSecret?: boolean };

/** OpenID Connect ile tek oturum açma (Google, Microsoft, Keycloak, Authentik...). */
export function SsoSettings() {
  const { data } = useQuery({ queryKey: ["settings", "sso"], queryFn: () => api.get<{ sso: Sso | null; redirectUri: string }>("/settings/sso") });
  const [form, setForm] = useState<Sso | null>(null);
  const f = form ?? data?.sso ?? { issuer: "", clientId: "", clientSecret: "", label: "", autoCreate: false, allowedDomains: "" };
  const set = (k: keyof Sso) => (e: { target: { value: string } }) => setForm({ ...f, [k]: e.target.value });
  const save = useAction(() => api.put("/settings/sso", f), { success: t("SSO ayarları kaydedildi"), invalidate: [["settings", "sso"], ["auth"]], onSuccess: () => setForm(null) });
  const off = useAction(() => api.del("/settings/sso"), { success: t("SSO kapatıldı"), invalidate: [["settings", "sso"], ["auth"]], onSuccess: () => setForm(null) });
  if (!data) return null;
  return (
    <Section title={t("Tek oturum açma (SSO)")} description={t("Google Workspace, Microsoft Entra, Keycloak, Authentik, GitLab gibi bir OpenID Connect sağlayıcısıyla giriş. İki adımlı doğrulama sağlayıcıda yapılır.")}>
      <form
        className="panel space-y-4 p-5"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <Field label={t("Yönlendirme adresi (sağlayıcıya gir)")}>
          <CopyField value={data.redirectUri} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t("Sağlayıcı adresi (issuer)")} hint={t("Ör. https://accounts.google.com")}>
            <input className="input font-mono text-[13px]" required value={f.issuer} onChange={set("issuer")} />
          </Field>
          <Field label={t("Düğme yazısı")}>
            <input className="input" placeholder="Google" value={f.label} onChange={set("label")} />
          </Field>
          <Field label="Client ID">
            <input className="input font-mono text-[13px]" required value={f.clientId} onChange={set("clientId")} />
          </Field>
          <Field label="Client secret" hint={data.sso?.hasSecret ? t("Kayıtlı. Değiştirmek için yenisini gir.") : undefined}>
            <input className="input font-mono text-[13px]" type="password" autoComplete="new-password" value={f.clientSecret} onChange={set("clientSecret")} />
          </Field>
        </div>
        <Toggle checked={f.autoCreate} onChange={(v) => setForm({ ...f, autoCreate: v })} label={t("Yeni kullanıcıları otomatik oluştur")} description={t("Kapalıysa yalnız panelde zaten kayıtlı e-postalar SSO ile girebilir. Açıksa aşağıdaki alan adlarından gelenler üye olarak oluşturulur (projelere sen eklersin).")} />
        {f.autoCreate && (
          <Field label={t("İzin verilen e-posta alan adları")} hint={t("Virgülle ayır, ör. sirketim.com")}>
            <input className="input" value={f.allowedDomains} onChange={set("allowedDomains")} />
          </Field>
        )}
        <div className="flex justify-end gap-2">
          {data.sso && <Button type="button" variant="ghost" onClick={() => off.mutate()}>{t("SSO'yu kapat")}</Button>}
          <Button type="submit" variant="primary" loading={save.isPending}>{t("Kaydet")}</Button>
        </div>
      </form>
    </Section>
  );
}
