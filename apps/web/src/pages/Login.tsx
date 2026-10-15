import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { AuthShell, Field, FormError } from "@/components/AuthShell";
import { api } from "@/lib/api";

export function LoginPage() {
  const qc = useQueryClient();
  const [form, setForm] = useState({ email: "", password: "" });
  const login = useMutation({
    mutationFn: () => api.post("/auth/login", form),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["auth"] }),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    login.mutate();
  };

  return (
    <AuthShell title="Giriş yap" subtitle="Sunucunu yönetmek için hesabınla giriş yap.">
      <form onSubmit={submit} className="space-y-4">
        <Field label="E-posta">
          <input className="input" type="email" required autoFocus autoComplete="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </Field>
        <Field label="Şifre">
          <input className="input" type="password" required autoComplete="current-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
        </Field>
        <FormError message={login.error?.message} />
        <button className="btn-primary w-full" disabled={login.isPending}>
          {login.isPending ? "Giriş yapılıyor…" : "Giriş yap"}
        </button>
      </form>
    </AuthShell>
  );
}
