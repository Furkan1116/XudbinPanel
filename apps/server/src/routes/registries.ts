import { Hono } from "hono";
import { z } from "zod";
import { body, idParam } from "../lib/http.js";
import type { AppEnv } from "../lib/types.js";
import { createRegistry, deleteRegistry, getRegistry, listRegistries, markVerified, normalizeRegistryHost, savedLogin, testRegistryLogin, updateRegistry } from "../services/registries.js";

/**
 * /api/settings/registries — özel imaj kayıt depoları için girişler. Yalnız yönetici (auth/middleware.ts ADMIN_ANY).
 * Şifre/token hiçbir yanıtta dönmez.
 */
const username = z.string().trim().min(1, "Kullanıcı adı gerekli").max(200);
const password = z.string().min(1, "Şifre veya token gerekli").max(4000);
const host = z.string().trim().min(1, "Kayıt deposu adresi gerekli").max(260);

export const registryRoutes = new Hono<AppEnv>()
  .get("/", (c) => c.json({ registries: listRegistries() }))
  // Kaydetmeden önce dene.
  .post("/test", async (c) => {
    const input = await body(c, z.object({ host, username, password }));
    const h = normalizeRegistryHost(input.host);
    if (!h) return c.json({ error: "Kayıt deposu adresi geçersiz (ör. ghcr.io, registry.gitlab.com, docker.io)" }, 400);
    await testRegistryLogin({ host: h, username: input.username, password: input.password });
    return c.json({ ok: true, host: h });
  })
  .post("/", async (c) => {
    const input = await body(
      c,
      z.object({ name: z.string().trim().max(100).default(""), host, username, password, verify: z.boolean().default(true) }),
    );
    const h = normalizeRegistryHost(input.host);
    if (!h) return c.json({ error: "Kayıt deposu adresi geçersiz (ör. ghcr.io, registry.gitlab.com, docker.io)" }, 400);
    // Varsayılan: önce doğrula, yanlış giriş kaydedilmesin. Kayıt deposu yalnız uzak sunuculardan erişilebiliyorsa doğrulamasız kaydedilebilir.
    if (input.verify) await testRegistryLogin({ host: h, username: input.username, password: input.password });
    return c.json({ registry: createRegistry({ ...input, host: h }, input.verify) }, 201);
  })
  .patch("/:id", async (c) => {
    const id = idParam(c);
    getRegistry(id);
    const input = await body(
      c,
      z.object({ name: z.string().trim().max(100).optional(), username: username.optional(), password: z.string().max(4000).optional(), verify: z.boolean().default(true) }),
    );
    if (input.verify && (input.username !== undefined || input.password)) {
      const current = savedLogin(id);
      await testRegistryLogin({ host: current.host, username: input.username ?? current.username, password: input.password || current.password });
    }
    return c.json({ registry: updateRegistry(id, input, input.verify && (input.username !== undefined || Boolean(input.password))) });
  })
  .post("/:id/test", async (c) => {
    const id = idParam(c);
    await testRegistryLogin(savedLogin(id));
    markVerified(id);
    return c.json({ ok: true });
  })
  .delete("/:id", (c) => {
    deleteRegistry(idParam(c));
    return c.json({ ok: true });
  });
