import { DEBIAN_ARCHIVE_FIX, flag, opt, shCmd, staticCaddyfile } from "./util.js";
import type { Framework, Repo } from "./types.js";

// ---------------------------------------------------------------------------
// PHP — FrankenPHP (Caddy + PHP tek süreçte; Nginx/PHP-FPM gerekmez)
// ---------------------------------------------------------------------------

const PHP_SUPPORTED = ["8.5", "8.4", "8.3", "8.2"];
const PHP_VERSIONS = PHP_SUPPORTED.map((v) => ({ value: v, label: `PHP ${v}` }));

/** Heroku Procfile'ındaki "heroku-php-apache2 web/" gibi kök klasör tanımı. */
function procfileRoot(repo: Repo) {
  return repo.read("Procfile").match(/heroku-php-(?:apache2|nginx)(?:\s+-\S+\s+\S+)*\s+([\w./-]+)/)?.[1]?.replace(/\/$/, "");
}
const phpRoot = (repo: Repo) => procfileRoot(repo) ?? (repo.has("public/index.php") ? "public" : repo.has("web/index.php") ? "web" : ".");

/** Bir sürüm kısıtının (^8.2, >=8.4.1, ^8.2|^8.3, 8.1 - 8.5) izin verdiği en düşük 8.x alt sürümü. */
function minPhp(constraint: string): number | null {
  const alts = constraint
    .split(/\|\|?/)
    .map((alt) => alt.match(/8\.(\d+)/)?.[1]) // her seçenekte ilk sürüm alt sınırdır ("8.1 - 8.5" dahil)
    .filter((x): x is string => x !== undefined)
    .map(Number);
  return alts.length ? Math.min(...alts) : null;
}

/**
 * composer.json ve composer.lock'taki tüm paketlerin istediği en düşük PHP sürümünün en büyüğü.
 * Ör. Laravel 13'ün kilitli Symfony 8 paketleri >=8.4 ister; composer.json ^8.3 dese bile 8.4 seçilir.
 */
function phpVersion(repo: Repo) {
  const constraints: string[] = [];
  const root = repo.json<{ require?: Record<string, string>; config?: { platform?: { php?: string } } }>("composer.json");
  if (root?.require?.php) constraints.push(root.require.php);
  const lock = repo.json<{ packages?: { require?: Record<string, string> }[]; platform?: Record<string, string> }>("composer.lock");
  for (const p of lock?.packages ?? []) if (p.require?.php) constraints.push(p.require.php);
  if (lock?.platform?.php) constraints.push(lock.platform.php);
  const mins = constraints.map(minPhp).filter((x): x is number => x !== null);
  if (!mins.length) return undefined;
  const need = Math.max(...mins);
  const ok = PHP_SUPPORTED.map((v) => Number(v.split(".")[1])).filter((m) => m >= need).sort((a, b) => a - b);
  return `8.${ok[0] ?? 5}`;
}

function phpBase(repo: Repo, version: string, extensions: string) {
  const exts = ["pdo_mysql", "pdo_pgsql", "gd", "intl", "zip", "opcache", "bcmath", ...extensions.split(/[\s,]+/).filter(Boolean)];
  const viteAssets = repo.has("package.json") && /"vite"|laravel-mix/.test(repo.read("package.json"));
  return {
    viteAssets,
    text: `${viteAssets ? `FROM node:24-alpine AS assets
WORKDIR /app
COPY . .
RUN (npm ci || npm install) && npm run build

` : ""}FROM dunglas/frankenphp:1-php${version}
RUN install-php-extensions ${[...new Set(exts)].join(" ")}
COPY --from=composer:2 /usr/bin/composer /usr/bin/composer
WORKDIR /app
COPY . .
${viteAssets ? "COPY --from=assets /app/public/build ./public/build\n" : ""}RUN if [ -f composer.json ]; then composer install --no-dev --optimize-autoloader --no-interaction --no-progress; fi
ENV SERVER_NAME=:80
# Temel imajın sağlık kontrolü php-server'da açık olmayan yönetim portunu (2019) dener; panel kendi kontrolünü yapar.
HEALTHCHECK NONE`,
  };
}

