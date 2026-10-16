import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { db } from "../db.js";
import { bus } from "../lib/events.js";
import { body, HttpError, idParam } from "../lib/http.js";
import { encrypt } from "../lib/crypto.js";
import { applyCaddyConfig } from "../services/caddy.js";
import { dockerFor, listContainers, type ServerRow } from "../services/docker.js";
import {
  getServer,
  getServerOverview,
  getServerSecurity,
  hardenServer,
  isSetupRunning,
  listServers,
  sshTargetFor,
  startServerSetup,
  updateServer,
} from "../services/servers.js";
import { generateSshKey, hostKeyFingerprint, sshExec } from "../services/ssh.js";
import { forgetDockerClient } from "../services/docker.js";
import { checkDomain } from "../services/dns-check.js";
import { ensureTunnel, tunnelStatus } from "../services/tunnel.js";

// Alan adı veya IP; boşluk ve satır sonu içeremez (SSH ayar dosyasına yazılıyor).
const HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$|^\[?[0-9a-f:.]+\]?$/i;
const USER = /^[a-z_][a-z0-9_.-]{0,31}$/i;

function publicServer(s: ServerRow) {
  const key = s.ssh_key_id
    ? (db.prepare("SELECT id, name, public_key FROM ssh_keys WHERE id = ?").get(s.ssh_key_id) as { id: number; name: string; public_key: string } | undefined)
    : undefined;
  const usage = db
    .prepare("SELECT (SELECT COUNT(*) FROM apps WHERE server_id = ?) AS apps, (SELECT COUNT(*) FROM databases WHERE server_id = ?) AS dbs")
    .get(s.id, s.id) as { apps: number; dbs: number };
  return {
    id: s.id,
    name: s.name,
    kind: s.kind,
    host: s.host,
    port: s.port,
    username: s.username,
    publicIp: s.public_ip,
    httpsMode: s.https_mode,
    acmeEmail: s.acme_email,
    status: s.status,
    statusDetail: s.status_detail,
    setupRunning: isSetupRunning(s.id),
    sshKey: key ? { id: key.id, name: key.name, publicKey: key.public_key } : null,
    hostKeyFingerprint: s.host_key ? hostKeyFingerprint(s.host_key) : null,
    appsDomain: s.apps_domain,
    tunnelEnabled: Boolean(s.tunnel_token),
    apps: usage.apps,
    databases: usage.dbs,
    createdAt: s.created_at,
  };
}

const serverInput = z.object({
  name: z.string().trim().min(1, "İsim gerekli").max(60),
  host: z.string().trim().min(1, "Adres gerekli").max(255).regex(HOST, "Geçerli bir alan adı veya IP adresi gir"),
  port: z.number().int().min(1).max(65535).default(22),
  username: z.string().trim().min(1).max(32).regex(USER, "Geçersiz kullanıcı adı").default("root"),
  sshKeyId: z.number().int().optional(),
});

const timeout = <T,>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<never>((_, r) => setTimeout(() => r(new Error("Sunucu yanıt vermedi")), ms))]);

