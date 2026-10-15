import { useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { useState } from "react";
import { Button, Field, Notice, PageLoading, Section, StatusBadge, Toggle, useAction } from "@/components/ui";
import { api } from "@/lib/api";
import { dateTime, formatBytes, timeAgo } from "@/lib/format";
import { t } from "@/lib/i18n";

type S3 = { endpoint: string; region: string; bucket: string; accessKey: string; secretKey: string; prefix: string; hasSecret?: boolean };
type BackupData = {
  s3: S3 | null;
  panelBackup: { enabled: boolean; intervalH: number; keep: number; lastAt: number | null };
  verifyEveryH: number;
  panelBackups: { id: number; file: string; size: number; status: "running" | "success" | "failed"; error: string | null; remote: number; remoteError: string | null; createdAt: number }[];
};

const EMPTY_S3: S3 = { endpoint: "", region: "auto", bucket: "", accessKey: "", secretKey: "", prefix: "xudbin" };

/** Uzak depolama (S3/R2/B2), panelin kendi yedeği ve yedek doğrulama sıklığı. */
export function BackupSettings() {
  const { data } = useQuery({ queryKey: ["settings", "backup"], queryFn: () => api.get<BackupData>("/settings/backup") });
  if (!data) return <PageLoading />;
  return (
    <div className="space-y-8">
      <Offsite data={data} />
      <PanelBackup data={data} />
    </div>
  );
}

function Offsite({ data }: { data: BackupData }) {
  const [on, setOn] = useState(Boolean(data.s3));
  const [s3, setS3] = useState<S3>(data.s3 ?? EMPTY_S3);
  const [verifyH, setVerifyH] = useState(String(data.verifyEveryH));
  const set = (k: keyof S3) => (e: { target: { value: string } }) => setS3({ ...s3, [k]: e.target.value });
  const test = useAction(() => api.post("/settings/backup/test", s3), { success: t("Bağlantı başarılı, yazma izni var") });
  const save = useAction(() => api.put("/settings/backup", { s3: on ? s3 : null, verifyEveryH: Number(verifyH) || 0 }), {
    success: t("Yedekleme ayarları kaydedildi"),
    invalidate: [["settings", "backup"]],
  });
  return (
    <Section
      title={t("Uzak depolama")}
      description={t("Veritabanı ve panel yedekleri S3 uyumlu bir depolamaya da yüklenir (AWS S3, Cloudflare R2, Backblaze B2, MinIO...). Sunucu tamamen giderse yedekler kaybolmaz.")}
      className="!mt-0"
    >
      <div className="panel space-y-4 p-5">
        <Toggle checked={on} onChange={setOn} label={t("Yedekleri uzak depolamaya da yükle")} />
        {on && (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t("Adres (endpoint)")} hint={t("Ör. https://<hesap>.r2.cloudflarestorage.com veya https://s3.eu-central-1.amazonaws.com")}>
                <input className="input font-mono text-[13px]" value={s3.endpoint} onChange={set("endpoint")} placeholder="https://" />
              </Field>
              <Field label={t("Bucket")}>
                <input className="input font-mono text-[13px]" value={s3.bucket} onChange={set("bucket")} />
              </Field>
              <Field label={t("Access key")}>
                <input className="input font-mono text-[13px]" value={s3.accessKey} onChange={set("accessKey")} autoComplete="off" />
              </Field>
              <Field label={t("Secret key")} hint={data.s3?.hasSecret ? t("Kayıtlı. Değiştirmek için yenisini gir.") : undefined}>
                <input className="input font-mono text-[13px]" type="password" value={s3.secretKey} onChange={set("secretKey")} autoComplete="new-password" />
              </Field>
              <Field label={t("Bölge (region)")} hint={t("R2 için auto.")}>
                <input className="input font-mono text-[13px]" value={s3.region} onChange={set("region")} />
              </Field>
              <Field label={t("Klasör (önek)")}>
                <input className="input font-mono text-[13px]" value={s3.prefix} onChange={set("prefix")} />
              </Field>
            </div>
          </>
        )}
        <Field label={t("Yedekleri doğrula")} hint={t("Otomatik yedeklerden biri bu sıklıkla geçici bir veritabanına geri yüklenip denenir. 0: kapalı.")}>
          <div className="flex items-center gap-2 text-[14px]">
            <input className="input w-20" inputMode="numeric" value={verifyH} onChange={(e) => setVerifyH(e.target.value.replace(/\D/g, ""))} />
            <span className="text-muted">{t("saatte bir")}</span>
          </div>
        </Field>
        <div className="flex justify-end gap-2">
          {on && <Button onClick={() => test.mutate()} loading={test.isPending}>{t("Bağlantıyı dene")}</Button>}
          <Button variant="primary" onClick={() => save.mutate()} loading={save.isPending}>{t("Kaydet")}</Button>
        </div>
      </div>
    </Section>
  );
}

