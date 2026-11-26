import "./restore-boot.js";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { pruneAudit } from "./services/audit.js";
import { purgeExpiredSessions } from "./auth/session.js";
import { ensureSetupToken } from "./auth/setup-token.js";
import { config } from "./config.js";
import { db } from "./db.js";
import { terminals } from "./services/terminal.js";
import { applyCaddyConfig, ensureCaddy } from "./services/caddy.js";
import { startBackupScheduler } from "./services/databases.js";
import { startPanelBackupScheduler } from "./services/panel-backup.js";
import { recoverInterruptedDeployments } from "./services/deploy.js";
import { startFirewallKeeper } from "./services/firewall.js";
import { startMaintenance } from "./services/maintenance.js";
import { startUptimeMonitor } from "./services/uptime.js";
import { startAnalyticsJobs } from "./services/analytics.js";
import { startCronScheduler } from "./services/cron.js";
import { startVolumeBackupScheduler } from "./services/volume-backups.js";
import { reconcileNetworks } from "./services/networks.js";
import { ensureTunnel } from "./services/tunnel.js";
import { getSettings, updateSettings } from "./lib/settings.js";
import { notify } from "./services/notify.js";
import { startSecurityMonitor } from "./services/security.js";
import { ensureLocalServer, listServers, startServerMonitor, startServerSetup } from "./services/servers.js";
import { startSystemSampler } from "./services/system.js";

const app = createApp();

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
startPanelBackupScheduler();
startSecurityMonitor();
startFirewallKeeper();
startMaintenance();
startUptimeMonitor();
startAnalyticsJobs();
startCronScheduler();
startVolumeBackupScheduler();
setInterval(pruneAudit, 24 * 3_600_000).unref();
startServerMonitor((s, ok) =>
  ok ? notify("server_down", `${s.name} yeniden erişilebilir`, "Sunucuyla bağlantı geri geldi.") : notify("server_down", `${s.name} sunucusuna ulaşılamıyor`, "SSH bağlantısı 20 saniye içinde kurulamadı."),
);

// Yerel sunucu: ilk açılışta kurulumu başlat, sonraki açılışlarda Caddy'nin çalıştığından emin ol.
const local = listServers().find((s) => s.kind === "local")!;
if (local.status === "ready") {
  ensureCaddy(local)
    .then(() => applyCaddyConfig(local))
    .catch((err) => console.error("Caddy hazırlanamadı:", (err as Error).message));
}
// Ağ ayrımı: uygulamalar ve veritabanları kendi proje ağlarına taşınır (çalışırken, yeniden deploy gerekmeden).
setTimeout(() => {
  for (const s of listServers().filter((x) => x.status === "ready")) {
    if (s.tunnel_token) ensureTunnel(s).catch((err) => console.error(`${s.name}: tunnel başlatılamadı:`, (err as Error).message));
    reconcileNetworks(s)
      .then((n) => n && console.log(`${s.name}: ${n} konteyner proje ağına taşındı`))
      .catch((err) => console.error(`${s.name}: ağlar düzenlenemedi:`, (err as Error).message));
  }
}, 5_000).unref();
if (local.status !== "ready" && process.env.XUDBIN_SKIP_LOCAL_SETUP !== "true") startServerSetup(local.id);

const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  console.log(`Xudbin http://localhost:${info.port} adresinde çalışıyor`);
  const { n } = db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number };
  if (n === 0) console.log(`Kurulum anahtarı: ${ensureSetupToken()}  (yönetici hesabını oluştururken gerekir)`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    // Açık terminallerin kabukları konteynerlerde kalmasın (en fazla birkaç saniye beklenir).
    void Promise.race([terminals.closeAll(), new Promise((r) => setTimeout(r, 5_000))]).finally(() => server.close(() => process.exit(0)));
  });
}
