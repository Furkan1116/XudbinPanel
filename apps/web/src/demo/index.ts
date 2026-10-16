/**
 * Demo modu (VITE_DEMO=1): arka uç yok; /api istekleri tarayıcıda örnek verilerle yanıtlanır,
 * log akışları (SSE) taklit edilir, değişiklik isteyen her işlem nazik bir uyarıyla reddedilir.
 * main.tsx bu modülü yalnız demo derlemesinde dinamik olarak yükler.
 */
import { toast } from "@/components/ui/toast";
import * as D from "./data";
import { demoMessage, handle } from "./routes";

const API = "/api";

function apiPath(input: RequestInfo | URL): string | null {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(raw, location.href);
  if (url.origin !== location.origin || !url.pathname.startsWith(`${API}/`)) return null;
  return url.pathname.slice(API.length) + url.search;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function installFetch() {
  const real = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const path = apiPath(input);
    if (path === null) return real(input, init);
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    let body: unknown = undefined;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {}
    }
    await wait(method === "GET" ? 60 + Math.random() * 140 : 250 + Math.random() * 250);
    const res = await handle(method, path, body);
    return new Response(JSON.stringify(res.body), { status: res.status, headers: { "content-type": "application/json" } });
  };
}

/** LogViewer'ın beklediği "snapshot" / "line" / "done" olaylarını üreten sahte EventSource. */
class DemoEventSource extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSED = 2;
  readyState = 0;
  withCredentials = false;
  onerror: ((e: Event) => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onopen: ((e: Event) => void) | null = null;
  private timers: number[] = [];
  private real?: EventSource;

  constructor(
    public readonly url: string,
    init?: EventSourceInit,
  ) {
    super();
    const path = apiPath(url);
    if (path === null) {
      this.real = new RealEventSource(url, init);
      return;
    }
    this.readyState = 1;
    this.later(() => this.run(path), 150);
  }

  private later(fn: () => void, ms: number) {
    this.timers.push(window.setTimeout(fn, ms));
  }
  private emit(type: string, data: string) {
    if (this.readyState === 2) return;
    this.dispatchEvent(new MessageEvent(type, { data }));
  }
  private snapshot(log: string) {
    this.emit("snapshot", JSON.stringify({ log }));
  }

  private run(path: string) {
    let m: RegExpMatchArray | null;
    if ((m = path.match(/^\/deployments\/(\d+)\/stream/))) {
      // Bitmiş deploy'un logu satır satır yeniden oynatılır.
      const dep = D.deployments.find((d) => d.id === Number(m![1]));
      const lines = (dep?.log ?? "").split("\n");
      this.snapshot("");
      let at = 40;
      for (const l of lines) this.later(() => this.emit("line", l), (at += l.startsWith("#") ? 60 : 130));
      this.later(() => this.emit("done", "{}"), at + 150);
      return;
    }
    if ((m = path.match(/^\/apps\/(\d+)\/logs\/stream/))) {
      const id = Number(m[1]);
      this.snapshot(D.appLogSnapshot(id));
      const app = D.apps.find((a) => a.id === id);
      if (app?.status !== "running") return;
      const r = D.rng(id * 1000 + Date.now());
      const tick = () => {
        this.emit("line", D.appLogLine(id, r));
        this.later(tick, 1200 + r() * 2800);
      };
      this.later(tick, 1500);
      return;
    }
    if ((m = path.match(/^\/databases\/(\d+)\/logs\/stream/))) {
      this.snapshot(D.dbLogSnapshot(Number(m[1])));
      return;
    }
    if ((m = path.match(/^\/servers\/(\d+)\/setup\/stream/))) {
      this.snapshot(D.serverSetupLog(Number(m[1])));
      this.later(() => this.emit("done", "{}"), 100);
      return;
    }
    console.warn(`[demo] Örnek akışı olmayan istek: ${path}`);
    this.later(() => this.emit("done", "{}"), 50);
  }

  close() {
    this.readyState = 2;
    this.timers.forEach(clearTimeout);
    this.timers = [];
    this.real?.close();
  }
}

const RealEventSource = window.EventSource;

/** /api/... indirme bağlantıları (yedek indir vb.) demo'da çalışmaz; tıklanınca uyarı gösterilir. */
function installLinkGuard() {
  document.addEventListener(
    "click",
    (e) => {
      const a = (e.target as Element | null)?.closest?.("a[href]");
      if (!a) return;
      if (apiPath((a as HTMLAnchorElement).href) === null) return;
      e.preventDefault();
      toast(demoMessage(), "error");
    },
    true,
  );
}

export function installDemo() {
  installFetch();
  window.EventSource = DemoEventSource as unknown as typeof EventSource;
  installLinkGuard();
  // Hata yakalanmadan bırakılan demo reddi (ör. doğrudan api.patch çağrısı) yine uyarı olarak görünsün.
  window.addEventListener("unhandledrejection", (e) => {
    if ((e.reason as { data?: { demo?: boolean } } | null)?.data?.demo) {
      e.preventDefault();
      toast(demoMessage(), "error");
    }
  });
}
