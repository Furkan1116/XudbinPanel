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
  /** Disk kullanımını ölçeceğimiz yol. Konteynerde /data (Docker volume'u) sunucunun diskinde durur; sunucu kökü panele bağlanmaz. */
  diskPath: env.DISK_PATH ?? "/",
  /** install.sh'nin güncelleme sonucunu yazdığı dosya; sunucudaki /opt/xudbin/status klasörü konteynere salt okunur bağlanır. */
  updateStatusFile: env.UPDATE_STATUS_FILE ?? "/host-status/update-status",
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
  // Sürüm sabit tutulur: "latest" gibi kendiliğinden değişen etiketler tedarik zinciri riskidir.
  trivyImage: env.XUDBIN_TRIVY_IMAGE ?? "aquasec/trivy:0.58.1",
  /** Hazır Caddy imajı (CI'da çok mimarili derlenir); çekilemezse sunucuda derlenir. */
  caddyPrebuilt: env.XUDBIN_CADDY_IMAGE ?? "ghcr.io/furkan1116/xudbin-caddy:1",
  /** Varsayılan Let's Encrypt yerine kullanılacak ACME dizini, ör. staging: https://acme-staging-v02.api.letsencrypt.org/directory */
  acmeCa: env.XUDBIN_ACME_CA || null,
  /** ACME sunucusu herkese açık bir sertifika kullanmıyorsa, Caddy konteynerindeki kök sertifika dosyası. */
  acmeCaRoot: env.XUDBIN_ACME_CA_ROOT || null,
  /**
   * Üyelerin verdiği adreslerin (git clone, uptime) özel ağa çözülmesi varsayılan olarak engellenir (SSRF).
   * İç ağdaki bir Gitea/GitLab gibi meşru hedefler için virgülle ayrılmış ana bilgisayar adı ya da IP listesi;
   * "*" her şeye izin verir (önerilmez).
   */
  ssrfAllow: (env.XUDBIN_SSRF_ALLOW ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
};

function findDockerSocket() {
  const candidates = [
    "/var/run/docker.sock",
    path.join(os.homedir(), ".orbstack/run/docker.sock"),
    path.join(os.homedir(), ".docker/run/docker.sock"),
  ];
  return candidates.find((p) => fs.existsSync(p)) ?? "/var/run/docker.sock";
}
