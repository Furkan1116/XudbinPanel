import tarStream from "tar-stream";
import { incomingRelays, outgoingRelays } from "./remote-replicas.js";
import { config } from "../config.js";
import { db } from "../db.js";
import { getSettings } from "../lib/settings.js";
import {
  buildImage,
  containerState,
  pullImage,
  withTimeout,
  dockerFor,
  ensureNetwork,
  execIn,
  imageExists,
  putFile,
  type ServerRow,
} from "./docker.js";

export const CADDY_CONTAINER = "xudbin-caddy";
export const ACCESS_LOG = "/data/logs/access.log";

const CADDY_DOCKERFILE = `
FROM caddy:2.11-builder AS builder
RUN xcaddy build \\
    --with github.com/corazawaf/coraza-caddy/v2 \\
    --with github.com/mholt/caddy-ratelimit
FROM caddy:2.11-alpine
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
RUN mkdir -p /data/logs
`;

export type AppSecurity = {
  waf: boolean;
  rateLimit: number | null; // IP başına dakikada istek
  basicAuth: { username: string; hash: string } | null;
  allowIps: string[];
  denyIps: string[];
  headers: boolean;
};

export const DEFAULT_SECURITY: AppSecurity = {
  waf: true,
  rateLimit: 600,
  basicAuth: null,
  allowIps: [],
  denyIps: [],
  headers: true,
};

export function parseSecurity(raw: string | null): AppSecurity {
  try {
    return { ...DEFAULT_SECURITY, ...(raw ? JSON.parse(raw) : {}) };
  } catch {
    return DEFAULT_SECURITY;
  }
}

/** Caddy imajı, ortak ağ ve Caddy konteyneri sunucuda yoksa oluşturur. */
export async function ensureCaddy(server: ServerRow, log: (line: string) => void = () => {}) {
  const docker = dockerFor(server);
  await ensureNetwork(docker);

  if (!(await imageExists(docker, config.caddyImage)) && config.caddyPrebuilt) {
    try {
      log(`Hazır Caddy imajı deneniyor: ${config.caddyPrebuilt}`);
      await withTimeout(pullImage(docker, config.caddyPrebuilt, () => {}), 180_000, "zaman aşımı");
      const [repo, tag] = config.caddyImage.split(":") as [string, string];
      await docker.getImage(config.caddyPrebuilt).tag({ repo, tag });
      log("Hazır Caddy imajı kullanılıyor.");
    } catch {
      log("Hazır imaj alınamadı.");
    }
  }
  if (!(await imageExists(docker, config.caddyImage)) && server.kind === "ssh") {
    await copyCaddyImageFromLocal(server, log).catch((err) => log(`İmaj kopyalanamadı (${(err as Error).message}), derlenecek.`));
  }
  if (!(await imageExists(docker, config.caddyImage))) {
    log("Caddy imajı derleniyor (WAF ve hız sınırı modülleriyle). İlk seferde birkaç dakika sürer...");
    const pack = tarStream.pack();
    pack.entry({ name: "Dockerfile" }, CADDY_DOCKERFILE);
    pack.finalize();
    // Go'nun "go: downloading ..." satırları yüzlerce olur; kurulum çıktısını boğmasın.
    await buildImage(docker, pack, { tag: config.caddyImage }, (l) => {
      if (!l.startsWith("go: ")) log(l);
    });
  }

  const state = await containerState(docker, CADDY_CONTAINER);
  if (!state.exists) {
    log("Caddy konteyneri oluşturuluyor...");
    await docker.createContainer({
      name: CADDY_CONTAINER,
      Image: config.caddyImage,
      Cmd: ["caddy", "run", "--config", "/etc/caddy/caddy.json"],
      Labels: { "xudbin.managed": "true", "xudbin.role": "proxy" },
      ExposedPorts: { "80/tcp": {}, "443/tcp": {}, "443/udp": {} },
      HostConfig: {
        PortBindings: {
          "80/tcp": [{ HostPort: "80" }],
          "443/tcp": [{ HostPort: "443" }],
          "443/udp": [{ HostPort: "443" }],
        },
        Binds: ["xudbin-caddy-data:/data", "xudbin-caddy-config:/config"],
        RestartPolicy: { Name: "unless-stopped" },
        NetworkMode: config.network,
        ExtraHosts: ["host.docker.internal:host-gateway"],
      },
    });
    await putFile(docker, CADDY_CONTAINER, "/etc/caddy", "caddy.json", JSON.stringify(buildCaddyConfig(server), null, 2));
  }
  if (!state.running) {
    log("Caddy başlatılıyor...");
    await docker.getContainer(CADDY_CONTAINER).start();
  }
}

