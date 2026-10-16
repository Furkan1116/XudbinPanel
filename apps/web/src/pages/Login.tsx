import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { AuthShell, Field, FormError } from "@/components/AuthShell";
import { api, ApiError } from "@/lib/api";
import { useAuthStatus } from "@/lib/auth";
import { t } from "@/lib/i18n";

export function LoginPage() {
  const qc = useQueryClient();
  const [form, setForm] = useState({ email: "", password: "", code: "" });
  const [needsCode, setNeedsCode] = useState(false);
  const sso = useAuthStatus().data?.sso;
  const ssoError = new URLSearchParams(location.search).get("sso_error");
  const login = useMutation({
    mutationFn: () => api.post("/auth/login", needsCode ? form : { email: form.email, password: form.password }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["auth"] }),
    onError: (err) => {
      if (err instanceof ApiError && err.data.needsCode) setNeedsCode(true);
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    login.mutate();
  };

  const showError = login.error && !(needsCode && login.error instanceof ApiError && login.error.data.needsCode && !form.code);

  return (
    <AuthShell title={t("Giriş yap")} subtitle={t("Sunucularını yönetmek için hesabınla giriş yap.")}>
      <form onSubmit={submit} className="space-y-4">
        <Field label={t("E-posta")}>
          <input className="input" type="email" required autoFocus autoComplete="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </Field>
        <Field label={t("Şifre")}>
          <input className="input" type="password" required autoComplete="current-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
        </Field>
        {needsCode && (
          <Field label={t("Doğrulama kodu")} hint={t("Kimlik doğrulama uygulamandaki 6 haneli kod.")}>
            <input
              className="input font-mono tracking-[0.3em]"
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
              maxLength={6}
              required
              value={form.code}
              onChange={(e) => setForm({ ...form, code: e.target.value.replace(/\D/g, "") })}
            />
          </Field>
        )}
        <FormError message={showError ? login.error?.message : (ssoError ?? undefined)} />
        <button className="btn-primary w-full" disabled={login.isPending}>
          {login.isPending ? t("Giriş yapılıyor…") : t("Giriş yap")}
        </button>
      </form>
      {sso && (
        <div className="mt-5 space-y-3">
          <div className="flex items-center gap-3 text-[12px] text-faint">
            <span className="h-px flex-1 bg-line" />
            {t("veya")}
            <span className="h-px flex-1 bg-line" />
          </div>
          <a href="/api/auth/oidc/start" className="btn-ghost flex w-full justify-center border border-line-strong">{t("{label} ile giriş yap", { label: sso.label })}</a>
        </div>
      )}
    </AuthShell>
  );
}
