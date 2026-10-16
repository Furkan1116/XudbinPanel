import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { useState } from "react";
import { type Template, TemplateDialog, TemplateLogo } from "@/components/TemplateDialog";
import { PageHeader, PageLoading } from "@/components/ui";
import { api } from "@/lib/api";
import { t } from "@/lib/i18n";

/** Tek tıkla kurulan hazır uygulamaların kataloğu; kurulacak proje seçilerek açılır. */
export function TemplatesPage() {
  const { data } = useQuery({ queryKey: ["templates"], queryFn: () => api.get<{ templates: Template[] }>("/templates") });
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [picked, setPicked] = useState<Template | null>(null);
  if (!data) return <PageLoading />;
  const categories = [...new Set(data.templates.map((x) => x.category))];
  const q = query.trim().toLocaleLowerCase("tr");
  const list = data.templates.filter(
    (x) => (!category || x.category === category) && (!q || `${x.name} ${t(x.description)} ${x.id}`.toLocaleLowerCase("tr").includes(q)),
  );
  return (
    <>
      <PageHeader title={t("Şablonlar")} description={t("Hazır uygulamaları tek tıkla kur: şifreler otomatik üretilir, alan adı ve HTTPS hazır gelir.")} />
      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center">
        <label className="relative sm:w-64">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint" />
          <input className="input pl-9" placeholder={t("Şablon ara")} value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <div className="flex flex-wrap gap-1.5">
          {["", ...categories].map((c) => (
            <button
              key={c || "all"}
              type="button"
              onClick={() => setCategory(c)}
              className={`rounded-full border px-3 py-1 text-[13px] ${category === c ? "border-line-strong bg-surface-2 font-medium text-fg" : "border-line text-muted hover:text-fg"}`}
            >
              {c ? t(c) : t("Tümü")}
            </button>
          ))}
        </div>
      </div>
      {list.length ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {list.map((tpl) => (
            <button key={tpl.id} type="button" onClick={() => setPicked(tpl)} className="panel flex items-start gap-3 p-4 text-left transition-colors hover:border-line-strong">
              <TemplateLogo icon={tpl.icon} name={tpl.name} />
              <span className="min-w-0">
                <span className="block font-medium">{tpl.name}</span>
                <span className="mt-0.5 block text-[13px] leading-snug text-muted">{t(tpl.description)}</span>
                <span className="mt-2 inline-block rounded-full bg-surface-2 px-2 py-0.5 text-[12px] text-faint">{t(tpl.category)}</span>
              </span>
            </button>
          ))}
        </div>
      ) : (
        <p className="text-[14px] text-muted">{t("Aramaya uyan şablon yok.")}</p>
      )}
      <TemplateDialog open={Boolean(picked)} onClose={() => setPicked(null)} initial={picked} />
    </>
  );
}
