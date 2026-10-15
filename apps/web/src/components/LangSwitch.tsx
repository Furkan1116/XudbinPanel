import { getLang, type Lang, setLang } from "@/lib/i18n";

/** Dil seçimi. Bütün metinlerin (sabit listeler dahil) yeniden çevrilmesi için sayfa yenilenir. */
export function LangSwitch() {
  const current = getLang();
  const choose = (l: Lang) => {
    if (l === current) return;
    setLang(l);
    location.reload();
  };
  return (
    <div role="radiogroup" aria-label="Dil / Language" className="inline-flex rounded-md border border-line p-0.5">
      {(["tr", "en"] as const).map((l) => (
        <button
          key={l}
          role="radio"
          aria-checked={current === l}
          onClick={() => choose(l)}
          className={`h-7 rounded-[5px] px-2 text-[12px] font-medium uppercase transition-colors ${current === l ? "bg-surface-2 text-fg" : "text-faint hover:text-fg"}`}
        >
          {l}
        </button>
      ))}
    </div>
  );
}
