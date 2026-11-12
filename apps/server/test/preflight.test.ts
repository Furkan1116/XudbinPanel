import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { devServer } from "../src/services/preflight/node.js";
import { decide, runPreflight, summaryLines, type PreflightContext, type PreflightReport } from "../src/services/preflight/index.js";
import { analyzeEnv } from "../src/services/preflight/secrets.js";
import { LIMITS } from "../src/services/preflight/tree.js";

/** Küçük sahte proje klasörü: { "yol": içerik }. */
function project(files: Record<string, string | Buffer>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xb-preflight-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return root;
}

const ctx = (over: Partial<PreflightContext> = {}): PreflightContext => ({
  sourceType: "git",
  framework: "auto",
  buildOptions: {},
  buildContext: ".",
  dockerfilePath: "Dockerfile",
  port: 8000,
  command: null,
  ...over,
});

const ids = (r: PreflightReport, level?: string) => r.findings.filter((f) => !level || f.level === level).map((f) => f.id);
const find = (r: PreflightReport, id: string) => r.findings.find((f) => f.id === id);

// Sahte ama biçimce gerçek bir özel anahtar gövdesi (base64 satırları + bitiş).
const KEY_BODY = `-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gun
VTLw7onLRnrq0/IzW7yWR7QkrmBL7jTKEn5u+qKhbwKfBstIs+bMY2Zkp18gnTxK
LxoS2tFczGkPLPgizskuemMghRniWaoLcyehkd3qqGElvW/VDL5AaWTg0nLVkjRo
-----END RSA PRIVATE KEY-----
`;
const SECRET_VALUE = "s3cr3t-deger-asla-gorunmemeli-91a7";

// --- Gizli bilgi ve gereksiz dosya -----------------------------------------------------------------

test("özel anahtar: gövdeli anahtar kritik (dosya:satır); yalnız başlığı anan kod ve test klasörü kritik değil", () => {
  const root = project({
    "deploy/server.key": `# yorum\n${KEY_BODY}`,
    "src/check.py": 'if line.startswith("-----BEGIN RSA PRIVATE KEY-----"):\n    pass\n',
    "tests/fixtures/test.pem": KEY_BODY,
    "requirements.txt": "flask\n",
  });
  const r = runPreflight(root, ctx());
  const key = r.findings.filter((f) => f.id === "private-key");
  assert.equal(key.length, 2);
  assert.deepEqual(key.find((f) => f.file === "deploy/server.key")?.level, "critical");
  assert.equal(key.find((f) => f.file === "deploy/server.key")?.line, 2);
  assert.equal(key.find((f) => f.file === "tests/fixtures/test.pem")?.level, "warning");
  assert.ok(!r.findings.some((f) => f.file === "src/check.py"));
});

test("servis hesabı JSON'u (tek satırlık anahtar) kritik; özel anahtarsız JSON ve sertifika .pem bulgu değil", () => {
  const sa = JSON.stringify({ type: "service_account", project_id: "x", private_key: "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj\n-----END PRIVATE KEY-----\n" });
  const root = project({
    "gcp.json": sa,
    "config.json": JSON.stringify({ type: "service_account", note: "anahtar ortamdan okunur" }),
    "certs/ca.pem": "-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIUQ\n-----END CERTIFICATE-----\n",
  });
  const r = runPreflight(root, ctx({ sourceType: "upload" }));
  assert.equal(find(r, "service-account")?.level, "critical");
  assert.equal(find(r, "service-account")?.file, "gcp.json");
  assert.ok(!r.findings.some((f) => f.file === "config.json" || f.file === "certs/ca.pem"));
});

