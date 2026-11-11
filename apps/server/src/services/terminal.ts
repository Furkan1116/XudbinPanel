import { randomBytes } from "node:crypto";
import type { Duplex } from "node:stream";
import { HttpError } from "../lib/http.js";
import type { AppRow } from "./deploy.js";
import { containerState, dockerFor, execIn, withTimeout } from "./docker.js";
import { getServer } from "./servers.js";

/**
 * Web terminali: uygulamanın çalışan konteynerinde TTY'li bir `docker exec` kabuğu.
 *
 * Oturumlar bellekte tutulur, tahmin edilemez bir kimlikle (kullanıcı, uygulama) ikilisine bağlıdır.
 * Çıktı SSE ile (base64), girdi/boyut/kapatma ayrı POST istekleriyle gelir; böylece her istek panelin
 * olağan kimlik, CSRF, rol, proje erişimi ve işlem kaydı ara katmanlarından geçer.
 *
 * Oturum şu durumlarda biter: kabuk çıkar, istemci kapatır, SSE bağlantısı kısa bir süre kopuk kalır,
 * uzun süre girdi gelmez ya da en uzun süre dolar. Her bitişte konteynerdeki süreç de öldürülür.
 */

export type TerminalLimits = {
  /** Kullanıcı başına eş zamanlı oturum. */
  perUser: number;
  /** Panel genelinde eş zamanlı oturum. */
  global: number;
  /** Girdi gelmezse oturum bu kadar sonra kapanır. */
  idleMs: number;
  /** Oturumun en uzun ömrü. */
  maxMs: number;
  /** Çıktı akışı (SSE) bu kadar süre bağlı değilse oturum kapanır. */
  graceMs: number;
  /** Akış bağlı değilken biriktirilen en fazla çıktı (bayt); fazlası en eskiden atılır. */
  bufferBytes: number;
};

export const DEFAULT_LIMITS: TerminalLimits = {
  perUser: 3,
  global: 20,
  idleMs: 15 * 60_000,
  maxMs: 4 * 3_600_000,
  graceMs: 30_000,
  bufferBytes: 256 * 1024,
};

/** "replaced": oturum başka bir sekmede/bağlantıda açıldı (oturum sürer, yalnız eski akış kapanır). */
export type EndReason = "exit" | "closed" | "idle" | "max" | "detached" | "error" | "shutdown" | "replaced";

export type TerminalContainer = { name: string; label: string };

/** Konteynerde açılmış bir TTY'li süreç. */
export interface ExecHandle {
  /** Ham TTY akışı: okunan çıktı, yazılan girdi. */
  stream: Duplex;
  resize(cols: number, rows: number): Promise<void>;
  /** Süreci (ve alt süreçlerini) konteynerde öldürür; akış kapatmak her zaman yetmez. */
  kill(): Promise<void>;
}

/** Docker'a dokunan kısım; testlerde sahtesi verilir. */
export interface TerminalBackend {
  /** Terminal açılabilecek (çalışan) konteynerler; ilk eleman varsayılan. */
  containers(app: AppRow): Promise<TerminalContainer[]>;
  open(app: AppRow, container: string, opts: { id: string; cols: number; rows: number }): Promise<ExecHandle>;
}

/** SSE olayına konacak çıktı parçası: ham baytlar base64 (kaçış dizileri, yarım UTF-8, satır sonları bozulmasın). */
export function encodeChunk(buf: Buffer) {
  return buf.toString("base64");
}

/** Büyük parçaları SSE olaylarına bölmek için (her olay en fazla `max` bayt ham veri taşır). */
export function splitChunk(buf: Buffer, max = 32 * 1024): Buffer[] {
  if (buf.length <= max) return [buf];
  const out: Buffer[] = [];
  for (let i = 0; i < buf.length; i += max) out.push(buf.subarray(i, i + max));
  return out;
}

