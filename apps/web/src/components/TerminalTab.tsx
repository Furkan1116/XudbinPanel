import { useQuery } from "@tanstack/react-query";
import { lazy, Suspense, useState } from "react";
import { Notice } from "@/components/ui";
import { api } from "@/lib/api";
import { useAuthStatus } from "@/lib/auth";
import { t } from "@/lib/i18n";

// xterm.js yalnız bu sekme açılınca indirilir.
const TerminalView = lazy(() => import("@/components/TerminalView"));

type Info = { containers: { name: string; label: string }[]; error?: string; limits?: { idleMinutes: number } };

/**
 * Uygulamanın çalışan konteynerinde kabuk. Yalnız yönetici ve proje geliştiricileri kullanabilir;
 * "sunucu erişimi" açık uygulamada yalnız yönetici (kabuk sunucuda root yetkisi verebilir).
 */
export function TerminalTab({ appId, hostAccess }: { appId: number; hostAccess: boolean }) {
  const demo = import.meta.env.VITE_DEMO === "1";
  const admin = useAuthStatus().data?.user?.role === "admin";
  const locked = hostAccess && !admin;
  const info = useQuery({ queryKey: ["terminal", appId], queryFn: () => api.get<Info>(`/apps/${appId}/terminal`), enabled: !demo && !locked, retry: false });
  const [picked, setPicked] = useState<string | null>(null);

  if (demo) {
    return <Notice tone="info" title={t("Terminal demo modunda kapalı")}>{t("Gerçek kurulumda burada uygulamanın konteynerine bağlanan bir komut satırı açılır.")}</Notice>;
  }
  if (locked) {
    return (
      <Notice tone="warn" title={t("Terminal yalnız yöneticiye açık")}>
        {t("Bu uygulamada sunucu erişimi açık; konteynerdeki kabuk sunucuda root yetkisi verebilir. Terminali yalnız yönetici açabilir.")}
      </Notice>
    );
  }
  if (info.isPending) return <p className="text-[14px] text-muted">{t("Yükleniyor...")}</p>;
  if (info.isError) return <Notice tone="warn" title={t("Terminal açılamıyor")}>{info.error.message}</Notice>;
  const containers = info.data.containers;
  if (!containers.length) {
    return (
      <Notice tone="info" title={t("Çalışan konteyner yok")}>
        {info.data.error ? t(info.data.error) : t("Terminal, uygulamanın çalışan konteynerine bağlanır. Önce uygulamayı deploy et ya da başlat.")}
      </Notice>
    );
  }
  const current = containers.find((c) => c.name === picked) ?? containers[0]!;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-[14px] text-muted">
          {t("Konteynerin içinde komut çalıştırırsın. Yaptığın değişiklikler bir sonraki deploy'da kaybolur (kalıcı klasörler hariç).")}{" "}
          {info.data.limits ? t("{n} dakika girdi gelmezse terminal kapanır.", { n: info.data.limits.idleMinutes }) : ""}
        </p>
        {containers.length > 1 && (
          <select className="input w-auto text-[13px]" aria-label={t("Konteyner")} value={current.name} onChange={(e) => setPicked(e.target.value)}>
            {containers.map((c) => (
              <option key={c.name} value={c.name}>
                {c.label}
              </option>
            ))}
          </select>
        )}
      </div>
      <Suspense fallback={<p className="text-[14px] text-muted">{t("Yükleniyor...")}</p>}>
        <TerminalView key={current.name} appId={appId} container={current.name} />
      </Suspense>
    </div>
  );
}