test(".env: dolu gizli değer kritik, örnek/yer tutucu/herkese açık değerler kritik değil", () => {
  const root = project({
    ".env": `DEBUG=False\nSECRET_KEY=${SECRET_VALUE}\nDATABASE_URL=postgres://app:${SECRET_VALUE}@db:5432/app\n`,
    ".env.example": `SECRET_KEY=${SECRET_VALUE}\n`,
    "web/.env.production": "NEXT_PUBLIC_SITE_URL=https://ornek.com\n",
    "api/.env": "SECRET_KEY=\nAPI_TOKEN=changeme\nDB_PASSWORD=<parola>\n",
    "svc/.env.test": `API_TOKEN=${SECRET_VALUE}\n`,
  });
  const r = runPreflight(root, ctx());
  const main = r.findings.find((f) => f.file === ".env")!;
  assert.equal(main.level, "critical");
  assert.equal(main.vars?.keys, "SECRET_KEY, DATABASE_URL");
  assert.ok(!r.findings.some((f) => f.file === ".env.example" || f.file === "web/.env.production"));
  assert.equal(r.findings.find((f) => f.file === "api/.env")?.id, "env-empty");
  assert.equal(r.findings.find((f) => f.file === "svc/.env.test")?.level, "warning");
  assert.equal(r.counts.critical, 1);
});

test("gizli değer rapora, özete ve günlük satırlarına sızmaz", () => {
  const root = project({
    ".env": `SECRET_KEY=${SECRET_VALUE}\nSTRIPE_KEY=${SECRET_VALUE}\n`,
    "manage.py": 'os.environ.setdefault("DJANGO_SETTINGS_MODULE", "site.settings")\n',
    "site/settings.py": `SECRET_KEY = "${SECRET_VALUE}"\nDEBUG = True\nALLOWED_HOSTS = ["*"]\n`,
    "requirements.txt": "django\n",
    "key.pem": KEY_BODY,
  });
  const r = runPreflight(root, ctx({ framework: "django" }));
  assert.ok(r.counts.critical >= 3);
  const everything = JSON.stringify(r) + summaryLines(r).join("\n") + decide(r, "block", { trigger: "manual", skip: false }).lines.join("\n");
  assert.ok(!everything.includes(SECRET_VALUE), "gizli değer raporda görünmemeli");
  assert.ok(!everything.includes("MIIEowIBAAKCAQEA"), "anahtar gövdesi raporda görünmemeli");
});

test(".env analizi: tırnak, export, yorum ve bağlantı adresindeki parola", () => {
  const a = analyzeEnv(`export TOKEN="abc def"\n# PASSWORD=gizli\nREDIS_URL=redis://:${SECRET_VALUE}@r:6379\nCACHE_URL=redis://r:6379\nNAME='Site' # yorum\n`);
  assert.deepEqual(a.secretKeys, ["TOKEN"]);
  assert.deepEqual(a.filledKeys, ["TOKEN", "REDIS_URL", "CACHE_URL", "NAME"]);
  assert.deepEqual(analyzeEnv("DATABASE_URL=postgres://u:p4ss@h/db\n").secretKeys, ["DATABASE_URL"]);
});

test("yüklemede .dockerignore'un dışarıda bıraktığı .env uyarıdır; git deposunda yine kritik", () => {
  const files = { ".env": `SECRET_KEY=${SECRET_VALUE}\n`, ".dockerignore": ".env\nnode_modules\n", "index.html": "<h1>x</h1>" };
  assert.equal(runPreflight(project(files), ctx({ sourceType: "upload" })).findings.find((f) => f.file === ".env")?.level, "warning");
  assert.equal(runPreflight(project(files), ctx({ sourceType: "git" })).findings.find((f) => f.file === ".env")?.level, "critical");
});

test("veritabanı dosyası, bağımlılık klasörleri, büyük dosya uyarı; içlerine girilmez", () => {
  const root = project({
    "db.sqlite3": Buffer.concat([Buffer.from("SQLite format 3\0"), Buffer.alloc(100)]),
    "notes.db": "düz metin, sqlite değil",
    "node_modules/paket/.env": `SECRET_KEY=${SECRET_VALUE}\n`,
    "node_modules/paket/key.pem": KEY_BODY,
    "env/pyvenv.cfg": "home = /usr/bin\n",
    "env/lib/x.py": "",
    "app/__pycache__/a.pyc": Buffer.from([0, 1, 2]),
    "media/video.bin": Buffer.alloc(2048),
    "package.json": "{}",
  });
  const r = runPreflight(root, ctx({ sourceType: "upload" }), { limits: { ...LIMITS, bigFile: 1024 } });
  assert.deepEqual(ids(r, "critical"), []);
  for (const id of ["sqlite", "dir-node_modules", "dir-venv", "dir-pycache", "big-file"]) assert.ok(ids(r).includes(id), id);
  assert.equal(find(r, "sqlite")?.file, "db.sqlite3");
  assert.equal(find(r, "dir-venv")?.file, "env");
  assert.ok(!r.findings.some((f) => f.file === "notes.db"));
});

