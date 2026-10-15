import os from "node:os";
import { config } from "../config.js";
import { db } from "../db.js";
import { bus } from "../lib/events.js";
import { HttpError } from "../lib/http.js";
import { applyDockerFirewall, dockerFirewallEnabled } from "./firewall.js";
import { applyCaddyConfig, ensureCaddy } from "./caddy.js";
import { dockerFor, forgetDockerClient, getDockerInfo, type ServerRow } from "./docker.js";
import { getPrivateKey, sshExec, type SshTarget } from "./ssh.js";
import { getSystemStats } from "./system.js";

export function getServer(id: number): ServerRow {
  const row = db.prepare("SELECT * FROM servers WHERE id = ?").get(id) as ServerRow | undefined;
  if (!row) throw new HttpError(404, "Sunucu bulunamadı");
  return row;
}

export function listServers(): ServerRow[] {
  return db.prepare("SELECT * FROM servers ORDER BY kind = 'local' DESC, id").all() as ServerRow[];
}


/** Panelin çalıştığı makine her zaman "yerel sunucu" olarak listede bulunur. */
export function ensureLocalServer() {
  const exists = db.prepare("SELECT id FROM servers WHERE kind = 'local'").get();
  if (exists) return;
  db.prepare(
    `INSERT INTO servers (name, kind, https_mode, public_ip, status, created_at)
     VALUES (?, 'local', ?, ?, 'pending', ?)`,
  ).run(
    process.env.HOST_HOSTNAME || os.hostname(),
    config.isProd && process.env.XUDBIN_HTTPS !== "0" ? "auto" : "off",
    // install.sh IP'yi bulduysa onu kullan (yerel ağ kurulumlarında dış IP'den farklıdır).
    process.env.XUDBIN_PUBLIC_IP || (config.isProd ? null : "127.0.0.1"),
    Date.now(),
  );
}

export function sshTargetFor(server: ServerRow): SshTarget {
  if (!server.host || !server.ssh_key_id) throw new HttpError(422, "Sunucunun SSH bilgileri eksik");
  return { host: server.host, port: server.port, username: server.username, privateKey: getPrivateKey(server.ssh_key_id) };
}

export function updateServer(id: number, patch: Partial<ServerRow>) {
  // undefined alanlar "değiştirme" demektir; yalnız null bilerek temizlemek içindir.
  const keys = Object.keys(patch).filter((k) => (patch as Record<string, unknown>)[k] !== undefined);
  if (!keys.length) return;
  db.prepare(`UPDATE servers SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`).run(
    ...keys.map((k) => (patch as Record<string, string | number | null>)[k] ?? null),
    id,
  );
  if (keys.some((k) => ["host", "port", "username", "ssh_key_id"].includes(k))) forgetDockerClient(id);
}

// ---------------------------------------------------------------------------
// İzleme
// ---------------------------------------------------------------------------

export type ServerStats = {
  cpu: { usage: number; cores: number; load: number[]; model: string };
  memory: { total: number; used: number };
  disk: { total: number; used: number } | null;
  uptime: number;
  platform: string;
  hostname: string;
};

// Uzak sunucuda tek SSH oturumunda çalışan ölçüm betiği: /proc'tan iki örnek alıp CPU yüzdesini hesaplar.
const STATS_SCRIPT = `
set -e
a=$(head -1 /proc/stat); sleep 1; b=$(head -1 /proc/stat)
echo "cpu1 $a"; echo "cpu2 $b"
echo "cores $(nproc)"
echo "load $(cut -d' ' -f1-3 /proc/loadavg)"
grep -E '^(MemTotal|MemAvailable):' /proc/meminfo
echo "disk $(df -kP / | tail -1 | awk '{print $2, $3}')"
echo "uptime $(cut -d' ' -f1 /proc/uptime)"
echo "kernel $(uname -sr)"
echo "host $(hostname)"
m=$(grep -m1 'model name' /proc/cpuinfo | cut -d: -f2- | sed 's/^ //' || true)
[ -n "$m" ] || m=$(lscpu 2>/dev/null | awk -F: '/Model name/{gsub(/^ +/,"",$2); print $2; exit}' || true)
echo "model $m"
. /etc/os-release 2>/dev/null && echo "os $PRETTY_NAME" || true
`;

const remoteCache = new Map<number, { at: number; stats: ServerStats }>();

