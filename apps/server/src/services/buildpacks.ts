import fs from "node:fs";
import path from "node:path";

/**
 * Dockerfile'ı olmayan projeler için proje türünü tanıyıp Dockerfile üretir.
 * Amaç her şeyi kapsamak değil; yaygın durumları sağlam ve okunabilir şekilde çözmek.
 * Üretilen Dockerfile deploy logunda gösterilir, kullanıcı isterse repoya kopyalayıp özelleştirir.
 */
export type Detected = { kind: string; dockerfile: string; port: number };

const exists = (dir: string, f: string) => fs.existsSync(path.join(dir, f));
const read = (dir: string, f: string) => fs.readFileSync(path.join(dir, f), "utf8");

export function detectProject(dir: string): Detected | null {
  if (exists(dir, "package.json")) return node(dir);
  if (exists(dir, "manage.py")) return django(dir);
  if (exists(dir, "requirements.txt") || exists(dir, "pyproject.toml")) return python(dir);
  if (exists(dir, "go.mod")) return go();
  if (exists(dir, "index.html")) return staticSite(".");
  return null;
}

function node(dir: string): Detected {
  const pkg = JSON.parse(read(dir, "package.json")) as { scripts?: Record<string, string>; dependencies?: Record<string, string>; engines?: { node?: string } };
  const scripts = pkg.scripts ?? {};
  const deps = { ...(pkg.dependencies ?? {}) };
  const pm = exists(dir, "pnpm-lock.yaml") ? "pnpm" : exists(dir, "yarn.lock") ? "yarn" : exists(dir, "bun.lockb") || exists(dir, "bun.lock") ? "bun" : "npm";
  const install = {
    npm: exists(dir, "package-lock.json") ? "npm ci" : "npm install",
    pnpm: "corepack enable && pnpm install --frozen-lockfile",
    yarn: "corepack enable && yarn install --frozen-lockfile",
    bun: "npm i -g bun && bun install",
  }[pm];
  const run = (s: string) => ({ npm: `npm run ${s}`, pnpm: `pnpm ${s}`, yarn: `yarn ${s}`, bun: `bun run ${s}` })[pm];
  // package.json "engines.node" (ör. "22.x || 24.x") belirtilmişse desteklenen en yüksek ana sürümü kullan.
  const majors = [...(pkg.engines?.node ?? "").matchAll(/(\d{2})/g)].map((m) => Number(m[1])).filter((n) => n >= 18 && n <= 30);
  const base = `node:${majors.length ? Math.max(...majors) : 22}-alpine`;

  // Sunucu tarafı olmayan ön yüz projesi (Vite, CRA...): derle ve statik olarak sun.
  if (!scripts.start && scripts.build && !deps.next) {
    const out = deps["react-scripts"] ? "build" : exists(dir, "angular.json") ? "dist/browser" : "dist";
    return {
      kind: "Node (statik derleme)",
      port: 80,
      dockerfile: `FROM ${base} AS build
WORKDIR /app
COPY . .
RUN ${install}
RUN ${run("build")}

FROM caddy:2.11-alpine
COPY --from=build /app/${out} /srv
EXPOSE 80
CMD ["caddy", "file-server", "--root", "/srv", "--listen", ":80"]
`,
    };
  }

  const isNext = Boolean(deps.next);
  return {
    kind: isNext ? "Next.js" : "Node.js",
    port: 3000,
    dockerfile: `FROM ${base}
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
COPY . .
RUN NODE_ENV=development ${install}
${scripts.build ? `RUN ${run("build")}\n` : ""}EXPOSE 3000
CMD ["sh", "-c", "${scripts.start ? run("start") : "node index.js"}"]
`,
  };
}

function django(dir: string): Detected {
  // settings modülünü manage.py içinden bul: os.environ.setdefault("DJANGO_SETTINGS_MODULE", "proje.settings")
  const manage = read(dir, "manage.py");
  const settings = manage.match(/DJANGO_SETTINGS_MODULE["']\s*,\s*["']([\w.]+)["']/)?.[1] ?? "config.settings";
  const project = settings.split(".")[0];
  return {
    kind: "Django",
    port: 8000,
    dockerfile: `FROM python:3.12-slim
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PORT=8000
COPY . .
RUN pip install --no-cache-dir ${exists(dir, "requirements.txt") ? "-r requirements.txt" : "."} gunicorn whitenoise
RUN python manage.py collectstatic --noinput || true
EXPOSE 8000
CMD ["sh", "-c", "python manage.py migrate --noinput && gunicorn ${project}.wsgi:application --bind 0.0.0.0:8000 --workers 3"]
`,
  };
}

function python(dir: string): Detected {
  const reqs = exists(dir, "requirements.txt") ? read(dir, "requirements.txt").toLowerCase() : read(dir, "pyproject.toml").toLowerCase();
  const entry = ["main.py", "app.py", "server.py"].find((f) => exists(dir, f))?.replace(".py", "") ?? "main";
  const cmd = reqs.includes("fastapi")
    ? `uvicorn ${entry}:app --host 0.0.0.0 --port 8000`
    : `gunicorn ${entry}:app --bind 0.0.0.0:8000 --workers 3`;
  return {
    kind: reqs.includes("fastapi") ? "FastAPI" : reqs.includes("flask") ? "Flask" : "Python",
    port: 8000,
    dockerfile: `FROM python:3.12-slim
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PORT=8000
COPY . .
RUN pip install --no-cache-dir ${exists(dir, "requirements.txt") ? "-r requirements.txt" : "."} gunicorn uvicorn
EXPOSE 8000
CMD ["sh", "-c", "${cmd}"]
`,
  };
}

function go(): Detected {
  return {
    kind: "Go",
    port: 8080,
    dockerfile: `FROM golang:1.24-alpine AS build
WORKDIR /src
COPY . .
RUN CGO_ENABLED=0 go build -o /out/app .

FROM alpine:3.21
RUN apk add --no-cache ca-certificates
COPY --from=build /out/app /app
ENV PORT=8080
EXPOSE 8080
CMD ["/app"]
`,
  };
}

export function staticSite(root: string): Detected {
  return {
    kind: "Statik site",
    port: 80,
    dockerfile: `FROM caddy:2.11-alpine
COPY ${root} /srv
EXPOSE 80
CMD ["caddy", "file-server", "--root", "/srv", "--listen", ":80"]
`,
  };
}