test(".gitignore yokluğu yalnız git kaynağında, .dockerignore yokluğu derlenen kaynakta bilgi", () => {
  const files = { "index.html": "<h1>x</h1>" };
  assert.deepEqual(ids(runPreflight(project(files), ctx()), "info").sort(), ["no-dockerignore", "no-gitignore"]);
  assert.deepEqual(ids(runPreflight(project(files), ctx({ sourceType: "upload" })), "info"), ["no-dockerignore"]);
  assert.deepEqual(ids(runPreflight(project({ ...files, ".gitignore": ".env\n", ".dockerignore": ".git\n" }), ctx()), "info"), []);
});

test("kısayollar izlenmez: klasör dışını gösteren .env, anahtar ve klasör okunmaz", () => {
  const outside = project({ "gizli.env": `SECRET_KEY=${SECRET_VALUE}\n`, "key.pem": KEY_BODY, "dir/.env": `TOKEN=${SECRET_VALUE}\n` });
  const root = project({ "index.html": "<h1>x</h1>" });
  fs.symlinkSync(path.join(outside, "gizli.env"), path.join(root, ".env"));
  fs.symlinkSync(path.join(outside, "key.pem"), path.join(root, "server.key"));
  fs.symlinkSync(path.join(outside, "dir"), path.join(root, "linked"));
  fs.symlinkSync(path.join(root, "index.html"), path.join(root, "ic-kisayol.html"));
  const r = runPreflight(root, ctx());
  assert.deepEqual(ids(r, "critical"), []);
  assert.ok(!r.findings.some((f) => f.file === ".env" || f.file === "server.key" || f.file?.startsWith("linked")));
  assert.equal(r.scanned.files, 1);
});

test("sınırlar: dosya sayısı ve derinlik aşılınca tarama kesilir ve raporda söylenir", () => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 30; i++) files[`f${String(i).padStart(2, "0")}.txt`] = "x";
  files["a/b/c/d/e/.env"] = `SECRET_KEY=${SECRET_VALUE}\n`;
  const r = runPreflight(project(files), ctx(), { limits: { ...LIMITS, maxFiles: 10 } });
  assert.equal(r.scanned.files, 10);
  assert.equal(r.scanned.truncated, true);
  assert.ok(r.notes.some((n) => n.text.includes("ilk {n} dosya")));
  const deep = runPreflight(project(files), ctx(), { limits: { ...LIMITS, maxDepth: 2 } });
  assert.ok(!deep.findings.some((f) => f.id === "env-secret"));
  assert.equal(deep.scanned.truncated, true);
});

test("okunamayan kök: kontrol hata vermez, rapor 'tamamlanamadı' olur", () => {
  const r = runPreflight(path.join(os.tmpdir(), "xb-preflight-yok-" + Date.now()), ctx());
  assert.equal(r.status, "error");
  assert.deepEqual(decide(r, "block", { trigger: "webhook", skip: false }).block, false);
});

test("imaj kaynağı atlanır ve bunu söyler; panelde yazılı compose'da dosya yok", () => {
  const image = runPreflight("/yok", ctx({ sourceType: "image" }));
  assert.equal(image.status, "skipped");
  assert.match(summaryLines(image)[0]!, /atlandı/);
  const inline = runPreflight(null, ctx({ sourceType: "compose" }));
  assert.equal(inline.status, "done");
  assert.deepEqual(inline.findings, []);
});

test("compose kaynağı: yalnız gizli bilgi grubu çalışır", () => {
  const root = project({ "docker-compose.yml": "services: {}\n", ".env": `DB_PASSWORD=${SECRET_VALUE}\n`, "Dockerfile": "FROM node\nCMD npm run dev\n", "package.json": '{"scripts":{"dev":"next dev"}}' });
  const r = runPreflight(root, ctx({ sourceType: "compose" }));
  assert.deepEqual(r.groups, ["secrets"]);
  assert.deepEqual(ids(r, "critical"), ["env-secret"]);
});

