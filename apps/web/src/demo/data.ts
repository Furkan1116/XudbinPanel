/**
 * Demo modu için örnek veriler. Zamanlar Date.now()'a göre hesaplanır ki demo her açılışta
 * "canlı" görünsün. Yalnız VITE_DEMO=1 derlemesinde (dinamik import ile) yüklenir.
 */
import { getLang } from "@/lib/i18n";
import type { App, Backup, Database, Deployment, Finding, Project, Server, ServerStats } from "@/lib/api";

export const NOW = Date.now();
export const MIN = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;

/** Tekrarlanabilir sözde rastgele sayı (aynı tohum, aynı demo). */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sha = (r: () => number) => Array.from({ length: 7 }, () => "0123456789abcdef"[Math.floor(r() * 16)]).join("");

// ---------------------------------------------------------------------------
// Kullanıcılar

export const demoUser = { id: 1, email: "demo@xudbin.com", name: "Demo Yönetici", role: "admin" as const, mustChangePassword: false };

export const users = [
  { ...demoUser, totpEnabled: true, createdAt: NOW - 142 * DAY },
  { id: 2, email: "elif.yilmaz@ornekfirma.com.tr", name: "Elif Yılmaz", role: "member" as const, totpEnabled: true, mustChangePassword: false, createdAt: NOW - 96 * DAY },
  { id: 3, email: "mert.kaya@ornekfirma.com.tr", name: "Mert Kaya", role: "member" as const, totpEnabled: false, mustChangePassword: false, createdAt: NOW - 40 * DAY },
  { id: 4, email: "stajyer@ornekfirma.com.tr", name: "Zeynep Demir", role: "member" as const, totpEnabled: false, mustChangePassword: true, createdAt: NOW - 2 * DAY },
];

// ---------------------------------------------------------------------------
// Sunucular

const IP1 = "203.0.113.24";
const IP2 = "198.51.100.17";
const sslip = (slug: string, ip: string) => `${slug}.${ip.replace(/\./g, "-")}.sslip.io`;

