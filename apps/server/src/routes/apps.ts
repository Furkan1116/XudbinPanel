import bcrypt from "bcryptjs";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { db } from "../db.js";
import { decrypt, encrypt, randomAlnum, randomToken } from "../lib/crypto.js";
import { bus } from "../lib/events.js";
import { body, HttpError, idParam, must } from "../lib/http.js";
import { makeSlug } from "../lib/slug.js";
import { applyCaddyConfig, parseSecurity } from "../services/caddy.js";
import {
  cancelDeployment,
  composeCommand,
  demuxLogs,
  enqueueDeploy,
  getApp,
  type AppRow,
} from "../services/deploy.js";
import { dockerFor, removeContainer, type ServerRow } from "../services/docker.js";
import { getServer } from "../services/servers.js";

const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

export function generatedHost(slug: string, server: ServerRow) {
  if (!server.public_ip) return null;
  return `${slug}.${server.public_ip.replace(/\./g, "-")}.sslip.io`;
}

function publicApp(a: AppRow) {
  const server = getServer(a.server_id);
  const domains = db.prepare("SELECT id, host, https, generated, created_at AS createdAt FROM domains WHERE app_id = ? ORDER BY generated DESC, id").all(a.id) as {
    id: number;
    host: string;
    https: number;
    generated: number;
  }[];
  const sec = parseSecurity(a.security);
  const httpsActive = server.https_mode !== "off";
  return {
    id: a.id,
    projectId: a.project_id,
    server: { id: server.id, name: server.name, status: server.status },
    name: a.name,
    slug: a.slug,
    sourceType: a.source_type,
    gitUrl: a.git_url,
    gitBranch: a.git_branch,
    hasGitToken: Boolean(a.git_token),
    buildType: a.build_type,
    dockerfilePath: a.dockerfile_path,
    buildContext: a.build_context,
    image: a.image,
    composeFile: a.compose_file,
    composeService: a.compose_service,
    port: a.port,
    command: a.command,
    volumes: JSON.parse(a.volumes || "[]"),
    autoDeploy: Boolean(a.auto_deploy),
    status: a.status,
    container: a.container,
    currentImage: a.current_image,
    internalHost: `xb-${a.slug}`,
    webhookPath: `/api/webhooks/deploy/${a.webhook_token}`,
    domains: domains.map((d) => ({ ...d, https: Boolean(d.https) && httpsActive, generated: Boolean(d.generated), url: `${d.https && httpsActive ? "https" : "http"}://${d.host}` })),
    security: { ...sec, basicAuth: sec.basicAuth ? { username: sec.basicAuth.username } : null },
    createdAt: a.created_at,
  };
}

const appInput = z.object({
  projectId: z.number().int(),
  serverId: z.number().int(),
  name: z.string().trim().min(1, "İsim gerekli").max(60),
  sourceType: z.enum(["git", "image", "compose"]),
  gitUrl: z.string().trim().max(500).optional(),
  gitBranch: z.string().trim().max(200).optional(),
  gitToken: z.string().max(500).optional(),
  buildType: z.enum(["auto", "dockerfile", "static"]).optional(),
  image: z.string().trim().max(300).optional(),
  composeFile: z.string().max(100_000).optional(),
  port: z.number().int().min(1).max(65535).optional(),
});

function validateSource(a: { sourceType: string; gitUrl?: string | null; image?: string | null; composeFile?: string | null }) {
  if (a.sourceType === "git" && !a.gitUrl) throw new HttpError(400, "Git adresi gerekli");
  if (a.gitUrl && !/^https:\/\/[^\s]+$/.test(a.gitUrl)) throw new HttpError(400, "Git adresi https:// ile başlamalı");
  if (a.sourceType === "image" && !a.image) throw new HttpError(400, "Docker imajı gerekli");
  if (a.sourceType === "compose" && !a.gitUrl && !a.composeFile?.trim()) throw new HttpError(400, "Compose dosyası veya git adresi gerekli");
}

function loadApp(id: number) {
  return must(getApp(id), "Uygulama bulunamadı");
}

