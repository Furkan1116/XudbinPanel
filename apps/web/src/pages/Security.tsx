import { useQuery } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { SecurityScore } from "@/components/SecurityScore";
import { Button, Dialog, Field, Notice, PageHeader, PageLoading, Section, Tabs, Toggle, useAction } from "@/components/ui";
import { api } from "@/lib/api";
import { dateTime, timeAgo } from "@/lib/format";
import { locale, t } from "@/lib/i18n";

type Summary = {
  hours: number;
  bucketMs: number;
  byKind: { kind: string; n: number }[];
  timeline: { t: number; n: number }[];
  topIps: { ip: string; n: number; last: number; blocked: number }[];
  topPaths: { path: string; n: number }[];
  topHosts: { host: string; n: number }[];
  blockedCount: number;
};
type Event = { id: number; ip: string; kind: string; method: string | null; path: string | null; status: number | null; host: string | null; userAgent: string | null; createdAt: number; serverName: string | null };
type Blocked = { id: number; ip: string; reason: string; auto: number; expiresAt: number | null; createdAt: number };

const KIND: Record<string, string> = {
  waf: t("WAF engelledi"),
  ratelimit: t("Hız sınırı"),
  blocked: t("Banlı IP"),
  denied: t("IP kuralı"),
  auth: t("Hatalı şifre"),
  panel_login: t("Panel girişi"),
};

export function SecurityPage() {
  const [hours, setHours] = useState(24);
  const [tab, setTab] = useState<"score" | "overview" | "events" | "blocked">("score");
  const summary = useQuery({ queryKey: ["security", "summary", hours], queryFn: () => api.get<Summary>(`/security/summary?hours=${hours}`), refetchInterval: 20_000 });
  if (!summary.data) return <PageLoading />;
  const s = summary.data;
  const total = s.byKind.reduce((sum, k) => sum + k.n, 0);

  return (
    <>
      <PageHeader
        title={t("Güvenlik")}
        description={t("Tüm sunuculardaki uygulamalara gelen ve engellenen saldırılar. Loglar 20 saniyede bir okunur.")}
        actions={
          <select className="input w-auto" value={hours} onChange={(e) => setHours(Number(e.target.value))} aria-label={t("Zaman aralığı")}>
            <option value={24}>{t("Son 24 saat")}</option>
            <option value={168}>{t("Son 7 gün")}</option>
            <option value={720}>{t("Son 30 gün")}</option>
          </select>
        }
      />
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "score", label: t("Puan") },
          { id: "overview", label: t("Saldırılar") },
          { id: "events", label: t("Olaylar") },
          { id: "blocked", label: t("Banlı IP'ler ({n})", { n: s.blockedCount }) },
        ]}
      />
      {tab === "overview" && (
        <>
          <section className="panel">
            <dl className="grid grid-cols-2 border-b border-line sm:grid-cols-4">
              <Stat label={t("Engellenen istek")} value={total} big />
              <Stat label={t("WAF")} value={s.byKind.find((k) => k.kind === "waf")?.n ?? 0} />
              <Stat label={t("Hız sınırı")} value={s.byKind.find((k) => k.kind === "ratelimit")?.n ?? 0} />
              <Stat label={t("Banlı IP")} value={s.blockedCount} />
            </dl>
            <div className="px-5 pt-4 pb-5">
              <Timeline data={s.timeline} hours={hours} bucketMs={s.bucketMs} />
            </div>
          </section>
          {total === 0 ? (
            <div className="mt-6">
              <Notice tone="info" title={t("Bu dönemde engellenen istek yok")}>
                {t("Uygulamalarına gelen şüpheli istekler (SQL injection, XSS, tarama botları, aşırı istek) burada görünür.")}
              </Notice>
            </div>
          ) : (
            <div className="mt-9 grid gap-9 lg:grid-cols-2">
              <TopIps rows={s.topIps} />
              <div className="space-y-9">
                <RankList title={t("En çok hedeflenen adresler")} rows={s.topPaths.map((p) => ({ key: p.path, n: p.n }))} mono />
                <RankList title={t("Hedeflenen siteler")} rows={s.topHosts.map((h) => ({ key: h.host, n: h.n }))} />
              </div>
            </div>
          )}
          <AutoBanSettings />
        </>
      )}
      {tab === "score" && <SecurityScore />}
      {tab === "events" && <Events />}
      {tab === "blocked" && <BlockedList />}
    </>
  );
}