export type Subscriber = {
  /** Çıktıyı istemciye yazar; dönen söz yazma bitince çözülür (geri basınç için). */
  output(chunk: Buffer): Promise<unknown>;
  end(reason: EndReason): void;
};

type Session = {
  id: string;
  userId: number;
  appId: number;
  container: string;
  handle: ExecHandle;
  createdAt: number;
  lastInput: number;
  sub: Subscriber | null;
  buffer: Buffer[];
  buffered: number;
  pending: number;
  ended: EndReason | null;
  idleTimer?: NodeJS.Timeout;
  maxTimer?: NodeJS.Timeout;
  graceTimer?: NodeJS.Timeout;
};

/** Kabuk: bash varsa bash, yoksa sh. */
export const SHELL_CMD = ["sh", "-c", "if command -v bash >/dev/null 2>&1; then exec bash; else exec sh; fi"];
/** Oturumun süreçlerini konteyner içinde bulmak için ortam değişkeni. */
export const SESSION_ENV = "XUDBIN_TERMINAL";

/** Geri basınç: istemciye yazılmayı bekleyen bu kadar olay birikirse konteyner çıktısı duraklatılır. */
const MAX_PENDING = 64;

export class TerminalManager {
  private sessions = new Map<string, Session>();

  constructor(
    private backend: TerminalBackend,
    readonly limits: TerminalLimits = DEFAULT_LIMITS,
  ) {}

  get size() {
    return this.sessions.size;
  }

  containers(app: AppRow) {
    return this.backend.containers(app);
  }

  async create(userId: number, app: AppRow, opts: { container?: string; cols: number; rows: number }) {
    if (this.countFor(userId) >= this.limits.perUser) {
      throw new HttpError(429, `Aynı anda en fazla ${this.limits.perUser} terminal açabilirsin; açık olanlardan birini kapat`);
    }
    if (this.sessions.size >= this.limits.global) throw new HttpError(503, "Panelde açık terminal sayısı sınıra ulaştı; biraz sonra tekrar dene");

    const list = await this.backend.containers(app);
    if (!list.length) throw new HttpError(409, "Uygulamanın çalışan bir konteyneri yok; önce deploy et ya da başlat");
    // Yalnız bu uygulamaya ait listedeki konteynerler: istemci başka bir konteyner adı veremez.
    const target = opts.container ? list.find((c) => c.name === opts.container) : list[0];
    if (!target) throw new HttpError(404, "Konteyner bulunamadı ya da çalışmıyor");

    const id = randomBytes(24).toString("base64url");
    // Docker beklenirken başka istek sınırı aşmasın diye yer önceden ayrılır.
    const placeholder = { id, userId, appId: app.id } as Session;
    this.sessions.set(id, placeholder);
    let handle: ExecHandle;
    try {
      handle = await this.backend.open(app, target.name, { id, cols: opts.cols, rows: opts.rows });
    } catch (err) {
      this.sessions.delete(id);
      throw err;
    }
    const now = Date.now();
    const s: Session = Object.assign(placeholder, {
      container: target.name,
      handle,
      createdAt: now,
      lastInput: now,
      sub: null,
      buffer: [],
      buffered: 0,
      pending: 0,
      ended: null,
    });
    handle.stream.on("data", (chunk: Buffer) => this.onOutput(s, chunk));
    handle.stream.on("end", () => void this.end(s, "exit"));
    handle.stream.on("close", () => void this.end(s, "exit"));
    handle.stream.on("error", () => void this.end(s, "error"));
    s.maxTimer = setTimeout(() => void this.end(s, "max"), this.limits.maxMs);
    s.maxTimer.unref?.();
    this.touchIdle(s);
    this.startGrace(s);
    return { id, container: target.name };
  }

  /** Oturum yalnız sahibi ve aynı uygulama için görünür; aksi halde "yok". */
  private get(userId: number, appId: number, id: string) {
    const s = this.sessions.get(id);
    if (!s || !s.handle || s.ended || s.userId !== userId || s.appId !== appId) throw new HttpError(404, "Terminal oturumu bulunamadı ya da kapandı");
    return s;
  }