const phpFields = [
  { key: "phpVersion", label: "PHP sürümü", type: "select" as const, options: PHP_VERSIONS },
  { key: "extensions", label: "Ek PHP eklentileri", type: "text" as const, placeholder: "redis imagick", hint: "pdo_mysql, pdo_pgsql, gd, intl, zip, opcache, bcmath zaten kurulu." },
];

export const laravel: Framework = {
  id: "laravel",
  name: "Laravel",
  language: "PHP",
  category: "PHP",
  description: "FrankenPHP ile çalışır; Vite varlıkları derlenir, migration'lar otomatik çalışır.",
  defaultPort: 80,
  fields: [...phpFields, { key: "migrate", label: "Her deploy'da migrate çalıştır", type: "toggle" }],
  envHints: [
    { key: "APP_KEY", description: "Laravel şifreleme anahtarı.", auto: "laravel-key", required: true },
    { key: "APP_ENV", description: "Çalışma ortamı.", value: "production", required: true },
    { key: "APP_DEBUG", description: "Canlıda kapalı olmalı.", value: "false", required: true },
    { key: "APP_URL", description: "Sitenin tam adresi.", auto: "url", required: true },
    { key: "DB_CONNECTION", description: "mysql, pgsql veya sqlite." },
    { key: "DB_HOST", description: "Xudbin veritabanının iç adresi (Veritabanı > Bağlantı)." },
    { key: "LOG_CHANNEL", description: "Logların panelde görünmesi için.", value: "stderr" },
  ],
  steps: [
    "Varsa Vite varlıkları Node ile derlenir.",
    "composer install --no-dev çalışır.",
    "Başlarken migrate --force ve optimize çalışır, uygulama FrankenPHP ile sunulur.",
  ],
  detect: (repo) => (repo.has("artisan") && repo.has("composer.json") ? { score: 95, reason: "artisan dosyası bulundu", options: { phpVersion: phpVersion(repo) } } : null),
  build(repo, opts) {
    const base = phpBase(repo, opt(opts.phpVersion, phpVersion(repo) ?? "8.4"), opt(opts.extensions, ""));
    const start = [
      "php artisan storage:link >/dev/null 2>&1 || true",
      flag(opts.migrate, true) ? "php artisan migrate --force" : "",
      "php artisan optimize || true",
      "exec frankenphp php-server --root /app/public --listen :80",
    ].filter(Boolean).join(" && ");
    return {
      port: 80,
      dockerfile: `${base.text}
RUN chown -R www-data:www-data storage bootstrap/cache 2>/dev/null || true
EXPOSE 80
${shCmd(start)}
`,
    };
  },
};

export const php: Framework = {
  id: "php",
  name: "PHP",
  language: "PHP",
  category: "PHP",
  description: "Klasik PHP siteleri (WordPress dahil) FrankenPHP ile sunulur.",
  defaultPort: 80,
  fields: [...phpFields, { key: "documentRoot", label: "Kök klasör", type: "text", placeholder: ".", hint: "index.php'nin bulunduğu klasör, ör. public" }],
  envHints: [],
  steps: ["Varsa composer install çalışır.", "Kök klasör FrankenPHP ile sunulur."],
  detect: (repo) => (repo.has("composer.json") || repo.has("index.php") ? { score: 50, reason: "PHP dosyaları bulundu", options: { documentRoot: phpRoot(repo), phpVersion: phpVersion(repo) } } : null),
  build(repo, opts) {
    const base = phpBase(repo, opt(opts.phpVersion, phpVersion(repo) ?? "8.4"), opt(opts.extensions, ""));
    const root = opt(opts.documentRoot, phpRoot(repo));
    return { port: 80, dockerfile: `${base.text}\nEXPOSE 80\n${shCmd(`exec frankenphp php-server --root /app/${root} --listen :80`)}\n` };
  },
};

