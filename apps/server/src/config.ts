import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const env = process.env;

export const config = {
  port: Number(env.XUDBIN_PORT ?? 3000),
  host: env.HOST ?? "0.0.0.0",
  isProd: env.NODE_ENV === "production",
  dataDir: path.resolve(env.DATA_DIR ?? "./data"),
  /** Derlenmiş arayüz dosyalarının yeri (production'da sunucu bunları servis eder). */
  webDist: path.resolve(env.WEB_DIST ?? "../web/dist"),
  /** Disk kullanımını ölçeceğimiz yol. Konteyner içinde host diski /host olarak bağlanır. */
  diskPath: env.DISK_PATH ?? "/",
  /** Panel bir proxy (Caddy) arkasındaysa X-Forwarded-For başlığına güven. */
  trustProxy: env.TRUST_PROXY === "true",
  /** HTTPS üzerinden servis ediliyorsa cookie'leri Secure işaretle. */
  secureCookies: env.SECURE_COOKIES === "true",
  sessionTtlMs: 1000 * 60 * 60 * 24 * 7,
  /** Yerel Docker soketi. Mac'te OrbStack/Docker Desktop soketini kendisi bulur. */
  dockerSocket: env.DOCKER_SOCKET ?? findDockerSocket(),
  /** Yerel sunucudaki Caddy'nin paneli bulacağı adres (konteyner adı:port). */
  panelUpstream: env.PANEL_UPSTREAM ?? "xudbin:3000",
  /** Sunucuların paylaştığı Docker ağı; Caddy uygulamalara bu ağ üzerinden ulaşır. */
  network: "xudbin",
  caddyImage: "xudbin/caddy:1",
};

function findDockerSocket() {
  const candidates = [
    "/var/run/docker.sock",
    path.join(os.homedir(), ".orbstack/run/docker.sock"),
    path.join(os.homedir(), ".docker/run/docker.sock"),
  ];
  return candidates.find((p) => fs.existsSync(p)) ?? "/var/run/docker.sock";
}