// --- Django -----------------------------------------------------------------------------------------

const djangoBase = {
  "manage.py": 'os.environ.setdefault("DJANGO_SETTINGS_MODULE", "site.settings")\nimport django\n',
  "requirements.txt": "Django==5.1\npsycopg[binary]\n",
  ".gitignore": ".env\n",
  ".dockerignore": ".git\n",
};

test("Django: tek ayar dosyasında sabit DEBUG = True kritik; ortamdan okunan DEBUG bulgu değil", () => {
  const bad = runPreflight(project({ ...djangoBase, "site/settings.py": "DEBUG = True  # geliştirme\nSTATIC_ROOT = BASE_DIR / 'static'\nCSRF_TRUSTED_ORIGINS = []\n" }), ctx({ framework: "django" }));
  assert.equal(find(bad, "django-debug")?.level, "critical");
  assert.equal(find(bad, "django-debug")?.file, "site/settings.py");
  assert.equal(find(bad, "django-debug")?.line, 1);
  const good = runPreflight(project({ ...djangoBase, "site/settings.py": 'DEBUG = os.environ.get("DJANGO_DEBUG", "False") == "True"\nSTATIC_ROOT = "s"\nCSRF_TRUSTED_ORIGINS = []\n' }), ctx({ framework: "django" }));
  assert.deepEqual(ids(good, "critical"), []);
  assert.ok(!ids(good).includes("django-debug"));
});

test("Django: birden çok ayar dosyası ve açık seçim yoksa DEBUG uyarıdır; ortamdaki modül kesinleştirir", () => {
  const files = {
    ...djangoBase,
    "manage.py": 'os.environ.setdefault("DJANGO_SETTINGS_MODULE", "site.settings.dev")\n',
    "site/settings/__init__.py": "",
    "site/settings/base.py": "DEBUG = True\nSTATIC_ROOT = 's'\nCSRF_TRUSTED_ORIGINS = []\n",
    "site/settings/dev.py": "from .base import *\n",
    "site/settings/production.py": "from .base import *\nDEBUG = False\n",
  };
  const maybe = runPreflight(project(files), ctx({ framework: "django" }));
  assert.deepEqual(ids(maybe, "critical"), []);
  const warn = maybe.findings.filter((f) => f.id === "django-debug-maybe");
  assert.ok(warn.length >= 1);
  assert.match(String(warn[0]!.vars?.files), /production\.py/);
  // Ortam üretim ayarını seçiyorsa: production.py DEBUG'u kapatıyor, bulgu yok.
  const prod = runPreflight(project(files), ctx({ framework: "django", settingsModule: "site.settings.production" }));
  assert.ok(!prod.findings.some((f) => f.id.startsWith("django-debug")));
  // Üretim ayarı base'i aynen alıyorsa (DEBUG ezilmiyor): kesin ve kritik.
  const inherited = runPreflight(project({ ...files, "site/settings/production.py": "from .base import *\n" }), ctx({ framework: "django", settingsModule: "site.settings.production" }));
  assert.equal(find(inherited, "django-debug")?.level, "critical");
  assert.equal(find(inherited, "django-debug")?.file, "site/settings/base.py");
});

test("Django: koşullu DEBUG ataması kritik değil uyarı", () => {
  const r = runPreflight(project({ ...djangoBase, "site/settings.py": "DEBUG = True\nif os.environ.get('PROD'):\n    DEBUG = False\nSTATIC_ROOT='s'\nCSRF_TRUSTED_ORIGINS=[]\n" }), ctx({ framework: "django" }));
  assert.equal(find(r, "django-debug")?.level, "warning");
});

