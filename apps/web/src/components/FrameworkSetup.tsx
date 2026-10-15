import { useQuery } from "@tanstack/react-query";
import { Check, Plus, Sparkles } from "lucide-react";
import { Field, Toggle } from "@/components/ui";
import { api, type DetectResult, type EnvHint, type FrameworkInfo } from "@/lib/api";
import { FrameworkLogo } from "./FrameworkLogo";
import { t } from "@/lib/i18n";

/** Sunucudan gelen katalog metinleri (Türkçe) seçili dile çevrilir. */
function translateCatalog(list: FrameworkInfo[]): FrameworkInfo[] {
  return list.map((f) => ({
    ...f,
    name: t(f.name),
    description: t(f.description),
    category: t(f.category),
    steps: f.steps.map((x) => t(x)),
    fields: f.fields.map((x) => ({ ...x, label: t(x.label), hint: x.hint && t(x.hint), options: x.options?.map((o) => ({ ...o, label: t(o.label) })) })),
    envHints: f.envHints.map((h) => ({ ...h, description: t(h.description) })),
  }));
}

export function useFrameworks() {
  return useQuery({
    queryKey: ["frameworks"],
    queryFn: () => api.get<{ frameworks: FrameworkInfo[] }>("/frameworks").then((r) => ({ frameworks: translateCatalog(r.frameworks) })),
    staleTime: Infinity,
  });
}

const AUTO_ENTRY: FrameworkInfo = {
  id: "auto",
  name: t("Otomatik algıla"),
  language: "",
  category: "",
  description: t("Her deploy'da repo taranır, en uygun framework seçilir."),
  defaultPort: 3000,
  fields: [],
  envHints: [],
  steps: [t("Repo klonlanır ve proje türü algılanır."), t("Algılanan framework'ün adımları uygulanır.")],
};

/** Dillere göre gruplanmış framework seçimi; algılananlar önerilen olarak işaretlenir. */
export function FrameworkPicker({ value, onChange, detected }: { value: string; onChange: (id: string) => void; detected?: DetectResult["matches"] }) {
  const { data } = useFrameworks();
  if (!data) return <div className="h-64 animate-pulse rounded-md bg-surface-2" />;
  const top = detected?.[0];
  const groups = new Map<string, FrameworkInfo[]>();
  for (const f of data.frameworks) groups.set(f.category, [...(groups.get(f.category) ?? []), f]);

  const card = (f: FrameworkInfo) => {
    const match = detected?.find((m) => m.id === f.id);
    const selected = value === f.id;
    return (
      <button
        type="button"
        key={f.id}
        onClick={() => onChange(f.id)}
        aria-pressed={selected}
        className={`relative flex items-center gap-2.5 rounded-md border px-3 py-2.5 text-left transition-colors ${
          selected ? "border-accent bg-accent-soft/40" : "border-line-strong hover:bg-surface-2"
        }`}
      >
        {f.id === "auto" ? <Sparkles className="size-5 shrink-0 text-accent" /> : <FrameworkLogo id={f.id} className="size-5 shrink-0" />}
        <span className="min-w-0">
          <span className="block truncate text-[14px] font-medium">{f.name}</span>
          {match && <span className="block truncate text-[12px] text-ok">{match === top ? t("Önerilen") : t("Uygun")}</span>}
        </span>
        {selected && <Check className="absolute top-2 right-2 size-3.5 text-accent" />}
      </button>
    );
  };

  return (
    <div className="space-y-4">
      {top && (
        <p className="rounded-md bg-surface-2 px-3 py-2 text-[13px] text-muted">
          {t("Repoda {name} bulundu: {reason}.", { name: data.frameworks.find((f) => f.id === top.id)?.name ?? "", reason: t(top.reason) })}
        </p>
      )}
      <div className="grid gap-2 sm:grid-cols-3">{card(AUTO_ENTRY)}</div>
      {[...groups.entries()].map(([cat, list]) => (
        <div key={cat}>
          <div className="mb-1.5 text-[13px] text-muted">{cat}</div>
          <div className="grid gap-2 sm:grid-cols-3">{list.map(card)}</div>
        </div>
      ))}
    </div>
  );
}

export function frameworkById(list: FrameworkInfo[] | undefined, id: string) {
  return id === "auto" ? AUTO_ENTRY : list?.find((f) => f.id === id);
}

/** Framework'e özel ayar alanları. Boş bırakılan alanlar otomatik değerleri kullanır. */
export function FrameworkFields({ fw, values, onChange }: { fw: FrameworkInfo; values: Record<string, string | boolean>; onChange: (v: Record<string, string | boolean>) => void }) {
  if (!fw.fields.length) return null;
  const set = (k: string, v: string | boolean) => onChange({ ...values, [k]: v });
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {fw.fields.map((f) =>
        f.type === "toggle" ? (
          <div key={f.key} className="sm:col-span-2">
            <Toggle checked={values[f.key] !== false && values[f.key] !== "false"} onChange={(v) => set(f.key, v)} label={f.label} description={f.hint} />
          </div>
        ) : f.type === "select" ? (
          <Field key={f.key} label={f.label} hint={f.hint}>
            <select className="input" value={String(values[f.key] ?? "")} onChange={(e) => set(f.key, e.target.value)}>
              <option value="">{t("Otomatik")}</option>
              {f.options?.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </Field>
        ) : (
          <Field key={f.key} label={f.label} hint={f.hint}>
            <input className="input font-mono text-[13px]" value={String(values[f.key] ?? "")} placeholder={f.placeholder} onChange={(e) => set(f.key, e.target.value)} />
          </Field>
        ),
      )}
    </div>
  );
}

