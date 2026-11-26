import fs from "node:fs";
import path from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { logger } from "hono/logger";
import { secureHeaders } from "hono/secure-headers";
import { enforceRoles, requireAuth } from "./auth/middleware.js";
import { projectAccess } from "./services/access.js";
import { auditTrail } from "./services/audit.js";
import { config } from "./config.js";
import { clientIp } from "./lib/client-ip.js";
import { errorResponse } from "./lib/http.js";
import { panelAccessGuard } from "./lib/panel-access.js";
import { sameOrigin } from "./lib/same-origin.js";
import type { AppEnv } from "./lib/types.js";
import { appRoutes, deploymentRoutes, frameworkRoutes, projectRoutes, uploadRoutes, webhookRoutes } from "./routes/apps.js";
import { analyticsRoutes } from "./routes/analytics.js";
import { templateRoutes } from "./routes/templates.js";
import { overviewRoutes } from "./routes/overview.js";
import { authRoutes } from "./routes/auth.js";
import { databaseRoutes } from "./routes/databases.js";
import { securityRoutes } from "./routes/security.js";
import { serverRoutes, sshKeyRoutes } from "./routes/servers.js";
import { settingsRoutes } from "./routes/settings.js";
import { registryRoutes } from "./routes/registries.js";
import { userRoutes } from "./routes/users.js";
import { terminalRoutes } from "./routes/terminal.js";
import { isBlocked } from "./services/security.js";

/**
 * Panelin HTTP uygulaması (rotalar ve ara katmanlar). Zamanlayıcıları ve sunucuyu index.ts başlatır;
 * testler aynı zinciri bu fonksiyonla kurar.
 */
export function createApp() {
  const app = new Hono<AppEnv>();

  if (!config.isProd) app.use(logger());
  app.use(
    secureHeaders({
      // Panelin arayüzü yalnız kendi dosyalarını yükler; olası bir XSS'te dışarıdan betik çalıştırılamaz.
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:"],
        fontSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        // GitHub App oluşturma: manifest GitHub'a form olarak gönderilir (yalnız github.com'a izin).
        formAction: ["'self'", "https://github.com"],
        frameAncestors: ["'none'"],
      },
      xFrameOptions: "DENY",
      referrerPolicy: "same-origin",
    }),
  );

  // Panel IP izin listesi doluysa listede olmayan istemci hiçbir sayfaya ulaşamaz (Caddy de aynısını uygular).
  app.use("*", panelAccessGuard);

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
  app.use("/api/*", enforceRoles);
  app.use("/api/*", projectAccess);
  app.use("/api/*", auditTrail);
  app.route("/api/servers", serverRoutes);
  app.route("/api/ssh-keys", sshKeyRoutes);
  app.route("/api/projects", projectRoutes);
  // Web terminali (/api/apps/:id/terminal...): uygulama uçlarından önce, ayrı dosyada.
  app.route("/api/apps", terminalRoutes);
  app.route("/api/apps", appRoutes);
  app.route("/api/frameworks", frameworkRoutes);
  app.route("/api/uploads", uploadRoutes);
  app.route("/api/deployments", deploymentRoutes);
  app.route("/api/databases", databaseRoutes);
  app.route("/api/security", securityRoutes);
  app.route("/api/analytics", analyticsRoutes);
  app.route("/api/templates", templateRoutes);
  app.route("/api/overview", overviewRoutes);
  app.route("/api/settings/registries", registryRoutes);
  app.route("/api/settings", settingsRoutes);
  app.route("/api/users", userRoutes);
  app.all("/api/*", (c) => c.json({ error: "Bulunamadı" }, 404));

  // Production: derlenmiş React arayüzünü servis et, bilinmeyen yolları index.html'e yönlendir (SPA).
  if (fs.existsSync(config.webDist)) {
    const root = path.relative(process.cwd(), config.webDist);
    app.use("/*", serveStatic({ root }));
    app.get("*", serveStatic({ root, path: "index.html" }));
  }

  app.onError(errorResponse);
  return app;
}