// ---------------------------------------------------------------------------
// .NET
// ---------------------------------------------------------------------------

function findCsproj(repo: Repo): string | null {
  const root = repo.find(/\.csproj$/);
  if (root) return root;
  for (const d of repo.list().filter((n) => !n.startsWith(".") && !/^(tests?|test)$/i.test(n))) {
    const hit = repo.find(/\.csproj$/, d);
    if (hit && /Microsoft\.NET\.Sdk\.Web/.test(repo.read(hit))) return hit;
  }
  return null;
}

export const dotnet: Framework = {
  id: "dotnet",
  name: "ASP.NET Core",
  language: "C#",
  category: ".NET",
  description: "dotnet publish ile derlenir, aspnet çalışma zamanı imajında çalışır.",
  defaultPort: 8080,
  fields: [
    { key: "project", label: "Proje dosyası", type: "text", placeholder: "MyApp/MyApp.csproj", hint: "Otomatik bulunur." },
    { key: "dotnetVersion", label: ".NET sürümü", type: "select", options: ["10.0", "9.0", "8.0"].map((v) => ({ value: v, label: `.NET ${v}` })) },
  ],
  envHints: [{ key: "ConnectionStrings__DefaultConnection", description: "appsettings.json'daki bağlantı dizesini ezer (çift alt çizgi = iç içe anahtar)." }],
  steps: ["dotnet publish -c Release çalışır.", "Uygulama 8080 portunda, Production ortamında başlar."],
  detect(repo) {
    const p = findCsproj(repo);
    if (!p) return null;
    const v = repo.read(p).match(/<TargetFramework>net(\d+\.\d+)/)?.[1];
    return { score: 90, reason: `${p} bulundu`, options: { project: p, dotnetVersion: v } };
  },
  build(repo, opts) {
    const project = opt(opts.project, findCsproj(repo) ?? "");
    if (!project) throw new Error(".csproj dosyası bulunamadı");
    const csproj = repo.read(project);
    const v = opt(opts.dotnetVersion, csproj.match(/<TargetFramework>net(\d+\.\d+)/)?.[1] ?? "8.0");
    const assembly = csproj.match(/<AssemblyName>([^<]+)</)?.[1] ?? project.split("/").pop()!.replace(/\.csproj$/, "");
    return {
      port: 8080,
      dockerfile: `FROM mcr.microsoft.com/dotnet/sdk:${v} AS build
WORKDIR /src
COPY . .
RUN if [ -f .config/dotnet-tools.json ] || [ -f "$(dirname "${project}")/.config/dotnet-tools.json" ]; then dotnet tool restore; fi
RUN dotnet publish "${project}" -c Release -o /out /p:UseAppHost=false

FROM mcr.microsoft.com/dotnet/aspnet:${v}
WORKDIR /app
COPY --from=build /out .
ENV ASPNETCORE_URLS=http://+:8080 ASPNETCORE_ENVIRONMENT=Production ASPNETCORE_FORWARDEDHEADERS_ENABLED=true
EXPOSE 8080
ENTRYPOINT ["dotnet", "${assembly}.dll"]
`,
      notes: [`Proje: ${project}, .NET ${v}`],
    };
  },
};

// ---------------------------------------------------------------------------
// Go, Rust
// ---------------------------------------------------------------------------