function parseRemoteStats(out: string): ServerStats {
  const line = (k: string) => out.split("\n").find((l) => l.startsWith(`${k} `) || l.startsWith(`${k}:`))?.replace(/^\S+:?\s*/, "") ?? "";
  const cpuNums = (s: string) => s.replace(/^cpu\s+/, "").split(/\s+/).map(Number);
  const [a, b] = [cpuNums(line("cpu1")), cpuNums(line("cpu2"))];
  const idle = (v: number[]) => (v[3] ?? 0) + (v[4] ?? 0);
  const total = (v: number[]) => v.slice(0, 8).reduce((s, n) => s + (n || 0), 0);
  const dt = total(b) - total(a);
  const usage = dt > 0 ? (1 - (idle(b) - idle(a)) / dt) * 100 : 0;
  const memTotal = Number(line("MemTotal").split(/\s+/)[0]) * 1024;
  const memAvail = Number(line("MemAvailable").split(/\s+/)[0]) * 1024;
  const [diskTotal, diskUsed] = line("disk").split(/\s+/).map((n) => Number(n) * 1024);
  const os = line("os");
  return {
    cpu: {
      usage: Math.round(usage * 10) / 10,
      cores: Number(line("cores")) || 1,
      load: line("load").split(/\s+/).map(Number),
      model: line("model").replace(/^-$/, ""),
    },
    memory: { total: memTotal, used: memTotal - memAvail },
    disk: diskTotal ? { total: diskTotal, used: diskUsed ?? 0 } : null,
    uptime: Number(line("uptime")) || 0,
    platform: os || line("kernel"),
    hostname: line("host"),
  };
}

export async function getServerStats(server: ServerRow): Promise<ServerStats & { history?: { t: number; cpu: number; mem: number }[] }> {
  if (server.kind === "local") {
    const s = getSystemStats();
    return { cpu: s.cpu, memory: s.memory, disk: s.disk, uptime: s.uptime, platform: s.platform, hostname: s.hostname, history: s.history };
  }
  const cached = remoteCache.get(server.id);
  if (cached && Date.now() - cached.at < 4000) return cached.stats;
  const res = await sshExec(sshTargetFor(server), STATS_SCRIPT, { timeoutMs: 15_000 });
  if (res.code !== 0) throw new Error(res.stderr.trim() || "Sunucu bilgileri okunamadı");
  const stats = parseRemoteStats(res.stdout);
  remoteCache.set(server.id, { at: Date.now(), stats });
  return stats;
}

export async function getServerOverview(server: ServerRow) {
  const [stats, docker] = await Promise.allSettled([getServerStats(server), getDockerInfo(dockerFor(server))]);
  return {
    stats: stats.status === "fulfilled" ? stats.value : null,
    statsError: stats.status === "rejected" ? (stats.reason as Error).message : null,
    docker: docker.status === "fulfilled" ? docker.value : { available: false as const, error: (docker.reason as Error).message },
  };
}

// ---------------------------------------------------------------------------
// Kurulum
// ---------------------------------------------------------------------------

const running = new Set<number>();

function setupLogger(serverId: number) {
  return (line: string) => {
    const stamped = `${line}\n`;
    db.prepare("UPDATE servers SET setup_log = substr(setup_log || ?, -200000) WHERE id = ?").run(stamped, serverId);
    bus.emit(`server-setup:${serverId}`, line);
  };
}

/**
 * Sunucuyu Xudbin'e hazırlar:
 *  - uzak sunucuda: SSH bağlantısını dener, Docker yoksa kurar, dış IP'yi bulur
 *  - her sunucuda: ortak ağı, Caddy imajını ve konteynerini kurar, yapılandırmayı uygular
 */
