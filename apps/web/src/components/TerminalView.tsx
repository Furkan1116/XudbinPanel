import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { t } from "@/lib/i18n";

/**
 * Konteynerdeki kabuğa bağlanan terminal (xterm.js). Çıktı SSE ile base64 olarak gelir; girdi, boyut ve kapatma
 * ayrı POST istekleridir. Bu dosya yalnız Terminal sekmesi açılınca yüklenir (ana paket büyümesin).
 */
type State = { kind: "connecting" } | { kind: "live" } | { kind: "closed"; text: string };

const REASONS: Record<string, string> = {
  exit: "Kabuk kapandı.",
  closed: "Terminal kapatıldı.",
  idle: "Uzun süre girdi gelmediği için terminal kapatıldı.",
  max: "Terminal en uzun süresine ulaştığı için kapatıldı.",
  detached: "Bağlantı koptuğu için terminal kapatıldı.",
  error: "Konteyner bağlantısı hata verdi.",
  shutdown: "Panel yeniden başlatıldığı için terminal kapandı.",
  replaced: "Bu terminal başka bir sekmede açıldı.",
};

function fromBase64(s: string) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function toBase64(bytes: Uint8Array) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Girdi en fazla bu sıklıkta ve tek tek gönderilir: tuşların sırası bozulmaz, panelin istek sınırı aşılmaz. */
const SEND_GAP_MS = 80;
const MAX_INPUT_BYTES = 48 * 1024;

export default function TerminalView({ appId, container }: { appId: number; container: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<State>({ kind: "connecting" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    setState({ kind: "connecting" });
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: '"IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 13,
      scrollback: 5000,
      theme: { background: "#141315", foreground: "#d9d6d8", cursor: "#d9d6d8", selectionBackground: "#4a454a" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    fit.fit();

    let disposed = false;
    let sid: string | null = null;
    let es: EventSource | null = null;
    const base = `/apps/${appId}/terminal`;
    const close = (text: string) => {
      if (disposed) return;
      es?.close();
      setState((s) => (s.kind === "closed" ? s : { kind: "closed", text }));
    };

    // --- Girdi: sırayla, birleştirilerek ---
    const encoder = new TextEncoder();
    let queue: Uint8Array[] = [];
    let sending = false;
    const flush = async () => {
      if (sending || !sid || !queue.length || disposed) return;
      sending = true;
      const total = Math.min(queue.reduce((n, b) => n + b.length, 0), MAX_INPUT_BYTES);
      const data = new Uint8Array(total);
      let off = 0;
      while (queue.length && off < total) {
        const b = queue[0]!;
        const take = Math.min(b.length, total - off);
        data.set(b.subarray(0, take), off);
        off += take;
        if (take === b.length) queue.shift();
        else queue[0] = b.subarray(take);
      }
      try {
        await api.post(`${base}/${sid}/input`, { data: toBase64(data) });
      } catch (err) {
        queue = [];
        if (err instanceof ApiError && err.status === 404) close(t("Terminal oturumu kapandı."));
      }
      setTimeout(() => {
        sending = false;
        void flush();
      }, SEND_GAP_MS);
    };
    const onData = term.onData((d) => {
      queue.push(encoder.encode(d));
      void flush();
    });
    const onBinary = term.onBinary((d) => {
      queue.push(Uint8Array.from(d, (ch) => ch.charCodeAt(0) & 0xff));
      void flush();
    });

    // --- Boyut ---
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    const onResize = term.onResize(({ cols, rows }) => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (sid && !disposed) void api.post(`${base}/${sid}/resize`, { cols, rows }).catch(() => {});
      }, 150);
    });
    const observer = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {}
    });
    observer.observe(el);

    // --- Oturum ---
    (async () => {
      try {
        const res = await api.post<{ sessionId: string }>(base, { container, cols: term.cols, rows: term.rows });
        if (disposed) {
          void api.post(`${base}/${res.sessionId}/close`).catch(() => {});
          return;
        }
        sid = res.sessionId;
        es = new EventSource(`/api${base}/${sid}/stream`);
        es.addEventListener("open", () => setState((s) => (s.kind === "connecting" ? { kind: "live" } : s)));
        es.addEventListener("o", (e) => term.write(fromBase64((e as MessageEvent).data)));
        es.addEventListener("exit", (e) => close(t(REASONS[(e as MessageEvent).data] ?? "Terminal kapandı.")));
        // Kısa kopmalarda tarayıcı kendiliğinden yeniden bağlanır (oturum sunucuda 30 sn bekler); kalıcı hata: oturum yok.
        es.onerror = () => {
          if (es?.readyState === EventSource.CLOSED) close(t("Bağlantı koptu."));
        };
        term.focus();
        void flush();
      } catch (err) {
        close(err instanceof Error ? err.message : t("Terminal açılamadı."));
      }
    })();

    return () => {
      disposed = true;
      clearTimeout(resizeTimer);
      observer.disconnect();
      onData.dispose();
      onBinary.dispose();
      onResize.dispose();
      es?.close();
      // Sekme değişince ya da sayfadan çıkınca kabuk konteynerde kalmasın.
      if (sid) void fetch(`/api${base}/${sid}/close`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}", credentials: "same-origin", keepalive: true }).catch(() => {});
      term.dispose();
    };
  }, [appId, container, attempt]);

  return (
    <div className="overflow-hidden rounded-[10px] border border-line bg-[#141315] text-[#d9d6d8]">
      <div className="flex items-center justify-between gap-3 border-b border-white/10 px-4 py-2 text-[12px] text-[#8f8a8e]">
        <span className="truncate font-mono">{container}</span>
        <span className="inline-flex shrink-0 items-center gap-1.5">
          <span className={`size-1.5 rounded-full ${state.kind === "live" ? "bg-[#62c08a]" : state.kind === "connecting" ? "bg-[#d9a441]" : "bg-[#5f5a5e]"}`} />
          {state.kind === "live" ? t("Bağlı") : state.kind === "connecting" ? t("Bağlanıyor...") : t("Bağlantı kapandı")}
        </span>
      </div>
      <div className="relative">
        <div ref={box} className="h-[28rem] px-3 py-2" />
        {state.kind === "closed" && (
          <div className="absolute inset-0 grid place-items-center bg-[#141315]/85 p-6 text-center">
            <div>
              <div className="text-[14px] text-[#d9d6d8]">{state.text}</div>
              <Button className="mt-3" size="sm" onClick={() => setAttempt((n) => n + 1)}>
                {t("Yeniden bağlan")}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