export const appRoutes = new Hono()
  .post("/", async (c) => {
    const input = await body(c, appInput);
    must(db.prepare("SELECT id FROM projects WHERE id = ?").get(input.projectId), "Proje bulunamadı");
    const server = getServer(input.serverId);
    validateSource(input);

    const slug = makeSlug(input.name);
    const res = db
      .prepare(
        `INSERT INTO apps (project_id, server_id, name, slug, source_type, git_url, git_branch, git_token, build_type,
                           image, compose_file, port, webhook_token, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.projectId,
        server.id,
        input.name,
        slug,
        input.sourceType,
        input.gitUrl || null,
        input.gitBranch || "main",
        input.gitToken ? encrypt(input.gitToken) : null,
        input.buildType ?? "auto",
        input.image || null,
        input.composeFile || null,
        input.port ?? (input.sourceType === "image" ? 80 : 3000),
        randomToken(24),
        Date.now(),
      );
    const id = Number(res.lastInsertRowid);

    // Domain almadan önce de çalışan bir adres: <slug>.<ip>.sslip.io
    const host = generatedHost(slug, server);
    if (host) {
      db.prepare("INSERT INTO domains (app_id, host, https, generated, created_at) VALUES (?, ?, ?, 1, ?)").run(
        id,
        host,
        server.https_mode === "off" ? 0 : 1,
        Date.now(),
      );
    }
    return c.json({ app: publicApp(loadApp(id)) }, 201);
  })

  .get("/:id", (c) => {
    const app = loadApp(idParam(c));
    const deployments = db
      .prepare("SELECT id, status, trigger, title, commit_sha AS commitSha, image, started_at AS startedAt, finished_at AS finishedAt FROM deployments WHERE app_id = ? ORDER BY id DESC LIMIT 30")
      .all(app.id);
    return c.json({ app: publicApp(app), env: decrypt(app.env), deployments });
  })

  .patch("/:id", async (c) => {
    const app = loadApp(idParam(c));
    const input = await body(
      c,
      z.object({
        name: z.string().trim().min(1).max(60).optional(),
        gitUrl: z.string().trim().max(500).nullable().optional(),
        gitBranch: z.string().trim().min(1).max(200).optional(),
        gitToken: z.string().max(500).nullable().optional(),
        buildType: z.enum(["auto", "dockerfile", "static"]).optional(),
        dockerfilePath: z.string().trim().min(1).max(300).optional(),
        buildContext: z.string().trim().min(1).max(300).optional(),
        image: z.string().trim().max(300).nullable().optional(),
        composeFile: z.string().max(100_000).nullable().optional(),
        composeService: z.string().trim().max(100).nullable().optional(),
        port: z.number().int().min(1).max(65535).optional(),
        command: z.string().max(2000).nullable().optional(),
        autoDeploy: z.boolean().optional(),
        volumes: z
          .array(z.object({ name: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,40}$/i, "Volume adı yalnız harf, rakam, - ve _ içerebilir"), path: z.string().startsWith("/", "Yol / ile başlamalı").max(300) }))
          .max(20)
          .optional(),
      }),
    );
    const next = {
      sourceType: app.source_type,
      gitUrl: input.gitUrl === undefined ? app.git_url : input.gitUrl,
      image: input.image === undefined ? app.image : input.image,
      composeFile: input.composeFile === undefined ? app.compose_file : input.composeFile,
    };
    validateSource(next);

    const map: Record<string, unknown> = {
      name: input.name,
      git_url: input.gitUrl,
      git_branch: input.gitBranch,
      git_token: input.gitToken === undefined ? undefined : input.gitToken ? encrypt(input.gitToken) : null,
      build_type: input.buildType,
      dockerfile_path: input.dockerfilePath,
      build_context: input.buildContext,
      image: input.image,
      compose_file: input.composeFile,
      compose_service: input.composeService,
      port: input.port,
      command: input.command,
      auto_deploy: input.autoDeploy === undefined ? undefined : input.autoDeploy ? 1 : 0,
      volumes: input.volumes ? JSON.stringify(input.volumes) : undefined,
    };
    const entries = Object.entries(map).filter(([, v]) => v !== undefined);
    if (entries.length) {
      db.prepare(`UPDATE apps SET ${entries.map(([k]) => `${k} = ?`).join(", ")} WHERE id = ?`).run(
        ...entries.map(([, v]) => (v === "" ? null : (v as string | number | null))),
        app.id,
      );
    }
    if (input.port !== undefined || input.composeService !== undefined) {
      const server = getServer(app.server_id);
      if (server.status === "ready") await applyCaddyConfig(server);
    }
    return c.json({ app: publicApp(loadApp(app.id)) });
  })

  .put("/:id/env", async (c) => {
    const app = loadApp(idParam(c));
    const { env } = await body(c, z.object({ env: z.string().max(200_000) }));
    db.prepare("UPDATE apps SET env = ? WHERE id = ?").run(env.trim() ? encrypt(env) : null, app.id);
    return c.json({ ok: true, note: "Değişikliklerin geçerli olması için yeniden deploy et." });
  })

  .put("/:id/security", async (c) => {
    const app = loadApp(idParam(c));
    const ipList = z.array(z.string().trim().regex(/^[0-9a-f:.]+(\/\d{1,3})?$/i, "Geçersiz IP veya CIDR")).max(200);
    const input = await body(
      c,
      z.object({
        waf: z.boolean(),
        rateLimit: z.number().int().min(10).max(100_000).nullable(),
        headers: z.boolean(),
        allowIps: ipList,
        denyIps: ipList,
        basicAuth: z
          .object({ username: z.string().trim().min(1).max(60), password: z.string().max(200).optional() })
          .nullable(),
      }),
    );
    const current = parseSecurity(app.security);
    let basicAuth = null;
    if (input.basicAuth) {
      if (input.basicAuth.password) {
        if (input.basicAuth.password.length < 8) throw new HttpError(400, "Şifre en az 8 karakter olmalı");
        basicAuth = { username: input.basicAuth.username, hash: Buffer.from(await bcrypt.hash(input.basicAuth.password, 12)).toString("base64") };
      } else if (current.basicAuth) {
        basicAuth = { ...current.basicAuth, username: input.basicAuth.username };
      } else throw new HttpError(400, "Şifre koruması için şifre gerekli");
    }
    const security = { waf: input.waf, rateLimit: input.rateLimit, headers: input.headers, allowIps: input.allowIps, denyIps: input.denyIps, basicAuth };
    db.prepare("UPDATE apps SET security = ? WHERE id = ?").run(JSON.stringify(security), app.id);
    const server = getServer(app.server_id);
    if (server.status === "ready") await applyCaddyConfig(server);
    return c.json({ app: publicApp(loadApp(app.id)) });
  })

  .post("/:id/domains", async (c) => {
    const app = loadApp(idParam(c));
    const input = await body(c, z.object({ host: z.string().trim().toLowerCase(), https: z.boolean().default(true) }));
    if (!HOST_RE.test(input.host)) throw new HttpError(400, "Geçerli bir alan adı gir (ör. blog.ornek.com)");
    if (db.prepare("SELECT 1 FROM domains WHERE host = ?").get(input.host)) throw new HttpError(409, "Bu alan adı zaten kullanılıyor");
    db.prepare("INSERT INTO domains (app_id, host, https, generated, created_at) VALUES (?, ?, ?, 0, ?)").run(app.id, input.host, input.https ? 1 : 0, Date.now());
    const server = getServer(app.server_id);
    if (server.status === "ready") await applyCaddyConfig(server);
    return c.json({ app: publicApp(loadApp(app.id)) }, 201);
  })

  .post("/:id/domains/generate", async (c) => {
    const app = loadApp(idParam(c));
    const server = getServer(app.server_id);
    const host = generatedHost(`${app.slug.split("-").slice(0, -1).join("-") || "app"}-${randomAlnum(4).toLowerCase()}`, server);
    if (!host) throw new HttpError(422, "Sunucunun dış IP adresi bilinmiyor. Sunucu ayarlarından gir.");
    db.prepare("INSERT INTO domains (app_id, host, https, generated, created_at) VALUES (?, ?, ?, 1, ?)").run(app.id, host, server.https_mode === "off" ? 0 : 1, Date.now());
    if (server.status === "ready") await applyCaddyConfig(server);
    return c.json({ app: publicApp(loadApp(app.id)) }, 201);
  })

  .delete("/:id/domains/:domainId", async (c) => {
    const app = loadApp(idParam(c));
    db.prepare("DELETE FROM domains WHERE id = ? AND app_id = ?").run(idParam(c, "domainId"), app.id);
    const server = getServer(app.server_id);
    if (server.status === "ready") await applyCaddyConfig(server);
    return c.json({ app: publicApp(loadApp(app.id)) });
  })

  .post("/:id/deploy", (c) => {
    const app = loadApp(idParam(c));
    const id = enqueueDeploy(app.id, "manual");
    return c.json({ deploymentId: id }, 202);
  })

  .post("/:id/rollback/:deploymentId", (c) => {
    const app = loadApp(idParam(c));
    const dep = must(
      db.prepare("SELECT id, image, status FROM deployments WHERE id = ? AND app_id = ?").get(idParam(c, "deploymentId"), app.id) as
        | { id: number; image: string | null; status: string }
        | undefined,
      "Deploy bulunamadı",
    );
    if (app.source_type === "compose") throw new HttpError(422, "Compose uygulamalarında geri dönüş yerine ilgili commit'i yeniden deploy et");
    if (dep.status !== "success" || !dep.image) throw new HttpError(422, "Yalnızca başarılı bir deploy'a geri dönülebilir");
    const id = enqueueDeploy(app.id, "rollback", { image: dep.image, title: `#${dep.id} sürümüne geri dönüş` });
    return c.json({ deploymentId: id }, 202);
  })

  .post("/:id/:action{start|stop|restart}", async (c) => {
    const app = loadApp(idParam(c));
    const action = c.req.param("action") as "start" | "stop" | "restart";
    const server = getServer(app.server_id);
    if (app.source_type === "compose") {
      await composeCommand(app, action);
    } else {
      if (!app.container) throw new HttpError(422, "Uygulama henüz deploy edilmedi");
      const container = dockerFor(server).getContainer(app.container);
      try {
        if (action === "start") await container.start();
        if (action === "stop") await container.stop({ t: 10 });
        if (action === "restart") await container.restart({ t: 10 });
      } catch (err) {
        const msg = (err as { statusCode?: number }).statusCode === 304 ? null : (err as Error).message;
        if (msg) throw new HttpError(500, msg);
      }
    }
    db.prepare("UPDATE apps SET status = ? WHERE id = ?").run(action === "stop" ? "stopped" : "running", app.id);
    if (server.status === "ready") await applyCaddyConfig(server);
    return c.json({ app: publicApp(loadApp(app.id)) });
  })

  .delete("/:id", async (c) => {
    const app = loadApp(idParam(c));
    const server = getServer(app.server_id);
    const docker = dockerFor(server);
    if (app.source_type === "compose") await composeCommand(app, "down").catch(() => {});
    const containers = await docker.listContainers({ all: true, filters: { label: [`xudbin.app=${app.slug}`] } }).catch(() => []);
    for (const ct of containers) await removeContainer(docker, ct.Id);
    const images = await docker.listImages({ filters: { reference: [`xudbin/${app.slug}`] } }).catch(() => []);
    for (const img of images) await docker.getImage(img.Id).remove({ force: true }).catch(() => {});
    db.prepare("DELETE FROM apps WHERE id = ?").run(app.id);
    if (server.status === "ready") await applyCaddyConfig(server).catch(() => {});
    return c.json({ ok: true });
  })

  .post("/:id/webhook/regenerate", (c) => {
    const app = loadApp(idParam(c));
    db.prepare("UPDATE apps SET webhook_token = ? WHERE id = ?").run(randomToken(24), app.id);
    return c.json({ app: publicApp(loadApp(app.id)) });
  })

  .get("/:id/stats", async (c) => {
    const app = loadApp(idParam(c));
    if (!app.container || app.source_type === "compose") return c.json({ stats: null });
    try {
      const s = (await dockerFor(getServer(app.server_id)).getContainer(app.container).stats({ stream: false })) as {
        cpu_stats: { cpu_usage: { total_usage: number }; system_cpu_usage: number; online_cpus: number };
        precpu_stats: { cpu_usage: { total_usage: number }; system_cpu_usage: number };
        memory_stats: { usage: number; limit: number; stats?: { inactive_file?: number } };
      };
      const cpuDelta = s.cpu_stats.cpu_usage.total_usage - s.precpu_stats.cpu_usage.total_usage;
      const sysDelta = s.cpu_stats.system_cpu_usage - s.precpu_stats.system_cpu_usage;
      const cpu = sysDelta > 0 ? (cpuDelta / sysDelta) * (s.cpu_stats.online_cpus || 1) * 100 : 0;
      const mem = s.memory_stats.usage - (s.memory_stats.stats?.inactive_file ?? 0);
      return c.json({ stats: { cpu: Math.round(cpu * 10) / 10, memory: mem, memoryLimit: s.memory_stats.limit } });
    } catch {
      return c.json({ stats: null });
    }
  })

  // Çalışan konteynerin logları, canlı (SSE).
  .get("/:id/logs/stream", async (c) => {
    const app = loadApp(idParam(c));
    const docker = dockerFor(getServer(app.server_id));
    const names =
      app.source_type === "compose"
        ? (await docker.listContainers({ all: true, filters: { label: [`com.docker.compose.project=xb-${app.slug}`] } })).map((ct) => ct.Names[0]!.slice(1))
        : app.container
          ? [app.container]
          : [];
    return streamSSE(c, async (stream) => {
      if (!names.length) {
        await stream.writeSSE({ event: "line", data: "Henüz çalışan bir konteyner yok. Önce deploy et." });
        return;
      }
      const streams: NodeJS.ReadableStream[] = [];
      for (const name of names) {
        const prefix = names.length > 1 ? `[${name.replace(`xb-${app.slug}-`, "")}] ` : "";
        const logStream = (await docker.getContainer(name).logs({ follow: true, stdout: true, stderr: true, tail: 300, timestamps: true })) as unknown as NodeJS.ReadableStream;
        streams.push(logStream);
        logStream.on("data", (chunk: Buffer) => {
          for (const line of demuxLogs(chunk)) void stream.writeSSE({ event: "line", data: prefix + line });
        });
      }
      stream.onAbort(() => {
        for (const s of streams) (s as unknown as { destroy?: () => void }).destroy?.();
      });
      while (!stream.aborted) await stream.sleep(15_000).then(() => stream.writeSSE({ event: "ping", data: "" }));
    });
  });

export const deploymentRoutes = new Hono()
  .get("/", (c) => {
    const deployments = db
      .prepare(
        `SELECT d.id, d.status, d.trigger, d.title, d.commit_sha AS commitSha, d.started_at AS startedAt, d.finished_at AS finishedAt,
                a.id AS appId, a.name AS appName
         FROM deployments d JOIN apps a ON a.id = d.app_id ORDER BY d.id DESC LIMIT 8`,
      )
      .all();
    return c.json({ deployments });
  })
  .get("/:id", (c) => {
    const dep = must(db.prepare("SELECT * FROM deployments WHERE id = ?").get(idParam(c)), "Deploy bulunamadı");
    return c.json({ deployment: dep });
  })
  .post("/:id/cancel", (c) => {
    if (!cancelDeployment(idParam(c))) throw new HttpError(409, "Yalnızca sıradaki deploylar iptal edilebilir");
    return c.json({ ok: true });
  })
  .get("/:id/stream", (c) => {
    const id = idParam(c);
    const dep = must(db.prepare("SELECT log, status FROM deployments WHERE id = ?").get(id) as { log: string; status: string } | undefined, "Deploy bulunamadı");
    return streamSSE(c, async (stream) => {
      await stream.writeSSE({ event: "snapshot", data: JSON.stringify(dep) });
      if (dep.status !== "queued" && dep.status !== "running") {
        await stream.writeSSE({ event: "done", data: "" });
        return;
      }
      const channel = `deploy:${id}`;
      let finished = false;
      const onLine = (line: string) => {
        if (line === "__done__") {
          finished = true;
          void stream.writeSSE({ event: "done", data: "" });
        } else void stream.writeSSE({ event: "line", data: line });
      };
      bus.on(channel, onLine);
      stream.onAbort(() => {
        bus.off(channel, onLine);
      });
      while (!stream.aborted && !finished) await stream.sleep(15_000).then(() => stream.writeSSE({ event: "ping", data: "" }));
      bus.off(channel, onLine);
    });
  });

export const projectRoutes = new Hono()
  .get("/", (c) => {
    const projects = db
      .prepare(
        `SELECT p.id, p.name, p.description, p.created_at AS createdAt,
                (SELECT COUNT(*) FROM apps a WHERE a.project_id = p.id) AS apps,
                (SELECT COUNT(*) FROM databases d WHERE d.project_id = p.id) AS databases,
                (SELECT COUNT(*) FROM apps a WHERE a.project_id = p.id AND a.status = 'running') AS running
         FROM projects p ORDER BY p.id DESC`,
      )
      .all();
    return c.json({ projects });
  })
  .post("/", async (c) => {
    const input = await body(c, z.object({ name: z.string().trim().min(1, "İsim gerekli").max(60), description: z.string().trim().max(300).default("") }));
    const res = db.prepare("INSERT INTO projects (name, description, created_at) VALUES (?, ?, ?)").run(input.name, input.description, Date.now());
    return c.json({ project: { id: Number(res.lastInsertRowid), ...input } }, 201);
  })
  .get("/:id", (c) => {
    const id = idParam(c);
    const project = must(db.prepare("SELECT id, name, description, created_at AS createdAt FROM projects WHERE id = ?").get(id), "Proje bulunamadı");
    const apps = (db.prepare("SELECT * FROM apps WHERE project_id = ? ORDER BY id").all(id) as AppRow[]).map((a) => {
      const p = publicApp(a);
      return { id: p.id, name: p.name, sourceType: p.sourceType, status: p.status, server: p.server, domains: p.domains, gitUrl: p.gitUrl, image: p.image };
    });
    const databases = db
      .prepare(
        `SELECT d.id, d.name, d.engine, d.version, d.status, s.name AS serverName
         FROM databases d JOIN servers s ON s.id = d.server_id WHERE d.project_id = ? ORDER BY d.id`,
      )
      .all(id);
    return c.json({ project, apps, databases });
  })
  .patch("/:id", async (c) => {
    const id = idParam(c);
    const input = await body(c, z.object({ name: z.string().trim().min(1).max(60), description: z.string().trim().max(300).default("") }));
    db.prepare("UPDATE projects SET name = ?, description = ? WHERE id = ?").run(input.name, input.description, id);
    return c.json({ ok: true });
  })
  .delete("/:id", (c) => {
    const id = idParam(c);
    const n = db.prepare("SELECT (SELECT COUNT(*) FROM apps WHERE project_id = ?) + (SELECT COUNT(*) FROM databases WHERE project_id = ?) AS n").get(id, id) as { n: number };
    if (n.n) throw new HttpError(409, "Önce projedeki uygulamaları ve veritabanlarını sil");
    db.prepare("DELETE FROM projects WHERE id = ?").run(id);
    return c.json({ ok: true });
  });

/** Git sağlayıcısının (GitHub, GitLab, Gitea...) push olayında çağırdığı adres. */
export const webhookRoutes = new Hono().post("/deploy/:token", async (c) => {
  const app = db.prepare("SELECT * FROM apps WHERE webhook_token = ?").get(c.req.param("token")) as AppRow | undefined;
  if (!app) return c.json({ error: "Geçersiz webhook" }, 404);
  if (!app.auto_deploy) return c.json({ ok: false, reason: "Otomatik deploy kapalı" });
  const payload = (await c.req.json().catch(() => ({}))) as { ref?: string; head_commit?: { message?: string } };
  if (payload.ref && payload.ref !== `refs/heads/${app.git_branch}`) {
    return c.json({ ok: false, reason: `Yalnızca ${app.git_branch} dalı deploy edilir` });
  }
  const id = enqueueDeploy(app.id, "webhook", { title: payload.head_commit?.message?.split("\n")[0] ?? "" });
  return c.json({ ok: true, deploymentId: id }, 202);
});