export function startServerSetup(serverId: number) {
  if (running.has(serverId)) throw new HttpError(409, "Kurulum zaten çalışıyor");
  running.add(serverId);
  db.prepare("UPDATE servers SET status = 'setting_up', status_detail = NULL, setup_log = '' WHERE id = ?").run(serverId);
  const log = setupLogger(serverId);

  (async () => {
    let server = getServer(serverId);
    try {
      if (server.kind === "ssh") {
        const target = sshTargetFor(server);
        const sudo = server.username === "root" ? "" : "sudo -n ";
        log(`${server.username}@${server.host}:${server.port} adresine bağlanılıyor...`);
        const hello = await sshExec(target, "uname -sr && (. /etc/os-release && echo $PRETTY_NAME)");
        log(`Bağlantı kuruldu: ${hello.stdout.trim().replace(/\n/g, ", ")}`);

        if (sudo) {
          const check = await sshExec(target, "sudo -n true");
          if (check.code !== 0) throw new Error(`${server.username} kullanıcısı şifresiz sudo yetkisine sahip değil. root kullan veya NOPASSWD sudo ver.`);
        }

        // Düşük RAM'li sunucularda (ör. 2 GB VPS) derlemeler bellek yetersizliğinden çökmesin.
        const swap = await sshExec(
          target,
          `mem=$(awk '/MemTotal/{print int($2/1024)}' /proc/meminfo)
           if [ "$mem" -lt 3000 ] && [ -z "$(swapon --show --noheadings)" ] && [ ! -e /swapfile ]; then
             (${sudo}fallocate -l 2G /swapfile || ${sudo}dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none) &&
             ${sudo}chmod 600 /swapfile && ${sudo}mkswap /swapfile >/dev/null && ${sudo}swapon /swapfile &&
             (grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | ${sudo}tee -a /etc/fstab >/dev/null) &&
             echo "RAM \${mem} MB; 2 GB swap oluşturuldu."
           fi`,
        );
        if (swap.stdout.trim()) log(swap.stdout.trim());

        const hasDocker = (await sshExec(target, "command -v docker")).code === 0;
        if (!hasDocker) {
          log("Docker kuruluyor (get.docker.com)...");
          const inst = await sshExec(target, `curl -fsSL https://get.docker.com | ${sudo}sh`, { onLine: log, timeoutMs: 15 * 60_000 });
          if (inst.code !== 0) throw new Error("Docker kurulamadı. Yukarıdaki çıktıya bak.");
        } else {
          const v = await sshExec(target, "docker version --format '{{.Server.Version}}'");
          log(`Docker zaten kurulu (${v.stdout.trim() || "sürüm okunamadı"}).`);
        }
        await sshExec(target, `${sudo}systemctl enable --now docker >/dev/null 2>&1 || true`);
        if (sudo) {
          await sshExec(target, `${sudo}usermod -aG docker ${server.username}`);
          log(`${server.username} docker grubuna eklendi.`);
        }

        if (!server.public_ip) {
          const ip = await sshExec(target, "curl -4 -fsS --max-time 5 https://api.ipify.org || true");
          const found = ip.stdout.trim();
          if (/^\d+\.\d+\.\d+\.\d+$/.test(found)) {
            updateServer(serverId, { public_ip: found });
            log(`Dış IP adresi: ${found}`);
          } else if (server.host && /^\d+\.\d+\.\d+\.\d+$/.test(server.host)) {
            updateServer(serverId, { public_ip: server.host });
          }
        }
        forgetDockerClient(serverId);
        server = getServer(serverId);
      } else if (!server.public_ip && config.isProd) {
        try {
          const res = await fetch("https://api.ipify.org", { signal: AbortSignal.timeout(5000) });
          const ip = (await res.text()).trim();
          if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) updateServer(serverId, { public_ip: ip });
          log(`Dış IP adresi: ${ip}`);
        } catch {
          log("Dış IP adresi bulunamadı; otomatik alan adları için sunucu ayarlarından gir.");
        }
        server = getServer(serverId);
      }

      log("Docker API'ye bağlanılıyor...");
      const info = await getDockerInfo(dockerFor(server));
      if (!info.available) throw new Error(`Docker API'ye ulaşılamadı: ${info.error}`);
      log(`Docker ${info.version} hazır.`);

      await ensureCaddy(server, log);
      await applyCaddyConfig(server);
      log("Caddy yapılandırması uygulandı.");

      updateServer(serverId, { status: "ready", status_detail: null });
      await applyDockerFirewall(getServer(serverId), { force: true })
        .then(() => dockerFirewallEnabled() && log("Docker portları güvenlik duvarına bağlandı: dışarıdan yalnız 80 ve 443 açık."))
        .catch((err) => log(`Uyarı: ${(err as Error).message}`));
      log("Sunucu hazır.");
      bus.emit(`server-setup:${serverId}`, "__done__");
    } catch (err) {
      const message = (err as Error).message;
      log(`Hata: ${message}`);
      updateServer(serverId, { status: "error", status_detail: message });
      bus.emit(`server-setup:${serverId}`, "__done__");
    } finally {
      running.delete(serverId);
    }
  })();
}

export const isSetupRunning = (id: number) => running.has(id);

/**
 * Uzak sunucuyu sıkılaştırır: UFW ile yalnız SSH/80/443 portlarını açar, fail2ban ile
 * SSH'a kaba kuvvet denemelerini banlar. SSH portu sshd yapılandırmasından okunur ki erişim kesilmesin.
 */
