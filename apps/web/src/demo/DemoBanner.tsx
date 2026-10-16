import { getLang } from "@/lib/i18n";

/** Demo derlemesinde en üstte duran ince bilgi şeridi. */
export function DemoBanner() {
  const en = getLang() === "en";
  return (
    <div role="note" className="flex flex-wrap items-center justify-center gap-x-3 gap-y-0.5 border-b border-line bg-accent-soft px-4 py-1.5 text-center text-[13px] text-fg">
      <span>{en ? "This is a demo: the data is sample data and changes are not saved." : "Bu bir demo: veriler örnektir, değişiklikler kaydedilmez."}</span>
      <a href={en ? "/en/docs/kurulum/" : "/belgeler/kurulum/"} target="_top" className="font-medium text-accent underline-offset-2 hover:underline">
        {en ? "Install on your server →" : "Kendi sunucuna kur →"}
      </a>
    </div>
  );
}