/**
 * Panelin sunucusunda Caddy imajı varsa ve hedef sunucu aynı işlemci mimarisindeyse,
 * imajı derlemek yerine Docker API üzerinden aktarır (dakikalar yerine saniyeler).
 */
async function copyCaddyImageFromLocal(server: ServerRow, log: (line: string) => void) {
  const local = db.prepare("SELECT * FROM servers WHERE kind = 'local'").get() as ServerRow | undefined;
  if (!local) return;
  const src = dockerFor(local);
  if (!(await imageExists(src, config.caddyImage))) return;
  const dst = dockerFor(server);
  const [img, info] = await Promise.all([src.getImage(config.caddyImage).inspect(), dst.info()]);
  const norm = (a: string) => ({ x86_64: "amd64", aarch64: "arm64" })[a] ?? a;
  if (norm(img.Architecture) !== norm(info.Architecture as string)) {
    log(`Panel sunucusu ${norm(img.Architecture)}, bu sunucu ${norm(info.Architecture as string)}; Caddy imajı burada derlenecek.`);
    return;
  }
  log("Caddy imajı panel sunucusundan aktarılıyor...");
  const stream = await src.getImage(config.caddyImage).get();
  const res = await dst.loadImage(stream);
  await new Promise<void>((resolve, reject) => dst.modem.followProgress(res, (err) => (err ? reject(err) : resolve())));
  log("Caddy imajı aktarıldı.");
}

const pending = new Map<number, Promise<void>>();

/** Sunucunun Caddy yapılandırmasını yeniden üretip uygular. Aynı sunucu için çağrılar sıraya girer. */
/** Caddy'nin bu alan adı için sertifikası hazır mı (Let's Encrypt / ZeroSSL / iç CA). */
export async function certificateReady(server: ServerRow, host: string) {
  if (!/^[a-z0-9.-]+$/i.test(host)) return false;
  const res = await execIn(dockerFor(server), CADDY_CONTAINER, ["sh", "-c", `ls /data/caddy/certificates/*/${host}/${host}.crt >/dev/null 2>&1`], { timeoutMs: 10_000 }).catch(() => ({ exitCode: 1 }));
  return res.exitCode === 0;
}

export function applyCaddyConfig(server: ServerRow): Promise<void> {
  const prev = pending.get(server.id) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(() => doApply(server));
  pending.set(server.id, next);
  return next;
}

