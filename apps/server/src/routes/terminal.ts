import type { Context } from "hono";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { body, HttpError, idParam, must } from "../lib/http.js";
import type { AppEnv } from "../lib/types.js";
import { secretsVisible } from "../services/access.js";
import { getApp } from "../services/deploy.js";
import { encodeChunk, type EndReason, terminals, type TerminalManager } from "../services/terminal.js";

/**
 * Web terminali uçları (/api/apps/:id/terminal...). Proje erişimi ara katmanı yolu /api/apps/:id ile
 * başladığı için yabancı kullanıcılar zaten 404 alır; burada ayrıca:
 *  - API anahtarına hiç açılmaz (yazma yetkili olsa bile): etkileşimli kabuk gerçek bir panel oturumu ister.
 *  - Yalnız sır görebilenlere (yönetici, proje geliştiricisi) açılır. Çıktı akışı GET olduğu için
 *    genel ara katman izleyiciyi geçirir; kural burada her uçta açıkça uygulanır.
 */
export function terminalAccess(c: Context<AppEnv>, projectId: number) {
  if (c.get("viaToken")) throw new HttpError(403, "Terminal API anahtarıyla açılamaz; panelde oturum açmış olman gerekiyor");
  if (!secretsVisible(c, projectId)) throw new HttpError(403, "Terminal yalnız yöneticiye ve projenin geliştiricilerine açık (konteynerdeki tüm sırları okuyabilir)");
}

function loadApp(c: Context<AppEnv>) {
  const app = must(getApp(idParam(c)), "Uygulama bulunamadı");
  terminalAccess(c, app.project_id);
  return app;
}

const sid = (c: Context) => {
  const v = c.req.param("sid") ?? "";
  if (!/^[\w-]{16,64}$/.test(v)) throw new HttpError(404, "Terminal oturumu bulunamadı ya da kapandı");
  return v;
};

const size = { cols: z.number().int().min(2).max(500), rows: z.number().int().min(1).max(300) };

export function makeTerminalRoutes(mgr: TerminalManager) {
  return (
    new Hono<AppEnv>()
      // Terminal açılabilecek konteynerler (Compose servisleri, kopyalar). Boşsa arayüz nedenini gösterir.
      .get("/:id/terminal", async (c) => {
        const app = loadApp(c);
        const containers = await mgr.containers(app).catch(() => null);
        if (!containers) return c.json({ containers: [], error: "Sunucudaki Docker'a ulaşılamadı" });
        return c.json({ containers, limits: { idleMinutes: Math.round(mgr.limits.idleMs / 60_000) } });
      })

      // Yeni oturum. İşlem kaydına "Terminal açtı" olarak geçer (tuş vuruşları ve çıktı kaydedilmez).
      .post("/:id/terminal", async (c) => {
        const app = loadApp(c);
        const input = await body(c, z.object({ container: z.string().max(200).optional(), ...size }));
        const s = await mgr.create(c.get("user").id, app, input);
        return c.json({ sessionId: s.id, container: s.container }, 201);
      })

      // Çıktı akışı (SSE). "o": base64 ham çıktı, "exit": oturum bitti (neden).
      .get("/:id/terminal/:sid/stream", (c) => {
        const app = loadApp(c);
        const id = sid(c);
        const userId = c.get("user").id;
        let finish!: (reason: EndReason) => void;
        const ended = new Promise<EndReason>((r) => (finish = r));
        // Oturum yoksa SSE açılmadan 404 dönsün (tarayıcı yeniden denemeyi bırakır). Yazmalar sıraya dizilir.
        let write: ((data: string) => Promise<unknown>) | null = null;
        const early: string[] = [];
        let chain: Promise<unknown> = Promise.resolve();
        const detach = mgr.attach(userId, app.id, id, {
          output: (buf) => {
            const data = encodeChunk(buf);
            if (!write) return (early.push(data), Promise.resolve());
            const w = write;
            return (chain = chain.then(() => w(data)));
          },
          end: (reason) => finish(reason),
        });
        return streamSSE(c, async (stream) => {
          const w = (data: string) => stream.writeSSE({ event: "o", data });
          for (const d of early.splice(0)) chain = chain.then(() => w(d));
          write = w;
          stream.onAbort(() => finish("detached"));
          try {
            for (;;) {
              let timer: NodeJS.Timeout | undefined;
              const tick = new Promise<null>((r) => (timer = setTimeout(() => r(null), 15_000)));
              const r = await Promise.race([ended, tick]);
              clearTimeout(timer);
              if (r) {
                await chain.catch(() => {});
                if (!stream.aborted) await stream.writeSSE({ event: "exit", data: r });
                break;
              }
              await stream.writeSSE({ event: "ping", data: "" });
            }
          } finally {
            detach();
          }
        });
      })

      .post("/:id/terminal/:sid/input", async (c) => {
        const app = loadApp(c);
        const { data } = await body(c, z.object({ data: z.string().max(90_000).regex(/^[A-Za-z0-9+/]*={0,2}$/, "Geçersiz girdi") }));
        mgr.input(c.get("user").id, app.id, sid(c), Buffer.from(data, "base64"));
        return c.json({ ok: true });
      })

      .post("/:id/terminal/:sid/resize", async (c) => {
        const app = loadApp(c);
        const input = await body(c, z.object(size));
        await mgr.resize(c.get("user").id, app.id, sid(c), input.cols, input.rows);
        return c.json({ ok: true });
      })

      .post("/:id/terminal/:sid/close", async (c) => {
        const app = loadApp(c);
        await mgr.close(c.get("user").id, app.id, sid(c));
        return c.json({ ok: true });
      })
  );
}

export const terminalRoutes = makeTerminalRoutes(terminals);