export const sshKeys = [
  { id: 1, name: "yedek-sunucu", publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIK3m8yQZp2vXc4Lr7bW9tN1eHs6JfUoKd0gPq5aRxYzV xudbin@yedek-sunucu", createdAt: NOW - 61 * DAY, servers: 1 },
  { id: 2, name: "eski-vps", publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFh2Qw8sLk3nJv6pTz1cXo9bR4yMe7aUdGiK0rVt5SPn xudbin@eski-vps", createdAt: NOW - 120 * DAY, servers: 0 },
];

export const servers: Server[] = [
  {
    id: 1,
    name: "ana-sunucu",
    kind: "local",
    host: null,
    port: 22,
    username: "root",
    publicIp: IP1,
    httpsMode: "auto",
    acmeEmail: "ops@ornekfirma.com.tr",
    status: "ready",
    statusDetail: null,
    setupRunning: false,
    sshKey: null,
    hostKeyFingerprint: null,
    appsDomain: null,
    tunnelEnabled: false,
    apps: 0,
    databases: 0,
    createdAt: NOW - 142 * DAY,
  },
  {
    id: 2,
    name: "yedek-sunucu",
    kind: "ssh",
    host: IP2,
    port: 22,
    username: "root",
    publicIp: IP2,
    httpsMode: "auto",
    acmeEmail: "ops@ornekfirma.com.tr",
    status: "ready",
    statusDetail: null,
    setupRunning: false,
    sshKey: { id: 1, name: sshKeys[0]!.name, publicKey: sshKeys[0]!.publicKey },
    hostKeyFingerprint: "SHA256:q8Zk1vW4fYc0nR3pXo6sT2mLhD9bE7uJ5aGiKyNwQe4",
    appsDomain: null,
    tunnelEnabled: false,
    apps: 0,
    databases: 0,
    createdAt: NOW - 61 * DAY,
  },
];

/** Canlı görünen kaynak kullanımı: zamana bağlı yumuşak dalgalanma. */
function wave(t: number, seed: number, base: number, amp: number) {
  const s = t / 1000;
  return Math.max(1, Math.min(99, base + amp * (Math.sin(s / 9 + seed) * 0.6 + Math.sin(s / 3.1 + seed * 2) * 0.3 + Math.sin(s / 1.3 + seed * 5) * 0.1)));
}
const round1 = (n: number) => Math.round(n * 10) / 10;

export function statsFor(serverId: number): ServerStats {
  const now = Date.now();
  const local = serverId === 1;
  const memTotal = local ? 16 * 1024 ** 3 : 8 * 1024 ** 3;
  const cpuBase = local ? 23 : 11;
  const memBase = local ? 47 : 38;
  const cpu = round1(wave(now, serverId, cpuBase, 9));
  const memPct = wave(now, serverId + 10, memBase, 2);
  const history = local
    ? Array.from({ length: 31 }, (_, i) => {
        const t = now - (30 - i) * 4000;
        return { t, cpu: round1(wave(t, serverId, cpuBase, 9)), mem: round1(wave(t, serverId + 10, memBase, 2)) };
      })
    : undefined;
  return {
    cpu: {
      usage: cpu,
      cores: local ? 8 : 4,
      load: local ? [1.42, 1.31, 1.18] : [0.36, 0.41, 0.38],
      model: local ? "AMD EPYC 7763 64-Core Processor" : "Intel Xeon Processor (Skylake, IBRS)",
    },
    memory: { total: memTotal, used: Math.round((memTotal * memPct) / 100) },
    disk: local ? { total: 320 * 1024 ** 3, used: 118.4 * 1024 ** 3 } : { total: 160 * 1024 ** 3, used: 41.7 * 1024 ** 3 },
    uptime: local ? 38 * 86400 + 5 * 3600 + 12 * 60 : 12 * 86400 + 9 * 3600,
    platform: "Ubuntu 24.04.1 LTS",
    hostname: local ? "ana-sunucu" : "yedek-sunucu",
    ...(history ? { history } : {}),
  };
}

export const docker = (serverId: number) =>
  serverId === 1
    ? { available: true as const, version: "27.3.1", containers: { total: 12, running: 11 }, images: 34 }
    : { available: true as const, version: "27.3.1", containers: { total: 6, running: 6 }, images: 15 };

// ---------------------------------------------------------------------------
// Projeler ve uygulamalar

export const projects: Omit<Project, "apps" | "databases" | "running">[] = [
  { id: 1, name: "Şirket sitesi", description: "Kurumsal web sitesi, API ve blog", createdAt: NOW - 140 * DAY },
  { id: 2, name: "Müşteri projeleri", description: "Müşteriler için geliştirilen uygulamalar", createdAt: NOW - 90 * DAY },
  { id: 3, name: "Deneme", description: "Yeni fikirler ve denemeler", createdAt: NOW - 21 * DAY },
];

type AppSeed = Partial<App> & Pick<App, "id" | "projectId" | "name" | "slug" | "sourceType" | "framework" | "status"> & { serverId: number; customDomain?: string };

function makeApp(s: AppSeed): App {
  const server = servers.find((x) => x.id === s.serverId)!;
  const ip = server.publicIp!;
  const r = rng(s.id * 97);
  const domains =
    s.kind === "worker"
      ? []
      : [
          ...(s.customDomain ? [{ id: s.id * 10 + 1, host: s.customDomain, https: true, generated: false, url: `https://${s.customDomain}` }] : []),
          { id: s.id * 10, host: sslip(s.slug, ip), https: true, generated: true, url: `https://${sslip(s.slug, ip)}` },
        ];
  const token = Array.from({ length: 24 }, () => "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(r() * 36)]).join("");
  const { serverId: _s, customDomain: _c, ...rest } = s;
  return {
    server: { id: server.id, name: server.name, status: server.status },
    buildOptions: {},
    gitUrl: null,
    gitBranch: "main",
    hasGitToken: false,
    buildType: "auto",
    dockerfilePath: "Dockerfile",
    buildContext: ".",
    image: null,
    composeFile: null,
    composeService: null,
    port: 3000,
    command: null,
    volumes: [],
    autoDeploy: true,
    hostAccess: false,
    webhookSecret: `whsec_${token.slice(0, 20)}`,
    webhookSigned: true,
    cpuLimit: null,
    memoryLimit: 512,
    httpCheck: true,
    uptimeEnabled: true,
    kind: "web",
    replicas: 1,
    previewsEnabled: false,
    buildServerId: null,
    extraServerIds: [],
    remoteReplicas: [],
    parentAppId: null,
    previewPr: null,
    previews: [],
    scan: { status: null, at: null, summary: null },
    healthPath: null,
    container: s.status === "stopped" || s.status === "failed" ? (s.status === "stopped" ? `xb-${s.slug}` : null) : `xb-${s.slug}`,
    currentImage: `xb-${s.slug}:${sha(r)}`,
    internalHost: `xb-${s.slug}`,
    webhookPath: `/api/webhooks/${token}`,
    domains,
    security: { waf: true, rateLimit: 600, headers: true, allowIps: [], denyIps: [], basicAuth: null },
    createdAt: NOW - 30 * DAY,
    ...rest,
  };
}

// --- İmaj tarama özetleri (sunucudaki services/scan.ts summarize() v2 biçimi) ---
const c = (critical: number, high: number, medium: number, low: number, unknown = 0) => ({ critical, high, medium, low, unknown });

const scanNext = {
  v: 2 as const,
  status: "dikkat" as const,
  counts: c(0, 2, 4, 3),
  os: { family: "alpine", name: "3.20.3", eosl: false },
  groups: { base: c(0, 1, 1, 2), app: c(0, 1, 2, 0), noFix: c(0, 0, 1, 1) },
  baseFix: [
    {
      name: "libcrypto3",
      ecosystem: "alpine",
      source: "base" as const,
      installed: "3.3.2-r0",
      fixed: "3.3.3-r0",
      maxSeverity: "HIGH" as const,
      cveCount: 2,
      cves: [
        { id: "CVE-2024-12797", severity: "HIGH" as const, title: "openssl: RFC7250 handshakes with unauthenticated servers don't abort as expected", url: "https://avd.aquasec.com/nvd/cve-2024-12797", score: 7.4, description: "Clients using RFC7250 Raw Public Keys to authenticate a server may fail to notice that the server was not authenticated." },
        { id: "CVE-2024-9143", severity: "LOW" as const, title: "openssl: Low-level invalid GF(2^m) parameters lead to OOB memory access", url: "https://avd.aquasec.com/nvd/cve-2024-9143", score: 4.3, description: "Use of the low-level GF(2^m) elliptic curve APIs with untrusted explicit values for the field polynomial can lead to out-of-bounds memory reads or writes." },
      ],
    },
    {
      name: "musl",
      ecosystem: "alpine",
      source: "base" as const,
      installed: "1.2.5-r0",
      fixed: "1.2.5-r1",
      maxSeverity: "MEDIUM" as const,
      cveCount: 1,
      cves: [{ id: "CVE-2025-26519", severity: "MEDIUM" as const, title: "musl libc: iconv EUC-KR decoder out-of-bounds write", url: "https://avd.aquasec.com/nvd/cve-2025-26519", score: 5.9, description: "musl libc 0.9.13 through 1.2.5 before 1.2.6 has an out-of-bounds write bug in the iconv implementation." }],
    },
  ],
  appFix: [
    {
      ecosystem: "npm",
      command: "npm install next@15.2.4 cross-spawn@7.0.5 nanoid@3.3.8",
      counts: c(0, 1, 2, 0),
      packages: [
        {
          name: "next",
          ecosystem: "npm",
          source: "app" as const,
          installed: "15.1.3",
          fixed: "15.2.4",
          maxSeverity: "HIGH" as const,
          cveCount: 1,
          cves: [{ id: "CVE-2025-29927", severity: "HIGH" as const, title: "nextjs: Authorization bypass in Next.js Middleware", url: "https://avd.aquasec.com/nvd/cve-2025-29927", score: 9.1, description: "It is possible to bypass authorization checks within a Next.js application, if the authorization check occurs in middleware." }],
        },
        {
          name: "cross-spawn",
          ecosystem: "npm",
          source: "app" as const,
          installed: "7.0.3",
          fixed: "7.0.5",
          maxSeverity: "MEDIUM" as const,
          cveCount: 1,
          cves: [{ id: "CVE-2024-21538", severity: "MEDIUM" as const, title: "cross-spawn: regular expression denial of service", url: "https://avd.aquasec.com/nvd/cve-2024-21538", score: 7.5, description: "Versions of the package cross-spawn before 7.0.5 are vulnerable to Regular Expression Denial of Service (ReDoS) due to improper input sanitization." }],
        },
        {
          name: "nanoid",
          ecosystem: "npm",
          source: "app" as const,
          installed: "3.3.7",
          fixed: "3.3.8",
          maxSeverity: "MEDIUM" as const,
          cveCount: 1,
          cves: [{ id: "CVE-2024-55565", severity: "MEDIUM" as const, title: "nanoid: infinite loop with non-integer values", url: "https://avd.aquasec.com/nvd/cve-2024-55565", score: 4.3, description: "nanoid (aka Nano ID) before 5.0.9 mishandles non-integer values." }],
        },
      ],
    },
  ],
  noFix: [
    {
      name: "busybox",
      ecosystem: "alpine",
      source: "base" as const,
      installed: "1.36.1-r29",
      fixed: null,
      maxSeverity: "MEDIUM" as const,
      cveCount: 2,
      cves: [
        { id: "CVE-2023-42363", severity: "MEDIUM" as const, title: "busybox: use-after-free in awk", url: "https://avd.aquasec.com/nvd/cve-2023-42363", score: 5.5, description: "A use-after-free vulnerability was discovered in xasprintf function in xfuncs_printf.c:344 in BusyBox v.1.36.1." },
        { id: "CVE-2023-42366", severity: "LOW" as const, title: "busybox: a heap-buffer-overflow", url: "https://avd.aquasec.com/nvd/cve-2023-42366", score: 5.5, description: "A heap-buffer-overflow was discovered in BusyBox v.1.36.1 via /lib/x86_64-linux-gnu/libc.so.6." },
      ],
    },
  ],
  truncated: false,
  critical: 0,
  high: 2,
  fixable: 6,
};

const scanDjango = {
  v: 2 as const,
  status: "acil" as const,
  counts: c(1, 1, 2, 4),
  os: { family: "debian", name: "12.8", eosl: false },
  groups: { base: c(0, 0, 1, 1), app: c(1, 1, 1, 0), noFix: c(0, 0, 0, 3) },
  baseFix: [
    {
      name: "libexpat1",
      ecosystem: "debian",
      source: "base" as const,
      installed: "2.5.0-1",
      fixed: "2.5.0-1+deb12u1",
      maxSeverity: "MEDIUM" as const,
      cveCount: 2,
      cves: [
        { id: "CVE-2024-45491", severity: "MEDIUM" as const, title: "libexpat: Integer Overflow or Wraparound", url: "https://avd.aquasec.com/nvd/cve-2024-45491", score: 7.5, description: "An issue was discovered in libexpat before 2.6.3. dtdCopy in xmlparse.c can have an integer overflow for nDefaultAtts on 32-bit platforms." },
        { id: "CVE-2024-50602", severity: "LOW" as const, title: "libexpat: expat: DoS via XML_ResumeParser", url: "https://avd.aquasec.com/nvd/cve-2024-50602", score: 5.9, description: "An issue was discovered in libexpat before 2.6.4. There is a crash within the XML_ResumeParser function." },
      ],
    },
  ],
  appFix: [
    {
      ecosystem: "pip",
      command: "pip install -U 'django>=4.2.16' 'requests>=2.32.0' 'gunicorn>=23.0.0'",
      counts: c(1, 1, 1, 0),
      packages: [
        {
          name: "django",
          ecosystem: "pip",
          source: "app" as const,
          installed: "4.2.11",
          fixed: "4.2.16",
          maxSeverity: "CRITICAL" as const,
          cveCount: 2,
          cves: [
            { id: "CVE-2024-42005", severity: "CRITICAL" as const, title: "django: Potential SQL injection in QuerySet.values() and values_list()", url: "https://avd.aquasec.com/nvd/cve-2024-42005", score: 9.8, description: "QuerySet.values() and values_list() methods on models with a JSONField are subject to SQL injection in column aliases via a crafted JSON object key." },
            { id: "CVE-2024-45230", severity: "HIGH" as const, title: "django: Potential denial-of-service vulnerability in django.utils.html.urlize()", url: "https://avd.aquasec.com/nvd/cve-2024-45230", score: 7.5, description: "urlize and urlizetrunc were subject to a potential denial-of-service attack via very large inputs with a specific sequence of characters." },
          ],
        },
        {
          name: "gunicorn",
          ecosystem: "pip",
          source: "app" as const,
          installed: "21.2.0",
          fixed: "23.0.0",
          maxSeverity: "HIGH" as const,
          cveCount: 1,
          cves: [{ id: "CVE-2024-6827", severity: "HIGH" as const, title: "gunicorn: HTTP Request Smuggling due to improper validation of Transfer-Encoding headers", url: "https://avd.aquasec.com/nvd/cve-2024-6827", score: 7.5, description: "Gunicorn version 21.2.0 does not properly validate the value of the 'Transfer-Encoding' header as specified in the RFC standards." }],
        },
        {
          name: "requests",
          ecosystem: "pip",
          source: "app" as const,
          installed: "2.31.0",
          fixed: "2.32.0",
          maxSeverity: "MEDIUM" as const,
          cveCount: 1,
          cves: [{ id: "CVE-2024-35195", severity: "MEDIUM" as const, title: "requests: subsequent requests to the same host ignore cert verification", url: "https://avd.aquasec.com/nvd/cve-2024-35195", score: 5.6, description: "When making requests through a Requests Session, if the first request is made with verify=False to disable cert verification, all subsequent requests to the same origin will continue to ignore cert verification." }],
        },
      ],
    },
  ],
  noFix: [
    {
      name: "libc6",
      ecosystem: "debian",
      source: "base" as const,
      installed: "2.36-9+deb12u9",
      fixed: null,
      maxSeverity: "LOW" as const,
      cveCount: 3,
      cves: [
        { id: "CVE-2010-4756", severity: "LOW" as const, title: "glibc: glob implementation can cause excessive CPU and memory consumption", url: "https://avd.aquasec.com/nvd/cve-2010-4756", score: 4.0, description: "The glob implementation in the GNU C Library allows remote authenticated users to cause a denial of service via crafted glob expressions." },
        { id: "CVE-2018-20796", severity: "LOW" as const, title: "glibc: uncontrolled recursion in function check_dst_limits_calc_pos_1", url: "https://avd.aquasec.com/nvd/cve-2018-20796", score: 7.5, description: "In the GNU C Library, check_dst_limits_calc_pos_1 in posix/regexec.c has Uncontrolled Recursion." },
        { id: "CVE-2019-9192", severity: "LOW" as const, title: "glibc: uncontrolled recursion in function check_dst_limits_calc_pos_1", url: "https://avd.aquasec.com/nvd/cve-2019-9192", score: 7.5, description: "In the GNU C Library through 2.29, check_dst_limits_calc_pos_1 in posix/regexec.c has Uncontrolled Recursion." },
      ],
    },
  ],
  truncated: false,
  critical: 1,
  high: 1,
  fixable: 5,
};

const scanClean = (os: { family: string; name: string }) => ({
  v: 2 as const,
  status: "temiz" as const,
  counts: c(0, 0, 0, 1),
  os: { ...os, eosl: false },
  groups: { base: c(0, 0, 0, 0), app: c(0, 0, 0, 0), noFix: c(0, 0, 0, 1) },
  baseFix: [],
  appFix: [],
  noFix: [
    {
      name: "busybox",
      ecosystem: os.family,
      source: "base" as const,
      installed: "1.36.1-r29",
      fixed: null,
      maxSeverity: "LOW" as const,
      cveCount: 1,
      cves: [{ id: "CVE-2023-42366", severity: "LOW" as const, title: "busybox: a heap-buffer-overflow", url: "https://avd.aquasec.com/nvd/cve-2023-42366", score: 5.5, description: "A heap-buffer-overflow was discovered in BusyBox v.1.36.1 via /lib/x86_64-linux-gnu/libc.so.6." }],
    },
  ],
  truncated: false,
  critical: 0,
  high: 0,
  fixable: 0,
});

type ScanSummary = App["scan"]["summary"];
const scan = (summary: unknown, ago: number): App["scan"] => ({ status: "success", at: NOW - ago, summary: summary as ScanSummary });

export const apps: App[] = [
  makeApp({
    id: 1,
    projectId: 1,
    serverId: 1,
    name: "kurumsal-site",
    slug: "kurumsal-site",
    sourceType: "git",
    framework: "nextjs",
    status: "running",
    customDomain: "www.ornekfirma.com.tr",
    gitUrl: "https://github.com/ornekfirma/kurumsal-site",
    buildOptions: { nodeVersion: "22" },
    port: 3000,
    memoryLimit: 768,
    previewsEnabled: true,
    scan: scan(scanNext, 3 * HOUR),
    createdAt: NOW - 138 * DAY,
  }),
  makeApp({
    id: 2,
    projectId: 1,
    serverId: 1,
    name: "sirket-api",
    slug: "sirket-api",
    sourceType: "git",
    framework: "django",
    status: "running",
    gitUrl: "https://github.com/ornekfirma/sirket-api",
    buildOptions: { pythonVersion: "3.12", settingsModule: "config.settings", wsgiModule: "config.wsgi", migrate: true, collectstatic: true },
    port: 8000,
    hasGitToken: true,
    healthPath: "/health/",
    replicas: 2,
    extraServerIds: [2],
    remoteReplicas: [{ serverId: 2, container: "xb-sirket-api-r1" }],
    scan: scan(scanDjango, 5 * HOUR),
    createdAt: NOW - 135 * DAY,
  }),
  makeApp({
    id: 3,
    projectId: 1,
    serverId: 1,
    name: "blog",
    slug: "blog",
    sourceType: "compose",
    framework: "auto",
    status: "running",
    port: 80,
    composeService: "wordpress",
    composeFile:
      "services:\n  wordpress:\n    image: wordpress:6-apache\n    environment:\n      WORDPRESS_DB_HOST: db\n      WORDPRESS_DB_USER: wordpress\n      WORDPRESS_DB_PASSWORD: ${DB_PASSWORD}\n      WORDPRESS_DB_NAME: wordpress\n    volumes:\n      - wp_data:/var/www/html\n    depends_on: [db]\n  db:\n    image: mariadb:11\n    environment:\n      MARIADB_DATABASE: wordpress\n      MARIADB_USER: wordpress\n      MARIADB_PASSWORD: ${DB_PASSWORD}\n      MARIADB_RANDOM_ROOT_PASSWORD: \"1\"\n    volumes:\n      - db_data:/var/lib/mysql\nvolumes:\n  wp_data:\n  db_data:\n",
    memoryLimit: null,
    autoDeploy: false,
    createdAt: NOW - 120 * DAY,
  }),
  makeApp({
    id: 4,
    projectId: 1,
    serverId: 2,
    name: "kampanya",
    slug: "kampanya",
    sourceType: "git",
    framework: "static",
    status: "running",
    gitUrl: "https://github.com/ornekfirma/kampanya-sayfasi",
    gitBranch: "yayin",
    buildOptions: { root: "public", spa: false },
    port: 80,
    memoryLimit: 128,
    scan: scan(scanClean({ family: "alpine", name: "3.20.3" }), 2 * DAY),
    createdAt: NOW - 44 * DAY,
  }),
  makeApp({
    id: 5,
    projectId: 2,
    serverId: 2,
    name: "magaza-api",
    slug: "magaza-api",
    sourceType: "git",
    framework: "laravel",
    status: "running",
    gitUrl: "https://github.com/ornekfirma/magaza-api",
    hasGitToken: true,
    buildOptions: { phpVersion: "8.4", extensions: "redis", migrate: true },
    port: 80,
    memoryLimit: 1024,
    cpuLimit: 1.5,
    volumes: [{ name: "storage", path: "/app/storage/app" }],
    scan: scan(scanClean({ family: "debian", name: "12.8" }), 1 * DAY),
    security: { waf: true, rateLimit: 300, headers: true, allowIps: [], denyIps: ["185.220.101.0/24"], basicAuth: null },
    createdAt: NOW - 88 * DAY,
  }),
  makeApp({
    id: 6,
    projectId: 2,
    serverId: 1,
    name: "rezervasyon-api",
    slug: "rezervasyon-api",
    sourceType: "git",
    framework: "fastapi",
    status: "failed",
    gitUrl: "https://github.com/ornekfirma/rezervasyon-api",
    gitBranch: "gelistirme",
    buildOptions: { pythonVersion: "3.10", module: "app.main:app" },
    port: 8000,
    webhookSigned: false,
    security: { waf: false, rateLimit: null, headers: true, allowIps: [], denyIps: [], basicAuth: null },
    createdAt: NOW - 12 * DAY,
  }),
  makeApp({
    id: 7,
    projectId: 2,
    serverId: 2,
    name: "bildirim-isci",
    slug: "bildirim-isci",
    sourceType: "git",
    framework: "node",
    status: "running",
    kind: "worker",
    gitUrl: "https://github.com/ornekfirma/bildirim-isci",
    buildOptions: { nodeVersion: "22", startCommand: "node dist/worker.js" },
    port: 3000,
    httpCheck: false,
    uptimeEnabled: false,
    memoryLimit: 256,
    createdAt: NOW - 70 * DAY,
  }),
  makeApp({
    id: 8,
    projectId: 2,
    serverId: 1,
    name: "durum-sayfasi",
    slug: "durum-sayfasi",
    sourceType: "image",
    framework: "auto",
    status: "running",
    image: "louislam/uptime-kuma:1",
    port: 3001,
    volumes: [{ name: "data", path: "/app/data" }],
    autoDeploy: false,
    memoryLimit: 256,
    createdAt: NOW - 55 * DAY,
  }),
  makeApp({
    id: 9,
    projectId: 3,
    serverId: 1,
    name: "flask-deneme",
    slug: "flask-deneme",
    sourceType: "git",
    framework: "flask",
    status: "stopped",
    gitUrl: "https://github.com/demo-kullanici/flask-deneme",
    buildOptions: { pythonVersion: "3.13", module: "app:app" },
    port: 8000,
    uptimeEnabled: false,
    memoryLimit: null,
    security: { waf: false, rateLimit: null, headers: false, allowIps: [], denyIps: [], basicAuth: { username: "admin" } },
    createdAt: NOW - 20 * DAY,
  }),
  makeApp({
    id: 10,
    projectId: 3,
    serverId: 1,
    name: "portfolyo",
    slug: "portfolyo",
    sourceType: "upload",
    framework: "static",
    status: "running",
    buildOptions: { root: ".", spa: true },
    port: 80,
    memoryLimit: 128,
    createdAt: NOW - 9 * DAY,
  }),
];

for (const s of servers) s.apps = apps.filter((a) => a.server.id === s.id).length;

export const envOf: Record<number, string> = {
  1: "NEXT_PUBLIC_SITE_URL={{XUDBIN_URL}}\nNEXT_PUBLIC_GA_ID=G-7Q2X9LMN4P\nAPI_URL=http://xb-sirket-api:8000\nREVALIDATE_SECRET=8f3c2a91d7e64b0f\n",
  2: "DJANGO_SECRET_KEY=django-insecure-3k$9z!p2v@x7q#m1w8r4t6y0u5i\nDJANGO_DEBUG=False\nDJANGO_ALLOWED_HOSTS={{XUDBIN_DOMAINS}}\nCSRF_TRUSTED_ORIGINS={{XUDBIN_ORIGINS}}\nDATABASE_URL=postgresql://sirket:Xb7hQ2mV9pLw@xb-db-sirket-db:5432/sirket\nREDIS_URL=redis://default:Rk4sT8nQ1zYc@xb-db-onbellek:6379\nEMAIL_HOST=smtp.yandex.com.tr\n",
  3: "DB_PASSWORD=Wq8eLr3tPz6yHn2m\n",
  4: "",
  5: "APP_KEY=base64:Q2hhbmdlTWVJblByb2R1Y3Rpb24xMjM0NTY3ODk=\nAPP_ENV=production\nAPP_DEBUG=false\nAPP_URL={{XUDBIN_URL}}\nDB_CONNECTION=mysql\nDB_HOST=xb-db-magaza-db\nDB_DATABASE=magaza\nDB_USERNAME=magaza\nDB_PASSWORD=Mz5vK2pR8sXq\nLOG_CHANNEL=stderr\nQUEUE_CONNECTION=redis\nREDIS_HOST=xb-db-onbellek\n",
  6: "DATABASE_URL=postgresql://sirket:Xb7hQ2mV9pLw@xb-db-sirket-db:5432/rezervasyon\nJWT_SECRET=c41f0e9b2a7d\n",
  7: "REDIS_URL=redis://default:Rk4sT8nQ1zYc@xb-db-onbellek:6379\nSMTP_URL=smtp://bildirim:sifre@smtp.yandex.com.tr:465\nCONCURRENCY=4\n",
  8: "",
  9: "SECRET_KEY=deneme123\nFLASK_ENV=production\n",
  10: "",
};

// ---------------------------------------------------------------------------
// Deploylar

const COMMITS: Record<number, string[]> = {
  1: ["Ana sayfa hero bölümü yenilendi", "İletişim formuna KVKK onayı eklendi", "Hizmetler sayfası metinleri güncellendi", "Görseller next/image ile optimize edildi", "Footer'a sosyal medya bağlantıları eklendi", "Blog listesinde sayfalama düzeltildi"],
  2: ["Sipariş listesine tarih filtresi eklendi", "Kullanıcı kaydında e-posta doğrulaması", "N+1 sorgusu giderildi (siparişler)", "Django 4.2.11'e yükseltildi", "Sağlık kontrolü ucu eklendi"],
  3: ["WordPress kurulumu"],
  4: ["Yılbaşı kampanya görselleri", "Geri sayım sayacı eklendi", "Mobil menü düzeltildi"],
  5: ["Ürün varyantları için yeni endpoint", "Stok güncellemesi kuyruğa alındı", "Kargo entegrasyonu (Yurtiçi)", "PHP 8.4'e geçiş"],
  6: ["Rezervasyon iptal akışı", "Pydantic v2'ye geçiş", "Uygunluk sorgusu hızlandırıldı"],
  7: ["SMS sağlayıcısı değiştirildi", "Yeniden deneme mantığı eklendi", "Toplu e-posta gönderimi"],
  8: ["louislam/uptime-kuma:1"],
  9: ["İlk sürüm", "Jinja şablonları eklendi"],
  10: ["Proje dosyaları yüklendi", "Yeni proje görselleri"],
};

const FW_NAME: Record<string, string> = { nextjs: "Next.js", django: "Django", static: "Statik site (HTML/CSS/JS)", laravel: "Laravel", fastapi: "FastAPI", node: "Node.js (Express, Fastify, Hono...)", flask: "Flask" };

export type DemoDeployment = Deployment & { appId: number; log: string };
export const deployments: DemoDeployment[] = [];

const failDiag: Finding[] = [
  {
    id: "pip",
    title: "Python sürümü uygun değil",
    detail: "Paket >=3.11 Python sürümünü istiyor, derlemede 3.10 kullanıldı. Uygulama ayarlarından Python sürümünü değiştir.",
    fix: { label: "Python 3.12 ile yeniden derle", buildOptions: { pythonVersion: "3.12" } },
  },
];

function buildLog(a: App, d: { id: number; title: string; commitSha: string | null; status: string; startedAt: number; finishedAt: number | null; image: string | null }) {
  const L: string[] = [];
  const secs = d.finishedAt ? Math.round((d.finishedAt - d.startedAt) / 1000) : 0;
  L.push(`${a.name} → ${a.server.name}`);
  if (a.sourceType === "image") {
    L.push(`İmaj çekiliyor: ${a.image}`);
    L.push("1: Pulling from louislam/uptime-kuma", "Digest: sha256:3b7a1c0f9e2d...", `Status: Downloaded newer image for ${a.image}`);
  } else if (a.sourceType === "compose") {
    L.push("Servisler: wordpress, db", "docker compose up çalıştırılıyor...");
    L.push(" Network xb-blog_default  Created", " Volume \"xb-blog_wp_data\"  Created", " Volume \"xb-blog_db_data\"  Created", " Container xb-blog-db-1  Started", " Container xb-blog-wordpress-1  Started");
  } else {
    if (a.sourceType === "git") {
      L.push(`Klonlanıyor: ${a.gitUrl} (${a.gitBranch})`);
      L.push(`Commit ${d.commitSha}: ${d.title}`);
    } else {
      L.push("Yüklenen dosya açılıyor (2.4 MB)...");
    }
    L.push(`Framework: ${FW_NAME[a.framework] ?? a.framework}`);
    L.push("Temel imajın güncel sürümü kontrol ediliyor (günde bir).");
    L.push(`İmaj derleniyor: ${d.image ?? `xb-${a.slug}:${d.commitSha}`}`);
    const steps: Record<string, string[]> = {
      nextjs: ["#1 [internal] load build definition from Dockerfile", "#5 [deps 1/4] FROM docker.io/library/node:22-alpine", "#8 [deps 4/4] RUN npm ci", "#8 12.84 added 412 packages, and audited 413 packages in 12s", "#11 [builder 3/3] RUN npm run build", "#11 3.12 ▲ Next.js 15.1.3", "#11 9.84  ✓ Compiled successfully", "#11 14.02  ✓ Generating static pages (18/18)", "#11 15.40 Route (app)                    Size     First Load JS", "#11 15.40 ┌ ○ /                          5.21 kB         112 kB", "#11 15.40 ├ ○ /hizmetler                 2.84 kB         109 kB", "#11 15.40 └ ○ /iletisim                  3.10 kB         110 kB", "#14 exporting to image", "#14 DONE 2.1s"],
      django: ["#1 [internal] load build definition from Dockerfile", "#4 [1/6] FROM docker.io/library/python:3.12-slim", "#7 [3/6] RUN pip install --no-cache-dir -r requirements.txt gunicorn whitenoise", "#7 18.40 Successfully installed Django-4.2.11 gunicorn-21.2.0 psycopg-3.2.1 whitenoise-6.7.0 ...", "#9 [5/6] COPY . .", "#10 exporting to image", "#10 DONE 1.4s"],
      laravel: ["#1 [internal] load build definition from Dockerfile", "#5 [assets 3/3] RUN npm ci && npm run build", "#5 8.12 vite v6.0.7 building for production...", "#5 11.03 ✓ 64 modules transformed.", "#7 [app 4/7] RUN composer install --no-dev --optimize-autoloader", "#7 6.41 Generating optimized autoload files", "#9 exporting to image", "#9 DONE 2.8s"],
      fastapi: ["#1 [internal] load build definition from Dockerfile", "#4 [1/5] FROM docker.io/library/python:3.10-slim", "#6 [3/5] RUN pip install --no-cache-dir -r requirements.txt uvicorn", "#6 4.21 ERROR: Ignored the following versions that require a different python version: 2.10.0 Requires-Python >=3.11", "#6 4.22 ERROR: No matching distribution found for pydantic-settings==2.10.0", "#6 ERROR: process \"/bin/sh -c pip install --no-cache-dir -r requirements.txt uvicorn\" did not complete successfully: exit code: 1"],
      node: ["#1 [internal] load build definition from Dockerfile", "#5 [2/5] RUN npm ci", "#5 7.90 added 186 packages in 7s", "#6 [3/5] RUN npm run build", "#6 2.31 > tsc -p .", "#8 exporting to image", "#8 DONE 0.9s"],
      flask: ["#1 [internal] load build definition from Dockerfile", "#5 [3/5] RUN pip install --no-cache-dir -r requirements.txt gunicorn", "#5 6.02 Successfully installed Flask-3.1.0 gunicorn-23.0.0 Jinja2-3.1.5", "#7 exporting to image", "#7 DONE 0.8s"],
      static: ["#1 [internal] load build definition from Dockerfile", "#4 [1/2] FROM docker.io/library/caddy:2-alpine", "#5 [2/2] COPY public/ /srv", "#6 exporting to image", "#6 DONE 0.3s"],
    };
    L.push(...(steps[a.framework] ?? steps.static!));
  }
  if (d.status === "failed") {
    L.push("Hata: İmaj derlenemedi (çıkış kodu 1)");
    L.push("Deploy Doktoru:");
    for (const f of failDiag) L.push(`  • ${f.title}`, `    ${f.detail}`);
    return L.join("\n");
  }
  if (d.status === "cancelled") {
    L.push("Deploy iptal edildi.");
    return L.join("\n");
  }
  const name = `xb-${a.slug}-${String(d.id).padStart(3, "0")}`;
  L.push(`Konteyner başlatılıyor: ${name}`);
  if (a.kind === "worker") {
    L.push(`İşçi kontrolü: ${name} 10 sn çalışmaya devam etmeli...`, `${name} çalışıyor.`);
  } else {
    L.push(`Uygulamanın ${a.port} portunu açması bekleniyor...`, `${name} çalışıyor, ${a.port} portu ${2 + (d.id % 4)} sn içinde yanıt verdi.`);
    if (a.httpCheck && a.domains[0]) L.push(`HTTP kontrolü: GET ${a.healthPath ?? "/"} (Host: ${a.domains[0].host})`, "HTTP kontrolü geçti: HTTP/1.1 200 OK");
    L.push(`Eski konteyner kaldırılıyor: xb-${a.slug}-${String(d.id - 1).padStart(3, "0")}`);
    L.push("HTTPS sertifikaları hazır.");
  }
  L.push(`Deploy tamamlandı (${secs} sn).`);
  if (a.sourceType !== "compose") L.push("İmaj güvenlik açıklarına karşı arka planda taranıyor (sonuç uygulama sayfasında).");
  return L.join("\n");
}

{
  let id = 100;
  const plan: { appId: number; agoH: number; status: Deployment["status"]; trigger: Deployment["trigger"]; dur: number }[] = [];
  const add = (appId: number, agoH: number, status: Deployment["status"] = "success", trigger: Deployment["trigger"] = "webhook", dur = 70) => plan.push({ appId, agoH, status, trigger, dur });
  // Eski → yeni sırasıyla.
  add(9, 19 * 24, "success", "manual", 48);
  add(1, 16 * 24, "success", "webhook", 96);
  add(2, 14 * 24, "success", "webhook", 81);
  add(5, 13 * 24, "failed", "webhook", 64);
  add(5, 13 * 24 - 1, "success", "webhook", 112);
  add(10, 9 * 24, "success", "manual", 14);
  add(9, 9 * 24 - 3, "success", "webhook", 51);
  add(3, 8 * 24, "success", "manual", 38);
  add(7, 7 * 24, "success", "webhook", 44);
  add(1, 6 * 24, "success", "webhook", 92);
  add(4, 5 * 24, "success", "webhook", 12);
  add(2, 5 * 24 - 4, "success", "webhook", 77);
  add(8, 4 * 24, "success", "manual", 19);
  add(6, 4 * 24 - 2, "success", "manual", 58);
  add(5, 3 * 24, "success", "webhook", 104);
  add(7, 3 * 24 - 5, "success", "webhook", 41);
  add(4, 2 * 24, "success", "webhook", 11);
  add(1, 2 * 24 - 6, "cancelled", "manual", 22);
  add(1, 2 * 24 - 7, "success", "webhook", 89);
  add(10, 30, "success", "manual", 13);
  add(2, 26, "success", "webhook", 84);
  add(5, 20, "success", "webhook", 99);
  add(7, 9, "success", "webhook", 43);
  add(1, 5, "success", "rollback", 18);
  add(6, 3, "failed", "webhook", 37);
  add(2, 2, "success", "webhook", 79);
  add(1, 0.6, "success", "webhook", 94);

  const counters: Record<number, number> = {};
  for (const p of plan) {
    const a = apps.find((x) => x.id === p.appId)!;
    const n = (counters[a.id] = (counters[a.id] ?? 0) + 1);
    const titles = COMMITS[a.id] ?? ["Güncelleme"];
    const r = rng(id * 13);
    const commitSha = a.sourceType === "git" ? sha(r) : null;
    const startedAt = NOW - p.agoH * HOUR;
    const title = p.trigger === "rollback" ? "Önceki sürüme dönüş" : a.sourceType === "image" ? `İmaj: ${a.image}` : titles[(n - 1) % titles.length]!;
    const image = p.status === "success" && a.sourceType !== "compose" ? (a.sourceType === "image" ? a.image : `xb-${a.slug}:${commitSha ?? sha(r)}`) : null;
    const d = { id, status: p.status, trigger: p.trigger, title, commitSha, image, startedAt, finishedAt: startedAt + p.dur * 1000, diagnosis: p.status === "failed" && a.id === 6 ? failDiag : null, appId: a.id };
    deployments.push({ ...d, log: buildLog(a, d) });
    id++;
  }
  deployments.reverse(); // yeniden eskiye
  // Uygulamaların çalışan imajı son başarılı deploy'unki olsun.
  for (const a of apps) {
    const last = deployments.find((d) => d.appId === a.id && d.status === "success");
    if (last?.image) a.currentImage = last.image;
  }
}

export const appDeployments = (appId: number) => deployments.filter((d) => d.appId === appId);

// ---------------------------------------------------------------------------
// Veritabanları

export const databases: Database[] = [
  {
    id: 1,
    projectId: 1,
    server: { id: 1, name: "ana-sunucu" },
    name: "sirket-db",
    slug: "sirket-db",
    engine: "postgres",
    engineLabel: "PostgreSQL",
    version: "17",
    dbName: "sirket",
    dbUser: "sirket",
    password: "Xb7hQ2mV9pLw",
    internalHost: "xb-db-sirket-db",
    internalPort: 5432,
    internalUrl: "postgresql://sirket:Xb7hQ2mV9pLw@xb-db-sirket-db:5432/sirket",
    externalPort: null,
    externalUrl: null,
    status: "running",
    backupIntervalH: 24,
    backupKeep: 7,
    lastBackupAt: NOW - 5 * HOUR,
    createdAt: NOW - 136 * DAY,
  },
  {
    id: 2,
    projectId: 2,
    server: { id: 2, name: "yedek-sunucu" },
    name: "magaza-db",
    slug: "magaza-db",
    engine: "mysql",
    engineLabel: "MySQL",
    version: "8.4",
    dbName: "magaza",
    dbUser: "magaza",
    password: "Mz5vK2pR8sXq",
    internalHost: "xb-db-magaza-db",
    internalPort: 3306,
    internalUrl: "mysql://magaza:Mz5vK2pR8sXq@xb-db-magaza-db:3306/magaza",
    externalPort: null,
    externalUrl: null,
    status: "running",
    backupIntervalH: 12,
    backupKeep: 14,
    lastBackupAt: NOW - 3 * HOUR,
    createdAt: NOW - 88 * DAY,
  },
  {
    id: 3,
    projectId: 2,
    server: { id: 1, name: "ana-sunucu" },
    name: "onbellek",
    slug: "onbellek",
    engine: "redis",
    engineLabel: "Redis",
    version: "7-alpine",
    dbName: "0",
    dbUser: "default",
    password: "Rk4sT8nQ1zYc",
    internalHost: "xb-db-onbellek",
    internalPort: 6379,
    internalUrl: "redis://default:Rk4sT8nQ1zYc@xb-db-onbellek:6379",
    externalPort: null,
    externalUrl: null,
    status: "running",
    backupIntervalH: 0,
    backupKeep: 7,
    lastBackupAt: null,
    createdAt: NOW - 80 * DAY,
  },
  {
    id: 4,
    projectId: 3,
    server: { id: 1, name: "ana-sunucu" },
    name: "deneme-db",
    slug: "deneme-db",
    engine: "postgres",
    engineLabel: "PostgreSQL",
    version: "16",
    dbName: "deneme",
    dbUser: "deneme",
    password: "Dn3mE7kLp2Qa",
    internalHost: "xb-db-deneme-db",
    internalPort: 5432,
    internalUrl: "postgresql://deneme:Dn3mE7kLp2Qa@xb-db-deneme-db:5432/deneme",
    externalPort: 5433,
    externalUrl: `postgresql://deneme:Dn3mE7kLp2Qa@${IP1}:5433/deneme`,
    status: "running",
    backupIntervalH: 0,
    backupKeep: 7,
    lastBackupAt: null,
    createdAt: NOW - 19 * DAY,
  },
];

for (const s of servers) s.databases = databases.filter((d) => d.server.id === s.id).length;

function dbBackups(dbId: number, slug: string, everyH: number, count: number, sizeMb: number, ext: string): Backup[] {
  const out: Backup[] = [];
  const r = rng(dbId * 31);
  const first = databases.find((d) => d.id === dbId)!.lastBackupAt!;
  for (let i = 0; i < count; i++) {
    const at = first - i * everyH * HOUR;
    const stamp = new Date(at).toISOString().slice(0, 16).replace(/[-:T]/g, "");
    out.push({
      id: dbId * 100 + count - i,
      file: `${slug}-${stamp}.${ext}`,
      size: Math.round((sizeMb - i * 0.6 + r() * 0.4) * 1024 * 1024),
      status: "success",
      error: null,
      createdAt: at,
      remote: 1,
      remoteError: null,
      verifyStatus: i === 0 ? "success" : null,
      verifyNote: i === 0 ? (getLang() === "en" ? "Restored into a temporary container: 23 tables, 48,112 rows." : "Geçici bir konteynere geri yüklendi: 23 tablo, 48.112 satır.") : null,
      verifiedAt: i === 0 ? at + 6 * MIN : null,
    });
  }
  return out;
}

export const backupsOf: Record<number, Backup[]> = {
  1: dbBackups(1, "sirket-db", 24, 7, 48.3, "sql.gz"),
  2: [
    ...dbBackups(2, "magaza-db", 12, 6, 131.7, "sql.gz").map((b, i) => (i === 0 ? { ...b, verifyStatus: null, verifyNote: null, verifiedAt: null } : b)),
  ],
  3: [],
  4: [],
};
// Bir mağaza yedeğinde uzak depolama hatası.
backupsOf[2]![2] = { ...backupsOf[2]![2]!, remote: 0, remoteError: "S3: RequestTimeout (yeniden denenecek)" };

// ---------------------------------------------------------------------------
// Proje özetleri

export function projectSummaries(): Project[] {
  return projects.map((p) => {
    const pa = apps.filter((a) => a.projectId === p.id);
    return { ...p, apps: pa.length, databases: databases.filter((d) => d.projectId === p.id).length, running: pa.filter((a) => a.status === "running").length };
  });
}

// ---------------------------------------------------------------------------
// Zamanlanmış görevler

type Run = { id: number; status: string; exitCode: number | null; startedAt: number; finishedAt: number | null; trigger: string; output?: string };
export type CronJob = { id: number; appId: number; name: string; schedule: string; command: string; enabled: boolean; timeoutMin: number; runs: Run[]; nextRun: number | null };

/** İstanbul saatiyle (UTC+3) verilen saat/dakikanın son ve sonraki gerçekleşme anı. */
const TZ = 3 * HOUR;
function lastLocal(h: number, m: number, everyH = 24) {
  const step = everyH * HOUR;
  const offset = (h * HOUR + m * MIN - TZ + DAY) % step;
  return Math.floor((NOW - offset) / step) * step + offset;
}

function runs(jobId: number, everyH: number, n: number, durS: number, output: string, last: number, failAt = -1): Run[] {
  return Array.from({ length: n }, (_, i) => {
    const startedAt = last - i * everyH * HOUR + 2000;
    const failed = i === failAt;
    return { id: jobId * 1000 + n - i, status: failed ? "failed" : "success", exitCode: failed ? 1 : 0, startedAt, finishedAt: startedAt + durS * 1000, trigger: "schedule", output: failed ? "Traceback (most recent call last):\n  File \"manage.py\", line 22, in <module>\nsmtplib.SMTPServerDisconnected: Connection unexpectedly closed" : output };
  });
}

const minuteNow = Math.floor(NOW / MIN) * MIN;
export const cronJobs: CronJob[] = [
  { id: 1, appId: 2, name: "Süresi dolan oturumları temizle", schedule: "0 3 * * *", command: "python manage.py clearsessions", enabled: true, timeoutMin: 10, runs: runs(1, 24, 7, 4, "Temizlendi.", lastLocal(3, 0)), nextRun: lastLocal(3, 0) + DAY },
  { id: 2, appId: 2, name: "Günlük rapor e-postası", schedule: "30 8 * * *", command: "python manage.py gunluk_rapor", enabled: true, timeoutMin: 15, runs: runs(2, 24, 5, 21, "12 alıcıya rapor gönderildi.", lastLocal(8, 30), 1), nextRun: lastLocal(8, 30) + DAY },
  { id: 3, appId: 5, name: "Laravel zamanlayıcı", schedule: "* * * * *", command: "php artisan schedule:run", enabled: true, timeoutMin: 5, runs: runs(3, 1 / 60, 10, 1, "No scheduled commands are ready to run.", minuteNow), nextRun: minuteNow + MIN },
  { id: 4, appId: 5, name: "Site haritası üret", schedule: "0 */6 * * *", command: "php artisan sitemap:generate", enabled: true, timeoutMin: 10, runs: runs(4, 6, 8, 9, "sitemap.xml güncellendi (1.284 URL).", lastLocal(0, 0, 6)), nextRun: lastLocal(0, 0, 6) + 6 * HOUR },
  { id: 5, appId: 1, name: "Önbelleği yenile", schedule: "*/30 * * * *", command: "node scripts/revalidate.mjs", enabled: false, timeoutMin: 5, runs: runs(5, 0.5, 3, 2, "18 sayfa yenilendi.", lastLocal(0, 0, 0.5) - 3 * DAY), nextRun: null },
];

// ---------------------------------------------------------------------------
// Kalıcı klasör yedekleri

export function volumeBackups(appId: number) {
  const a = apps.find((x) => x.id === appId);
  if (!a) return { volumes: [], backups: [], intervalH: 0, keep: 7, lastAt: null };
  const vols = a.sourceType === "compose" ? ["wp_data", "db_data"] : a.volumes.map((v) => v.name);
  if (!vols.length) return { volumes: [], backups: [], intervalH: 0, keep: 7, lastAt: null };
  const intervalH = appId === 5 || appId === 3 ? 24 : 0;
  const lastAt = intervalH ? NOW - 7 * HOUR : appId === 8 ? NOW - 4 * DAY : null;
  const backups = lastAt
    ? vols.flatMap((v, vi) =>
        Array.from({ length: intervalH ? 3 : 1 }, (_, i) => ({
          id: appId * 100 + vi * 10 + i,
          volume: v,
          file: `${a.slug}-${v}-${new Date(lastAt - i * DAY).toISOString().slice(0, 10)}.tar.gz`,
          size: Math.round((v === "db_data" ? 86 : v === "wp_data" ? 212 : 34) * 1024 * 1024 * (1 - i * 0.02)),
          status: "success",
          error: null,
          remote: intervalH ? 1 : 0,
          remoteError: null,
          trigger: intervalH ? "schedule" : "manual",
          createdAt: lastAt - i * DAY,
        })),
      )
    : [];
  return { volumes: vols, backups, intervalH, keep: 7, lastAt };
}

// ---------------------------------------------------------------------------
// Erişilebilirlik (uptime)

export const incidents = [
  { appId: 6, startedAt: NOW - 3 * HOUR + 4 * MIN, endedAt: null, reason: "502 Bad Gateway" },
  { appId: 1, startedAt: NOW - 2 * DAY - 6 * HOUR, endedAt: NOW - 2 * DAY - 6 * HOUR + 7 * MIN, reason: "Zaman aşımı (10 sn)" },
  { appId: 5, startedAt: NOW - 13 * DAY, endedAt: NOW - 13 * DAY + 22 * MIN, reason: "503 Service Unavailable" },
];

const BASE_MS: Record<number, number> = { 1: 142, 2: 88, 3: 311, 4: 41, 5: 176, 6: 231, 8: 64, 10: 37 };

/** Son 24 saatteki dakikalık kontroller. */
export function uptimeChecks(appId: number) {
  const r = rng(appId * 7);
  const end = Math.floor(Date.now() / MIN) * MIN;
  const out: { at: number; ok: number; status: number | null; ms: number }[] = [];
  const inc = incidents.filter((i) => i.appId === appId);
  for (let i = 1439; i >= 0; i -= 1) {
    const at = end - i * MIN;
    const down = inc.some((x) => at >= x.startedAt && at < (x.endedAt ?? Infinity));
    const base = BASE_MS[appId] ?? 120;
    const ms = down ? 0 : Math.round(base * (0.8 + r() * 0.5) + (r() < 0.02 ? base * 2 : 0));
    out.push({ at, ok: down ? 0 : 1, status: down ? (appId === 6 ? 502 : null) : 200, ms });
  }
  return out;
}

export function uptimeOf(appId: number) {
  const recent = uptimeChecks(appId);
  const up24 = recent.filter((x) => x.ok).length / recent.length;
  const inc = incidents.filter((i) => i.appId === appId);
  const down = inc.some((i) => i.endedAt === null);
  const ratio = (days: number) => {
    const span = days * DAY;
    const lost = inc.reduce((s, i) => s + Math.max(0, Math.min(i.endedAt ?? Date.now(), Date.now()) - Math.max(i.startedAt, Date.now() - span)), 0);
    return Math.max(0, 1 - lost / span);
  };
  return { up24h: up24, up7d: ratio(7), up30d: ratio(30), down, recent, incidents: inc.map(({ startedAt, endedAt, reason }) => ({ startedAt, endedAt, reason })) };
}

// ---------------------------------------------------------------------------
// Güvenlik

const IPS = ["185.220.101.42", "45.155.205.233", "193.142.146.17", "89.248.165.74", "162.247.74.201", "103.145.13.92", "141.98.11.115", "5.188.62.140", "212.70.149.10", "78.128.113.66"];
const PATHS = ["/wp-login.php", "/.env", "/xmlrpc.php", "/admin/login", "/phpmyadmin/", "/api/v1/users?id=1' OR '1'='1", "/.git/config", "/cgi-bin/luci", "/vendor/phpunit/phpunit/src/Util/PHP/eval-stdin.php", "/wp-admin/setup-config.php", "/search?q=<script>alert(1)</script>", "/boaform/admin/formLogin"];
const UAS = ["Mozilla/5.0 (compatible; Nmap Scripting Engine)", "python-requests/2.31.0", "curl/8.4.0", "Mozilla/5.0 zgrab/0.x", "sqlmap/1.8#stable (https://sqlmap.org)", "Go-http-client/1.1", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"];

export type SecEvent = { id: number; ip: string; kind: string; method: string | null; path: string | null; status: number | null; host: string | null; userAgent: string | null; createdAt: number; serverName: string | null };
export const securityEvents: SecEvent[] = (() => {
  const r = rng(4242);
  const hosts = apps.flatMap((a) => a.domains.map((d) => d.host));
  const kinds = ["waf", "waf", "waf", "ratelimit", "blocked", "blocked", "denied", "auth", "panel_login"];
  const out: SecEvent[] = [];
  for (let i = 0; i < 420; i++) {
    const kind = kinds[Math.floor(r() * kinds.length)]!;
    const ago = Math.pow(r(), 1.6) * 7 * DAY;
    const ip = IPS[Math.floor(Math.pow(r(), 1.8) * IPS.length)]!;
    const path = kind === "panel_login" ? "/api/auth/login" : kind === "ratelimit" ? "/api/v1/products" : PATHS[Math.floor(r() * PATHS.length)]!;
    out.push({
      id: 10000 - i,
      ip,
      kind,
      method: kind === "panel_login" || kind === "auth" ? "POST" : r() < 0.85 ? "GET" : "POST",
      path,
      status: kind === "ratelimit" ? 429 : kind === "auth" || kind === "panel_login" ? 401 : 403,
      host: kind === "panel_login" ? "panel.ornekfirma.com.tr" : hosts[Math.floor(r() * hosts.length)]!,
      userAgent: UAS[Math.floor(r() * UAS.length)]!,
      createdAt: Math.round(NOW - ago),
      serverName: r() < 0.7 ? "ana-sunucu" : "yedek-sunucu",
    });
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
})();

export const blockedIps = [
  { id: 1, ip: "185.220.101.42", reason: "Otomatik: 10 dakikada 214 WAF engeli", auto: 1, expiresAt: NOW + 19 * HOUR, createdAt: NOW - 5 * HOUR },
  { id: 2, ip: "45.155.205.233", reason: "Otomatik: 10 dakikada 87 WAF engeli", auto: 1, expiresAt: NOW + 7 * HOUR, createdAt: NOW - 17 * HOUR },
  { id: 3, ip: "193.142.146.17", reason: "Otomatik: 10 dakikada 52 WAF engeli", auto: 1, expiresAt: NOW + 2 * HOUR, createdAt: NOW - 22 * HOUR },
  { id: 4, ip: "103.145.13.0/24", reason: "Sürekli tarama yapan ağ", auto: 0, expiresAt: null, createdAt: NOW - 34 * DAY },
];

export function securitySummary(hours: number) {
  const from = Date.now() - hours * HOUR;
  const ev = securityEvents.filter((e) => e.createdAt >= from);
  const bucketMs = hours <= 48 ? HOUR : DAY;
  const count = <K extends string>(key: (e: SecEvent) => K | null) => {
    const m = new Map<K, number>();
    for (const e of ev) {
      const k = key(e);
      if (k !== null) m.set(k, (m.get(k) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  };
  const lastOf = (ip: string) => ev.find((e) => e.ip === ip)?.createdAt ?? 0;
  return {
    hours,
    bucketMs,
    byKind: count((e) => e.kind).map(([kind, n]) => ({ kind, n })),
    timeline: count((e) => String(Math.floor(e.createdAt / bucketMs) * bucketMs)).map(([t, n]) => ({ t: Number(t), n })),
    topIps: count((e) => e.ip)
      .slice(0, 10)
      .map(([ip, n]) => ({ ip, n, last: lastOf(ip), blocked: blockedIps.some((b) => b.ip === ip) ? 1 : 0 })),
    topPaths: count((e) => e.path).slice(0, 10).map(([path, n]) => ({ path, n })),
    topHosts: count((e) => e.host).slice(0, 8).map(([host, n]) => ({ host, n })),
    blockedCount: blockedIps.length,
  };
}

type Check = { id: string; scope: "panel" | "server" | "app"; target: { id: number; name: string } | null; title: string; ok: boolean; severity: "high" | "medium" | "low"; detail: string; fix?: { action: string; label: string }; link?: string };

export function securityScore() {
  const checks: Check[] = [
    { id: "panel-2fa", scope: "panel", target: null, title: "Yöneticilerde iki adımlı doğrulama", ok: true, severity: "high", detail: "Tüm yöneticilerde açık.", link: "/settings?tab=account" },
    { id: "panel-backup", scope: "panel", target: null, title: "Panel yedeği", ok: true, severity: "medium", detail: "Panel düzenli olarak yedekleniyor.", link: "/settings?tab=backup" },
    { id: "panel-offsite", scope: "panel", target: null, title: "Yedekler sunucu dışında", ok: true, severity: "medium", detail: "Yedekler uzak depolamaya da yükleniyor.", link: "/settings?tab=backup" },
    { id: "db-backup-3", scope: "panel", target: { id: 3, name: "onbellek" }, title: "Veritabanı otomatik yedekleniyor", ok: false, severity: "medium", detail: "\"onbellek\" için otomatik yedek kapalı.", link: "/databases/3?tab=backups" },
    { id: "db-backup-4", scope: "panel", target: { id: 4, name: "deneme-db" }, title: "Veritabanı otomatik yedekleniyor", ok: false, severity: "medium", detail: "\"deneme-db\" için otomatik yedek kapalı.", link: "/databases/4?tab=backups" },
    { id: "db-public-4", scope: "panel", target: { id: 4, name: "deneme-db" }, title: "Veritabanı internete kapalı", ok: false, severity: "low", detail: "\"deneme-db\" 5433 portundan dışarı açık. Gerekmiyorsa kapat; gerekiyorsa güçlü şifre kullanıldığından emin ol.", link: "/databases/4?tab=settings" },
  ];
  for (const sv of servers) {
    const target = { id: sv.id, name: sv.name };
    const remote = sv.id === 2;
    checks.push({ id: `srv-fw-${sv.id}`, scope: "server", target, title: "Güvenlik duvarı açık", ok: true, severity: "high", detail: "Yalnız izin verilen portlar açık." });
    checks.push({ id: `srv-f2b-${sv.id}`, scope: "server", target, title: "SSH kaba kuvvet koruması (fail2ban)", ok: true, severity: "medium", detail: "SSH'a çok sayıda hatalı giriş deneyen IP'ler banlanıyor." });
    checks.push({ id: `srv-dockerfw-${sv.id}`, scope: "server", target, title: "Docker portları güvenlik duvarına bağlı", ok: true, severity: "high", detail: "Konteyner portları dışarıdan yalnız izin verilenlerle açık." });
    checks.push({
      id: `srv-pw-${sv.id}`,
      scope: "server",
      target,
      title: "SSH'ta şifreyle giriş kapalı",
      ok: !remote,
      severity: "medium",
      detail: remote
        ? "SSH şifreyle girişe açık. Kendi SSH anahtarınla girebildiğini doğruladıktan sonra /etc/ssh/sshd_config.d/00-xudbin.conf dosyasına \"PasswordAuthentication no\" yazıp sshd'yi yeniden yükle."
        : "Yalnız SSH anahtarıyla giriş yapılabiliyor.",
    });
    checks.push({ id: `srv-root-${sv.id}`, scope: "server", target, title: "Root şifreyle giriş yapamıyor", ok: true, severity: "medium", detail: "Root yalnız anahtarla girebiliyor ya da hiç giremiyor." });
    checks.push({
      id: `srv-updates-${sv.id}`,
      scope: "server",
      target,
      title: "Otomatik güvenlik güncellemeleri",
      ok: !remote,
      severity: "medium",
      detail: remote ? "İşletim sistemi güvenlik yamaları otomatik kurulmuyor." : "Güvenlik yamaları otomatik kuruluyor.",
      fix: remote ? { action: `server.autoupdates:${sv.id}`, label: "Otomatik güncellemeyi aç" } : undefined,
    });
    if (!remote) checks.push({ id: `srv-reboot-${sv.id}`, scope: "server", target, title: "Yeniden başlatma bekleyen güncelleme yok", ok: false, severity: "low", detail: "Kurulmuş bir çekirdek/sistem güncellemesi sunucu yeniden başlatılınca devreye girecek." });
  }
  for (const a of apps) {
    const target = { id: a.id, name: a.name };
    const link = `/apps/${a.id}`;
    const sec = a.security;
    if (a.kind === "web") {
      checks.push({ id: `app-waf-${a.id}`, scope: "app", target, title: "WAF açık", ok: sec.waf, severity: "medium", detail: sec.waf ? "SQL injection, XSS gibi saldırılar engelleniyor." : "Web uygulama güvenlik duvarı kapalı.", fix: sec.waf ? undefined : { action: `app.waf:${a.id}`, label: "WAF'ı aç" } });
      checks.push({ id: `app-headers-${a.id}`, scope: "app", target, title: "Güvenlik başlıkları", ok: sec.headers, severity: "low", detail: sec.headers ? "Clickjacking ve MIME koklama başlıkları ekleniyor." : "Güvenlik başlıkları kapalı.", fix: sec.headers ? undefined : { action: `app.headers:${a.id}`, label: "Başlıkları aç" } });
      checks.push({ id: `app-rate-${a.id}`, scope: "app", target, title: "Hız sınırı", ok: Boolean(sec.rateLimit), severity: "low", detail: sec.rateLimit ? `IP başına dakikada ${sec.rateLimit} istek.` : "Tek bir IP sınırsız istek atabiliyor.", fix: sec.rateLimit ? undefined : { action: `app.ratelimit:${a.id}`, label: "Dakikada 600 istekle sınırla" } });
    }
    if (a.sourceType !== "compose") checks.push({ id: `app-mem-${a.id}`, scope: "app", target, title: "Bellek sınırı", ok: Boolean(a.memoryLimit), severity: "low", detail: a.memoryLimit ? `${a.memoryLimit} MB.` : "Sınır yok; bellek sızdıran bir uygulama tüm sunucuyu çökertebilir.", link: `${link}?tab=settings` });
    if (a.sourceType === "git") checks.push({ id: `app-webhook-${a.id}`, scope: "app", target, title: "Webhook imzası zorunlu", ok: a.webhookSigned, severity: "low", detail: a.webhookSigned ? "Yalnız imzalı push olayları deploy başlatıyor." : "Webhook adresini bilen herkes deploy tetikleyebilir.", link: `${link}?tab=settings` });
    if (a.id === 9) checks.push({ id: `app-debug-${a.id}`, scope: "app", target, title: "Hata ayıklama modu kapalı", ok: false, severity: "high", detail: "FLASK_DEBUG=1: hata sayfaları kaynak kodu, ayarları ve gizli anahtarları gösterebilir.", fix: { action: `app.debug:${a.id}:FLASK_DEBUG`, label: "FLASK_DEBUG'u kapat ve yeniden deploy et" } });
    const sum = a.scan.summary as { critical?: number; high?: number; fixable?: number } | null;
    if (a.scan.status === "success" && sum && typeof sum.critical === "number") {
      checks.push({ id: `app-cve-${a.id}`, scope: "app", target, title: "İmajda kritik açık yok", ok: sum.critical === 0, severity: sum.critical ? "high" : "medium", detail: sum.critical || sum.high ? `${sum.critical} kritik, ${sum.high} yüksek seviye açık; ${sum.fixable} tanesi güncellemeyle kapanıyor. Taban imajı ve bağımlılıkları güncelleyip yeniden deploy et.` : "Bilinen kritik veya yüksek seviye açık yok.", link });
    }
  }
  const W = { high: 3, medium: 2, low: 1 };
  const total = checks.reduce((n, x) => n + W[x.severity], 0);
  const passed = checks.reduce((n, x) => n + (x.ok ? W[x.severity] : 0), 0);
  const score = Math.round((passed / total) * 100);
  return { score, grade: score >= 90 ? "A" : score >= 75 ? "B" : score >= 60 ? "C" : score >= 40 ? "D" : "F", checks, checkedAt: NOW - 14 * MIN, imageScanEnabled: true };
}

// ---------------------------------------------------------------------------
// Analitik

type Row = { value: string; visitors: number; pageviews: number };

const SITE_WEIGHT: Record<number, number> = { 1: 1, 2: 0.08, 3: 0.55, 4: 0.32, 5: 0.25, 8: 0.04, 10: 0.12 };
export const analyticsSites = apps
  .filter((a) => SITE_WEIGHT[a.id] !== undefined)
  .map((a) => ({ id: a.id, name: a.name, project: projects.find((p) => p.id === a.projectId)!.name, host: a.domains[0]?.host ?? null }));

const PAGES: Record<number, string[]> = {
  1: ["/", "/hizmetler", "/hakkimizda", "/iletisim", "/referanslar", "/kariyer", "/hizmetler/web-tasarim", "/hizmetler/e-ticaret", "/kvkk"],
  2: ["/api/v1/orders", "/api/v1/auth/token", "/api/v1/products", "/admin/"],
  3: ["/", "/2025/10/sunucu-guvenligi-rehberi/", "/2025/09/django-deploy/", "/kategori/devops/", "/2025/08/docker-ipuclari/", "/hakkimda/"],
  4: ["/", "/yilbasi", "/kosullar"],
  5: ["/api/products", "/api/cart", "/api/checkout", "/api/categories"],
  8: ["/status/genel", "/dashboard"],
  10: ["/", "/projeler", "/iletisim"],
};

function rowsFrom(entries: [string, number][], total: number, pvMul = 1.6): Row[] {
  const sum = entries.reduce((s, [, w]) => s + w, 0);
  return entries
    .map(([value, w]) => {
      const visitors = Math.max(1, Math.round((total * w) / sum));
      return { value, visitors, pageviews: Math.round(visitors * pvMul) };
    })
    .sort((a, b) => b.visitors - a.visitors);
}

export function analyticsReport(site: string, range: string) {
  const ids = site === "all" ? Object.keys(SITE_WEIGHT).map(Number) : [Number(site)];
  const weight = ids.reduce((s, id) => s + (SITE_WEIGHT[id] ?? 0.1), 0);
  const hourly = range === "24h" || range === "7d";
  const days = { "24h": 1, "7d": 7, "30d": 30, "90d": 90, "365d": 365 }[range] ?? 7;
  const step = hourly ? HOUR : DAY;
  const n = hourly ? days * 24 : days;
  const end = Math.floor(Date.now() / step) * step;
  const r = rng(ids.reduce((s, x) => s * 31 + x, 7) + days);
  const perHourBase = 46 * weight;
  const series = Array.from({ length: n }, (_, i) => {
    const t = end - (n - 1 - i) * step;
    const d = new Date(t);
    const growth = 1 + (i / n) * (days > 60 ? 0.35 : 0.08);
    const weekday = [0.72, 1.08, 1.12, 1.1, 1.05, 0.96, 0.7][d.getDay()]!;
    let visitors: number;
    if (hourly) {
      const h = (d.getUTCHours() + 3) % 24; // İstanbul
      const diurnal = 0.18 + Math.max(0, Math.sin(((h - 6) / 24) * Math.PI * 2 - 0.3)) * 1.35 + (h >= 20 && h <= 23 ? 0.3 : 0);
      visitors = Math.round(perHourBase * diurnal * weekday * growth * (0.8 + r() * 0.4));
    } else {
      visitors = Math.round(perHourBase * 17 * weekday * growth * (0.85 + r() * 0.3) * (i === n - 1 ? (new Date().getUTCHours() + 3) / 24 : 1));
    }
    return { t, visitors, pageviews: Math.round(visitors * (2.1 + r() * 0.6)) };
  });
  const visitors = series.reduce((s, x) => s + x.visitors, 0);
  const pageviews = series.reduce((s, x) => s + x.pageviews, 0);
  const period = (mul: number) => ({
    visitors: Math.round(visitors * mul),
    pageviews: Math.round(pageviews * mul),
    requests: Math.round(pageviews * 7.4 * mul),
    bytes: Math.round(pageviews * 1.9 * 1024 * 1024 * mul),
    errors4xx: Math.round(pageviews * 0.021 * mul),
    errors5xx: Math.round(pageviews * (ids.includes(6) || site === "all" ? 0.0021 : 0.0004) * mul),
    bots: Math.round(pageviews * 0.38 * mul),
    bounceRate: 0.41 + (mul - 1) * 0.3,
    avgDurationMs: Math.round(146_000 * (mul > 1 ? 0.93 : 1)),
  });
  const pageEntries: [string, number][] = ids.flatMap((id) => (PAGES[id] ?? ["/"]).map((p, i): [string, number] => [ids.length > 1 ? `${apps.find((a) => a.id === id)!.domains[0]?.host ?? ""}${p}` : p, (SITE_WEIGHT[id] ?? 0.1) / (i + 1.3)]));
  const pages = rowsFrom(pageEntries, pageviews / 2.2, 2.2).slice(0, 12);
  const entries = rowsFrom(pageEntries.slice(0, 10).map(([p, w], i) => [p, w * (i === 0 ? 2.5 : 1)]), visitors * 0.9, 1).slice(0, 10);
  return {
    range,
    timeZone: "Europe/Istanbul",
    current: period(1),
    previous: period(0.87),
    realtime: Math.max(1, Math.round(9 * weight * (0.7 + Math.random() * 0.6))),
    series,
    pages,
    entries,
    referrers: rowsFrom([["Doğrudan", 38], ["google.com", 34], ["instagram.com", 9], ["linkedin.com", 6], ["t.co", 3], ["bing.com", 2.5], ["duckduckgo.com", 1.6], ["yandex.com.tr", 1.4], ["eksisozluk.com", 1.1], ["github.com", 0.8]], visitors, 2.3),
    countries: rowsFrom([["TR", 78], ["DE", 7.4], ["NL", 3.1], ["US", 2.8], ["GB", 1.9], ["AZ", 1.6], ["FR", 1.1], ["CY", 0.9], ["AT", 0.7], ["XX", 0.5]], visitors, 2.3),
    browsers: rowsFrom([["Chrome", 58], ["Safari", 24], ["Samsung Internet", 6], ["Edge", 5], ["Firefox", 4], ["Opera", 2], ["Yandex", 1]], visitors, 2.3),
    os: rowsFrom([["Android", 41], ["iOS", 27], ["Windows", 21], ["macOS", 8], ["Linux", 3]], visitors, 2.3),
    devices: rowsFrom([["Mobil", 66], ["Masaüstü", 31], ["Tablet", 3]], visitors, 2.3),
    utmSources: rowsFrom([["instagram", 52], ["newsletter", 28], ["google", 20]], visitors * 0.08, 2),
    utmMediums: rowsFrom([["social", 52], ["email", 28], ["cpc", 20]], visitors * 0.08, 2),
    utmCampaigns: rowsFrom([["yilbasi-2025", 61], ["ekim-bulteni", 39]], visitors * 0.08, 2),
  };
}

// ---------------------------------------------------------------------------
// Loglar

const APP_LOG: Record<string, (r: () => number, at: number) => string> = {
  nextjs: (r) => `  ▲ GET ${["/", "/hizmetler", "/iletisim", "/hakkimizda", "/_next/data/build/index.json"][Math.floor(r() * 5)]} 200 in ${Math.round(8 + r() * 60)}ms`,
  django: (r) => `${["GET", "GET", "POST"][Math.floor(r() * 3)]} ${["/api/v1/orders/", "/api/v1/products/?page=2", "/health/", "/api/v1/auth/token/"][Math.floor(r() * 4)]} HTTP/1.1" ${r() < 0.95 ? 200 : 404} ${Math.round(200 + r() * 4000)}`,
  laravel: (r, at) => `[${new Date(at).toISOString()}] production.INFO: ${["Sipariş oluşturuldu", "Stok güncellendi", "Sepet hesaplandı", "Kargo etiketi üretildi"][Math.floor(r() * 4)]} {"order_id":${Math.round(18000 + r() * 900)}}`,
  node: (r) => `[worker] ${["SMS gönderildi", "E-posta kuyruktan alındı", "Bildirim teslim edildi", "Yeniden deneme planlandı (2/5)"][Math.floor(r() * 4)]} job=${Math.round(r() * 99999)}`,
  static: (r, at) => `{"level":"info","ts":${(at / 1000).toFixed(3)},"logger":"http.log.access","msg":"handled request","request":{"method":"GET","uri":"${["/", "/assets/app.css", "/img/hero.webp", "/projeler"][Math.floor(r() * 4)]}"},"status":200}`,
  fastapi: () => "INFO:     Started server process [1]",
  flask: () => "[INFO] Booting worker with pid: 8",
  auto: (r) => `${["10.0.1.4", "10.0.1.7"][Math.floor(r() * 2)]} - - "GET ${["/", "/wp-json/wp/v2/posts", "/feed/"][Math.floor(r() * 3)]} HTTP/1.1" 200 ${Math.round(1000 + r() * 30000)}`,
};

export function appLogLine(appId: number, r: () => number, at = Date.now()) {
  const a = apps.find((x) => x.id === appId);
  const fn = APP_LOG[a?.framework ?? "auto"] ?? APP_LOG.auto!;
  const ts = new Date(at).toISOString().replace("T", " ").slice(0, 19);
  return a?.framework === "laravel" || a?.framework === "static" ? fn(r, at) : `${ts} ${fn(r, at)}`;
}

export function appLogSnapshot(appId: number) {
  const a = apps.find((x) => x.id === appId);
  if (a?.status === "failed") return "Hata: konteyner çalışmıyor; son deploy başarısız oldu.\nSon başarılı sürümün logları için Deploylar sekmesine bak.";
  if (a?.status === "stopped") return "[2025-10-04 11:02:13 +0000] [1] [INFO] Handling signal: term\n[2025-10-04 11:02:13 +0000] [8] [INFO] Worker exiting (pid: 8)\n[2025-10-04 11:02:14 +0000] [1] [INFO] Shutting down: Master";
  const r = rng(appId * 11);
  const head: Record<string, string[]> = {
    nextjs: ["  ▲ Next.js 15.1.3", "  - Local:        http://localhost:3000", "  - Network:      http://0.0.0.0:3000", "", " ✓ Starting...", " ✓ Ready in 412ms"],
    django: ["Operations to perform:", "  Apply all migrations: admin, auth, contenttypes, orders, products, sessions", "Running migrations:", "  No migrations to apply.", "142 static files copied to '/app/staticfiles'.", "[INFO] Starting gunicorn 21.2.0", "[INFO] Listening at: http://0.0.0.0:8000 (1)", "[INFO] Booting worker with pid: 9", "[INFO] Booting worker with pid: 10"],
    laravel: ["INFO  Nothing to migrate.", "INFO  Caching framework bootstrap, configuration, and metadata.", "{\"level\":\"info\",\"msg\":\"FrankenPHP started 🐘\",\"php_version\":\"8.4.2\"}"],
    node: ["[worker] Redis'e bağlanıldı", "[worker] 4 eşzamanlı iş ile dinleniyor: bildirimler"],
    static: ["{\"level\":\"info\",\"msg\":\"serving initial configuration\"}"],
    auto: ["AH00558: apache2: Could not reliably determine the server's fully qualified domain name", "[core:notice] [pid 1] AH00094: Command line: 'apache2 -D FOREGROUND'"],
  };
  const lines = [...(head[a?.framework ?? "auto"] ?? head.auto!)];
  const now = Date.now();
  let at = now - 40 * 30_000;
  for (let i = 0; i < 40; i++) lines.push(appLogLine(appId, r, (at += 5_000 + r() * 50_000)));
  return lines.join("\n");
}

export function serverSetupLog(serverId: number) {
  const s = servers.find((x) => x.id === serverId)!;
  return [
    `==> ${s.name} kurulumu başladı`,
    "Sistem: Ubuntu 24.04.1 LTS (x86_64)",
    "Docker kuruluyor...",
    "Docker 27.3.1 hazır.",
    "Xudbin ağı oluşturuluyor: xudbin",
    "Caddy imajı derleniyor (WAF ve hız sınırı modülleriyle)...",
    "Caddy başlatıldı: xudbin-caddy",
    "Güvenlik duvarı (UFW): SSH, 80 ve 443 izinli",
    "fail2ban etkinleştirildi (sshd)",
    "Kurulum tamamlandı (4 dk 12 sn).",
  ].join("\n");
}

export const dbLogSnapshot = (dbId: number) => {
  const d = databases.find((x) => x.id === dbId);
  if (d?.engine === "redis") return "1:C * Redis version=7.4.1, bits=64, commit=00000000, modified=0, pid=1, just started\n1:M * Server initialized\n1:M * Loading RDB produced by version 7.4.1\n1:M * DB loaded from disk: 0.012 seconds\n1:M * Ready to accept connections tcp";
  if (d?.engine === "mysql") return "[System] [MY-010116] [Server] /usr/sbin/mysqld (mysqld 8.4.3) starting as process 1\n[System] [MY-013576] [InnoDB] InnoDB initialization has started.\n[System] [MY-013577] [InnoDB] InnoDB initialization has ended.\n[System] [MY-010931] [Server] /usr/sbin/mysqld: ready for connections. Version: '8.4.3'  socket: '/var/run/mysqld/mysqld.sock'  port: 3306";
  return "LOG:  starting PostgreSQL 17.2 on x86_64-pc-linux-gnu\nLOG:  listening on IPv4 address \"0.0.0.0\", port 5432\nLOG:  database system was shut down at 2025-10-12 03:00:02 UTC\nLOG:  database system is ready to accept connections\nLOG:  checkpoint starting: time\nLOG:  checkpoint complete: wrote 412 buffers (2.5%); 0 WAL file(s) added, 0 removed, 1 recycled";
};

// ---------------------------------------------------------------------------
// Ayarlar

export const notifications = [
  { id: 1, name: "Ekip Discord kanalı", kind: "discord" as const, events: ["deploy_failed", "site_down", "site_up", "backup_failed", "server_down", "vulnerability"], enabled: true },
  { id: 2, name: "Nöbetçi Telegram", kind: "telegram" as const, events: ["site_down", "server_down", "server_resource"], enabled: true },
  { id: 3, name: "ops@ornekfirma.com.tr", kind: "email" as const, events: ["backup_failed", "cert_expiring", "cron_failed"], enabled: false },
];

export const notifyEvents = {
  deploy_success: "Deploy başarılı",
  deploy_failed: "Deploy başarısız",
  ip_banned: "Saldırgan IP banlandı",
  backup_failed: "Yedekleme başarısız",
  server_down: "Sunucuya ulaşılamıyor",
  vulnerability: "İmajda kritik güvenlik açığı",
  site_down: "Site çöktü",
  site_up: "Site yeniden çalışıyor",
  cert_expiring: "HTTPS sertifikası bitmek üzere",
  server_resource: "Sunucuda disk veya bellek doluyor",
  cron_failed: "Zamanlanmış görev başarısız",
};

export const panelBackups = Array.from({ length: 5 }, (_, i) => ({
  id: 50 - i,
  file: `xudbin-panel-${new Date(NOW - 2 * HOUR - i * DAY).toISOString().slice(0, 10)}.tar.gz.enc`,
  size: Math.round((3.4 - i * 0.05) * 1024 * 1024),
  status: "success" as const,
  error: null,
  remote: 1,
  remoteError: null,
  createdAt: NOW - 2 * HOUR - i * DAY,
}));

export const apiTokens = [
  { id: 1, name: "GitHub Actions", prefix: "xb_7Kq2", readOnly: 0, lastUsedAt: NOW - 3 * HOUR, expiresAt: NOW + 290 * DAY, createdAt: NOW - 75 * DAY },
  { id: 2, name: "Grafana (salt okunur)", prefix: "xb_Lm9p", readOnly: 1, lastUsedAt: NOW - 4 * MIN, expiresAt: null, createdAt: NOW - 40 * DAY },
];

export const auditEntries = (() => {
  const r = rng(99);
  const acts: [string, string, string, string][] = [
    ["Deploy başlatıldı", "POST", "/api/apps/1/deploy", "demo@xudbin.com"],
    ["Giriş yapıldı", "POST", "/api/auth/login", "demo@xudbin.com"],
    ["Ortam değişkenleri güncellendi", "PUT", "/api/apps/2/env", "elif.yilmaz@ornekfirma.com.tr"],
    ["Alan adı eklendi", "POST", "/api/apps/1/domains", "demo@xudbin.com"],
    ["Veritabanı yedeği alındı", "POST", "/api/databases/1/backups", "mert.kaya@ornekfirma.com.tr"],
    ["Hatalı giriş denemesi", "POST", "/api/auth/login", "admin@ornekfirma.com.tr"],
    ["IP engellendi", "POST", "/api/security/blocked", "demo@xudbin.com"],
    ["Uygulama ayarları güncellendi", "PATCH", "/api/apps/5", "elif.yilmaz@ornekfirma.com.tr"],
    ["Deploy başlatıldı", "POST", "/api/apps/2/deploy", "token:GitHub Actions"],
    ["Kullanıcı eklendi", "POST", "/api/users", "demo@xudbin.com"],
  ];
  return Array.from({ length: 60 }, (_, i) => {
    const [action, method, path, email] = acts[Math.floor(r() * acts.length)]!;
    const failed = action === "Hatalı giriş denemesi";
    return {
      id: 5000 - i,
      email: email.startsWith("token:") ? "demo@xudbin.com" : email,
      action,
      method,
      path,
      status: failed ? 401 : 200,
      ip: failed ? IPS[Math.floor(r() * IPS.length)]! : ["88.241.12.7", "176.88.40.112", "95.70.183.24"][Math.floor(r() * 3)]!,
      via: email.startsWith("token:") ? "api-token" : "web",
      createdAt: Math.round(NOW - i * 3.1 * HOUR - r() * HOUR),
    };
  });
})();

export const containersOf = (serverId: number) => {
  const own = apps.filter((a) => a.server.id === serverId && a.container);
  const out = own.flatMap((a) =>
    a.sourceType === "compose"
      ? [
          { name: `xb-${a.slug}-wordpress-1`, image: "wordpress:6-apache", state: "running" },
          { name: `xb-${a.slug}-db-1`, image: "mariadb:11", state: "running" },
        ]
      : [{ name: `${a.container}`, image: a.currentImage ?? "", state: a.status === "stopped" ? "exited" : "running" }],
  );
  for (const d of databases.filter((x) => x.server.id === serverId)) out.push({ name: d.internalHost, image: `${d.engine}:${d.version}`, state: "running" });
  if (serverId === 2) out.push({ name: "xb-sirket-api-r1", image: apps[1]!.currentImage ?? "", state: "running" });
  out.push({ name: "xudbin-caddy", image: "xudbin/caddy:2.9-waf", state: "running" });
  if (serverId === 1) out.push({ name: "node-exporter", image: "prom/node-exporter:v1.8.2", state: "running" });
  return out.map((x, i) => ({
    id: (i + 1).toString(16).padStart(12, "a"),
    ...x,
    status: x.state === "running" ? `Up ${1 + ((i * 7) % 20)} days` : "Exited (0) 12 days ago",
    createdAt: Math.floor((NOW - (i + 2) * DAY) / 1000),
    ports: x.name === "xudbin-caddy" ? ["0.0.0.0:80->80/tcp", "0.0.0.0:443->443/tcp"] : [],
    managed: x.name !== "node-exporter",
  }));
};