  /** Çıktı akışını bağlar. Önceki bağlantı varsa düşürülür; bağlı değilken biriken çıktı önce gönderilir. */
  attach(userId: number, appId: number, id: string, sub: Subscriber) {
    const s = this.get(userId, appId, id);
    if (s.sub) s.sub.end("replaced");
    s.sub = sub;
    clearTimeout(s.graceTimer);
    s.graceTimer = undefined;
    const backlog = s.buffer;
    s.buffer = [];
    s.buffered = 0;
    for (const b of backlog) this.deliver(s, b);
    return () => this.detach(s, sub);
  }

  private detach(s: Session, sub: Subscriber) {
    if (s.sub !== sub) return;
    s.sub = null;
    if (!s.ended) this.startGrace(s);
  }

  input(userId: number, appId: number, id: string, data: Buffer) {
    const s = this.get(userId, appId, id);
    s.lastInput = Date.now();
    this.touchIdle(s);
    s.handle.stream.write(data);
  }

  async resize(userId: number, appId: number, id: string, cols: number, rows: number) {
    const s = this.get(userId, appId, id);
    await s.handle.resize(cols, rows).catch(() => {});
  }

  async close(userId: number, appId: number, id: string) {
    const s = this.get(userId, appId, id);
    await this.end(s, "closed");
  }

  /** Panel kapanırken: tüm kabukları öldür. */
  async closeAll() {
    await Promise.all([...this.sessions.values()].filter((s) => s.handle).map((s) => this.end(s, "shutdown")));
  }

  private countFor(userId: number) {
    let n = 0;
    for (const s of this.sessions.values()) if (s.userId === userId) n++;
    return n;
  }

  private onOutput(s: Session, chunk: Buffer) {
    if (s.ended) return;
    if (s.sub) return this.deliver(s, chunk);
    s.buffer.push(chunk);
    s.buffered += chunk.length;
    while (s.buffered > this.limits.bufferBytes && s.buffer.length > 1) s.buffered -= s.buffer.shift()!.length;
  }

  private deliver(s: Session, chunk: Buffer) {
    const sub = s.sub!;
    for (const part of splitChunk(chunk)) {
      s.pending++;
      if (s.pending === MAX_PENDING) s.handle.stream.pause();
      void Promise.resolve(sub.output(part))
        .catch(() => {})
        .finally(() => {
          s.pending--;
          if (s.pending === MAX_PENDING / 2 && !s.ended) s.handle.stream.resume();
        });
    }
  }

  private touchIdle(s: Session) {
    clearTimeout(s.idleTimer);
    s.idleTimer = setTimeout(() => void this.end(s, "idle"), this.limits.idleMs);
    s.idleTimer.unref?.();
  }

  private startGrace(s: Session) {
    clearTimeout(s.graceTimer);
    s.graceTimer = setTimeout(() => void this.end(s, "detached"), this.limits.graceMs);
    s.graceTimer.unref?.();
  }

  private async end(s: Session, reason: EndReason) {
    if (s.ended) return;
    s.ended = reason;
    this.sessions.delete(s.id);
    clearTimeout(s.idleTimer);
    clearTimeout(s.maxTimer);
    clearTimeout(s.graceTimer);
    s.buffer = [];
    const sub = s.sub;
    s.sub = null;
    sub?.end(reason);
    try {
      s.handle.stream.destroy();
    } catch {}
    // Bağlantıyı kapatmak süreci her zaman sonlandırmaz (Docker exec'i öldürmez); kabuk konteynerde kalmasın.
    await s.handle.kill().catch((err) => console.error(`Terminal süreci sonlandırılamadı (${s.container}):`, (err as Error).message));
  }
}

