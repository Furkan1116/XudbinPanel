import { ShieldCheck } from "lucide-react";
import { useState } from "react";
import { Button, useAction } from "@/components/ui";
import { api, type App } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import { t } from "@/lib/i18n";

/** Son imajın Trivy taraması: kritik/yüksek açık sayısı ve en önemlileri. */
export function ImageScan({ app }: { app: App }) {
  const [open, setOpen] = useState(false);
  const scan = useAction(() => api.post(`/apps/${app.id}/scan`), { success: t("Tarama başladı"), invalidate: [["app", app.id]] });
  if (app.sourceType === "compose" || !app.currentImage) return null;
  const { status, at, summary } = app.scan;
  const result = summary && "critical" in summary ? summary : null;

  return (
    <div className="panel px-5 py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <ShieldCheck className="size-4 text-muted" />
          <h3 className="font-medium">{t("İmaj güvenlik taraması")}</h3>
        </div>
        <Button size="sm" variant="ghost" loading={scan.isPending || status === "running"} onClick={() => scan.mutate()}>
          {status === "running" ? t("Taranıyor") : t("Tara")}
        </Button>
      </div>
      <p className="mt-2 text-[13px] text-muted">
        {status === "running" && t("İmaj bilinen açıklara (CVE) karşı taranıyor; ilk taramada açık veritabanı indirildiği için birkaç dakika sürebilir.")}
        {status === "failed" && <span className="text-accent">{t("Tarama başarısız")}: {summary && "error" in summary ? summary.error : ""}</span>}
        {status === "success" && result && (
          <>
            {result.critical || result.high
              ? t("{c} kritik, {h} yüksek seviye açık; {f} tanesi paket güncellemesiyle kapanıyor.", { c: result.critical, h: result.high, f: result.fixable })
              : t("Bilinen kritik veya yüksek seviye açık yok.")}
            {at ? ` ${t("Son tarama {ago}.", { ago: timeAgo(at) })}` : ""}
          </>
        )}
        {!status && t("Bu imaj henüz taranmadı.")}
      </p>
      {result && result.top.length > 0 && (
        <>
          <button type="button" className="mt-2 text-[13px] text-accent hover:underline" onClick={() => setOpen(!open)}>
            {open ? t("Gizle") : t("Açıkları göster")}
          </button>
          {open && (
            <ul className="mt-2 divide-y divide-line rounded-md border border-line text-[13px]">
              {result.top.map((v) => (
                <li key={`${v.id}-${v.pkg}`} className="flex flex-wrap gap-x-3 px-3 py-2">
                  <span className={`font-mono ${v.severity === "CRITICAL" ? "text-accent" : "text-warn"}`}>{v.id}</span>
                  <span className="font-mono">{v.pkg} {v.installed}</span>
                  <span className="text-muted">{v.fixed ? `→ ${v.fixed}` : t("düzeltme yok")}</span>
                  {v.title && <span className="w-full truncate text-faint">{v.title}</span>}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
