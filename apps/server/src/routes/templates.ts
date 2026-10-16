import { Hono } from "hono";
import { z } from "zod";
import { db } from "../db.js";
import { encrypt, randomAlnum, randomToken } from "../lib/crypto.js";
import { body, HttpError, must } from "../lib/http.js";
import { makeSlug } from "../lib/slug.js";
import type { AppEnv } from "../lib/types.js";
import { canWriteProject } from "../services/access.js";
import { enqueueDeploy } from "../services/deploy.js";
import { getServer } from "../services/servers.js";
import { getTemplate, TEMPLATES, templateEnv } from "../services/templates.js";
import { generatedHost } from "./apps.js";

export const templateRoutes = new Hono<AppEnv>()
  .get("/", (c) =>
    c.json({
      templates: TEMPLATES.map(({ compose: _c, vars, ...t }) => ({ ...t, vars: vars.map((v) => ({ key: v.key, label: v.label, secret: Boolean(v.secret) })) })),
    }),
  )
  // Şablondan Compose uygulaması oluşturur ve deploy'u başlatır.
  .post("/:id/install", async (c) => {
    const t = must(getTemplate(c.req.param("id")), "Şablon bulunamadı");
    const input = await body(c, z.object({ projectId: z.number().int(), serverId: z.number().int(), name: z.string().trim().min(1).max(60).optional() }));
    must(db.prepare("SELECT id FROM projects WHERE id = ?").get(input.projectId), "Proje bulunamadı");
    if (!canWriteProject(c.get("user"), input.projectId)) throw new HttpError(403, "Bu projeye uygulama ekleme yetkin yok");
    const server = getServer(input.serverId);
    const name = input.name || t.name;
    const slug = makeSlug(name);
    const env = Object.entries(templateEnv(t, randomAlnum)).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
    const res = db
      .prepare(
        `INSERT INTO apps (project_id, server_id, name, slug, source_type, compose_file, compose_service, port, env, webhook_token, webhook_secret, webhook_signed, framework, created_at)
         VALUES (?, ?, ?, ?, 'compose', ?, ?, ?, ?, ?, ?, 1, 'auto', ?)`,
      )
      .run(input.projectId, server.id, name, slug, t.compose, t.service, t.port, encrypt(env), randomToken(24), randomToken(24), Date.now());
    const id = Number(res.lastInsertRowid);
    const host = generatedHost(slug, server);
    if (host) db.prepare("INSERT INTO domains (app_id, host, https, generated, created_at) VALUES (?, ?, ?, 1, ?)").run(id, host, server.https_mode === "off" ? 0 : 1, Date.now());
    const deploymentId = enqueueDeploy(id, "manual", { title: `${t.name} kurulumu` });
    return c.json({ appId: id, deploymentId }, 201);
  });