export const serverRoutes = new Hono()
  .get("/", (c) => c.json({ servers: listServers().map(publicServer) }))

  // Tüm sunucuların anlık durumu; biri yavaşsa diğerlerini bekletmez.
  .get("/overview", async (c) => {
    const servers = listServers();
    const results = await Promise.all(
      servers.map(async (s) => {
        if (s.kind === "ssh" && s.status !== "ready") {
          return { ...publicServer(s), stats: null, statsError: null, docker: { available: false, error: "Kurulum tamamlanmadı" } };
        }
        try {
          return { ...publicServer(s), ...(await timeout(getServerOverview(s), 6_000)) };
        } catch (err) {
          return { ...publicServer(s), stats: null, statsError: (err as Error).message, docker: { available: false, error: (err as Error).message } };
        }
      }),
    );
    return c.json({ servers: results });
  })

  .post("/", async (c) => {
    const input = await body(c, serverInput);
    let keyId = input.sshKeyId;
    if (keyId) {
      if (!db.prepare("SELECT 1 FROM ssh_keys WHERE id = ?").get(keyId)) throw new HttpError(404, "SSH anahtarı bulunamadı");
    } else {
      keyId = generateSshKey(input.name).id;
    }
    const res = db
      .prepare(
        `INSERT INTO servers (name, kind, host, port, username, ssh_key_id, public_ip, status, created_at)
         VALUES (?, 'ssh', ?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .run(input.name, input.host, input.port, input.username, keyId, /^\d+\.\d+\.\d+\.\d+$/.test(input.host) ? input.host : null, Date.now());
    return c.json({ server: publicServer(getServer(Number(res.lastInsertRowid))) }, 201);
  })

  .get("/:id", (c) => {
    const s = getServer(idParam(c));
    return c.json({ server: publicServer(s), setupLog: s.setup_log });
  })

  .patch("/:id", async (c) => {
    const s = getServer(idParam(c));
    const input = await body(
      c,
      z.object({
        name: z.string().trim().min(1).max(60).optional(),
        host: z.string().trim().min(1).max(255).regex(HOST, "Geçerli bir alan adı veya IP adresi gir").optional(),
        port: z.number().int().min(1).max(65535).optional(),
        username: z.string().trim().min(1).max(32).regex(USER, "Geçersiz kullanıcı adı").optional(),
        sshKeyId: z.number().int().optional(),
        publicIp: z.union([z.ipv4(), z.literal("")]).optional(),
        httpsMode: z.enum(["auto", "internal", "off"]).optional(),
        acmeEmail: z.union([z.email(), z.literal("")]).optional(),
        appsDomain: z.union([z.string().trim().toLowerCase().regex(/^([a-z0-9-]+\.)+[a-z]{2,63}$/, "Geçerli bir alan adı gir (ör. apps.ornek.com)"), z.literal("")]).optional(),
        tunnelToken: z.string().trim().max(2000).nullable().optional(),
      }),
    );
    if (s.kind === "local" && (input.host || input.port || input.username || input.sshKeyId))
      throw new HttpError(422, "Yerel sunucunun bağlantı bilgileri değiştirilemez");
    updateServer(s.id, {
      name: input.name,
      host: input.host,
      port: input.port,
      username: input.username,
      ssh_key_id: input.sshKeyId,
      public_ip: input.publicIp === "" ? null : input.publicIp,
      https_mode: input.httpsMode,
      acme_email: input.acmeEmail === "" ? null : input.acmeEmail,
      apps_domain: input.appsDomain === undefined ? undefined : input.appsDomain || null,
      tunnel_token: input.tunnelToken === undefined ? undefined : input.tunnelToken ? encrypt(input.tunnelToken) : null,
    });
    // Adres değiştiyse kayıtlı SSH anahtarı artık başka bir makineye ait; yeni bağlantıda yeniden kaydedilir.
    if ((input.host && input.host !== s.host) || (input.port && input.port !== s.port)) {
      db.prepare("UPDATE servers SET host_key = NULL WHERE id = ?").run(s.id);
      forgetDockerClient(s.id);
    }
    const updated = getServer(s.id);
    if (updated.status === "ready" && input.tunnelToken !== undefined) {
      try {
        await ensureTunnel(updated);
      } catch (err) {
        throw new HttpError(500, `Tunnel başlatılamadı: ${(err as Error).message}`);
      }
      await applyCaddyConfig(updated);
    }
    if (updated.status === "ready" && (input.httpsMode || input.acmeEmail !== undefined)) await applyCaddyConfig(updated);
    return c.json({ server: publicServer(updated) });
  })

  .delete("/:id", (c) => {
    const s = getServer(idParam(c));
    if (s.kind === "local") throw new HttpError(422, "Panelin çalıştığı sunucu silinemez");
    const p = publicServer(s);
    if (p.apps || p.databases) throw new HttpError(409, "Önce bu sunucudaki uygulamaları ve veritabanlarını sil veya taşı");
    db.prepare("DELETE FROM servers WHERE id = ?").run(s.id);
    return c.json({ ok: true });
  })

  .post("/:id/test", async (c) => {
    const s = getServer(idParam(c));
    if (s.kind === "local") return c.json({ ok: true, output: "Yerel sunucu" });
    try {
      const res = await sshExec(sshTargetFor(s), "uname -sr; (. /etc/os-release && echo $PRETTY_NAME); command -v docker >/dev/null && docker --version || echo 'Docker kurulu değil'", {
        timeoutMs: 20_000,
      });
      return c.json({ ok: res.code === 0, output: res.stdout.trim() || res.stderr.trim() });
    } catch (err) {
      return c.json({ ok: false, output: (err as Error).message });
    }
  })

  .post("/:id/setup", (c) => {
    const id = idParam(c);
    getServer(id);
    startServerSetup(id);
    return c.json({ ok: true });
  })

  .get("/:id/setup/stream", (c) => {
    const id = idParam(c);
    const s = getServer(id);
    return streamSSE(c, async (stream) => {
      await stream.writeSSE({ event: "snapshot", data: JSON.stringify({ log: s.setup_log, running: isSetupRunning(id) }) });
      const channel = `server-setup:${id}`;
      const onLine = (line: string) => {
        void stream.writeSSE(line === "__done__" ? { event: "done", data: "" } : { event: "line", data: line });
      };
      bus.on(channel, onLine);
      stream.onAbort(() => {
        bus.off(channel, onLine);
      });
      while (!stream.aborted) await stream.sleep(15_000).then(() => stream.writeSSE({ event: "ping", data: "" }));
    });
  })

  // Sunucu yeniden kurulduysa: kayıtlı SSH anahtarı silinir, bir sonraki bağlantıda yenisi kaydedilir.
  // Wildcard alan adı testi: rastgele bir alt alan adı sunucunun IP'sine çözülüyor mu?
  .post("/:id/apps-domain/check", async (c) => {
    const s = getServer(idParam(c));
    const { domain } = await body(c, z.object({ domain: z.string().trim().toLowerCase().regex(/^([a-z0-9-]+\.)+[a-z]{2,63}$/) }));
    const probe = `xudbin-test-${Math.random().toString(36).slice(2, 8)}.${domain}`;
    const r = await checkDomain(probe, s.public_ip);
    return c.json({ ...r, message: r.ok ? `*.${domain} bu sunucuyu gösteriyor.` : r.reason === "missing" ? `*.${domain} için wildcard A kaydı yok. Alan adı sağlayıcında "*.${domain}" → ${s.public_ip ?? "sunucunun IP'si"} kaydını ekle.` : r.message });
  })

  .get("/:id/tunnel", async (c) => c.json(await tunnelStatus(getServer(idParam(c))).catch(() => ({ enabled: false, running: false, logs: [] }))))

  .post("/:id/reset-host-key", (c) => {
    const s = getServer(idParam(c));
    db.prepare("UPDATE servers SET host_key = NULL WHERE id = ?").run(s.id);
    forgetDockerClient(s.id);
    return c.json({ ok: true });
  })

  .post("/:id/harden", (c) => {
    const s = getServer(idParam(c));
    if (isSetupRunning(s.id)) throw new HttpError(409, "Kurulum çalışırken sıkılaştırma yapılamaz");
    hardenServer(s).catch((err) => bus.emit(`server-setup:${s.id}`, `Hata: ${(err as Error).message}`));
    return c.json({ ok: true });
  })

  .get("/:id/security", async (c) => {
    const s = getServer(idParam(c));
    try {
      return c.json({ security: await getServerSecurity(s) });
    } catch (err) {
      return c.json({ security: null, error: (err as Error).message });
    }
  })

  .get("/:id/stats", async (c) => {
    const s = getServer(idParam(c));
    return c.json(await getServerOverview(s));
  })

  .get("/:id/containers", async (c) => {
    const s = getServer(idParam(c));
    try {
      return c.json({ containers: await listContainers(dockerFor(s)) });
    } catch (err) {
      throw new HttpError(503, `Docker'a bağlanılamadı: ${(err as Error).message}`);
    }
  });

export const sshKeyRoutes = new Hono()
  .get("/", (c) => {
    const keys = db
      .prepare(
        `SELECT k.id, k.name, k.public_key AS publicKey, k.created_at AS createdAt,
                (SELECT COUNT(*) FROM servers s WHERE s.ssh_key_id = k.id) AS servers
         FROM ssh_keys k ORDER BY k.id DESC`,
      )
      .all();
    return c.json({ keys });
  })
  .post("/", async (c) => {
    const { name } = await body(c, z.object({ name: z.string().trim().min(1).max(60) }));
    return c.json({ key: generateSshKey(name) }, 201);
  })
  .delete("/:id", (c) => {
    const id = idParam(c);
    const used = db.prepare("SELECT COUNT(*) AS n FROM servers WHERE ssh_key_id = ?").get(id) as { n: number };
    if (used.n) throw new HttpError(409, "Bu anahtarı kullanan sunucular var");
    db.prepare("DELETE FROM ssh_keys WHERE id = ?").run(id);
    return c.json({ ok: true });
  });
