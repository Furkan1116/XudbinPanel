import { db } from "../db.js";
import { decrypt } from "../lib/crypto.js";
import { getSettings } from "../lib/settings.js";
import { applyCaddyConfig, parseSecurity } from "./caddy.js";
import type { AppRow } from "./deploy.js";
import { parseEnv } from "./deploy.js";
import { applyDockerFirewall, dockerFirewallEnabled, hostExec } from "./firewall.js";
import { getServer, hardenServer, listServers } from "./servers.js";
import type { ScanSummary } from "./scan.js";

/**
 * Güvenlik puanı: panel, sunucular ve uygulamalar için kontroller. Her başarısız kontrolün ağırlığı
 * puandan düşer; düzeltilebilenler için tek tıkla düzeltme eylemi verilir.
 */
export type Check = {
  id: string;
  scope: "panel" | "server" | "app";
  target: { id: number; name: string } | null;
  title: string;
  ok: boolean;
  severity: "high" | "medium" | "low";
  detail: string;
  /** Tek tıkla düzeltme (yalnız yönetici). */
  fix?: { action: string; label: string };
  /** Düzeltmenin yapıldığı sayfa. */
  link?: string;
};

const WEIGHT = { high: 10, medium: 5, low: 2 } as const;

type HostInfo = { firewall: string; fail2ban: string; passwordAuth: string; rootLogin: string; dockerFw: string; autoUpdates: string; rebootRequired: string; error?: string };
const hostCache = new Map<number, { at: number; info: HostInfo }>();

const HOST_SCRIPT = `
fw=unknown
if command -v ufw >/dev/null 2>&1; then fw=$(ufw status 2>/dev/null | head -1 | awk '{print $2}'); elif command -v firewall-cmd >/dev/null 2>&1; then fw=$(firewall-cmd --state 2>/dev/null | sed 's/running/active/'); fi
echo "firewall=$fw"
echo "fail2ban=$(systemctl is-active fail2ban 2>/dev/null || echo inactive)"
echo "passwordAuth=$(sshd -T 2>/dev/null | awk '/^passwordauthentication /{print $2}')"
echo "rootLogin=$(sshd -T 2>/dev/null | awk '/^permitrootlogin /{print $2}')"
if iptables -C DOCKER-USER -j XUDBIN-FW >/dev/null 2>&1; then echo dockerFw=yes; else echo dockerFw=no; fi
if systemctl is-enabled unattended-upgrades >/dev/null 2>&1 || systemctl is-enabled dnf-automatic.timer >/dev/null 2>&1 || systemctl is-enabled dnf-automatic-install.timer >/dev/null 2>&1; then echo autoUpdates=yes; else echo autoUpdates=no; fi
if [ -f /var/run/reboot-required ]; then echo rebootRequired=yes; else echo rebootRequired=no; fi
`;

async function hostInfo(serverId: number, refresh: boolean): Promise<HostInfo> {
  const cached = hostCache.get(serverId);
  if (cached && !refresh && Date.now() - cached.at < 15 * 60_000) return cached.info;
  const empty: HostInfo = { firewall: "", fail2ban: "", passwordAuth: "", rootLogin: "", dockerFw: "", autoUpdates: "", rebootRequired: "" };
  let info: HostInfo;
  try {
    const out = await hostExec(getServer(serverId), HOST_SCRIPT, 30_000);
    info = { ...empty };
    for (const line of out.split("\n")) {
      const [k, ...v] = line.trim().split("=");
      if (k && k in info) (info as Record<string, string>)[k] = v.join("=");
    }
  } catch (e) {
    info = { ...empty, error: (e as Error).message };
  }
  hostCache.set(serverId, { at: Date.now(), info });
  return info;
}

