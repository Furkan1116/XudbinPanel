import { config } from "../config.js";
import { db } from "../db.js";
import { dockerFor, imageExists, withTimeout, type ServerRow } from "./docker.js";
import { listServers } from "./servers.js";

/**
 * Docker, yayınlanan portlar için iptables kurallarını kendisi yazdığından UFW/firewalld bu portları engelleyemez.
 * Burada DOCKER-USER zincirine bir XUDBIN-FW zinciri eklenir: dışarıdan konteynerlere yalnız 80/443 ve
 * panelden dışarı açılmış veritabanı portları ulaşır; compose'taki "ports:" dahil gerisi kapalıdır.
 * Kurallar kalıcı değildir (yeniden başlatmada silinir); panel açılışta ve periyodik olarak yeniden uygular.
 */
export function firewallScript(openPorts: number[]) {
  const ports = [80, 443, ...openPorts].filter((p, i, a) => Number.isInteger(p) && p > 0 && p < 65536 && a.indexOf(p) === i);
  return `
set -e
CH=XUDBIN-FW
for T in iptables ip6tables; do
  command -v $T >/dev/null 2>&1 || continue
  $T -n -L DOCKER-USER >/dev/null 2>&1 || continue
  $T -N $CH 2>/dev/null || $T -F $CH
  $T -A $CH -i docker0 -j RETURN
  $T -A $CH -i br-+ -j RETURN
  $T -A $CH -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN
  for P in ${ports.join(" ")}; do $T -A $CH -p tcp -m conntrack --ctorigdstport $P --ctdir ORIGINAL -j RETURN; done
  $T -A $CH -p udp -m conntrack --ctorigdstport 443 --ctdir ORIGINAL -j RETURN
  $T -A $CH -m conntrack --ctstate NEW,INVALID -j DROP
  $T -C DOCKER-USER -j $CH 2>/dev/null || $T -I DOCKER-USER 1 -j $CH
  echo "$T: açık portlar ${ports.join(", ")}"
done
`;
}

/** Geliştirmede (Mac + OrbStack) kapalı; sunucuda XUDBIN_DOCKER_FIREWALL=0 ile kapatılabilir. */
export const dockerFirewallEnabled = () => config.isProd && process.env.XUDBIN_DOCKER_FIREWALL !== "0";

/** Sunucunun kendi kabuğunda root olarak komut çalıştırır: Caddy imajından, sunucunun köküne chroot eden kısa ömürlü bir konteyner. */
export async function hostExec(server: ServerRow, script: string, timeoutMs = 60_000) {
  const docker = dockerFor(server);
  if (!(await imageExists(docker, config.caddyImage))) throw new Error("Caddy imajı yok; önce sunucu kurulumunu tamamla");
  const container = await docker.createContainer({
    Image: config.caddyImage,
    Entrypoint: ["chroot", "/host", "sh", "-c", script],
    Cmd: [],
    // TTY: çıktı Docker'ın çoklama başlıkları olmadan, düz metin gelir.
    Tty: true,
    Labels: { "xudbin.managed": "true", "xudbin.task": "host-exec" },
    HostConfig: { AutoRemove: false, Privileged: true, NetworkMode: "host", Binds: ["/:/host"] },
  });
  try {
    await container.start();
    const res = (await withTimeout(container.wait(), timeoutMs, "Sunucu komutu zaman aşımına uğradı")) as { StatusCode: number };
    const logs = (await container.logs({ stdout: true, stderr: true })).toString("utf8").replace(/\r/g, "");
    if (res.StatusCode !== 0) throw new Error(logs.trim().split("\n").pop() || `Komut ${res.StatusCode} koduyla çıktı`);
    return logs;
  } finally {
    await container.remove({ force: true }).catch(() => {});
  }
}

const lastApplied = new Map<number, string>();

/** Sunucudaki Docker güvenlik duvarı kurallarını günceller. Aynı kurallar az önce uygulandıysa tekrar çalıştırmaz (force hariç). */
export async function applyDockerFirewall(server: ServerRow, opts: { force?: boolean } = {}) {
  if (!dockerFirewallEnabled() || server.status !== "ready") return;
  const ports = (db.prepare("SELECT external_port FROM databases WHERE server_id = ? AND external_port IS NOT NULL").all(server.id) as { external_port: number }[]).map(
    (r) => r.external_port,
  );
  const script = firewallScript(ports);
  if (!opts.force && lastApplied.get(server.id) === script) return;
  await hostExec(server, script).catch((e: Error) => {
    throw new Error(`Güvenlik duvarı kuralları uygulanamadı: ${e.message}`);
  });
  lastApplied.set(server.id, script);
}

/** Açılışta ve 15 dakikada bir tüm sunuculara uygular (sunucu yeniden başladıysa kurallar geri gelir). */
export function startFirewallKeeper() {
  if (!dockerFirewallEnabled()) return;
  const all = () => {
    for (const s of listServers().filter((x) => x.status === "ready")) {
      applyDockerFirewall(s, { force: true }).catch((err) => console.error(`${s.name}: ${(err as Error).message}`));
    }
  };
  setTimeout(all, 10_000).unref();
  setInterval(all, 15 * 60_000).unref();
}