test("Django: runserver kritik (Dockerfile CMD ve panel komutu); Procfile'da yalnız uyarı", () => {
  const settings = { "site/settings.py": "DEBUG = False\nSTATIC_ROOT='s'\nCSRF_TRUSTED_ORIGINS=[]\n" };
  const own = runPreflight(project({ ...djangoBase, ...settings, Dockerfile: 'FROM python:3.12-slim\nCOPY . .\nUSER app\nCMD ["python", "manage.py", "runserver", "0.0.0.0:8000"]\n' }), ctx({ framework: "dockerfile" }));
  assert.equal(find(own, "django-runserver")?.level, "critical");
  assert.equal(find(own, "django-runserver")?.file, "Dockerfile");
  assert.equal(find(own, "django-runserver")?.line, 4);
  assert.ok(ids(own).includes("django-no-server"));
  const panel = runPreflight(project({ ...djangoBase, ...settings }), ctx({ framework: "django", command: "python manage.py runserver 0.0.0.0:8000" }));
  assert.equal(find(panel, "django-runserver")?.level, "critical");
  // Panelin ön ayarı gunicorn ile başlatır: Procfile'daki runserver kullanılmaz, yalnız uyarı.
  const procfile = runPreflight(project({ ...djangoBase, ...settings, Procfile: "web: python manage.py runserver\n" }), ctx({ framework: "django" }));
  assert.deepEqual(ids(procfile, "critical"), []);
  assert.equal(find(procfile, "django-procfile-runserver")?.level, "warning");
  // Ön ayar gunicorn ve whitenoise'u kendisi kurar: bağımlılık uyarısı yok.
  assert.ok(!ids(procfile).includes("django-no-server"));
});

test("Django: gömülü SECRET_KEY, ALLOWED_HOSTS = ['*'], STATIC_ROOT ve CSRF_TRUSTED_ORIGINS", () => {
  const r = runPreflight(project({ ...djangoBase, "site/settings.py": `SECRET_KEY = 'django-insecure-${SECRET_VALUE}'\nDEBUG = False\nALLOWED_HOSTS = ['*']\n` }), ctx({ framework: "django" }));
  assert.equal(find(r, "django-secret-key")?.level, "warning");
  assert.equal(find(r, "django-allowed-hosts")?.level, "warning");
  assert.equal(find(r, "django-static")?.vars?.missing, "STATIC_ROOT");
  assert.equal(find(r, "django-csrf-origins")?.level, "info");
  const env = runPreflight(project({ ...djangoBase, "site/settings.py": 'SECRET_KEY = os.environ["DJANGO_SECRET_KEY"]\nDEBUG = False\nALLOWED_HOSTS = os.environ.get("H", "").split(",")\nSTATIC_ROOT = "s"\nCSRF_TRUSTED_ORIGINS = []\n' }), ctx({ framework: "django" }));
  assert.deepEqual(env.findings.filter((f) => f.group === "django").map((f) => f.id), []);
});

// --- Node / Next.js -----------------------------------------------------------------------------------

test("Node: geliştirme sunucusuyla başlatma kritik (betik içinden de); üretim komutları bulgu değil", () => {
  const pkg = (scripts: Record<string, string>, deps: Record<string, string> = { express: "4" }) => JSON.stringify({ scripts, dependencies: deps, engines: { node: ">=22" } });
  const lock = { "package-lock.json": "{}", ".gitignore": "x", ".dockerignore": "x" };
  const viaScript = runPreflight(project({ ...lock, "package.json": pkg({ start: "next dev -p 3000" }) }), ctx({ framework: "node", port: 3000 }));
  assert.equal(find(viaScript, "node-dev-server")?.level, "critical");
  assert.equal(find(viaScript, "node-dev-server")?.vars?.dev, "next dev");
  const panel = runPreflight(project({ ...lock, "package.json": pkg({ dev: "vite", build: "vite build" }, { vite: "6" }) }), ctx({ framework: "node", command: "npm run dev" }));
  assert.equal(find(panel, "node-dev-server")?.level, "critical");
  // Next.js ön ayarı next start kullanır; start betiğinde next dev olsa bile çalışmaz.
  const next = runPreflight(project({ ...lock, "package.json": pkg({ start: "next dev", build: "next build" }, { next: "15" }) }), ctx({ framework: "nextjs", port: 3000 }));
  assert.ok(!ids(next).includes("node-dev-server"));
  const prod = runPreflight(project({ ...lock, "package.json": pkg({ start: "node server.js" }) }), ctx({ framework: "node" }));
  assert.deepEqual(ids(prod, "critical"), []);
  assert.equal(devServer("vite build"), null);
  assert.equal(devServer("vite preview --port 3000"), null);
  assert.equal(devServer("node node_modules/vite/bin/vite.js"), "vite");
  assert.equal(devServer("cat vite.config.ts"), null);
});

