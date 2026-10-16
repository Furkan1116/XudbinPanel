import { useState } from "react";
import { Button } from "@/components/ui";
import { api } from "@/lib/api";
import { t } from "@/lib/i18n";

/** Geçmiş loglarda arama (son 1 saat - 14 gün). */
export function LogSearch({ appId }: { appId: number }) {
  const [q, setQ] = useState("");
  const [hours, setHours] = useState("24");
  const [result, setResult] = useState<{ matches: { container: string; line: string }[]; truncated: boolean } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const search = async () => {
    setLoading(true);
    setError(null);
    try {
      setResult(await api.get(`/apps/${appId}/logs/search?q=${encodeURIComponent(q)}&hours=${hours}`));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };
  return (
    <div className="space-y-3">
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (q.trim().length >= 2) void search();
        }}
      >
        <input className="input min-w-48 flex-1" placeholder={t("Geçmiş loglarda ara (ör. Traceback, 500, kullanıcı e-postası)")} value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="input w-auto" value={hours} onChange={(e) => setHours(e.target.value)} aria-label={t("Zaman aralığı")}>
          <option value="1">{t("Son 1 saat")}</option>
          <option value="24">{t("Son 24 saat")}</option>
          <option value="168">{t("Son 7 gün")}</option>
          <option value="336">{t("Son 14 gün")}</option>
        </select>
        <Button type="submit" loading={loading} disabled={q.trim().length < 2}>{t("Ara")}</Button>
      </form>
      {error && <p className="text-[13px] text-accent">{error}</p>}
      {result && (
        <div className="overflow-hidden rounded-[10px] border border-line bg-[#141315] text-[#d9d6d8]">
          <div className="border-b border-white/10 px-4 py-2 text-[12px] text-[#8f8a8e]">
            {t("{n} eşleşme", { n: result.matches.length })}{result.truncated ? ` ${t("(son 2000 gösteriliyor)")}` : ""}
          </div>
          <div className="max-h-96 overflow-auto px-4 py-3 font-mono text-[12.5px] leading-[1.6]">
            {result.matches.length === 0 ? (
              <div className="text-[#8f8a8e]">{t("Eşleşme yok.")}</div>
            ) : (
              result.matches.map((m, i) => (
                <div key={i} className="break-all whitespace-pre-wrap">{m.line}</div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
