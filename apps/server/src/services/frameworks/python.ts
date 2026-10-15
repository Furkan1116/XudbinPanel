import { DEBIAN_ARCHIVE_FIX, flag, opt, shCmd } from "./util.js";
import type { Framework, Options, Repo } from "./types.js";

const PY_VERSIONS = ["3.14", "3.13", "3.12", "3.11", "3.10"].map((v) => ({ value: v, label: `Python ${v}` }));

function pythonVersion(repo: Repo): string | undefined {
  const raw = (repo.read(".python-version") || repo.read("runtime.txt") || "").trim();
  const m = raw.match(/(\d)\.(\d{1,2})/) ?? repo.read("pyproject.toml").match(/requires-python\s*=\s*["'][^"'\d]*(\d)\.(\d{1,2})/);
  if (!m) return undefined;
  // Henüz resmi imajı olmayan yeni sürümler en yeni desteklenene çekilir.
  return Number(m[2]) > 14 ? "3.14" : Number(m[2]) < 10 ? "3.10" : `${m[1]}.${m[2]}`;
}

function deps(repo: Repo) {
  return (repo.read("requirements.txt") + repo.read("pyproject.toml") + repo.read("Pipfile")).toLowerCase();
}

/** Bağımlılık kurulumu: requirements.txt, pyproject (uv) veya Pipfile. */
function installStep(repo: Repo): string {
  if (repo.has("requirements.txt")) return "COPY requirements.txt .\nRUN pip install --no-cache-dir -r requirements.txt";
  if (repo.has("Pipfile")) return "COPY Pipfile* .\nRUN pip install --no-cache-dir pipenv && pipenv install --system --deploy";
  if (repo.has("pyproject.toml")) return "COPY . .\nRUN pip install --no-cache-dir uv && uv pip install --system -r pyproject.toml";
  return "";
}

/** Derlenmesi gereken sürücüler için sistem paketleri (psycopg2, mysqlclient, Pillow...). */
function systemPackages(repo: Repo, extra: string) {
  const d = deps(repo);
  const pkgs = new Set(extra.split(/[\s,]+/).filter(Boolean));
  if (/psycopg2(?!-binary)|psycopg\b/.test(d)) ["gcc", "libpq-dev"].forEach((p) => pkgs.add(p));
  if (d.includes("mysqlclient")) ["gcc", "pkg-config", "default-libmysqlclient-dev"].forEach((p) => pkgs.add(p));
  if (/\bpillow\b/.test(d)) ["libjpeg62-turbo-dev", "zlib1g-dev"].forEach((p) => pkgs.add(p));
  if (!pkgs.size) return "";
  return `${DEBIAN_ARCHIVE_FIX}
RUN apt-get update && apt-get install -y --no-install-recommends ${[...pkgs].join(" ")} && rm -rf /var/lib/apt/lists/*`;
}

const commonFields = (o: { entry?: boolean } = {}) => [
  { key: "pythonVersion", label: "Python sürümü", type: "select" as const, options: PY_VERSIONS },
  ...(o.entry ? [{ key: "module", label: "Uygulama modülü", type: "text" as const, placeholder: "main:app", hint: "dosya:değişken biçiminde, ör. app:app veya src.main:app" }] : []),
  { key: "aptPackages", label: "Ek sistem paketleri", type: "text" as const, placeholder: "ffmpeg libmagic1", hint: "Boşluklarla ayır. Veritabanı sürücülerinin paketleri otomatik eklenir." },
];

function header(repo: Repo, opts: Options) {
  const v = opt(opts.pythonVersion, pythonVersion(repo) ?? "3.12");
  return `FROM python:${v}-slim
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_DISABLE_PIP_VERSION_CHECK=1 PORT=8000
${systemPackages(repo, opt(opts.aptPackages, ""))}
${installStep(repo)}`;
}

/** manage.py içindeki DJANGO_SETTINGS_MODULE değerinden ayar ve WSGI modüllerini bulur. */
function djangoModules(repo: Repo) {
  const settings = repo.read("manage.py").match(/DJANGO_SETTINGS_MODULE["']\s*,\s*["']([\w.]+)["']/)?.[1] ?? "config.settings";
  const pkg = settings.split(".").slice(0, -1).join(".") || settings.split(".")[0]!;
  return { settings, wsgi: `${pkg}.wsgi` };
}

/** Ayar modülünün kaynak metni (paket ise klasördeki tüm .py dosyaları). */
function settingsSource(repo: Repo, module: string) {
  const base = module.replace(/\./g, "/");
  if (repo.has(`${base}.py`)) return repo.read(`${base}.py`);
  return repo
    .list(base)
    .filter((f) => f.endsWith(".py"))
    .map((f) => repo.read(`${base}/${f}`))
    .join("\n");
}

/** settings.py'de bir ayarın okunduğu ortam değişkeninin adı: ALLOWED_HOSTS = env_list("X") / os.environ.get("X") ... */
export function settingEnvName(source: string, setting: string): string | undefined {
  const m = source.match(new RegExp(`^${setting}\\s*=\\s*([^\\n]*(?:\\n[ \\t)\\]]+[^\\n]*){0,3})`, "m"));
  return m?.[1]?.match(/[([]\s*["']([A-Z][A-Z0-9_]*)["']/)?.[1];
}

export const django: Framework = {
  id: "django",
  name: "Django",
  language: "Python",
  category: "Python",
  description: "Gunicorn ile çalışır. Statik dosyalar WhiteNoise ile sunulur, Nginx gerekmez.",
  defaultPort: 8000,
  fields: [
    ...commonFields(),
    { key: "settingsModule", label: "Ayar modülü", type: "text", placeholder: "config.settings", hint: "manage.py dosyasından otomatik bulunur." },
    { key: "wsgiModule", label: "WSGI modülü", type: "text", placeholder: "config.wsgi" },
    { key: "migrate", label: "Her deploy'da migrate çalıştır", type: "toggle" },
    { key: "collectstatic", label: "Statik dosyaları topla (collectstatic)", type: "toggle" },
  ],
  envHints: [
    { key: "DJANGO_SECRET_KEY", description: "Django'nun gizli anahtarı. Projendeki settings.py hangi adı okuyorsa onu kullan (ör. SECRET_KEY).", auto: "secret", required: true },
    { key: "DJANGO_DEBUG", description: "Canlıda mutlaka kapalı olmalı.", value: "False", required: true },
    { key: "DJANGO_ALLOWED_HOSTS", description: "Uygulamanın alan adları, virgülle ayrılmış.", auto: "domains", required: true },
    { key: "CSRF_TRUSTED_ORIGINS", description: "HTTPS formlarının reddedilmemesi için alan adları.", auto: "https-origins" },
    { key: "DATABASE_URL", description: "Xudbin veritabanı kullanıyorsan bağlantı adresi (dj-database-url ile)." },
  ],
  steps: [
    "Bağımlılıklar kurulur (requirements.txt, pyproject veya Pipfile); gunicorn ve whitenoise eklenir.",
    "Konteyner başlarken collectstatic ve migrate çalışır; ortam değişkenleri bu anda okunur.",
    "Uygulama Gunicorn ile çalışır, statik dosyalar WhiteNoise ile aynı süreçten sunulur.",
  ],
  envAliases(repo, opts) {
    const source = settingsSource(repo, opt(opts.settingsModule, djangoModules(repo).settings));
    const out: Record<string, string> = {};
    const map = { DJANGO_ALLOWED_HOSTS: "ALLOWED_HOSTS", CSRF_TRUSTED_ORIGINS: "CSRF_TRUSTED_ORIGINS", DJANGO_SECRET_KEY: "SECRET_KEY", DJANGO_DEBUG: "DEBUG" };
    for (const [hint, setting] of Object.entries(map)) {
      const name = settingEnvName(source, setting);
      if (name && name !== hint) out[hint] = name;
    }
    return out;
  },
  detect: (repo) => (repo.has("manage.py") && /django/i.test(deps(repo) + repo.read("manage.py")) ? { score: 90, reason: "manage.py ve Django bağımlılığı bulundu", options: { settingsModule: djangoModules(repo).settings, wsgiModule: djangoModules(repo).wsgi, pythonVersion: pythonVersion(repo) } } : null),
  build(repo, opts) {
    const found = djangoModules(repo);
    const settings = opt(opts.settingsModule, found.settings);
    const wsgi = opt(opts.wsgiModule, found.wsgi);
    const start = [
      flag(opts.collectstatic, true) ? "(python manage.py collectstatic --noinput || echo 'collectstatic atlandı: STATIC_ROOT tanımlı mı?')" : "",
      flag(opts.migrate, true) ? "python manage.py migrate --noinput" : "",
      `exec gunicorn xudbin_wsgi:application --bind 0.0.0.0:$PORT --workers \${WEB_CONCURRENCY:-3} --access-logfile - --forwarded-allow-ips='*'`,
    ].filter(Boolean).join(" && ");
    return {
      port: 8000,
      dockerfile: `${header(repo, opts)}
RUN pip install --no-cache-dir gunicorn whitenoise
COPY . .
ENV DJANGO_SETTINGS_MODULE=${settings}
EXPOSE 8000
${shCmd(start)}
`,
      files: {
        // Projenin ayarlarına dokunmadan statik dosyaları sunar; ManifestStaticFilesStorage ile de çalışır.
        "xudbin_wsgi.py": `import os
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "${settings}")
from ${wsgi} import application as django_app  # noqa: E402
from django.conf import settings  # noqa: E402

application = django_app
if getattr(settings, "STATIC_ROOT", None):
    from whitenoise import WhiteNoise
    application = WhiteNoise(django_app, root=str(settings.STATIC_ROOT), prefix=settings.STATIC_URL, max_age=31536000)
`,
      },
      notes: [`Ayar modülü: ${settings}, WSGI: ${wsgi}`],
    };
  },
};

function findAppModule(repo: Repo, marker: RegExp): string | undefined {
  for (const f of ["main.py", "app.py", "wsgi.py", "server.py", "application.py", "app/main.py", "src/main.py", "api/main.py"]) {
    const text = repo.read(f);
    const m = text.match(marker);
    if (m) return `${f.replace(/\.py$/, "").replace(/\//g, ".")}:${m[1]}`;
  }
  return undefined;
}

export const flask: Framework = {
  id: "flask",
  name: "Flask",
  language: "Python",
  category: "Python",
  description: "Gunicorn ile çalıştırılır.",
  defaultPort: 8000,
  fields: commonFields({ entry: true }),
  envHints: [{ key: "SECRET_KEY", description: "Oturum çerezlerini imzalar.", auto: "secret" }],
  steps: ["Bağımlılıklar kurulur, gunicorn eklenir.", "Uygulama gunicorn ile modül:değişken üzerinden başlatılır."],
  detect: (repo) => (/\bflask\b/.test(deps(repo)) ? { score: 70, reason: "Flask bağımlılığı bulundu", options: { module: findAppModule(repo, /(\w+)\s*=\s*Flask\(/), pythonVersion: pythonVersion(repo) } } : null),
  build(repo, opts) {
    const mod = opt(opts.module, findAppModule(repo, /(\w+)\s*=\s*Flask\(/) ?? "app:app");
    return {
      port: 8000,
      dockerfile: `${header(repo, opts)}
RUN pip install --no-cache-dir gunicorn
COPY . .
EXPOSE 8000
${shCmd(`exec gunicorn ${mod} --bind 0.0.0.0:$PORT --workers \${WEB_CONCURRENCY:-3} --access-logfile -`)}
`,
    };
  },
};

export const fastapi: Framework = {
  id: "fastapi",
  name: "FastAPI",
  language: "Python",
  category: "Python",
  description: "Uvicorn ile çalıştırılır.",
  defaultPort: 8000,
  fields: commonFields({ entry: true }),
  envHints: [],
  steps: ["Bağımlılıklar kurulur, uvicorn eklenir.", "Uygulama uvicorn ile başlatılır; proxy başlıkları (X-Forwarded-*) kabul edilir."],
  detect: (repo) => (/\bfastapi\b/.test(deps(repo)) ? { score: 75, reason: "FastAPI bağımlılığı bulundu", options: { module: findAppModule(repo, /(\w+)\s*=\s*FastAPI\(/), pythonVersion: pythonVersion(repo) } } : null),
  build(repo, opts) {
    const mod = opt(opts.module, findAppModule(repo, /(\w+)\s*=\s*FastAPI\(/) ?? "main:app");
    return {
      port: 8000,
      dockerfile: `${header(repo, opts)}
RUN pip install --no-cache-dir "uvicorn[standard]"
COPY . .
EXPOSE 8000
${shCmd(`exec uvicorn ${mod} --host 0.0.0.0 --port $PORT --proxy-headers --forwarded-allow-ips='*' --workers \${WEB_CONCURRENCY:-2}`)}
`,
    };
  },
};

export const python: Framework = {
  id: "python",
  name: "Python (genel)",
  language: "Python",
  category: "Python",
  description: "Başlatma komutunu kendin verirsin.",
  defaultPort: 8000,
  fields: [...commonFields(), { key: "startCommand", label: "Başlatma komutu", type: "text", placeholder: "python main.py" }],
  envHints: [],
  steps: ["Bağımlılıklar kurulur.", "Verdiğin başlatma komutu çalıştırılır; uygulama $PORT portunu dinlemeli."],
  detect: (repo) => (repo.has("requirements.txt") || repo.has("pyproject.toml") || repo.has("Pipfile") ? { score: 30, reason: "Python bağımlılık dosyası bulundu" } : null),
  build(repo, opts) {
    const start = opt(opts.startCommand, repo.has("main.py") ? "python main.py" : "python app.py");
    return { port: 8000, dockerfile: `${header(repo, opts)}\nCOPY . .\nEXPOSE 8000\n${shCmd(`exec ${start}`)}\n` };
  },
};