test("Node: dev betiği, eksik betik, kilit dosyası, build betiği, Node sürümü, standalone", () => {
  const r = runPreflight(project({ "package.json": JSON.stringify({ scripts: { dev: "node server.js" }, dependencies: { next: "15" } }) }), ctx({ framework: "node", command: "npm run dev" }));
  assert.equal(find(r, "node-dev-script")?.level, "warning");
  for (const id of ["node-no-lockfile", "node-no-build", "node-no-version"]) assert.equal(find(r, id)?.level, "warning", id);
  assert.equal(find(r, "next-standalone")?.level, "info");
  const missing = runPreflight(project({ "package.json": JSON.stringify({ scripts: {} }), "package-lock.json": "{}" }), ctx({ framework: "remix" }));
  assert.equal(find(missing, "node-missing-script")?.vars?.script, "start");
  const ok = runPreflight(
    project({ "package.json": JSON.stringify({ scripts: { build: "next build", start: "next start" }, dependencies: { next: "15" } }), "pnpm-lock.yaml": "", ".nvmrc": "22", "next.config.mjs": 'export default { output: "standalone" }' }),
    ctx({ framework: "nextjs", port: 3000 }),
  );
  assert.deepEqual(ok.findings.filter((f) => f.group === "node"), []);
});

test("Node grubu JavaScript dışı ön ayarda (ör. Django projesindeki package.json) çalışmaz", () => {
  const r = runPreflight(project({ ...djangoBase, "site/settings.py": "DEBUG=False\nSTATIC_ROOT='s'\nCSRF_TRUSTED_ORIGINS=[]\n", "package.json": '{"scripts":{"dev":"vite"}}' }), ctx({ framework: "django" }));
  assert.ok(!r.groups.includes("node"));
});

// --- Dockerfile ve port --------------------------------------------------------------------------------

test("Dockerfile: USER yok, sabitlenmemiş imaj, EXPOSE uyuşmazlığı, ADD URL, COPY . . + .dockerignore yok (hepsi uyarı)", () => {
  const r = runPreflight(
    project({ Dockerfile: "FROM python\nWORKDIR /app\nADD https://ornek.com/x.tgz /tmp/\nCOPY . .\nEXPOSE 5000\nCMD gunicorn app:app --bind 0.0.0.0:5000\n", "app.py": "", ".gitignore": "x" }),
    ctx({ framework: "dockerfile", port: 8000 }),
  );
  assert.deepEqual(ids(r, "critical"), []);
  for (const id of ["docker-root", "docker-unpinned", "docker-expose", "docker-add-url", "docker-copy-all"]) assert.equal(find(r, id)?.level, "warning", id);
  assert.equal(find(r, "docker-unpinned")?.line, 1);
  assert.equal(find(r, "docker-add-url")?.line, 3);
  // Aynı şeyi söyleyen ".dockerignore yok" bilgisi tekrarlanmaz.
  assert.ok(!ids(r).includes("no-dockerignore"));
});

test("Dockerfile: çok aşamalı yapıda aşama adı imaj sayılmaz, miras alınan USER geçerli; temiz Dockerfile bulgu vermez", () => {
  const df = "FROM node:22-alpine AS build\nRUN npm ci && npm run build\nUSER node\n\nFROM build\nEXPOSE 3000\nCMD [\"node\", \"server.js\"]\n";
  const r = runPreflight(project({ Dockerfile: df, ".dockerignore": "node_modules\n", ".gitignore": "x", "package.json": JSON.stringify({ scripts: { build: "tsc" } }), "package-lock.json": "{}" }), ctx({ framework: "dockerfile", port: 3000 }));
  assert.deepEqual(r.findings.filter((f) => f.group === "docker"), []);
  const latest = runPreflight(project({ Dockerfile: "FROM nginx:latest\nUSER nginx\nCOPY site /usr/share/nginx/html\n", ".dockerignore": "x" }), ctx({ framework: "dockerfile", port: 80 }));
  assert.ok(ids(latest).includes("docker-unpinned"));
  const pinned = runPreflight(project({ Dockerfile: "FROM ghcr.io/ornek/imaj@sha256:abc\nUSER 1000\n", ".dockerignore": "x" }), ctx({ framework: "dockerfile", port: 80 }));
  assert.deepEqual(pinned.findings.filter((f) => f.group === "docker"), []);
});