function PanelBackup({ data }: { data: BackupData }) {
  const [pass, setPass] = useState("");
  const [intervalH, setIntervalH] = useState(String(data.panelBackup.intervalH));
  const [keep, setKeep] = useState(String(data.panelBackup.keep));
  const save = useAction(
    () => api.put("/settings/backup", { ...(pass ? { passphrase: pass } : {}), intervalH: Number(intervalH) || 0, keep: Number(keep) || 7 }),
    { success: t("Panel yedeği ayarları kaydedildi"), invalidate: [["settings", "backup"]], onSuccess: () => setPass("") },
  );
  const now = useAction(() => api.post("/settings/backup/panel"), { success: t("Panel yedeği alındı"), invalidate: [["settings", "backup"]] });
  return (
    <Section
      title={t("Panel yedeği")}
      description={t("Panelin kendi verisi: sunucular, uygulamalar, ortam değişkenleri, kullanıcılar ve şifreleme anahtarı. Şifreyle korunur; sunucu giderse yeni bir kurulumda xudbin restore ile geri yüklenir.")}
    >
      <div className="panel space-y-4 p-5">
        {!data.panelBackup.enabled && <Notice tone="warn" title={t("Panel yedeği kapalı. Açmak için bir yedek şifresi belirle.")} />}
        <Field
          label={data.panelBackup.enabled ? t("Yedek şifresini değiştir") : t("Yedek şifresi")}
          hint={t("En az 12 karakter. Geri yüklerken sorulur; kaybedersen yedek açılamaz, bir yere not et. Değiştirmek eski yedekleri etkilemez.")}
        >
          <input className="input" type="password" value={pass} onChange={(e) => setPass(e.target.value)} autoComplete="new-password" />
        </Field>
        <div className="flex flex-wrap items-center gap-2 text-[14px]">
          <input className="input w-20" inputMode="numeric" value={intervalH} onChange={(e) => setIntervalH(e.target.value.replace(/\D/g, ""))} />
          <span className="text-muted">{t("saatte bir, son")}</span>
          <input className="input w-20" inputMode="numeric" value={keep} onChange={(e) => setKeep(e.target.value.replace(/\D/g, ""))} />
          <span className="text-muted">{t("yedek saklansın")}</span>
        </div>
        <p className="text-[13px] text-muted">
          {data.panelBackup.lastAt ? t("Son panel yedeği {ago} alındı.", { ago: timeAgo(data.panelBackup.lastAt) }) : t("Henüz panel yedeği alınmadı.")}
        </p>
        <div className="flex justify-end gap-2">
          {data.panelBackup.enabled && <Button onClick={() => now.mutate()} loading={now.isPending}>{t("Şimdi yedekle")}</Button>}
          <Button variant="primary" onClick={() => save.mutate()} loading={save.isPending}>{t("Kaydet")}</Button>
        </div>
      </div>

      {data.panelBackups.length > 0 && (
        <div className="panel mt-4 divide-y divide-line">
          {data.panelBackups.map((b) => (
            <div key={b.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3">
              <div className="min-w-0 flex-1">
                <div className="truncate font-mono text-[13px]">{b.file}</div>
                <div className="text-[13px] text-faint">
                  {dateTime(b.createdAt)}
                  {b.status === "success" ? `, ${formatBytes(b.size)}` : ""}
                  {b.remote ? `, ${t("uzak depolamada")} ✓` : ""}
                </div>
                {(b.error || b.remoteError) && <div className="text-[13px] text-accent">{b.error ?? b.remoteError}</div>}
              </div>
              <StatusBadge status={b.status} />
              {b.status === "success" && (
                <a href={`/api/settings/backup/panel/${b.id}/download`} className="inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[13px] text-muted hover:bg-surface-2 hover:text-fg">
                  <Download className="size-4" /> {t("İndir")}
                </a>
              )}
            </div>
          ))}
        </div>
      )}
      <p className="mt-3 text-[13px] text-faint">
        {t("Geri yükleme (yeni sunucuda Xudbin kurduktan sonra):")} <code className="font-mono">sudo xudbin restore /root/xudbin-panel-....xbk</code>
      </p>
    </Section>
  );
}
