import { useEffect, useRef, useState } from "react";

/**
 * SSE ile akan logları gösterir. Sunucu "snapshot" (mevcut log), "line" (yeni satır) ve
 * "done" (bitti) olayları gönderir. Kullanıcı yukarı kaydırmadıkça en alta kayar.
 */
export function LogViewer({ url, height = "h-[28rem]", onDone, emptyText = "Henüz çıktı yok." }: { url: string; height?: string; onDone?: () => void; emptyText?: string }) {
  const [lines, setLines] = useState<string[]>([]);
  const [state, setState] = useState<"live" | "done" | "closed">("live");
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  useEffect(() => {
    setLines([]);
    setState("live");
    const es = new EventSource(url);
    es.addEventListener("snapshot", (e) => {
      const data = JSON.parse((e as MessageEvent).data) as { log?: string };
      setLines((data.log ?? "").split("\n").filter(Boolean));
    });
    es.addEventListener("line", (e) => setLines((prev) => (prev.length > 5000 ? [...prev.slice(-4000), (e as MessageEvent).data] : [...prev, (e as MessageEvent).data])));
    es.addEventListener("done", () => {
      setState("done");
      es.close();
      doneRef.current?.();
    });
    es.onerror = () => setState((s) => (s === "done" ? s : "closed"));
    return () => es.close();
  }, [url]);

  useEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lines]);

  return (
    <div className="overflow-hidden rounded-[10px] border border-line bg-[#141315] text-[#d9d6d8]">
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-2 text-[12px] text-[#8f8a8e]">
        <span>{lines.length} satır</span>
        <span className="inline-flex items-center gap-1.5">
          <span className={`size-1.5 rounded-full ${state === "live" ? "bg-[#62c08a]" : "bg-[#5f5a5e]"}`} />
          {{ live: "Canlı", done: "Tamamlandı", closed: "Bağlantı kesildi" }[state]}
        </span>
      </div>
      <div
        ref={box}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
        className={`${height} overflow-auto px-4 py-3 font-mono text-[12.5px] leading-[1.6]`}
      >
        {lines.length === 0 ? (
          <div className="text-[#8f8a8e]">{emptyText}</div>
        ) : (
          lines.map((l, i) => (
            <div key={i} className={`break-all whitespace-pre-wrap ${/^Hata:|error|failed/i.test(l) ? "text-[#f0828c]" : ""}`}>
              {l}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