test("Dockerfile yokken (ön ayar) USER gibi bulgular üretilmez; kullanılmayan Dockerfile bilgi olarak söylenir", () => {
  const files = { "package.json": JSON.stringify({ scripts: { start: "node index.js" }, engines: { node: "22" } }), "package-lock.json": "{}", ".dockerignore": "x", ".gitignore": "x" };
  const preset = runPreflight(project(files), ctx({ framework: "node", port: 3000 }));
  assert.deepEqual(preset.findings.filter((f) => f.group === "docker"), []);
  assert.ok(preset.notes.some((n) => n.text.startsWith("Dockerfile panel tarafından üretilecek")));
  const unused = runPreflight(project({ ...files, Dockerfile: "FROM node\nCMD npm start\n" }), ctx({ framework: "node", port: 3000 }));
  assert.deepEqual(unused.findings.filter((f) => f.group === "docker").map((f) => [f.id, f.level]), [["docker-unused", "info"]]);
});

test("Sunucu yalnız 127.0.0.1/localhost dinliyorsa uyarı", () => {
  const r = runPreflight(project({ "requirements.txt": "flask\ngunicorn\n", "app.py": "app = Flask(__name__)\n", ".dockerignore": "x" }), ctx({ framework: "flask", command: "gunicorn app:app --bind 127.0.0.1:8000" }));
  assert.equal(find(r, "docker-localhost")?.vars?.addr, "127.0.0.1");
  const ok = runPreflight(project({ "requirements.txt": "flask\n", "app.py": "", ".dockerignore": "x" }), ctx({ framework: "flask", command: "gunicorn app:app --bind 0.0.0.0:8000" }));
  assert.ok(!ids(ok).includes("docker-localhost"));
});

// --- Karar: mod ve geçiş ------------------------------------------------------------------------------------

test("karar: block kritikte durur; elle 'yine de yayınla' geçer, webhook geçemez; warn yalnız uyarır", () => {
  const withCritical = runPreflight(project({ ".env": `SECRET_KEY=${SECRET_VALUE}\n`, ".gitignore": "x" }), ctx({ sourceType: "upload" }));
  assert.equal(withCritical.counts.critical, 1);
  assert.deepEqual(decide(withCritical, "block", { trigger: "manual", skip: false }).block, true);
  assert.equal(decide(withCritical, "block", { trigger: "manual", skip: false }).outcome, "blocked");
  const bypass = decide(withCritical, "block", { trigger: "manual", skip: true });
  assert.equal(bypass.outcome, "bypassed");
  assert.equal(bypass.block, false);
  assert.ok(bypass.lines.some((l) => l.includes("bilerek geçildi")));
  assert.equal(decide(withCritical, "block", { trigger: "webhook", skip: true }).block, true);
  assert.equal(decide(withCritical, "warn", { trigger: "webhook", skip: false }).outcome, "warned");
  assert.equal(decide(withCritical, "warn", { trigger: "manual", skip: false }).block, false);
  const clean = runPreflight(project({ "index.html": "x", ".gitignore": "x", ".dockerignore": "x" }), ctx());
  assert.equal(decide(clean, "block", { trigger: "webhook", skip: false }).outcome, "passed");
  assert.match(summaryLines(clean)[0]!, /sorun bulunmadı/);
  // "Sorun bulunmadı" der, "güvenli" demez.
  assert.doesNotMatch(summaryLines(clean)[0]!, /güvenli(\s|\.|,|$)|onaylandı/);
});

test("kontrol birkaç saniyenin altında biter (orta boy depo)", () => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 1500; i++) files[`src/m${i % 30}/f${i}.py`] = `x = ${i}\n`.repeat(50);
  const r = runPreflight(project(files), ctx());
  assert.equal(r.scanned.files, 1500);
  assert.ok(r.scanned.ms < 3000, `${r.scanned.ms} ms`);
});