export async function hardenServer(server: ServerRow) {
  if (server.kind !== "ssh") throw new HttpError(422, "Panelin kendi sunucusu kurulum scriptiyle sıkılaştırılır.");
  const sudo = server.username === "root" ? "" : "sudo -n ";
  const log = setupLogger(server.id);
  // Debian/Ubuntu'da UFW, AlmaLinux/Rocky/RHEL'de firewalld; fail2ban ikisinde de.
  const script = `
set -e
SSH_PORT=$(${sudo}sshd -T 2>/dev/null | awk '/^port /{print $2; exit}' || true)
SSH_PORT=\${SSH_PORT:-${server.port}}
echo "SSH portu: $SSH_PORT"
if command -v apt-get >/dev/null; then
  export DEBIAN_FRONTEND=noninteractive
  ${sudo}apt-get update -qq
  ${sudo}apt-get install -y -qq ufw fail2ban >/dev/null
  ${sudo}ufw allow "$SSH_PORT"/tcp >/dev/null
  ${sudo}ufw allow 80/tcp >/dev/null
  ${sudo}ufw allow 443/tcp >/dev/null
  ${sudo}ufw allow 443/udp >/dev/null
  ${sudo}ufw --force enable >/dev/null
  BACKEND=auto
elif command -v dnf >/dev/null; then
  ${sudo}dnf install -y -q epel-release >/dev/null
  ${sudo}dnf install -y -q firewalld fail2ban >/dev/null
  ${sudo}systemctl enable --now firewalld >/dev/null 2>&1
  for p in "$SSH_PORT/tcp" 80/tcp 443/tcp 443/udp; do ${sudo}firewall-cmd -q --permanent --add-port="$p"; done
  ${sudo}firewall-cmd -q --reload
  BACKEND=systemd
else
  echo "Desteklenmeyen dağıtım: apt-get veya dnf bulunamadı"; exit 3
fi
echo "Güvenlik duvarı açık: $SSH_PORT, 80, 443"
printf '[sshd]\\nenabled = true\\nport = %s\\nbackend = %s\\nmaxretry = 5\\nfindtime = 10m\\nbantime = 1h\\n' "$SSH_PORT" "$BACKEND" | ${sudo}tee /etc/fail2ban/jail.d/xudbin.local >/dev/null
${sudo}systemctl enable --now fail2ban >/dev/null 2>&1
${sudo}systemctl restart fail2ban
echo "fail2ban SSH korumasıyla çalışıyor"
`;
  log("Sunucu sıkılaştırılıyor...");
  const res = await sshExec(sshTargetFor(server), script, { onLine: log, timeoutMs: 10 * 60_000 });
  if (res.code !== 0) throw new Error("Sıkılaştırma tamamlanamadı. Kurulum çıktısına bak.");
  log("Sıkılaştırma tamamlandı.");
}

/** Sunucunun güvenlik durumunu okur: güvenlik duvarı, fail2ban, SSH şifre girişi. */
export async function getServerSecurity(server: ServerRow) {
  if (server.kind !== "ssh") return null;
  const sudo = server.username === "root" ? "" : "sudo -n ";
  const res = await sshExec(
    sshTargetFor(server),
    `if command -v ufw >/dev/null; then echo "ufw $(${sudo}ufw status 2>/dev/null | head -1 | awk '{print $2}')"; else echo "ufw $(${sudo}firewall-cmd --state 2>/dev/null | sed 's/running/active/')"; fi
     echo "f2b $(systemctl is-active fail2ban 2>/dev/null)"
     echo "banned $(${sudo}fail2ban-client status sshd 2>/dev/null | awk -F: '/Total banned/{gsub(/ /,"",$2); print $2}')"
     echo "pwauth $(${sudo}sshd -T 2>/dev/null | awk '/^passwordauthentication /{print $2}')"
     echo "rootlogin $(${sudo}sshd -T 2>/dev/null | awk '/^permitrootlogin /{print $2}')"`,
    { timeoutMs: 15_000 },
  );
  const get = (k: string) => res.stdout.split("\n").find((l) => l.startsWith(`${k} `))?.slice(k.length + 1).trim() ?? "";
  return {
    firewall: get("ufw") === "active",
    fail2ban: get("f2b") === "active",
    sshBanned: Number(get("banned")) || 0,
    passwordAuth: get("pwauth") !== "no",
    rootLogin: get("rootlogin") || "bilinmiyor",
  };
}

/** Uzak sunuculara 2 dakikada bir ulaşılabilirlik kontrolü; erişim kesilirse/dönerse bildirir. */
export function startServerMonitor(onChange: (server: ServerRow, reachable: boolean) => void) {
  const down = new Set<number>();
  setInterval(async () => {
    for (const s of listServers().filter((x) => x.kind === "ssh" && x.status === "ready")) {
      const ok = await sshExec(sshTargetFor(s), "true", { timeoutMs: 20_000 }).then(() => true, () => false);
      if (!ok && !down.has(s.id)) {
        down.add(s.id);
        onChange(s, false);
      } else if (ok && down.has(s.id)) {
        down.delete(s.id);
        onChange(s, true);
      }
    }
  }, 120_000).unref();
}
