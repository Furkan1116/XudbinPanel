import { useInfiniteQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Button, PageLoading } from "@/components/ui";
import { api } from "@/lib/api";
import { t } from "@/lib/i18n";

type Entry = { id: number; email: string | null; action: string; method: string | null; path: string | null; status: number | null; ip: string | null; via: string | null; createdAt: number };

/** Kim, ne zaman, nereden, ne yaptı: değişiklik yapan tüm istekler ve giriş denemeleri. */
export function AuditLog() {
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  const query = useInfiniteQuery({
    queryKey: ["audit", search],
    queryFn: ({ pageParam }) => api.get<{ entries: Entry[] }>(`/settings/audit?q=${encodeURIComponent(search)}${pageParam ? `&before=${pageParam}` : ""}`),
    initialPageParam: 0,
    getNextPageParam: (last) => (last.entries.length === 100 ? last.entries.at(-1)!.id : undefined),
  });
  const rows = query.data?.pages.flatMap((p) => p.entries) ?? [];
  const fmt = new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "medium" });
  return (
    <div className="space-y-4">
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setSearch(q.trim());
        }}
      >
        <input className="input" placeholder={t("Kullanıcı, işlem, adres veya IP ara")} value={q} onChange={(e) => setQ(e.target.value)} />
        <Button type="submit">{t("Ara")}</Button>
      </form>
      {!query.data ? (
        <PageLoading />
      ) : rows.length === 0 ? (
        <div className="panel px-5 py-6 text-[14px] text-muted">{t("Kayıt yok.")}</div>
      ) : (
        <div className="panel overflow-x-auto">
          <table className="w-full text-left text-[13px]">
            <thead className="border-b border-line text-muted">
              <tr>
                <th className="px-4 py-2 font-normal">{t("Zaman")}</th>
                <th className="px-4 py-2 font-normal">{t("Kullanıcı")}</th>
                <th className="px-4 py-2 font-normal">{t("İşlem")}</th>
                <th className="hidden px-4 py-2 font-normal md:table-cell">{t("IP")}</th>
                <th className="px-4 py-2 text-right font-normal">{t("Sonuç")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="px-4 py-2 whitespace-nowrap text-muted tabular-nums">{fmt.format(r.createdAt)}</td>
                  <td className="px-4 py-2">{r.email ?? "–"}{r.via === "api" && <span className="ml-1 text-faint">(API)</span>}</td>
                  <td className="px-4 py-2">
                    <div>{t(r.action)}</div>
                    {r.path && <div className="font-mono text-[12px] text-faint">{r.method} {r.path}</div>}
                  </td>
                  <td className="hidden px-4 py-2 font-mono text-[12px] text-muted md:table-cell">{r.ip}</td>
                  <td className={`px-4 py-2 text-right tabular-nums ${r.status && r.status >= 400 ? "text-accent" : "text-muted"}`}>{r.status ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {query.hasNextPage && (
        <Button onClick={() => query.fetchNextPage()} loading={query.isFetchingNextPage}>{t("Daha eski kayıtlar")}</Button>
      )}
    </div>
  );
}