export async function computeScore(opts: { refresh?: boolean } = {}) {
  const checks: Check[] = [];
  const s = getSettings();

  // --- Panel ---------------------------------------------------------------
  const admins = db.prepare("SELECT name, email, totp_secret FROM users WHERE role = 'admin'").all() as { name: string; email: string; totp_secret: string | null }[];
  const no2fa = admins.filter((u) => !u.totp_secret);
  checks.push({
    id: "panel-2fa",
    scope: "panel",
    target: null,
    title: "Yöneticilerde iki adımlı doğrulama",
    ok: no2fa.length === 0,
    severity: "high",
    detail: no2fa.length ? `İki adımlı doğrulaması kapalı yönetici: ${no2fa.map((u) => u.email).join(", ")}. Şifre sızarsa panel ve tüm sunucular ele geçer.` : "Tüm yöneticilerde açık.",
    link: "/settings?tab=account",
  });
  checks.push({
    id: "panel-backup",
    scope: "panel",
    target: null,
    title: "Panel yedeği",
    ok: Boolean(s.panelBackupPassphrase) && s.panelBackupIntervalH > 0,
    severity: "medium",
    detail: s.panelBackupPassphrase ? "Panel düzenli olarak yedekleniyor." : "Panelin kendi verisi (sunucular, uygulamalar, şifreli ayarlar) yedeklenmiyor.",
    link: "/settings?tab=backup",
  });
  checks.push({
    id: "panel-offsite",
    scope: "panel",
    target: null,
    title: "Yedekler sunucu dışında",
    ok: Boolean(s.backupS3),
    severity: "medium",
    detail: s.backupS3 ? "Yedekler uzak depolamaya da yükleniyor." : "Yedekler yalnız panelin sunucusunda; sunucu giderse yedekler de gider.",
    link: "/settings?tab=backup",
  });
  const dbsNoBackup = db.prepare("SELECT id, name FROM databases WHERE backup_interval_h = 0").all() as { id: number; name: string }[];
  for (const d of dbsNoBackup) {
    checks.push({ id: `db-backup-${d.id}`, scope: "panel", target: d, title: "Veritabanı otomatik yedekleniyor", ok: false, severity: "medium", detail: `"${d.name}" için otomatik yedek kapalı.`, link: `/databases/${d.id}?tab=backups` });
  }
  const failedVerify = db
    .prepare(
      `SELECT d.id, d.name, b.verify_note AS note FROM databases d JOIN backups b ON b.id = (SELECT id FROM backups WHERE database_id = d.id AND verify_status IS NOT NULL AND verify_status != 'running' ORDER BY id DESC LIMIT 1)
       WHERE b.verify_status = 'failed'`,
    )
    .all() as { id: number; name: string; note: string }[];
  for (const d of failedVerify) {
    checks.push({ id: `db-verify-${d.id}`, scope: "panel", target: { id: d.id, name: d.name }, title: "Yedek geri yüklenebiliyor", ok: false, severity: "high", detail: `"${d.name}" son yedeğinin doğrulaması başarısız: ${d.note}`, link: `/databases/${d.id}?tab=backups` });
  }
  const openDbs = db.prepare("SELECT id, name, external_port FROM databases WHERE external_port IS NOT NULL").all() as { id: number; name: string; external_port: number }[];
  for (const d of openDbs) {
    checks.push({ id: `db-public-${d.id}`, scope: "panel", target: { id: d.id, name: d.name }, title: "Veritabanı internete kapalı", ok: false, severity: "low", detail: `"${d.name}" ${d.external_port} portundan dışarı açık. Gerekmiyorsa kapat; gerekiyorsa güçlü şifre kullanıldığından emin ol.`, link: `/databases/${d.id}?tab=settings` });
  }

  // --- Sunucular -------------------------------------------------------------
  const servers = listServers().filter((x) => x.status === "ready");
  const infos = await Promise.all(servers.map((sv) => hostInfo(sv.id, Boolean(opts.refresh))));
  servers.forEach((sv, i) => {
    const info = infos[i]!;
    const target = { id: sv.id, name: sv.name };
    if (info.error) {
      checks.push({ id: `srv-reach-${sv.id}`, scope: "server", target, title: "Sunucu denetlenebiliyor", ok: false, severity: "low", detail: `Sunucunun güvenlik durumu okunamadı: ${info.error}` });
      return;
    }
    const harden = sv.kind === "ssh" ? { action: `server.harden:${sv.id}`, label: "Sıkılaştır (UFW + fail2ban)" } : undefined;
    checks.push({ id: `srv-fw-${sv.id}`, scope: "server", target, title: "Güvenlik duvarı açık", ok: info.firewall === "active", severity: "high", detail: info.firewall === "active" ? "Yalnız izin verilen portlar açık." : "Güvenlik duvarı kapalı; sunucudaki tüm servisler internete açık olabilir.", fix: info.firewall === "active" ? undefined : harden });
    checks.push({ id: `srv-f2b-${sv.id}`, scope: "server", target, title: "SSH kaba kuvvet koruması (fail2ban)", ok: info.fail2ban === "active", severity: "medium", detail: info.fail2ban === "active" ? "SSH'a çok sayıda hatalı giriş deneyen IP'ler banlanıyor." : "SSH'a sınırsız şifre denemesi yapılabiliyor.", fix: info.fail2ban === "active" ? undefined : harden });
    if (dockerFirewallEnabled()) {
      checks.push({ id: `srv-dockerfw-${sv.id}`, scope: "server", target, title: "Docker portları güvenlik duvarına bağlı", ok: info.dockerFw === "yes", severity: "high", detail: info.dockerFw === "yes" ? "Konteyner portları dışarıdan yalnız izin verilenlerle açık." : "Docker, yayınlanan portlar için güvenlik duvarını atlıyor; konteyner portları internete açık olabilir.", fix: info.dockerFw === "yes" ? undefined : { action: `server.dockerfw:${sv.id}`, label: "Kuralları uygula" } });
    }
    checks.push({ id: `srv-pw-${sv.id}`, scope: "server", target, title: "SSH'ta şifreyle giriş kapalı", ok: info.passwordAuth === "no", severity: "medium", detail: info.passwordAuth === "no" ? "Yalnız SSH anahtarıyla giriş yapılabiliyor." : "SSH şifreyle girişe açık. Kendi SSH anahtarınla girebildiğini doğruladıktan sonra /etc/ssh/sshd_config.d/00-xudbin.conf dosyasına \"PasswordAuthentication no\" yazıp sshd'yi yeniden yükle." });
    checks.push({ id: `srv-root-${sv.id}`, scope: "server", target, title: "Root şifreyle giriş yapamıyor", ok: info.rootLogin !== "yes", severity: "medium", detail: info.rootLogin === "yes" ? "Root kullanıcısı şifreyle girebiliyor (PermitRootLogin yes). prohibit-password yapman önerilir." : "Root yalnız anahtarla girebiliyor ya da hiç giremiyor." });
    checks.push({ id: `srv-updates-${sv.id}`, scope: "server", target, title: "Otomatik güvenlik güncellemeleri", ok: info.autoUpdates === "yes", severity: "medium", detail: info.autoUpdates === "yes" ? "Güvenlik yamaları otomatik kuruluyor." : "İşletim sistemi güvenlik yamaları otomatik kurulmuyor.", fix: info.autoUpdates === "yes" ? undefined : { action: `server.autoupdates:${sv.id}`, label: "Otomatik güncellemeyi aç" } });
    if (info.rebootRequired === "yes") checks.push({ id: `srv-reboot-${sv.id}`, scope: "server", target, title: "Yeniden başlatma bekleyen güncelleme yok", ok: false, severity: "low", detail: "Kurulmuş bir çekirdek/sistem güncellemesi sunucu yeniden başlatılınca devreye girecek." });
  });

  // --- Uygulamalar -----------------------------------------------------------
  const apps = db.prepare("SELECT * FROM apps").all() as AppRow[];
  for (const a of apps) {
    const target = { id: a.id, name: a.name };
    const sec = parseSecurity(a.security);
    const link = `/apps/${a.id}`;
    checks.push({ id: `app-waf-${a.id}`, scope: "app", target, title: "WAF açık", ok: sec.waf, severity: "medium", detail: sec.waf ? "SQL injection, XSS gibi saldırılar engelleniyor." : "Web uygulama güvenlik duvarı kapalı.", fix: sec.waf ? undefined : { action: `app.waf:${a.id}`, label: "WAF'ı aç" } });
    checks.push({ id: `app-headers-${a.id}`, scope: "app", target, title: "Güvenlik başlıkları", ok: sec.headers, severity: "low", detail: sec.headers ? "Clickjacking ve MIME koklama başlıkları ekleniyor." : "Güvenlik başlıkları kapalı.", fix: sec.headers ? undefined : { action: `app.headers:${a.id}`, label: "Başlıkları aç" } });
    checks.push({ id: `app-rate-${a.id}`, scope: "app", target, title: "Hız sınırı", ok: Boolean(sec.rateLimit), severity: "low", detail: sec.rateLimit ? `IP başına dakikada ${sec.rateLimit} istek.` : "Tek bir IP sınırsız istek atabiliyor.", fix: sec.rateLimit ? undefined : { action: `app.ratelimit:${a.id}`, label: "Dakikada 600 istekle sınırla" } });
    if (a.source_type !== "compose") {
      checks.push({ id: `app-mem-${a.id}`, scope: "app", target, title: "Bellek sınırı", ok: Boolean(a.memory_limit), severity: "low", detail: a.memory_limit ? `${a.memory_limit} MB.` : "Sınır yok; bellek sızdıran bir uygulama tüm sunucuyu çökertebilir.", link: `${link}?tab=settings` });
    }
    if (a.source_type === "git" || a.source_type === "compose") {
      checks.push({ id: `app-webhook-${a.id}`, scope: "app", target, title: "Webhook imzası zorunlu", ok: Boolean(a.webhook_signed), severity: "low", detail: a.webhook_signed ? "Yalnız imzalı push olayları deploy başlatıyor." : "Webhook adresini bilen herkes deploy tetikleyebilir.", link: `${link}?tab=settings` });
    }
    if (a.host_access) {
      checks.push({ id: `app-host-${a.id}`, scope: "app", target, title: "Sunucu erişimi kapalı", ok: false, severity: "medium", detail: "Bu uygulamanın compose dosyası sunucuya erişim (privileged, sunucu klasörü bağlama...) kullanabiliyor. Gerekmiyorsa kapat.", link: `${link}?tab=settings` });
    }
    const env = parseEnv(decrypt(a.env));
    const debug = Object.entries(env).find(([k, v]) => /^(DJANGO_)?DEBUG$|^APP_DEBUG$|^FLASK_DEBUG$/.test(k) && /^(1|true|yes|on)$/i.test(v));
    if (debug) {
      checks.push({ id: `app-debug-${a.id}`, scope: "app", target, title: "Hata ayıklama modu kapalı", ok: false, severity: "high", detail: `${debug[0]}=${debug[1]}: hata sayfaları kaynak kodu, ayarları ve gizli anahtarları gösterebilir.`, fix: { action: `app.debug:${a.id}:${debug[0]}`, label: `${debug[0]}'u kapat ve yeniden deploy et` } });
    }
    if (a.scan_status === "success" && a.scan_summary) {
      const sum = JSON.parse(a.scan_summary) as ScanSummary;
      checks.push({ id: `app-cve-${a.id}`, scope: "app", target, title: "İmajda kritik açık yok", ok: sum.critical === 0, severity: sum.critical ? "high" : "medium", detail: sum.critical || sum.high ? `${sum.critical} kritik, ${sum.high} yüksek seviye açık; ${sum.fixable} tanesi güncellemeyle kapanıyor. Taban imajı ve bağımlılıkları güncelleyip yeniden deploy et.` : "Bilinen kritik veya yüksek seviye açık yok.", link });
    }
  }

  const total = checks.reduce((n, c) => n + WEIGHT[c.severity], 0);
  const passed = checks.reduce((n, c) => n + (c.ok ? WEIGHT[c.severity] : 0), 0);
  const score = total ? Math.round((passed / total) * 100) : 100;
  return { score, grade: score >= 90 ? "A" : score >= 75 ? "B" : score >= 60 ? "C" : score >= 40 ? "D" : "F", checks, checkedAt: Date.now() };
}

