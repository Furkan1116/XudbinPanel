import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useSearchParams } from "react-router";
import { siGithub } from "simple-icons";
import { Button, ConfirmDialog, Field, Notice, Section, useAction } from "@/components/ui";
import { api } from "@/lib/api";
import { t } from "@/lib/i18n";

type GithubInfo = {
  app: { id: number; slug: string; name: string; htmlUrl: string; owner: string; installUrl: string } | null;
  installations: { id: number; account: string; type: string; settingsUrl: string }[];
};

function GithubIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-5 shrink-0" fill="currentColor" aria-hidden>
      <path d={siGithub.path} />
    </svg>
  );
}

/** GitHub App: manifest akışıyla tek tıkla oluşturma, kurulumlar, bağlantıyı kaldırma. */
export function GithubSettings() {
  const [params] = useSearchParams();
  const { data } = useQuery({ queryKey: ["settings", "github"], queryFn: () => api.get<GithubInfo>("/settings/github") });
  const [org, setOrg] = useState("");
  const [confirm, setConfirm] = useState(false);
  const create = useAction(() => api.post<{ action: string; manifest: string }>("/settings/github/manifest", { org }), {
    onSuccess: (r) => {
      // GitHub manifest'i form POST'u olarak bekler.
      const form = document.createElement("form");
      form.method = "post";
      form.action = r.action;
      const input = document.createElement("input");
      input.type = "hidden";
      input.name = "manifest";
      input.value = r.manifest;
      form.appendChild(input);
      document.body.appendChild(form);
      form.submit();
    },
  });
  const remove = useAction(() => api.del("/settings/github"), { success: t("GitHub bağlantısı kaldırıldı"), invalidate: [["settings", "github"], ["github-repos"]], onSuccess: () => setConfirm(false) });
  if (!data) return null;
  const error = params.get("error");
  return (
    <Section
      title="GitHub"
      description={t("Panel için bir GitHub App oluştur: özel repolar token girmeden deploy edilir, repolar listeden seçilir, push ve PR olayları webhook kurmadan gelir, önizleme adresleri PR'a yorum olarak yazılır.")}
    >
      {error && <Notice tone="danger" title={t("GitHub App oluşturulamadı")}>{error}</Notice>}
      {params.get("created") && data.app && !data.installations.length && (
        <Notice tone="info" title={t("GitHub App oluşturuldu")}>{t("Şimdi \"Repolara erişim ver\" ile hangi repolara erişebileceğini seç.")}</Notice>
      )}
      {!data.app ? (
        <div className="panel space-y-4 p-5">
          <Field label={t("Organizasyon (isteğe bağlı)")} hint={t("Boş bırakırsan App kişisel hesabında oluşturulur. Organizasyonda oluşturmak için orada yönetici olmalısın.")}>
            <input className="input" placeholder="sirketim" value={org} onChange={(e) => setOrg(e.target.value)} />
          </Field>
          <p className="text-[13px] text-muted">
            {t("İzinler: kod okuma (contents: read), PR yorumu (pull_requests: write). Olaylar: push, pull_request. Panele https:// ile, internetten erişilebilir bir adresle girmiş olmalısın.")}
          </p>
          <ul className="list-disc space-y-1 pl-5 text-[13px] text-muted">
            <li>{t("Önce bu tarayıcıda GitHub'a giriş yap (organizasyonda SSO varsa onu da onayla).")}</li>
            <li>{t("GitHub'da açılan sayfada yalnız \"Create GitHub App\" düğmesine bas; ayarlar hazır gelir.")}</li>
            <li>
              {t("Daha önce denediysen yarım kalan App'ler olabilir:")}{" "}
              <a className="underline hover:text-fg" href={org ? `https://github.com/organizations/${org}/settings/apps` : "https://github.com/settings/apps"} target="_blank" rel="noreferrer">
                {t("GitHub'daki App'lerini gör")}
              </a>
            </li>
          </ul>
          <div className="flex justify-end">
            <Button variant="primary" loading={create.isPending} onClick={() => create.mutate()}>
              <GithubIcon /> {t("GitHub App oluştur")}
            </Button>
          </div>
        </div>
      ) : (
        <div className="panel divide-y divide-line">
          <div className="flex flex-wrap items-center gap-3 p-5">
            <GithubIcon />
            <div className="min-w-0 flex-1">
              <a href={data.app.htmlUrl} target="_blank" rel="noreferrer" className="font-medium hover:underline">{data.app.name}</a>
              <div className="text-[13px] text-muted">{t("Sahibi: {owner}", { owner: data.app.owner })}</div>
            </div>
            <a className="btn-primary" href={data.app.installUrl} target="_blank" rel="noreferrer">{t("Repolara erişim ver")}</a>
            <Button variant="ghost" onClick={() => setConfirm(true)}>{t("Bağlantıyı kaldır")}</Button>
          </div>
          {data.installations.length ? (
            data.installations.map((i) => (
              <div key={i.id} className="flex items-center justify-between gap-3 px-5 py-3 text-sm">
                <span>
                  {i.account} <span className="text-muted">· {i.type === "Organization" ? t("Organizasyon") : t("Kişisel")}</span>
                </span>
                <a href={i.settingsUrl} target="_blank" rel="noreferrer" className="text-[13px] text-muted hover:text-fg">{t("Repoları düzenle")}</a>
              </div>
            ))
          ) : (
            <div className="px-5 py-3 text-sm text-muted">{t("Henüz hiçbir hesaba kurulmadı.")}</div>
          )}
        </div>
      )}
      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title={t("GitHub bağlantısı kaldırılsın mı?")}
        description={t("Panel App'in anahtarlarını siler; token'ı olmayan özel repolar artık klonlanamaz. App GitHub'da kalır; tamamen silmek için GitHub'daki App ayarlarından sil.")}
        confirmLabel={t("Kaldır")}
        loading={remove.isPending}
        onConfirm={() => remove.mutate()}
      />
    </Section>
  );
}
