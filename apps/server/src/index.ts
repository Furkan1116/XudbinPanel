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
import { clientIp } from "./lib/client-ip.js";
import { HttpError } from "./lib/http.js";
import { sameOrigin } from "./lib/same-origin.js";
import type { AppEnv } from "./lib/types.js";
import { appRoutes, deploymentRoutes, projectRoutes, webhookRoutes } from "./routes/apps.js";
import { authRoutes } from "./routes/auth.js";
import { databaseRoutes } from "./routes/databases.js";
import { securityRoutes } from "./routes/security.js";
import { serverRoutes, sshKeyRoutes } from "./routes/servers.js";
import { settingsRoutes } from "./routes/settings.js";
import { applyCaddyConfig, ensureCaddy } from "./services/caddy.js";
import { startBackupScheduler } from "./services/databases.js";
import { recoverInterruptedDeployments } from "./services/deploy.js";
import { getSettings, updateSettings } from "./lib/settings.js";
import { notify } from "./services/notify.js";
import { isBlocked, startSecurityMonitor } from "./services/security.js";
import { ensureLocalServer, listServers, startServerMonitor, startServerSetup } from "./services/servers.js";
import { startSystemSampler } from "./services/system.js";

const app = new Hono<AppEnv>();

if (!config.isProd) app.use(logger());
app.use(secureHeaders());

// Banlanmış IP'ler panelin API'sine de ulaşamaz.
app.use("/api/*", async (c, next) => {
  if (isBlocked(clientIp(c))) return c.json({ error: "Erişim engellendi" }, 403);
  await next();
});

// Git sağlayıcılarının çağırdığı webhook'lar oturum ve CSRF kontrolü dışında; token ile korunur.
app.route("/api/webhooks", webhookRoutes);

app.use("/api/*", sameOrigin);
app.route("/api/auth", authRoutes);
app.use("/api/*", requireAuth);
app.route("/api/servers", serverRoutes);
app.route("/api/ssh-keys", sshKeyRoutes);
app.route("/api/projects", projectRoutes);
app.route("/api/apps", appRoutes);
app.route("/api/deployments", deploymentRoutes);
app.route("/api/databases", databaseRoutes);
app.route("/api/security", securityRoutes);
app.route("/api/settings", settingsRoutes);
app.all("/api/*", (c) => c.json({ error: "Bulunamadı" }, 404));

// Production: derlenmiş React arayüzünü servis et, bilinmeyen yolları index.html'e yönlendir (SPA).
if (fs.existsSync(config.webDist)) {
  const root = path.relative(process.cwd(), config.webDist);
  app.use("/*", serveStatic({ root }));
  app.get("*", serveStatic({ root, path: "index.html" }));
}

app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
  console.error(err);
  return c.json({ error: (err as Error).message || "Sunucu hatası" }, 500);
});

startSystemSampler();
purgeExpiredSessions();
setInterval(purgeExpiredSessions, 60 * 60 * 1000).unref();
ensureLocalServer();
// install.sh panel adresini ortam değişkeniyle verir; yalnız ilk açılışta ayarlara yazılır.
if (process.env.XUDBIN_DOMAIN && !getSettings().panelDomain) {
  updateSettings({ panelDomain: process.env.XUDBIN_DOMAIN.toLowerCase(), panelHttps: process.env.XUDBIN_HTTPS !== "0" });
}
if (process.env.ACME_EMAIL) {
  db.prepare("UPDATE servers SET acme_email = COALESCE(acme_email, ?) WHERE kind = 'local'").run(process.env.ACME_EMAIL);
}
recoverInterruptedDeployments();
startBackupScheduler();
startSecurityMonitor();
startServerMonitor((s, ok) =>
  ok ? notify("server_down", `${s.name} yeniden erişilebilir`, "Sunucuyla bağlantı geri geldi.") : notify("server_down", `${s.name} sunucusuna ulaşılamıyor`, "SSH bağlantısı 20 saniye içinde kurulamadı."),
);

// Yerel sunucu: ilk açılışta kurulumu başlat, sonraki açılışlarda Caddy'nin çalıştığından emin ol.
const local = listServers().find((s) => s.kind === "local")!;
if (local.status === "ready") {
  ensureCaddy(local)
    .then(() => applyCaddyConfig(local))
    .catch((err) => console.error("Caddy hazırlanamadı:", (err as Error).message));
} else if (process.env.XUDBIN_SKIP_LOCAL_SETUP !== "true") {
  startServerSetup(local.id);
}

const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  console.log(`Xudbin http://localhost:${info.port} adresinde çalışıyor`);
  const { n } = db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number };
  if (n === 0) console.log(`Kurulum anahtarı: ${ensureSetupToken()}  (yönetici hesabını oluştururken gerekir)`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
