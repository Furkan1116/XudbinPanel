import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, ShieldAlert } from "lucide-react";
import { Link } from "react-router";
import { Button, PageLoading, Section, Toggle, useAction } from "@/components/ui";
import { api } from "@/lib/api";
import { useAuthStatus } from "@/lib/auth";
import { timeAgo } from "@/lib/format";
import { t } from "@/lib/i18n";

type Check = {
  id: string;
  scope: "panel" | "server" | "app";
  target: { id: number; name: string } | null;
  title: string;
  ok: boolean;
  severity: "high" | "medium" | "low";
  detail: string;
  fix?: { action: string; label: string };
  link?: string;
};
type Score = { score: number; grade: string; checks: Check[]; checkedAt: number; imageScanEnabled: boolean };

const SEVERITY = { high: "Yüksek", medium: "Orta", low: "Düşük" } as const;
const ORDER = { high: 0, medium: 1, low: 2 } as const;
const SCOPES = [
  { id: "panel", label: "Panel ve yedekler" },
  { id: "server", label: "Sunucular" },
  { id: "app", label: "Uygulamalar" },
] as const;

/** Panel, sunucu ve uygulamaların güvenlik puanı; eksikler için tek tıkla düzeltme. */
export function SecurityScore() {
  const admin = useAuthStatus().data?.user?.role === "admin";
  const score = useQuery({ queryKey: ["security", "score"], queryFn: () => api.get<Score>("/security/score") });
  const refresh = useAction(() => api.get<Score>("/security/score?refresh=1"), { invalidate: [["security", "score"]] });
  const fix = useAction((action: string) => api.post<{ background: boolean }>("/security/score/fix", { action }), {
    success: (r) => (r.background ? t("Başladı; ilerlemesi sunucu sayfasında görünür") : t("Düzeltildi")),
    invalidate: [["security", "score"]],
  });
  const scanSetting = useAction((enabled: boolean) => api.put("/security/image-scan", { enabled }), { invalidate: [["security", "score"]] });
  if (!score.data) return <PageLoading />;
  const { checks } = score.data;
  const failed = checks.filter((c) => !c.ok);
  const tone = score.data.score >= 75 ? "text-ok" : score.data.score >= 50 ? "text-warn" : "text-accent";

  return (
    <div className="space-y-9">
      <section className="panel flex flex-wrap items-center gap-6 px-5 py-5">
        <div className={`text-5xl font-semibold tabular-nums ${tone}`}>{score.data.score}</div>
        <div className="min-w-0 flex-1">
          <div className="font-medium">{t("Güvenlik puanı")} · {score.data.grade}</div>
          <p className="mt-0.5 text-[13px] text-muted">
            {failed.length ? t("{n} kontrol başarısız, {m} kontrol geçti.", { n: failed.length, m: checks.length - failed.length }) : t("Tüm kontroller geçti.")}{" "}
            {t("Son kontrol {ago}.", { ago: timeAgo(score.data.checkedAt) })}
          </p>
        </div>
        <Button onClick={() => refresh.mutate()} loading={refresh.isPending}>{t("Yeniden denetle")}</Button>
      </section>

      {SCOPES.map((scope) => {
        const rows = checks.filter((c) => c.scope === scope.id).sort((a, b) => Number(a.ok) - Number(b.ok) || ORDER[a.severity] - ORDER[b.severity]);
        if (!rows.length) return null;
        return (
          <Section key={scope.id} title={t(scope.label)} className="!mt-0">
            <div className="panel divide-y divide-line">
              {rows.map((c) => (
                <div key={c.id} className="flex flex-wrap items-start gap-x-4 gap-y-2 px-5 py-3">
                  {c.ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-ok" /> : <ShieldAlert className={`mt-0.5 size-4 shrink-0 ${c.severity === "high" ? "text-accent" : "text-warn"}`} />}
                  <div className="min-w-0 flex-1">
                    <div className="text-[14px]">
                      {t(c.title)}
                      {c.target && <span className="text-muted"> · {c.target.name}</span>}
                      {!c.ok && <span className="ml-2 text-[12px] text-faint">{t(SEVERITY[c.severity])}</span>}
                    </div>
                    {!c.ok && <p className="mt-0.5 text-[13px] leading-relaxed text-muted">{c.detail}</p>}
                  </div>
                  {!c.ok && (
                    <div className="flex gap-1">
                      {c.fix && admin && (
                        <Button size="sm" variant="primary" loading={fix.isPending && fix.variables === c.fix.action} onClick={() => fix.mutate(c.fix!.action)}>
                          {c.fix.label}
                        </Button>
                      )}
                      {c.link && (
                        <Link to={c.link} className="inline-flex h-8 items-center rounded-md px-2.5 text-[13px] text-muted hover:bg-surface-2 hover:text-fg">
                          {t("Git")}
                        </Link>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </Section>
        );
      })}

      {admin && (
        <div className="panel p-5">
          <Toggle
            checked={score.data.imageScanEnabled}
            onChange={(v) => scanSetting.mutate(v)}
            label={t("Deploy sonrası imaj taraması")}
            description={t("Her başarılı deploy'dan sonra imaj, bilinen güvenlik açıklarına (CVE) karşı Trivy ile taranır. Tarama sırasında yaklaşık 1 GB bellek kullanır.")}
          />
        </div>
      )}
    </div>
  );
}
