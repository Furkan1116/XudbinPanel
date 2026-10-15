import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { AuthShell, Field, FormError } from "@/components/AuthShell";
import { api } from "@/lib/api";
import { t } from "@/lib/i18n";

/** Geçici şifreyle giriş yapan kullanıcı panele girmeden önce kendi şifresini belirler. */
export function ChangePasswordPage() {
  const qc = useQueryClient();
  const [form, setForm] = useState({ current: "", next: "", repeat: "" });
  const [error, setError] = useState<string>();
  const save = useMutation({
    mutationFn: () => api.put("/settings/account/password", { current: form.current, next: form.next }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["auth"] }),
    onError: (e) => setError(e.message),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (form.next !== form.repeat) return setError(t("Yeni şifreler aynı değil"));
    setError(undefined);
    save.mutate();
  };
  return (
    <AuthShell title={t("Şifreni belirle")} subtitle={t("Geçici bir şifreyle giriş yaptın. Devam etmeden önce yalnız senin bildiğin bir şifre belirle.")}>
      <form onSubmit={submit} className="space-y-4">
        <Field label={t("Geçici şifre")}>
          <input className="input" type="password" required autoFocus autoComplete="current-password" value={form.current} onChange={(e) => setForm({ ...form, current: e.target.value })} />
        </Field>
        <Field label={t("Yeni şifre")} hint={t("En az 10 karakter.")}>
          <input className="input" type="password" required minLength={10} autoComplete="new-password" value={form.next} onChange={(e) => setForm({ ...form, next: e.target.value })} />
        </Field>
        <Field label={t("Yeni şifre (tekrar)")}>
          <input className="input" type="password" required minLength={10} autoComplete="new-password" value={form.repeat} onChange={(e) => setForm({ ...form, repeat: e.target.value })} />
        </Field>
        <FormError message={error} />
        <button className="btn-primary w-full" disabled={save.isPending}>{save.isPending ? t("Kaydediliyor…") : t("Şifreyi kaydet")}</button>
      </form>
    </AuthShell>
  );
}
