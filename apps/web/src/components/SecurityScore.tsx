import { type UseMutationResult, useQuery } from "@tanstack/react-query";
import { CheckCircle2, ChevronDown, ChevronRight, Search, ShieldAlert } from "lucide-react";
import { useMemo, useState } from "react";
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
        const rows = checks.filter((c) => c.scope === scope.id);
        if (!rows.length) return null;
        if (scope.id === "app") return <AppChecks key={scope.id} checks={rows} admin={admin} fix={fix} />;
        return (
          <Section key={scope.id} title={t(scope.label)} className="!mt-0">
            <div className="panel divide-y divide-line">
              {sortChecks(rows).map((c) => (
                <CheckRow key={c.id} c={c} admin={admin} fix={fix} showTarget />
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

type Fix = UseMutationResult<{ background: boolean }, Error, string>;

const sortChecks = (rows: Check[]) => [...rows].sort((a, b) => Number(a.ok) - Number(b.ok) || ORDER[a.severity] - ORDER[b.severity]);

function CheckRow({ c, admin, fix, showTarget }: { c: Check; admin: boolean; fix: Fix; showTarget?: boolean }) {
  return (
    <div className="flex flex-wrap items-start gap-x-4 gap-y-2 px-5 py-3">
      {c.ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-ok" /> : <ShieldAlert className={`mt-0.5 size-4 shrink-0 ${c.severity === "high" ? "text-accent" : "text-warn"}`} />}
      <div className="min-w-0 flex-1">
        <div className="text-[14px]">
          {t(c.title)}
          {showTarget && c.target && <span className="text-muted"> · {c.target.name}</span>}
          {!c.ok && <span className="ml-2 text-[12px] text-faint">{t(SEVERITY[c.severity])}</span>}
        </div>
        {!c.ok && <p className="mt-0.5 text-[13px] leading-relaxed break-words text-muted">{c.detail}</p>}
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
  );
}

type AppGroup = { id: number; name: string; checks: Check[]; failed: Check[]; counts: Record<Check["severity"], number> };
type Filter = "attention" | "ok" | "all";

const PAGE = 10;
const SEVERITY_COUNT = {
  high: (n: number) => t("{n} yüksek", { n }),
  medium: (n: number) => t("{n} orta", { n }),
  low: (n: number) => t("{n} düşük", { n }),
} as const;
/** Uygulamada hangi korumaların açık olduğunu bir bakışta gösteren rozetler (kontrol kimliğinin ön ekiyle eşleşir). */
const PROTECTIONS = [
  { prefix: "app-waf-", label: "WAF" },
  { prefix: "app-rate-", label: "Hız sınırı" },
  { prefix: "app-headers-", label: "Başlıklar" },
] as const;

/**
 * Uygulama kontrolleri: onlarca uygulamada sayfa sonsuz uzamasın diye her uygulama tek satır;
 * dikkat isteyenler üstte, satıra tıklayınca o uygulamanın kontrolleri ve düzeltmeleri açılır.
 */
function AppChecks({ checks, admin, fix }: { checks: Check[]; admin: boolean; fix: Fix }) {
  const apps = useMemo(() => {
    const map = new Map<number, AppGroup>();
    for (const c of checks) {
      if (!c.target) continue;
      let g = map.get(c.target.id);
      if (!g) map.set(c.target.id, (g = { id: c.target.id, name: c.target.name, checks: [], failed: [], counts: { high: 0, medium: 0, low: 0 } }));
      g.checks.push(c);
      if (!c.ok) {
        g.failed.push(c);
        g.counts[c.severity]++;
      }
    }
    return [...map.values()].sort(
      (a, b) => b.counts.high - a.counts.high || b.counts.medium - a.counts.medium || b.counts.low - a.counts.low || a.name.localeCompare(b.name),
    );
  }, [checks]);
  const attention = apps.filter((a) => a.failed.length).length;
  const [filter, setFilter] = useState<Filter>(attention ? "attention" : "all");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<number | null>(null);
  const [limit, setLimit] = useState(PAGE);

  const query = q.trim().toLocaleLowerCase();
  const visible = apps.filter(
    (a) =>
      a.id === open ||
      ((filter === "all" || (filter === "attention" ? a.failed.length > 0 : a.failed.length === 0)) && (!query || a.name.toLocaleLowerCase().includes(query))),
  );
  const shown = visible.slice(0, limit);
  const chips: { id: Filter; label: string; n: number }[] = [
    { id: "attention", label: t("Dikkat isteyenler"), n: attention },
    { id: "ok", label: t("Sorunsuz"), n: apps.length - attention },
    { id: "all", label: t("Tümü"), n: apps.length },
  ];

  return (
    <Section
      title={t("Uygulamalar")}
      className="!mt-0"
      description={
        attention
          ? t("{total} uygulamadan {n} tanesi dikkat istiyor.", { total: apps.length, n: attention })
          : t("{total} uygulamanın hepsinde kontroller geçti.", { total: apps.length })
      }
    >
      {apps.length > 1 && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div className="flex flex-wrap gap-1" role="group" aria-label={t("Filtre")}>
            {chips.map((c) => (
              <button
                key={c.id}
                type="button"
                aria-pressed={filter === c.id}
                onClick={() => {
                  setFilter(c.id);
                  setLimit(PAGE);
                }}
                className={`inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-[13px] transition-colors ${
                  filter === c.id ? "border-fg bg-fg text-bg" : "border-line text-muted hover:border-line-strong hover:text-fg"
                }`}
              >
                {c.label}
                <span className={`tabular-nums ${filter === c.id ? "opacity-70" : "text-faint"}`}>{c.n}</span>
              </button>
            ))}
          </div>
          {apps.length > 8 && (
            <div className="relative min-w-0 flex-1 sm:max-w-64 sm:flex-none max-sm:basis-full">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-faint" />
              <input
                className="input w-full pl-8"
                placeholder={t("Uygulama ara")}
                aria-label={t("Uygulama ara")}
                value={q}
                onChange={(e) => {
                  setQ(e.target.value);
                  setLimit(PAGE);
                }}
              />
            </div>
          )}
        </div>
      )}

      {shown.length === 0 ? (
        <div className="panel px-5 py-6 text-[14px] text-muted">
          {query ? t("Aramaya uyan uygulama yok.") : filter === "attention" ? t("Dikkat isteyen uygulama yok; tüm kontroller geçti.") : t("Bu filtrede uygulama yok.")}
        </div>
      ) : (
        <div className="panel divide-y divide-line">
          {shown.map((a) => (
            <AppRow key={a.id} app={a} open={open === a.id} onToggle={() => setOpen(open === a.id ? null : a.id)} admin={admin} fix={fix} />
          ))}
          {visible.length > shown.length && (
            <button type="button" onClick={() => setLimit(limit + 25)} className="flex w-full items-center justify-center gap-1.5 px-5 py-3 text-[13px] text-muted hover:bg-surface-2 hover:text-fg">
              <ChevronDown className="size-3.5" />
              {t("{n} uygulama daha göster", { n: visible.length - shown.length })}
            </button>
          )}
        </div>
      )}
    </Section>
  );
}

function AppRow({ app, open, onToggle, admin, fix }: { app: AppGroup; open: boolean; onToggle: () => void; admin: boolean; fix: Fix }) {
  const [showPassed, setShowPassed] = useState(false);
  const passed = app.checks.filter((c) => c.ok);
  const issues = app.failed.length;
  const panelId = `app-checks-${app.id}`;
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={panelId}
        className={`flex w-full flex-wrap items-center gap-x-3 gap-y-1.5 px-5 py-3 text-left hover:bg-surface-2 ${open ? "bg-surface-2" : ""}`}
      >
        <ChevronRight className={`size-4 shrink-0 text-faint transition-transform ${open ? "rotate-90" : ""}`} />
        {issues ? (
          <ShieldAlert className={`size-4 shrink-0 ${app.counts.high ? "text-accent" : "text-warn"}`} />
        ) : (
          <CheckCircle2 className="size-4 shrink-0 text-ok" />
        )}
        <span className="min-w-0 flex-1 truncate text-[14px] font-medium">{app.name}</span>
        <span className="flex flex-wrap items-center gap-1 max-sm:order-last max-sm:basis-full max-sm:pl-7">
          {PROTECTIONS.map((p) => {
            const c = app.checks.find((x) => x.id.startsWith(p.prefix));
            if (!c) return null;
            return (
              <span
                key={p.prefix}
                title={c.ok ? t("{name} açık", { name: t(p.label) }) : t("{name} kapalı", { name: t(p.label) })}
                className={`inline-flex h-5 items-center rounded border px-1.5 text-[11px] ${c.ok ? "border-ok/40 text-ok" : "border-line text-faint line-through"}`}
              >
                {t(p.label)}
              </span>
            );
          })}
        </span>
        <span className="flex shrink-0 items-center gap-1">
          {issues ? (
            (["high", "medium", "low"] as const).map(
              (sev) =>
                app.counts[sev] > 0 && (
                  <span
                    key={sev}
                    title={t(SEVERITY[sev])}
                    className={`inline-flex h-5 items-center rounded-full px-2 text-[12px] tabular-nums ${
                      sev === "high" ? "bg-accent/15 text-accent" : sev === "medium" ? "bg-warn/15 text-warn" : "bg-surface-2 text-muted"
                    }`}
                  >
                    {SEVERITY_COUNT[sev](app.counts[sev])}
                  </span>
                ),
            )
          ) : (
            <span className="inline-flex h-5 items-center rounded-full bg-ok/15 px-2 text-[12px] text-ok">{t("Sorunsuz")}</span>
          )}
        </span>
      </button>
      {open && (
        <div id={panelId} className="border-t border-line bg-surface-2/40">
          <div className="divide-y divide-line">
            {sortChecks(app.failed).map((c) => (
              <CheckRow key={c.id} c={c} admin={admin} fix={fix} />
            ))}
            {(showPassed || !issues) && passed.map((c) => <CheckRow key={c.id} c={c} admin={admin} fix={fix} />)}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-5 py-2.5">
            {issues > 0 && passed.length > 0 ? (
              <button type="button" onClick={() => setShowPassed(!showPassed)} className="text-[13px] text-muted hover:text-fg">
                {showPassed ? t("Geçen kontrolleri gizle") : t("Geçen {n} kontrolü göster", { n: passed.length })}
              </button>
            ) : (
              <span />
            )}
            <Link to={`/apps/${app.id}`} className="text-[13px] text-muted hover:text-fg">
              {t("Uygulamaya git")} →
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