/** Tek tıkla düzeltme. Eylem biçimi: "<tür>.<ad>:<id>[:<ek>]". */
export async function applyFix(action: string) {
  const [kind, idStr, extra] = action.split(":");
  const id = Number(idStr);
  if (!Number.isInteger(id)) throw new Error("Geçersiz eylem");
  switch (kind) {
    case "server.harden":
      // Birkaç dakika sürebilir; ilerleme sunucu sayfasındaki kurulum çıktısında görünür.
      hardenServer(getServer(id))
        .then(() => hostCache.delete(id))
        .catch((e) => console.error("Sıkılaştırma başarısız:", (e as Error).message));
      return { background: true };
    case "server.dockerfw":
      await applyDockerFirewall(getServer(id), { force: true });
      break;
    case "server.autoupdates":
      await hostExec(
        getServer(id),
        `set -e
if command -v apt-get >/dev/null; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq && apt-get install -y -qq unattended-upgrades >/dev/null
  printf 'APT::Periodic::Update-Package-Lists "1";\\nAPT::Periodic::Unattended-Upgrade "1";\\n' > /etc/apt/apt.conf.d/20auto-upgrades
  systemctl enable --now unattended-upgrades >/dev/null 2>&1
elif command -v dnf >/dev/null; then
  dnf install -y -q dnf-automatic >/dev/null
  sed -i 's/^apply_updates.*/apply_updates = yes/; s/^upgrade_type.*/upgrade_type = security/' /etc/dnf/automatic.conf
  systemctl enable --now dnf-automatic.timer >/dev/null 2>&1
fi`,
        10 * 60_000,
      );
      break;
    case "app.waf":
    case "app.headers":
    case "app.ratelimit": {
      const app = db.prepare("SELECT security, server_id FROM apps WHERE id = ?").get(id) as { security: string; server_id: number } | undefined;
      if (!app) throw new Error("Uygulama bulunamadı");
      const sec = parseSecurity(app.security);
      if (kind === "app.waf") sec.waf = true;
      if (kind === "app.headers") sec.headers = true;
      if (kind === "app.ratelimit") sec.rateLimit = 600;
      db.prepare("UPDATE apps SET security = ? WHERE id = ?").run(JSON.stringify(sec), id);
      const server = getServer(app.server_id);
      if (server.status === "ready") await applyCaddyConfig(server);
      break;
    }
    case "app.debug": {
      const { mergeEnvText, enqueueDeploy } = await import("./deploy.js");
      const { encrypt } = await import("../lib/crypto.js");
      const app = db.prepare("SELECT env FROM apps WHERE id = ?").get(id) as { env: string | null } | undefined;
      if (!app || !extra || !/^[A-Z_]+$/.test(extra)) throw new Error("Geçersiz eylem");
      db.prepare("UPDATE apps SET env = ? WHERE id = ?").run(encrypt(mergeEnvText(decrypt(app.env), { [extra]: extra === "APP_DEBUG" || extra === "FLASK_DEBUG" ? "false" : "False" })), id);
      enqueueDeploy(id, "manual", { title: "Güvenlik puanı: hata ayıklama kapatıldı" });
      break;
    }
    default:
      throw new Error("Bilinmeyen eylem");
  }
  if (kind?.startsWith("server.")) hostCache.delete(id);
  return { background: false };
}