async function doApply(server: ServerRow) {
  const docker = dockerFor(server);
  const state = await containerState(docker, CADDY_CONTAINER);
  if (!state.exists) throw new Error("Bu sunucuda Caddy kurulu değil. Önce sunucu kurulumunu çalıştır.");
  const json = JSON.stringify(buildCaddyConfig(server), null, 2);
  await putFile(docker, CADDY_CONTAINER, "/etc/caddy", "caddy.json", json);
  if (!state.running) {
    await docker.getContainer(CADDY_CONTAINER).start();
    return;
  }
  const res = await execIn(docker, CADDY_CONTAINER, ["caddy", "reload", "--config", "/etc/caddy/caddy.json", "--force"], {
    timeoutMs: 30_000,
  });
  if (res.exitCode !== 0) {
    const msg = (res.stderr || res.stdout).split("\n").filter(Boolean).pop() ?? "bilinmeyen hata";
    throw new Error(`Caddy yapılandırması uygulanamadı: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// Yapılandırma üretimi
// ---------------------------------------------------------------------------

type Route = Record<string, unknown>;

type DomainRow = {
  host: string;
  https: number;
  app_id: number;
  app_slug: string;
  source_type: string;
  container: string | null;
  compose_service: string | null;
  port: number;
  security: string;
  status: string;
  kind: string;
  replica_containers: string;
};

const WAF_DIRECTIVES = [
  "Include @coraza.conf-recommended",
  "Include @crs-setup.conf.example",
  "Include @owasp_crs/*.conf",
  "SecRuleEngine On",
  "SecRequestBodyAccess On",
  "SecResponseBodyAccess Off",
  "SecAuditEngine Off",
].join("\n");

/** Caddy'nin çözdüğü gerçek istemci IP'si (güvenilir vekil yoksa doğrudan bağlanan adres). */
const CLIENT_IP = "{http.vars.client_ip}";
/** Panel ile Caddy arasında gerçek istemci IP'sini taşıyan başlık; lib/client-ip.ts aynı adı okur. */
export const CLIENT_IP_HEADER = "X-Xudbin-Client-Ip";

function blockedIpRanges(): string[] {
  const rows = db
    .prepare("SELECT ip FROM blocked_ips WHERE expires_at IS NULL OR expires_at > ?")
    .all(Date.now()) as { ip: string }[];
  return rows.map((r) => r.ip);
}

function blockRoute(ranges: string[], reason: string): Route {
  return {
    // client_ip: Cloudflare Tunnel gibi güvenilir bir vekil varsa gerçek ziyaretçi IP'si; yoksa doğrudan bağlanan adres.
    match: [{ client_ip: { ranges } }],
    handle: [
      {
        handler: "static_response",
        status_code: 403,
        headers: { "X-Xudbin-Block": [reason] },
        body: "Erişim engellendi.",
      },
    ],
    terminal: true,
  };
}

function securityHandlers(sec: AppSecurity, zone: string): { routes: Route[]; handlers: Route[] } {
  const routes: Route[] = [];
  const handlers: Route[] = [];
  if (sec.denyIps.length) routes.push(blockRoute(sec.denyIps, "deny"));
  if (sec.allowIps.length) {
    routes.push({
      match: [{ not: [{ client_ip: { ranges: sec.allowIps } }] }],
      handle: [{ handler: "static_response", status_code: 403, headers: { "X-Xudbin-Block": ["allowlist"] }, body: "Erişim engellendi." }],
      terminal: true,
    });
  }
  if (sec.rateLimit && sec.rateLimit > 0) {
    handlers.push({
      handler: "rate_limit",
      rate_limits: {
        [zone]: { key: CLIENT_IP, window: "1m", max_events: sec.rateLimit },
      },
    });
  }
  if (sec.headers) {
    handlers.push({
      handler: "headers",
      response: {
        set: {
          "X-Content-Type-Options": ["nosniff"],
          "X-Frame-Options": ["SAMEORIGIN"],
          "Referrer-Policy": ["strict-origin-when-cross-origin"],
        },
        delete: ["Server", "X-Powered-By"],
        deferred: true,
      },
    });
  }
  if (sec.basicAuth) {
    handlers.push({
      handler: "authentication",
      providers: {
        http_basic: {
          accounts: [{ username: sec.basicAuth.username, password: sec.basicAuth.hash }],
          hash: { algorithm: "bcrypt" },
          realm: "Xudbin",
        },
      },
    });
  }
  if (sec.waf) handlers.push({ handler: "waf", load_owasp_crs: true, directives: WAF_DIRECTIVES });
  return { routes, handlers };
}

/**
 * Coraza bir isteği kestiğinde Caddy'ye hata olarak döner; bu rota yanıtı X-Xudbin-Block: waf ile işaretler.
 * Otomatik ban yalnız bu işareti sayar (uygulamanın kendi 403'ü proxy yanıtıdır, hata rotasına girmez).
 */
const WAF_ERROR_ROUTES: Route[] = [
  {
    match: [{ expression: "{http.error.status_code} == 403" }],
    handle: [{ handler: "static_response", status_code: 403, headers: { "X-Xudbin-Block": ["waf"] }, body: "Erişim engellendi." }],
    terminal: true,
  },
];

function upstreamsFor(d: DomainRow): string[] {
  if (d.kind === "worker") return [];
  if (d.source_type === "compose") return d.compose_service ? [`xb-${d.app_slug}-${d.compose_service}-1:${d.port}`] : [];
  if (!d.container) return [];
  const replicas = (() => {
    try {
      return JSON.parse(d.replica_containers || "[]") as string[];
    } catch {
      return [];
    }
  })();
  return [d.container, ...replicas].map((c) => `${c}:${d.port}`);
}

export function buildCaddyConfig(server: ServerRow) {
  // Cloudflare Tunnel açıkken istekler cloudflared konteynerinden gelir; ziyaretçinin gerçek IP'si başlıktan alınır.
  const clientIp = server.tunnel_token
    ? { trusted_proxies: { source: "static", ranges: ["172.16.0.0/12", "10.0.0.0/8", "192.168.0.0/16"] }, client_ip_headers: ["Cf-Connecting-Ip", "X-Forwarded-For"] }
    : {};
  const settings = getSettings();
  const blocked = blockedIpRanges();
  const domains = db
    .prepare(
      `SELECT d.host, d.https, a.id AS app_id, a.slug AS app_slug, a.source_type, a.container, a.compose_service,
              a.port, a.security, a.status, a.kind, a.replica_containers
       FROM domains d JOIN apps a ON a.id = d.app_id
       WHERE a.server_id = ? ORDER BY d.id`,
    )
    .all(server.id) as DomainRow[];

  // HTTPS'li alan adları :443 sunucusunda, yalnız HTTP olanlar :80 sunucusunda servis edilir.
  // :80'de ayrı bir sunucu olunca Caddy HTTPS'li alan adları için HTTP→HTTPS yönlendirmesini kendisi ekler.
  const httpsRoutes: Route[] = [];
  const httpRoutes: Route[] = [];
  const httpOnlyHosts: string[] = [];
  const httpsHosts: string[] = [];

  // Panel: yalnızca panelin çalıştığı (yerel) sunucuda.
  const httpsOff = server.https_mode === "off";
  const add = (host: string, wantsHttps: boolean, route: Route) => {
    if (wantsHttps && !httpsOff) {
      httpsHosts.push(host);
      httpsRoutes.push(route);
    } else {
      httpOnlyHosts.push(host);
      httpRoutes.push(route);
    }
  };

  if (server.kind === "local" && settings.panelDomain) {
    add(settings.panelDomain, settings.panelHttps, {
      match: [{ host: [settings.panelDomain] }],
      handle: [
        {
          handler: "subroute",
          routes: [
            ...(blocked.length ? [blockRoute(blocked, "blocklist")] : []),
            {
              handle: [
                {
                  handler: "rate_limit",
                  rate_limits: { panel: { key: CLIENT_IP, window: "1m", max_events: 600 } },
                },
                {
                  handler: "reverse_proxy",
                  upstreams: [{ dial: config.panelUpstream }],
                  // Panel gerçek ziyaretçi IP'sini yalnız bu başlıktan okur; set istemcinin gönderdiği değeri ezer.
                  headers: { request: { set: { [CLIENT_IP_HEADER]: [CLIENT_IP] } } },
                },
              ],
            },
          ],
        },
      ],
      terminal: true,
    });
  }

  // Çok sunuculu dağıtım: bu sunucu ana sunucuysa uzak kopyalara aktarma, ek sunucuysa gelen aktarma rotaları.
  const relayOut = outgoingRelays(server);
  const relayIn = httpsOff ? { routes: [], hosts: [] } : incomingRelays(server);

  for (const d of domains) {
    const relay = d.kind === "worker" ? undefined : relayOut.get(d.app_id);
    const upstreams = relay ? relay.upstreams.map((u) => u.dial) : upstreamsFor(d);
    const sec = parseSecurity(d.security);
    const { routes: secRoutes, handlers } = securityHandlers(sec, `app_${d.app_id}`);
    const final: Route =
      upstreams.length && d.status !== "stopped"
        ? {
            handle: [
              ...handlers,
              {
                handler: "reverse_proxy",
                upstreams: upstreams.map((dial) => ({ dial })),
                // Birden çok kopyada: sırayla dağıt, hata veren kopyayı 30 sn devre dışı bırak, isteği diğerine yeniden dene.
                ...(relay
                  ? {
                      // Çok sunuculu: hedefler sunucular (ağırlık = kopya sayısı), bağlantı şifreli; ulaşılamayan sunucu atlanır.
                      transport: relay.transport,
                      headers: relay.headers,
                      load_balancing: { selection_policy: { policy: "weighted_round_robin", weights: relay.upstreams.map((u) => u.weight) }, retries: 2 },
                      health_checks: { passive: { fail_duration: "30s", max_fails: 1, unhealthy_status: [502, 503, 504] } },
                    }
                  : upstreams.length > 1
                    ? { load_balancing: { selection_policy: { policy: "round_robin" }, retries: 2 }, health_checks: { passive: { fail_duration: "30s", max_fails: 3, unhealthy_status: [502, 503, 504] } } }
                    : {}),
              },
            ],
          }
        : {
            handle: [
              {
                handler: "static_response",
                status_code: 503,
                headers: { "Content-Type": ["text/html; charset=utf-8"] },
                body: placeholderPage("Uygulama şu an çalışmıyor", "Bu adres Xudbin'de bir uygulamaya bağlı, ama uygulama henüz yayında değil veya durduruldu."),
              },
            ],
          };
    add(d.host, Boolean(d.https), {
      match: [{ host: [d.host] }],
      handle: [
        {
          handler: "subroute",
          routes: [...(blocked.length ? [blockRoute(blocked, "blocklist")] : []), ...secRoutes, final],
        },
      ],
      terminal: true,
    });
  }

  // Hiçbir uygulamaya bağlı olmayan adresler.
  const fallback: Route = {
    handle: [
      {
        handler: "static_response",
        status_code: 404,
        headers: { "Content-Type": ["text/html; charset=utf-8"] },
        body: placeholderPage("Bu adres bir uygulamaya bağlı değil", "Sunucu Xudbin ile yönetiliyor, ama bu alan adı için tanımlı bir uygulama yok."),
      },
    ],
  };

  const tlsPolicies =
    server.https_mode === "internal"
      ? [{ issuers: [{ module: "internal" }] }]
      : server.https_mode === "auto"
        ? [
            {
              issuers: [
                {
                  module: "acme",
                  ...(server.acme_email ? { email: server.acme_email } : {}),
                  // İsteğe bağlı farklı ACME sunucusu (ör. Let's Encrypt staging) ve onun kök sertifikası.
                  ...(config.acmeCa ? { ca: config.acmeCa } : {}),
                  ...(config.acmeCaRoot ? { trusted_roots_pem_files: [config.acmeCaRoot] } : {}),
                },
              ],
            },
          ]
        : undefined;

  return {
    admin: { listen: "localhost:2019" },
    logging: {
      logs: {
        default: { exclude: ["http.log.access.access"] },
        access: {
          writer: { output: "file", filename: ACCESS_LOG, roll_size_mb: 20, roll_keep: 3 },
          encoder: { format: "json" },
          include: ["http.log.access.access"],
        },
      },
    },
    apps: {
      http: {
        servers: httpsOff
          ? {
              http: { listen: [":80"], routes: [...httpRoutes, fallback], logs: { default_logger_name: "access" }, errors: { routes: WAF_ERROR_ROUTES }, automatic_https: { disable: true }, ...clientIp },
            }
          : {
              https: {
                listen: [":443"],
                routes: [...relayIn.routes, ...httpsRoutes, fallback],
                logs: { default_logger_name: "access" },
                errors: { routes: WAF_ERROR_ROUTES },
                automatic_https: { skip: httpOnlyHosts },
                ...clientIp,
              },
              http: { listen: [":80"], routes: [...httpRoutes, fallback], logs: { default_logger_name: "access" }, errors: { routes: WAF_ERROR_ROUTES }, ...clientIp },
            },
      },
      ...(!httpsOff && (relayIn.hosts.length || (tlsPolicies && httpsHosts.length))
        ? {
            tls: {
              // Sunucular arası aktarma adresleri: Caddy'nin iç CA'sından sertifika (ana sunucu bu CA'ya güvenir).
              ...(relayIn.hosts.length ? { certificates: { automate: relayIn.hosts } } : {}),
              automation: {
                policies: [
                  ...(relayIn.hosts.length ? [{ subjects: relayIn.hosts, issuers: [{ module: "internal" }] }] : []),
                  ...(tlsPolicies && httpsHosts.length ? tlsPolicies : []),
                ],
              },
            },
          }
        : {}),
    },
  };
}

function placeholderPage(title: string, text: string) {
  return `<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px/1.6 system-ui,sans-serif;background:#f7f7f6;color:#1c1a1b}
@media(prefers-color-scheme:dark){body{background:#1b1a1c;color:#edebec}}main{max-width:32rem;padding:2rem}h1{font-size:1.4rem;margin:0 0 .5rem}p{margin:0;opacity:.7}</style></head>
<body><main><h1>${title}</h1><p>${text}</p></main></body></html>`;
}