export const go: Framework = {
  id: "go",
  name: "Go",
  language: "Go",
  category: "Go",
  description: "Statik ikili olarak derlenir, küçük bir Alpine imajında çalışır.",
  defaultPort: 8080,
  fields: [{ key: "buildPath", label: "main paketinin yolu", type: "text", placeholder: ".", hint: "ör. ./cmd/server" }],
  envHints: [],
  steps: ["go build çalışır (CGO kapalı).", "İkili dosya, şablon ve statik dosyalarla birlikte Alpine'da başlar; uygulama PORT değişkenini dinlemeli."],
  detect: (repo) => (repo.has("go.mod") ? { score: 90, reason: "go.mod bulundu", options: { buildPath: repo.has("main.go") ? "." : (repo.list("cmd")[0] ? `./cmd/${repo.list("cmd")[0]}` : ".") } } : null),
  build(repo, opts) {
    const v = repo.read("go.mod").match(/^go (\d+\.\d+)/m)?.[1] ?? "1.24";
    const p = opt(opts.buildPath, ".");
    return {
      port: 8080,
      dockerfile: `FROM golang:${v}-alpine AS build
WORKDIR /src
COPY go.* ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/app ${p}

FROM alpine:3.21
RUN apk add --no-cache ca-certificates tzdata
WORKDIR /app
# Şablonlar ve statik dosyalar çalışma anında göreli yoldan okunabilsin diye kaynak da kopyalanır.
COPY --from=build /src /app
COPY --from=build /out/app /usr/local/bin/app
ENV PORT=8080
EXPOSE 8080
CMD ["app"]
`,
    };
  },
};