function Stat({ label, value, big }: { label: string; value: number; big?: boolean }) {
  return (
    <div className="border-line px-5 py-4 [&:not(:last-child)]:border-r max-sm:[&:nth-child(2)]:border-r-0 max-sm:[&:nth-child(-n+2)]:border-b">
      <dt className="text-[13px] text-muted">{label}</dt>
      <dd className={`mt-1 leading-none font-medium tracking-[-0.02em] tabular-nums ${big ? "text-[32px] text-accent" : "text-[28px]"}`}>{value.toLocaleString(locale())}</dd>
    </div>
  );
}

/** Saatlik/günlük engellenen istek sayısı; boş dilimler de çizilir ki zaman ekseni dürüst kalsın. */
function Timeline({ data, hours, bucketMs }: { data: { t: number; n: number }[]; hours: number; bucketMs: number }) {
  const buckets = Math.round((hours * 3_600_000) / bucketMs);
  const end = Math.floor(Date.now() / bucketMs) * bucketMs;
  const map = new Map(data.map((d) => [d.t, d.n]));
  const bars = Array.from({ length: buckets }, (_, i) => {
    const t = end - (buckets - 1 - i) * bucketMs;
    return { t, n: map.get(t) ?? 0 };
  });
  const max = Math.max(1, ...bars.map((b) => b.n));
  const [hover, setHover] = useState<number | null>(null);
  const h = hover !== null ? bars[hover] : null;
  return (
    <div>
      <div className="mb-3 flex justify-between text-[13px]">
        <span className="text-muted">{bucketMs === 3_600_000 ? t("Saatlik engellenen istek") : t("Günlük engellenen istek")}</span>
        <span className="text-faint tabular-nums">{h ? `${new Date(h.t).toLocaleString(locale(), bucketMs === 3_600_000 ? { hour: "2-digit", minute: "2-digit", day: "numeric", month: "short" } : { day: "numeric", month: "short" })}: ${h.n}` : t("en yüksek {n}", { n: max === 1 && !bars.some((b) => b.n) ? 0 : max })}</span>
      </div>
      <div className="flex h-28 items-end gap-[2px]" onMouseLeave={() => setHover(null)}>
        {bars.map((b, i) => (
          <div key={b.t} className="flex h-full flex-1 items-end" onMouseEnter={() => setHover(i)}>
            <div
              className={`w-full rounded-t-[2px] ${b.n ? (hover === i ? "bg-accent-hover" : "bg-accent") : "bg-line"}`}
              style={{ height: b.n ? `${Math.max(4, (b.n / max) * 100)}%` : "2px" }}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

function TopIps({ rows }: { rows: Summary["topIps"] }) {
  const [blockIp, setBlockIp] = useState<string | null>(null);
  return (
    <Section title={t("En çok engellenen IP'ler")} className="!mt-0">
      <div className="panel divide-y divide-line">
        {rows.map((r) => (
          <div key={r.ip} className="flex items-center gap-3 px-5 py-2.5">
            <div className="min-w-0 flex-1">
              <div className="font-mono text-[13px]">{r.ip}</div>
              <div className="text-[12px] text-faint">son {timeAgo(r.last)}</div>
            </div>
            <span className="text-[14px] font-medium tabular-nums">{r.n}</span>
            {r.blocked ? <span className="w-20 text-right text-[13px] text-accent">{t("Banlı")}</span> : <Button size="sm" variant="ghost" className="w-20" onClick={() => setBlockIp(r.ip)}>{t("Banla")}</Button>}
          </div>
        ))}
      </div>
      <BlockDialog ip={blockIp} onClose={() => setBlockIp(null)} />
    </Section>
  );
}

function RankList({ title, rows, mono }: { title: string; rows: { key: string; n: number }[]; mono?: boolean }) {
  const max = Math.max(1, ...rows.map((r) => r.n));
  return (
    <Section title={title} className="!mt-0">
      <div className="panel space-y-2.5 px-5 py-4">
        {rows.map((r) => (
          <div key={r.key}>
            <div className="flex justify-between gap-3 text-[13px]">
              <span className={`truncate ${mono ? "font-mono" : ""}`}>{r.key}</span>
              <span className="tabular-nums text-muted">{r.n}</span>
            </div>
            <div className="mt-1 h-1 rounded-full bg-surface-2">
              <div className="h-full rounded-full bg-fg/50" style={{ width: `${(r.n / max) * 100}%` }} />
            </div>
          </div>
        ))}
      </div>
    </Section>
  );
}

function Events() {
  const [kind, setKind] = useState("");
  const { data } = useQuery({ queryKey: ["security", "events", kind], queryFn: () => api.get<{ events: Event[] }>(`/security/events?limit=200${kind ? `&kind=${kind}` : ""}`), refetchInterval: 20_000 });
  return (
    <>
      <div className="mb-4">
        <select className="input w-auto" value={kind} onChange={(e) => setKind(e.target.value)} aria-label={t("Olay türü")}>
          <option value="">{t("Tüm olaylar")}</option>
          {Object.entries(KIND).map(([k, v]) => (
            <option key={k} value={k}>{v}</option>
          ))}
        </select>
      </div>
      {!data ? (
        <div className="panel h-40 animate-pulse" />
      ) : data.events.length === 0 ? (
        <div className="panel px-5 py-6 text-[14px] text-muted">{t("Olay yok.")}</div>
      ) : (
        <div className="panel overflow-x-auto">
          <table className="w-full text-left text-[13px]">
            <thead className="border-b border-line text-muted">
              <tr>
                <th className="px-4 py-2.5 font-normal">{t("Zaman")}</th>
                <th className="px-4 py-2.5 font-normal">{t("Tür")}</th>
                <th className="px-4 py-2.5 font-normal">{t("IP")}</th>
                <th className="px-4 py-2.5 font-normal">{t("İstek")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {data.events.map((e) => (
                <tr key={e.id} className="align-top">
                  <td className="px-4 py-2.5 whitespace-nowrap text-muted">{dateTime(e.createdAt)}</td>
                  <td className="px-4 py-2.5 whitespace-nowrap">{t(KIND[e.kind] ?? e.kind)}</td>
                  <td className="px-4 py-2.5 font-mono whitespace-nowrap">{e.ip}</td>
                  <td className="max-w-[28rem] px-4 py-2.5">
                    <div className="truncate font-mono" title={e.path ?? ""}>
                      {e.method} {e.host ? `${e.host}` : ""}{e.path}
                    </div>
                    {e.userAgent && <div className="truncate text-faint" title={e.userAgent}>{e.userAgent}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function BlockedList() {
  const [adding, setAdding] = useState(false);
  const { data } = useQuery({ queryKey: ["security", "blocked"], queryFn: () => api.get<{ blocked: Blocked[] }>("/security/blocked"), refetchInterval: 20_000 });
  const remove = useAction((id: number) => api.del(`/security/blocked/${id}`), { success: t("Ban kaldırıldı"), invalidate: [["security"]] });
  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-xl text-[14px] text-muted">{t("Banlı IP'ler tüm sunuculardaki uygulamalara ve panele erişemez.")}</p>
        <Button variant="primary" onClick={() => setAdding(true)}>{t("IP banla")}</Button>
      </div>
      {!data ? (
        <div className="panel h-32 animate-pulse" />
      ) : data.blocked.length === 0 ? (
        <div className="panel px-5 py-6 text-[14px] text-muted">{t("Banlı IP yok.")}</div>
      ) : (
        <div className="panel divide-y divide-line">
          {data.blocked.map((b) => (
            <div key={b.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3">
              <div className="min-w-0 flex-1">
                <div className="font-mono text-[14px]">{b.ip}</div>
                <div className="text-[13px] text-muted">
                  {b.reason}
                  {b.auto ? t(", otomatik") : ""}
                </div>
              </div>
              <span className="text-[13px] text-faint">{b.expiresAt ? t("{date} tarihine kadar", { date: new Date(b.expiresAt).toLocaleString(locale(), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) }) : t("Süresiz")}</span>
              <Button size="sm" variant="ghost" onClick={() => remove.mutate(b.id)}>{t("Banı kaldır")}</Button>
            </div>
          ))}
        </div>
      )}
      <BlockDialog ip={adding ? "" : null} onClose={() => setAdding(false)} />
    </>
  );
}

function BlockDialog({ ip, onClose }: { ip: string | null; onClose: () => void }) {
  const [form, setForm] = useState({ ip: "", reason: "", hours: "" });
  const open = ip !== null;
  const block = useAction(() => api.post("/security/blocked", { ip: form.ip || ip, reason: form.reason, hours: form.hours ? Number(form.hours) : null }), {
    success: t("IP banlandı, tüm sunuculara uygulandı"),
    invalidate: [["security"]],
    onSuccess: () => {
      onClose();
      setForm({ ip: "", reason: "", hours: "" });
    },
  });
  return (
    <Dialog open={open} onClose={onClose} title={t("IP banla")}>
      <form
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          block.mutate();
        }}
        className="space-y-4"
      >
        <Field label={t("IP veya CIDR")}>
          <input className="input font-mono" required autoFocus value={form.ip || ip || ""} onChange={(e) => setForm({ ...form, ip: e.target.value.trim() })} placeholder="203.0.113.7" />
        </Field>
        <Field label={t("Neden")} hint={t("İsteğe bağlı, kendin için not.")}>
          <input className="input" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
        </Field>
        <Field label={t("Süre (saat)")} hint={t("Boş bırakırsan süresiz.")}>
          <input className="input max-w-32" inputMode="numeric" value={form.hours} onChange={(e) => setForm({ ...form, hours: e.target.value.replace(/\D/g, "") })} />
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>{t("Vazgeç")}</Button>
          <Button type="submit" variant="primary" loading={block.isPending}>{t("Banla")}</Button>
        </div>
      </form>
    </Dialog>
  );
}

function AutoBanSettings() {
  const { data } = useQuery({
    queryKey: ["security", "settings"],
    queryFn: () => api.get<{ autoBanEnabled: boolean; autoBanThreshold: number; autoBanWindowMin: number; autoBanDurationH: number }>("/security/settings"),
  });
  const [form, setForm] = useState<{ on: boolean; threshold: string; window: string; duration: string } | null>(null);
  const f = form ?? (data ? { on: data.autoBanEnabled, threshold: String(data.autoBanThreshold), window: String(data.autoBanWindowMin), duration: String(data.autoBanDurationH) } : null);
  const save = useAction(
    () => api.put("/security/settings", { autoBanEnabled: f!.on, autoBanThreshold: Number(f!.threshold), autoBanWindowMin: Number(f!.window), autoBanDurationH: Number(f!.duration) }),
    { success: t("Otomatik ban ayarları kaydedildi"), invalidate: [["security", "settings"]] },
  );
  if (!f) return null;
  const num = (k: "threshold" | "window" | "duration") => (
    <input className="input w-20" inputMode="numeric" value={f[k]} onChange={(e) => setForm({ ...f, [k]: e.target.value.replace(/\D/g, "") })} />
  );
  return (
    <Section title={t("Otomatik ban")} description={t("Saldırgan IP'ler kısa sürede çok fazla engellenirse tüm sunucularda geçici olarak banlanır.")}>
      <div className="panel space-y-4 p-5">
        <Toggle checked={f.on} onChange={(v) => setForm({ ...f, on: v })} label={t("Otomatik ban açık")} />
        {f.on && (
          <div className="flex flex-wrap items-center gap-2 text-[14px] text-muted">
            {num("window")} {t("dakika içinde")} {num("threshold")} {t("engellenen istek yapan IP")} {num("duration")} {t("saat banlansın.")}
          </div>
        )}
        <div className="flex justify-end">
          <Button onClick={() => save.mutate()} loading={save.isPending}>{t("Kaydet")}</Button>
        </div>
      </div>
    </Section>
  );
}
