import fs from "node:fs";
import path from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { logger } from "hono/logger";
import { secureHeaders } from "hono/secure-headers";
import { requireAuth } from "./auth/middleware.js";
import { purgeExpiredSessions } from "./auth/session.js";
import { ensureSetupToken } from "./auth/setup-token.js";
import { config } from "./config.js";
import { db } from "./db.js";
import { sameOrigin } from "./lib/same-origin.js";
import type { AppEnv } from "./lib/types.js";
import { authRoutes } from "./routes/auth.js";
import { systemRoutes } from "./routes/system.js";
import { startSystemSampler } from "./services/system.js";

const app = new Hono<AppEnv>();

app.use(logger());
app.use(secureHeaders());
app.use("/api/*", sameOrigin);

app.route("/api/auth", authRoutes);
app.use("/api/*", requireAuth);
app.route("/api/system", systemRoutes);
app.all("/api/*", (c) => c.json({ error: "Bulunamadı" }, 404));

// Production: derlenmiş React arayüzünü servis et, bilinmeyen yolları index.html'e yönlendir (SPA).
if (fs.existsSync(config.webDist)) {
  const root = path.relative(process.cwd(), config.webDist);
  app.use("/*", serveStatic({ root }));
  app.get("*", serveStatic({ root, path: "index.html" }));
}

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: "Sunucu hatası" }, 500);
});

startSystemSampler();
purgeExpiredSessions();
setInterval(purgeExpiredSessions, 60 * 60 * 1000).unref();

const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  console.log(`Xudbin http://localhost:${info.port} adresinde çalışıyor`);
  const { n } = db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number };
  if (n === 0) console.log(`Kurulum anahtarı: ${ensureSetupToken()}  (yönetici hesabını oluştururken gerekir)`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