/**
 * Konteyner içinde, ortamında XUDBIN_TERMINAL=<kimlik> olan tüm süreçleri (kabuk ve ondan başlatılan her şey)
 * önce HUP/TERM ile, kalırsa KILL ile sonlandıran komut. Yalnız POSIX sh ve cat gerekir (busybox dahil).
 */
export function killScript(id: string) {
  if (!/^[\w-]+$/.test(id)) throw new Error("Geçersiz oturum kimliği");
  const marker = `${SESSION_ENV}=${id}`;
  // environ NUL ile ayrılır; tr/grep varsa satır satır tam eşleşme, yoksa düz sh ile (NUL'lar atılarak) içerik eşleşmesi.
  const match = `if command -v tr >/dev/null 2>&1 && command -v grep >/dev/null 2>&1; then m() { tr '\\000' '\\n' < "$1/environ" 2>/dev/null | grep -qxF '${marker}'; }; else m() { case "$(cat "$1/environ" 2>/dev/null)" in *'${marker}'*) return 0;; esac; return 1; }; fi`;
  const find = `p=""; for d in /proc/[0-9]*; do n=\${d#/proc/}; [ "$n" = "$$" ] && continue; m "$d" && p="$p $n"; done`;
  return `${match}; ${find}; [ -z "$p" ] && exit 0; kill -HUP $p 2>/dev/null; kill -TERM $p 2>/dev/null; sleep 1; ${find}; [ -n "$p" ] && kill -KILL $p 2>/dev/null; exit 0`;
}

/** Gerçek Docker arka ucu: uygulamanın sunucusundaki Docker (yerel soket ya da SSH). */
export const dockerTerminalBackend: TerminalBackend = {
  async containers(app) {
    const docker = dockerFor(getServer(app.server_id));
    // Log görüntüleyiciyle aynı kaynaklar: Compose projesinin konteynerleri ya da ana konteyner + kopyalar.
    if (app.source_type === "compose") {
      const list = await withTimeout(docker.listContainers({ filters: { label: [`com.docker.compose.project=xb-${app.slug}`], status: ["running"] } }), 10_000);
      return list
        .map((ct) => ({ name: ct.Names[0]!.slice(1), label: ct.Labels?.["com.docker.compose.service"] ?? ct.Names[0]!.slice(1) }))
        .sort((a, b) => a.label.localeCompare(b.label));
    }
    if (!app.container) return [];
    const names = [app.container, ...(JSON.parse(app.replica_containers || "[]") as string[])];
    const out: TerminalContainer[] = [];
    for (const name of names) {
      const st = await withTimeout(containerState(docker, name), 10_000).catch(() => null);
      if (st?.running) out.push({ name, label: name === app.container ? name : name.replace(`xb-${app.slug}-`, "") });
    }
    return out;
  },

  async open(app, container, { id, cols, rows }) {
    const docker = dockerFor(getServer(app.server_id));
    const exec = await withTimeout(
      docker.getContainer(container).exec({
        Cmd: SHELL_CMD,
        AttachStdin: true,
        AttachStdout: true,
        AttachStderr: true,
        Tty: true,
        Env: ["TERM=xterm-256color", "COLORTERM=truecolor", `${SESSION_ENV}=${id}`],
      }),
      15_000,
    );
    const stream = (await withTimeout(exec.start({ hijack: true, stdin: true, Tty: true }), 15_000)) as Duplex;
    const resize = async (w: number, h: number) => {
      await withTimeout(exec.resize({ w, h }), 5_000);
    };
    await resize(cols, rows).catch(() => {});
    return {
      stream,
      resize,
      async kill() {
        const info = await withTimeout(exec.inspect(), 5_000).catch(() => null);
        if (info && !info.Running) return;
        // Konteyner bu arada durduysa/silindiyse süreç de gitmiştir.
        const st = await containerState(docker, container);
        if (!st.running) return;
        await execIn(docker, container, ["sh", "-c", killScript(id)], { timeoutMs: 15_000 });
      },
    };
  },
};

export const terminals = new TerminalManager(dockerTerminalBackend);
