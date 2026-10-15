import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { AuthShell, Field, FormError } from "@/components/AuthShell";
import { api } from "@/lib/api";
import { t } from "@/lib/i18n";

export function SetupPage() {
  const qc = useQueryClient();
  // install.sh kurulum linkini ?setup=<anahtar> ile verir.
  const [form, setForm] = useState(() => ({
    name: "",
    email: "",
    password: "",
    setupToken: new URLSearchParams(location.search).get("setup") ?? "",
  }));
  const setup = useMutation({
    mutationFn: () => api.post("/auth/setup", form),
    onSuccess: () => {
      history.replaceState(null, "", "/");
      qc.invalidateQueries({ queryKey: ["auth"] });
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setup.mutate();
  };

  return (
    <AuthShell
      title={t("Yönetici hesabını oluştur")}
      subtitle={t("Bu hesap sunucunun tamamını yönetir. Başkasının tahmin edemeyeceği bir şifre seç.")}
    >
      <form onSubmit={submit} className="space-y-4">
        <Field label={t("Adın")}>
          <input className="input" autoFocus required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <Field label={t("E-posta")}>
          <input className="input" type="email" required autoComplete="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </Field>
        <Field label={t("Şifre")} hint={t("En az 10 karakter.")}>
          <input className="input" type="password" required minLength={10} autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
        </Field>
        <Field label={t("Kurulum anahtarı")} hint={<>{t("Kurulum bitince ekrana yazılır. Kaçırdıysan sunucuda")} <code className="font-mono text-muted">{t("docker compose exec xudbin cat /data/setup-token")}</code> {t("ile görebilirsin.")}</>}>
          <input className="input font-mono" required value={form.setupToken} onChange={(e) => setForm({ ...form, setupToken: e.target.value.trim() })} />
        </Field>
        <FormError message={setup.error?.message} />
        <button className="btn-primary w-full" disabled={setup.isPending}>
          {setup.isPending ? t("Oluşturuluyor…") : t("Hesabı oluştur")}
        </button>
      </form>
    </AuthShell>
  );
}