export function FrameworkSteps({ fw }: { fw: FrameworkInfo }) {
  return (
    <ol className="space-y-1.5 text-[13px] text-muted">
      {fw.steps.map((s, i) => (
        <li key={i} className="flex gap-2">
          <span className="grid size-5 shrink-0 place-items-center rounded-full bg-surface-2 text-[11px] font-medium text-fg">{i + 1}</span>
          <span className="pt-px">{s}</span>
        </li>
      ))}
    </ol>
  );
}

// ---------------------------------------------------------------------------
// Ortam değişkeni önerileri
// ---------------------------------------------------------------------------

export function randomSecret(n = 50) {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}

/** Alan adına bağlı otomatik değerler; alan adı henüz yoksa sunucuda doldurulmak üzere yer tutucu kalır. */
export function hintValue(h: EnvHint, ctx: { hosts: string[]; https: boolean }) {
  const scheme = ctx.https ? "https" : "http";
  switch (h.auto) {
    case "secret":
      return randomSecret();
    case "laravel-key":
      return `base64:${btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))}`;
    case "domains":
      return ctx.hosts.length ? ctx.hosts.join(",") : "{{XUDBIN_DOMAINS}}";
    case "url":
      return ctx.hosts[0] ? `${scheme}://${ctx.hosts[0]}` : "{{XUDBIN_URL}}";
    case "https-origins":
      return ctx.hosts.length ? ctx.hosts.map((x) => `${scheme}://${x}`).join(",") : "{{XUDBIN_ORIGINS}}";
    default:
      return h.value ?? "";
  }
}

export const envKeys = (text: string) =>
  new Set(text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#") && l.includes("=")).map((l) => l.slice(0, l.indexOf("=")).trim()));

export function appendEnv(text: string, lines: string[]) {
  const add = lines.filter(Boolean);
  if (!add.length) return text;
  return (text.trim() ? `${text.trimEnd()}\n` : "") + add.join("\n") + "\n";
}

/** Framework'ün istediği, kodda okunan ve .env.example'daki değişkenleri tek tıkla ekletir. */
export function EnvSuggestions({
  hints,
  detect,
  env,
  onChange,
  ctx,
}: {
  hints: EnvHint[];
  detect?: DetectResult | null;
  env: string;
  onChange: (env: string) => void;
  ctx: { hosts: string[]; https: boolean };
}) {
  const present = envKeys(env);
  const missingHints = hints.filter((h) => !present.has(h.key));
  const example = (detect?.envExample ?? []).filter((e) => !present.has(e.key));
  const fromCode = (detect?.envFromCode ?? []).filter((k) => !present.has(k) && !hints.some((h) => h.key === k) && !example.some((e) => e.key === k));
  if (!missingHints.length && !example.length && !fromCode.length) return null;

  const required = missingHints.filter((h) => h.required);
  return (
    <div className="space-y-3 rounded-md border border-line bg-surface-2/50 p-3">
      {missingHints.length > 0 && (
        <div>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <span className="text-[13px] font-medium">{t("Bu framework için önerilenler")}</span>
            {required.length > 0 && (
              <button type="button" className="text-[13px] text-accent hover:underline" onClick={() => onChange(appendEnv(env, required.map((h) => `${h.key}=${hintValue(h, ctx)}`)))}>
                {t("Gerekenlerin hepsini ekle")}
              </button>
            )}
          </div>
          <ul className="space-y-1.5">
            {missingHints.map((h) => (
              <li key={h.key} className="flex items-start gap-2">
                <button type="button" onClick={() => onChange(appendEnv(env, [`${h.key}=${hintValue(h, ctx)}`]))} className="mt-0.5 grid size-5 shrink-0 place-items-center rounded border border-line-strong text-muted hover:border-accent hover:text-accent" aria-label={`${h.key} ekle`}>
                  <Plus className="size-3" />
                </button>
                <span className="text-[13px]">
                  <code className="font-mono">{h.key}</code>
                  {h.required && <span className="ml-1 text-accent">*</span>}
                  <span className="text-muted"> {h.description}{h.auto ? t(" Değer otomatik üretilir.") : ""}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {example.length > 0 && (
        <div>
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <span className="text-[13px] font-medium">{t(".env.example dosyasında ({n})", { n: example.length })}</span>
            <button type="button" className="text-[13px] text-accent hover:underline" onClick={() => onChange(appendEnv(env, example.map((e) => `${e.key}=${e.value}`)))}>
              {t("Hepsini ekle")}
            </button>
          </div>
          <div className="flex flex-wrap gap-1">
            {example.slice(0, 40).map((e) => (
              <button type="button" key={e.key} onClick={() => onChange(appendEnv(env, [`${e.key}=${e.value}`]))} className="rounded border border-line-strong px-1.5 py-0.5 font-mono text-[12px] text-muted hover:border-accent hover:text-fg">
                {e.key}
              </button>
            ))}
          </div>
        </div>
      )}
      {fromCode.length > 0 && (
        <div>
          <div className="mb-1.5 text-[13px] font-medium">{t("Kodunda okunan değişkenler")}</div>
          <div className="flex flex-wrap gap-1">
            {fromCode.slice(0, 40).map((k) => (
              <button type="button" key={k} onClick={() => onChange(appendEnv(env, [`${k}=`]))} className="rounded border border-line-strong px-1.5 py-0.5 font-mono text-[12px] text-muted hover:border-accent hover:text-fg">
                {k}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
