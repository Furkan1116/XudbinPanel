/** Demo modu: API isteklerini (yöntem + yol) örnek verilerle yanıtlar. */
import { getLang } from "@/lib/i18n";
import frameworks from "./frameworks.json";
import templates from "./templates.json";
import * as D from "./data";

export type DemoResponse = { status: number; body: unknown };
type Ctx = { params: Record<string, string>; query: URLSearchParams; body: unknown };
type Handler = (ctx: Ctx) => unknown;

const routes: { method: string; re: RegExp; keys: string[]; handler: Handler }[] = [];

function on(method: string, pattern: string, handler: Handler) {
  const keys: string[] = [];
  const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, k: string) => (keys.push(k), "([^/]+)"))}/?$`);
  routes.push({ method, re, keys, handler });
}

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export const demoMessage = () =>
  getLang() === "en" ? "Changes are disabled in the demo — install Xudbin on your own server to try it." : "Demo modunda değişiklik yapılamaz — kendi sunucuna kurup dene.";

const num = (s: string | undefined) => Number(s);
const findApp = (id: string) => {
  const a = D.apps.find((x) => x.id === num(id));
  if (!a) throw new HttpError(404, "Uygulama bulunamadı");
  return a;
};
const findDb = (id: string) => {
  const d = D.databases.find((x) => x.id === num(id));
  if (!d) throw new HttpError(404, "Veritabanı bulunamadı");
  return d;
};
const findServer = (id: string) => {
  const s = D.servers.find((x) => x.id === num(id));
  if (!s) throw new HttpError(404, "Sunucu bulunamadı");
  return s;
};
const projectName = (id: number) => D.projects.find((p) => p.id === id)?.name ?? "";
const strip = ({ log: _l, ...d }: D.DemoDeployment) => d;

// --- Kimlik ----------------------------------------------------------------
on("GET", "/auth/status", () => ({ setupRequired: false, user: D.demoUser, sso: null }));

// --- Genel bakış -------------------------------------------------------------
on("GET", "/servers/overview", () => ({ servers: D.servers.map((s) => ({ ...s, stats: D.statsFor(s.id), statsError: null, docker: D.docker(s.id) })) }));
on("GET", "/servers", () => ({ servers: D.servers }));
on("GET", "/deployments", () => ({
  deployments: D.deployments.slice(0, 8).map((d) => ({ ...strip(d), appName: D.apps.find((a) => a.id === d.appId)!.name })),
}));
on("GET", "/analytics/down", () => ({
  down: D.incidents
    .filter((i) => i.endedAt === null)
    .map((i) => ({ appId: i.appId, name: D.apps.find((a) => a.id === i.appId)!.name, since: i.startedAt, reason: i.reason })),
}));

on("GET", "/overview/deployments", ({ query }) => {
  const status = query.get("status");
  const limit = Number(query.get("limit") ?? 50);
  const before = Number(query.get("before") ?? 0);
  const rows = D.deployments
    .filter((d) => (!status || d.status === status) && (!before || d.id < before))
    .slice(0, limit)
    .map((d) => {
      const a = D.apps.find((x) => x.id === d.appId)!;
      return { ...strip(d), appId: a.id, appName: a.name, framework: a.sourceType === "git" || a.sourceType === "upload" ? a.framework : null, projectId: a.projectId, projectName: projectName(a.projectId), serverName: a.server.name };
    });
  const week = D.deployments.filter((d) => d.startedAt > Date.now() - 7 * D.DAY);
  const last7d: Record<string, number> = {};
  for (const d of week) last7d[d.status] = (last7d[d.status] ?? 0) + 1;
  return { deployments: rows, last7d };
});

on("GET", "/overview/databases", () => ({
  databases: D.databases.map((d) => {
    const b = D.backupsOf[d.id]?.[0];
    return {
      id: d.id,
      name: d.name,
      engine: d.engine,
      version: d.version,
      status: d.status,
      externalPort: d.externalPort,
      backupIntervalH: d.backupIntervalH,
      lastBackupAt: d.lastBackupAt,
      lastBackupStatus: b?.status ?? null,
      lastVerifyStatus: D.backupsOf[d.id]?.find((x) => x.verifyStatus)?.verifyStatus ?? null,
      projectId: d.projectId,
      projectName: projectName(d.projectId),
      serverName: d.server.name,
    };
  }),
}));

on("GET", "/overview/monitoring", () => {
  const rows = D.apps
    .filter((a) => a.kind === "web")
    .map((a) => {
      const monitored = a.uptimeEnabled && a.domains.length > 0;
      if (!monitored) return { id: a.id, name: a.name, status: a.status, projectName: projectName(a.projectId), url: a.domains[0]?.url ?? null, monitored, down: false, downSince: null, up24h: null, up7d: null, lastMs: null, avgMs: null, bars: Array(24).fill(null) };
      const u = D.uptimeOf(a.id);
      const end = Date.now();
      const bars = Array.from({ length: 24 }, (_, i) => {
        const from = end - (24 - i) * D.HOUR;
        const rows = u.recent.filter((x) => x.at >= from && x.at < from + D.HOUR);
        return rows.length ? rows.filter((x) => x.ok).length / rows.length : null;
      });
      const okRows = u.recent.filter((x) => x.ok);
      const inc = D.incidents.find((i) => i.appId === a.id && i.endedAt === null);
      return {
        id: a.id,
        name: a.name,
        status: a.status,
        projectName: projectName(a.projectId),
        url: a.domains[0]?.url ?? null,
        monitored,
        down: u.down,
        downSince: inc?.startedAt ?? null,
        up24h: u.up24h,
        up7d: u.up7d,
        lastMs: u.recent.at(-1)?.ms || null,
        avgMs: okRows.length ? Math.round(okRows.reduce((s, x) => s + x.ms, 0) / okRows.length) : null,
        bars,
      };
    });
  return {
    apps: rows,
    incidents: D.incidents.map((i) => ({ appId: i.appId, appName: D.apps.find((a) => a.id === i.appId)!.name, startedAt: i.startedAt, endedAt: i.endedAt, reason: i.reason })),
  };
});

on("GET", "/overview/backups", () => ({
  databases: D.databases.map((d) => {
    const list = D.backupsOf[d.id] ?? [];
    const last = list[0];
    return {
      id: d.id,
      name: d.name,
      engine: d.engine,
      projectName: projectName(d.projectId),
      intervalH: d.backupIntervalH,
      keep: d.backupKeep,
      lastAt: last?.createdAt ?? null,
      lastStatus: last?.status ?? null,
      lastError: last?.error ?? null,
      lastSize: last?.size ?? null,
      offsite: last ? (last.remote ?? 0) : null,
      verifyStatus: list.find((b) => b.verifyStatus)?.verifyStatus ?? null,
      count: list.length,
    };
  }),
  volumes: D.apps
    .map((a) => ({ a, v: D.volumeBackups(a.id) }))
    .filter(({ v }) => v.volumes.length > 0)
    .map(({ a, v }) => ({
      id: a.id,
      name: a.name,
      projectName: projectName(a.projectId),
      intervalH: v.intervalH,
      keep: v.keep,
      lastAt: v.lastAt,
      lastStatus: v.backups[0]?.status ?? null,
      lastError: null,
      lastSize: v.backups.filter((b) => b.createdAt === v.lastAt).reduce((s, b) => s + b.size, 0) || null,
      count: v.backups.length,
      volumeCount: v.volumes.length,
    })),
  panel: { status: "success", error: null, size: D.panelBackups[0]!.size, offsite: 1, createdAt: D.panelBackups[0]!.createdAt },
}));

on("GET", "/overview/schedules", () => ({
  timezone: "Europe/Istanbul",
  jobs: D.cronJobs.map((j) => {
    const a = D.apps.find((x) => x.id === j.appId)!;
    const last = j.runs[0];
    return {
      id: j.id,
      name: j.name,
      schedule: j.schedule,
      command: j.command,
      enabled: j.enabled,
      lastRunAt: last?.startedAt ?? null,
      lastStatus: last?.status ?? null,
      lastExitCode: last?.exitCode ?? null,
      lastDurationMs: last?.finishedAt ? last.finishedAt - last.startedAt : null,
      nextRunAt: j.nextRun,
      appId: a.id,
      appName: a.name,
      projectName: projectName(a.projectId),
    };
  }),
}));

// --- Projeler --------------------------------------------------------------
on("GET", "/projects", () => ({ projects: D.projectSummaries() }));
on("GET", "/projects/:id", ({ params }) => {
  const p = D.projects.find((x) => x.id === num(params.id));
  if (!p) throw new HttpError(404, "Proje bulunamadı");
  return {
    project: { id: p.id, name: p.name, description: p.description },
    apps: D.apps.filter((a) => a.projectId === p.id).map(({ id, name, sourceType, status, server, domains, gitUrl, image, framework }) => ({ id, name, sourceType, status, server, domains, gitUrl, image, framework })),
    databases: D.databases.filter((d) => d.projectId === p.id).map((d) => ({ id: d.id, name: d.name, engine: d.engine, version: d.version, status: d.status, serverName: d.server.name })),
  };
});
on("GET", "/projects/:id/members", ({ params }) => ({
  members:
    num(params.id) === 2
      ? [
          { id: 2, name: "Elif Yılmaz", email: "elif.yilmaz@ornekfirma.com.tr", role: "developer" },
          { id: 3, name: "Mert Kaya", email: "mert.kaya@ornekfirma.com.tr", role: "viewer" },
        ]
      : num(params.id) === 1
        ? [{ id: 2, name: "Elif Yılmaz", email: "elif.yilmaz@ornekfirma.com.tr", role: "developer" }]
        : [],
}));
on("GET", "/users", () => ({ users: D.users, me: D.demoUser.id }));

// --- Uygulamalar ------------------------------------------------------------
on("GET", "/apps/:id", ({ params }) => {
  const a = findApp(params.id!);
  return { app: a, env: D.envOf[a.id] ?? "", deployments: D.appDeployments(a.id).map(strip) };
});
on("GET", "/apps/:id/stats", ({ params }) => {
  const a = findApp(params.id!);
  if (a.status !== "running") return { stats: null };
  const t = Date.now() / 1000;
  const mem = (a.memoryLimit ?? 512) * 1024 * 1024;
  return { stats: { cpu: Math.abs(Math.sin(t / 7 + a.id)) * 6 + 0.4, memory: Math.round(mem * (0.38 + 0.04 * Math.sin(t / 11 + a.id))), memoryLimit: mem } };
});
on("GET", "/apps/:id/uptime", ({ params }) => D.uptimeOf(findApp(params.id!).id));
on("GET", "/apps/:id/volume-backups", ({ params }) => D.volumeBackups(findApp(params.id!).id));
on("GET", "/apps/:id/cron", ({ params }) => {
  const id = findApp(params.id!).id;
  return { jobs: D.cronJobs.filter((j) => j.appId === id).map(({ runs, appId: _a, ...j }) => ({ ...j, lastRun: runs[0] ? { ...runs[0], output: undefined } : null })) };
});
on("GET", "/apps/:id/cron/:job/runs", ({ params }) => ({ runs: D.cronJobs.find((j) => j.id === num(params.job))?.runs ?? [] }));
on("GET", "/apps/:id/diagnose", ({ params }) => {
  const a = findApp(params.id!);
  return { probe: { status: 200, statusLine: "HTTP/1.1 200 OK" }, healthy: true, findings: a.id === 2 ? [] : [] };
});
on("GET", "/apps/:id/domains/check", ({ params }) => {
  const a = findApp(params.id!);
  const ip = D.servers.find((s) => s.id === a.server.id)!.publicIp!;
  return {
    results: a.domains.map((d) => ({ host: d.host, ok: true, reason: "ok", message: "DNS bu sunucuyu gösteriyor", addresses: [ip] })),
  };
});
on("GET", "/apps/:id/logs/search", ({ params, query }) => {
  const a = findApp(params.id!);
  const q = (query.get("q") ?? "").toLowerCase();
  const lines = D.appLogSnapshot(a.id).split("\n").filter((l) => l.toLowerCase().includes(q));
  return { matches: lines.slice(0, 200).map((line) => ({ container: a.container ?? `xb-${a.slug}`, line })), truncated: false };
});

on("GET", "/frameworks", () => ({ frameworks }));
on("POST", "/frameworks/detect", () => ({
  matches: [
    { id: "django", score: 90, reason: "manage.py bulundu", options: { pythonVersion: "3.12", settingsModule: "config.settings", wsgiModule: "config.wsgi", migrate: true, collectstatic: true } },
    { id: "python", score: 30, reason: "requirements.txt bulundu", options: {} },
  ],
  envFromCode: ["DJANGO_SECRET_KEY", "DJANGO_DEBUG", "DJANGO_ALLOWED_HOSTS", "DATABASE_URL"],
  envExample: [
    { key: "DJANGO_DEBUG", value: "False" },
    { key: "DATABASE_URL", value: "" },
  ],
}));
on("GET", "/templates", () => ({ templates }));

// --- Veritabanları ----------------------------------------------------------
on("GET", "/databases/engines", () => ({
  engines: [
    { id: "postgres", label: "PostgreSQL", versions: ["17", "16", "15"], port: 5432 },
    { id: "mysql", label: "MySQL", versions: ["8.4", "8.0"], port: 3306 },
    { id: "mariadb", label: "MariaDB", versions: ["11", "10.11"], port: 3306 },
    { id: "mongo", label: "MongoDB", versions: ["8", "7"], port: 27017 },
    { id: "redis", label: "Redis", versions: ["7-alpine", "8-alpine"], port: 6379 },
  ],
}));
on("GET", "/databases/:id", ({ params }) => {
  const d = findDb(params.id!);
  return { database: d, backups: D.backupsOf[d.id] ?? [] };
});

// --- Sunucular --------------------------------------------------------------
on("GET", "/servers/:id", ({ params }) => {
  const s = findServer(params.id!);
  return { server: s, setupLog: D.serverSetupLog(s.id) };
});
on("GET", "/servers/:id/stats", ({ params }) => {
  const s = findServer(params.id!);
  return { stats: D.statsFor(s.id), statsError: null, docker: D.docker(s.id) };
});
on("GET", "/servers/:id/containers", ({ params }) => ({ containers: D.containersOf(findServer(params.id!).id) }));
on("GET", "/servers/:id/security", ({ params }) => {
  const s = findServer(params.id!);
  return { security: { firewall: true, fail2ban: true, sshBanned: s.id === 2 ? 7 : 3, passwordAuth: s.id === 2, rootLogin: "prohibit-password" } };
});
on("GET", "/servers/:id/tunnel", () => ({ enabled: false, running: false, logs: [] }));
on("GET", "/ssh-keys", () => ({ keys: D.sshKeys }));

// --- Güvenlik ---------------------------------------------------------------
on("GET", "/security/summary", ({ query }) => D.securitySummary(Number(query.get("hours") ?? 24)));
on("GET", "/security/score", () => D.securityScore());
on("GET", "/security/events", ({ query }) => {
  const kind = query.get("kind");
  const limit = Number(query.get("limit") ?? 200);
  return { events: D.securityEvents.filter((e) => !kind || e.kind === kind).slice(0, limit) };
});
on("GET", "/security/blocked", () => ({ blocked: D.blockedIps }));
on("GET", "/security/settings", () => ({ autoBanEnabled: true, autoBanThreshold: 30, autoBanWindowMin: 10, autoBanDurationH: 24 }));

// --- Analitik ---------------------------------------------------------------
on("GET", "/analytics/sites", () => ({ sites: D.analyticsSites }));
on("GET", "/analytics/report", ({ query }) => D.analyticsReport(query.get("site") ?? "all", query.get("range") ?? "7d"));

// --- Ayarlar ----------------------------------------------------------------
on("GET", "/settings", () => ({ panelDomain: "panel.ornekfirma.com.tr", panelHttps: true, localServerIp: "203.0.113.24", version: "1.3.0", timezone: "Europe/Istanbul", uptimeEnabled: true }));
on("GET", "/settings/update", () => ({ current: "1.3.0", latest: "1.3.0", updateAvailable: false, url: "https://github.com/xudbin/xudbin/releases", canSelfUpdate: true }));
on("GET", "/settings/account", () => ({
  user: { id: D.demoUser.id, name: D.demoUser.name, email: D.demoUser.email },
  totpEnabled: true,
  sessions: [
    { id: "s1", ip: "88.241.12.7", userAgent: navigator.userAgent, createdAt: Date.now() - 2 * D.HOUR, current: true },
    { id: "s2", ip: "176.88.40.112", userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1", createdAt: Date.now() - 3 * D.DAY, current: false },
  ],
}));
on("GET", "/settings/account/tokens", () => ({ tokens: D.apiTokens }));
on("GET", "/settings/notifications", () => ({ notifications: D.notifications, events: D.notifyEvents }));
on("GET", "/settings/backup", () => ({
  s3: { endpoint: "https://s3.eu-central-1.wasabisys.com", region: "eu-central-1", bucket: "ornekfirma-yedek", accessKey: "WSB7K2Q9XLM4P8RT", secretKey: "", prefix: "xudbin/", hasSecret: true },
  panelBackup: { enabled: true, intervalH: 24, keep: 7, lastAt: D.panelBackups[0]!.createdAt },
  verifyEveryH: 24,
  panelBackups: D.panelBackups,
}));
on("GET", "/settings/sso", () => ({ sso: null, redirectUri: `${location.origin}/api/auth/oidc/callback` }));
on("GET", "/settings/github", () => ({ app: null, installations: [] }));
on("GET", "/settings/github/repos", () => ({ connected: false, repos: [] }));
on("GET", "/settings/audit", ({ query }) => {
  const q = (query.get("q") ?? "").toLowerCase();
  const before = Number(query.get("before") ?? 0);
  return {
    entries: D.auditEntries.filter((e) => (!before || e.id < before) && (!q || [e.email, e.action, e.path, e.ip].some((x) => x?.toLowerCase().includes(q)))).slice(0, 100),
  };
});

// --- Zararsız yazma istekleri -----------------------------------------------
on("POST", "/auth/logout", () => {
  // Demo'da çıkış yok: sayfayı yenile, oturum (örnek kullanıcı) aynen kalır.
  setTimeout(() => location.reload(), 50);
  return new Promise(() => {});
});

/** Bilinmeyen GET'ler için makul boş yanıt. */
function emptyFor(path: string) {
  const last = path.split("/").filter(Boolean).at(-1) ?? "";
  const key = /^\d+$/.test(last) ? "item" : last.replace(/-(\w)/g, (_, c: string) => c.toUpperCase());
  return { [key]: [] };
}

export async function handle(method: string, rawPath: string, body: unknown): Promise<DemoResponse> {
  const url = new URL(rawPath, "http://demo");
  const path = url.pathname;
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = r.re.exec(path);
    if (!m) continue;
    const params: Record<string, string> = {};
    r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1]!)));
    try {
      return { status: 200, body: await r.handler({ params, query: url.searchParams, body }) };
    } catch (e) {
      if (e instanceof HttpError) return { status: e.status, body: { error: e.message } };
      throw e;
    }
  }
  if (method === "GET") {
    console.warn(`[demo] Örnek verisi olmayan istek: GET ${rawPath}`);
    return { status: 200, body: emptyFor(path) };
  }
  return { status: 403, body: { error: demoMessage(), demo: true } };
}