export const rust: Framework = {
  id: "rust",
  name: "Rust",
  language: "Rust",
  category: "Rust",
  description: "cargo build --release ile derlenir, Debian slim imajında çalışır.",
  defaultPort: 8080,
  fields: [{ key: "binary", label: "Çalıştırılacak ikili", type: "text", hint: "Cargo.toml'daki paket adı; otomatik bulunur." }],
  envHints: [],
  steps: ["cargo build --release çalışır.", "İkili dosya slim bir imajda başlar."],
  detect: (repo) => (repo.has("Cargo.toml") ? { score: 90, reason: "Cargo.toml bulundu" } : null),
  build(repo, opts) {
    const toml = repo.read("Cargo.toml");
    const bin = opt(opts.binary, toml.match(/\[\[bin\]\][^[]*name\s*=\s*"([^"]+)"/)?.[1] ?? toml.match(/\[package\][^[]*name\s*=\s*"([^"]+)"/)?.[1] ?? "app");
    return {
      port: 8080,
      dockerfile: `FROM rust:1-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends pkg-config libssl-dev && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY . .
RUN cargo build --release && cp target/release/${bin} /out-app

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libssl3 && rm -rf /var/lib/apt/lists/*
COPY --from=build /out-app /usr/local/bin/app
ENV PORT=8080 ROCKET_ADDRESS=0.0.0.0
EXPOSE 8080
CMD ["app"]
`,
    };
  },
};

// ---------------------------------------------------------------------------
// Java — Spring Boot ve diğer jar uygulamaları
// ---------------------------------------------------------------------------

function javaVersion(repo: Repo) {
  const text = repo.read("pom.xml") + repo.read("build.gradle") + repo.read("build.gradle.kts");
  const m = text.match(/<java\.version>(\d+)<|languageVersion(?:\.set\()?\s*=?\s*JavaLanguageVersion\.of\((\d+)\)|sourceCompatibility\s*=\s*['"]?(?:JavaVersion\.VERSION_)?(\d+)/);
  return m?.[1] ?? m?.[2] ?? m?.[3];
}

export const java: Framework = {
  id: "java",
  name: "Java / Spring Boot",
  language: "Java",
  category: "Java",
  description: "Maven veya Gradle ile jar derlenir, JRE imajında çalışır.",
  defaultPort: 8080,
  fields: [{ key: "javaVersion", label: "Java sürümü", type: "select", options: ["21", "17", "25"].map((v) => ({ value: v, label: `Java ${v}` })) }],
  envHints: [
    { key: "SPRING_PROFILES_ACTIVE", description: "Spring profili.", value: "prod" },
    { key: "SPRING_DATASOURCE_URL", description: "Veritabanı JDBC adresi, ör. jdbc:postgresql://xb-db-...:5432/db" },
  ],
  steps: ["Maven (mvn package) veya Gradle (bootJar) ile jar üretilir, testler atlanır.", "Jar, --server.port=$PORT ile JRE üzerinde başlar."],
  detect: (repo) =>
    repo.has("pom.xml") || repo.has("build.gradle") || repo.has("build.gradle.kts")
      ? { score: 85, reason: repo.has("pom.xml") ? "pom.xml bulundu" : "Gradle derleme dosyası bulundu", options: { javaVersion: javaVersion(repo) } }
      : null,
  build(repo, opts) {
    const v = opt(opts.javaVersion, javaVersion(repo) ?? "21");
    const maven = repo.has("pom.xml");
    const build = maven
      ? `FROM maven:3-eclipse-temurin-${v} AS build
WORKDIR /src
COPY . .
RUN (if [ -x mvnw ]; then ./mvnw -B -DskipTests package; else mvn -B -DskipTests package; fi) && cp "$(ls target/*.jar | grep -v -e '-plain.jar$' -e '/original-' | head -1)" /app.jar`
      : `FROM gradle:jdk${v} AS build
WORKDIR /src
COPY . .
RUN (if [ -x gradlew ]; then ./gradlew --no-daemon -x test bootJar || ./gradlew --no-daemon -x test build; else gradle --no-daemon -x test bootJar || gradle --no-daemon -x test build; fi) && cp "$(ls build/libs/*.jar | grep -v -e '-plain.jar$' | head -1)" /app.jar`
    return {
      port: 8080,
      dockerfile: `${build}

FROM eclipse-temurin:${v}-jre
WORKDIR /app
COPY --from=build /app.jar app.jar
ENV PORT=8080 JAVA_OPTS="-XX:MaxRAMPercentage=75"
EXPOSE 8080
${shCmd("exec java $JAVA_OPTS -jar app.jar --server.port=$PORT --server.forward-headers-strategy=framework")}
`,
    };
  },
};

// ---------------------------------------------------------------------------
// Ruby on Rails
// ---------------------------------------------------------------------------

/**
 * database.yml'de üretim ortamı SQLite kullanıyor ama dosya yolu verilmemişse, yolu eksik veritabanlarının adları.
 * (Tek veritabanında "primary", çoklu yapıda primary/cache/queue/cable.)
 */
export function railsProductionDatabases(yml: string): string[] | null {
  if (!/adapter:\s*sqlite3/.test(yml)) return null;
  const block = yml.split(/^production:\s*$/m)[1]?.split(/^\S/m)[0];
  if (block === undefined) return null;
  const entries = [...block.matchAll(/^  (\w+):\s*$/gm)].map((m) => m[1]!);
  if (!entries.length) return /^\s+database:/m.test(block) ? null : ["primary"];
  const missing = entries.filter((name) => {
    const sub = block.split(new RegExp(`^  ${name}:\\s*$`, "m"))[1]?.split(/^  \w+:\s*$/m)[0] ?? "";
    return !/^\s+(database|url):/m.test(sub);
  });
  return missing.length ? missing : null;
}

export const rails: Framework = {
  id: "rails",
  name: "Ruby on Rails",
  language: "Ruby",
  category: "Ruby",
  description: "Bundler ile kurulur, varlıklar derlenir, Puma ile çalışır.",
  defaultPort: 3000,
  fields: [{ key: "migrate", label: "Her deploy'da db:prepare çalıştır", type: "toggle" }],
  envHints: [
    { key: "SECRET_KEY_BASE", description: "Rails gizli anahtarı (veya RAILS_MASTER_KEY).", auto: "secret", required: true },
    { key: "RAILS_ENV", description: "Çalışma ortamı.", value: "production", required: true },
    { key: "RAILS_LOG_TO_STDOUT", description: "Logların panelde görünmesi için.", value: "1" },
    { key: "DATABASE_URL", description: "Veritabanı bağlantı adresi." },
  ],
  steps: ["bundle install (development/test hariç) çalışır.", "assets:precompile çalışır.", "Başlarken db:prepare, ardından Puma başlar."],
  detect: (repo) => (repo.has("Gemfile") && repo.has("config/application.rb") ? { score: 90, reason: "Rails uygulaması bulundu" } : null),
  autoConfig(repo) {
    // Rails 8 yeni projelerde üretim SQLite dosyalarının yolunu bilerek boş bırakır; panel kalıcı bir klasöre bağlar.
    const prod = railsProductionDatabases(repo.read("config/database.yml"));
    if (!prod) return {};
    const env: Record<string, string> = {};
    for (const name of prod) env[name === "primary" ? "DATABASE_URL" : `${name.toUpperCase()}_DATABASE_URL`] = `sqlite3:storage/production${name === "primary" ? "" : `_${name}`}.sqlite3`;
    return { env, volumes: [{ name: "storage", path: "/app/storage" }], notes: ["Üretim SQLite dosyaları kalıcı storage/ klasörüne bağlandı."] };
  },
  build(repo, opts) {
    const v = (repo.read(".ruby-version").trim().match(/\d+\.\d+/)?.[0]) ?? "3.3";
    const start = [flag(opts.migrate, true) ? "bundle exec rails db:prepare" : "", "exec bundle exec rails server -b 0.0.0.0 -p $PORT"].filter(Boolean).join(" && ");
    return {
      port: 3000,
      dockerfile: `FROM ruby:${v}-slim
${DEBIAN_ARCHIVE_FIX}
RUN apt-get update && apt-get install -y --no-install-recommends build-essential git libpq-dev libyaml-dev pkg-config curl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV RAILS_ENV=production BUNDLE_WITHOUT="development:test" BUNDLE_DEPLOYMENT=1 RAILS_SERVE_STATIC_FILES=1 PORT=3000
COPY Gemfile Gemfile.lock ./
RUN bundle install
COPY . .
RUN SECRET_KEY_BASE_DUMMY=1 bundle exec rails assets:precompile || true
EXPOSE 3000
${shCmd(start)}
`,
    };
  },
};

// ---------------------------------------------------------------------------
// Statik site ve Dockerfile
// ---------------------------------------------------------------------------

export const staticSite: Framework = {
  id: "static",
  name: "Statik site (HTML/CSS/JS)",
  language: "HTML",
  category: "Statik",
  description: "Dosyalar derlenmeden Caddy ile sıkıştırılarak sunulur.",
  defaultPort: 80,
  fields: [
    { key: "root", label: "Kök klasör", type: "text", placeholder: ".", hint: "index.html'in bulunduğu klasör" },
    { key: "spa", label: "Bilinmeyen yollar index.html'e gitsin", type: "toggle" },
  ],
  envHints: [],
  steps: ["Kök klasördeki dosyalar imaja kopyalanır.", "Caddy ile gzip/zstd sıkıştırmalı sunulur."],
  detect: (repo) => (repo.has("index.html") ? { score: 20, reason: "index.html bulundu", options: { root: "." } } : null),
  build(_repo, opts) {
    const root = opt(opts.root, ".");
    return {
      port: 80,
      dockerfile: `FROM caddy:2.11-alpine\nCOPY ${root} /srv\nCOPY Caddyfile.xudbin /etc/caddy/Caddyfile\nRUN rm -f /srv/Caddyfile.xudbin /srv/Dockerfile.xudbin\nEXPOSE 80\n`,
      files: { "Caddyfile.xudbin": staticCaddyfile(flag(opts.spa, false)) },
    };
  },
};

export const dockerfileFw: Framework = {
  id: "dockerfile",
  name: "Dockerfile",
  language: "Docker",
  category: "Diğer",
  description: "Repodaki kendi Dockerfile'ın kullanılır; tam kontrol sende.",
  defaultPort: 3000,
  fields: [{ key: "dockerfilePath", label: "Dockerfile yolu", type: "text", placeholder: "Dockerfile" }],
  envHints: [],
  steps: ["Repodaki Dockerfile ile imaj derlenir.", "Port ayarını Dockerfile'daki EXPOSE ile aynı yap."],
  detect: (repo) => (repo.has("Dockerfile") ? { score: 100, reason: "Repoda Dockerfile var" } : null),
  build() {
    throw new Error("Dockerfile türü özel olarak işlenir");
  },
};
