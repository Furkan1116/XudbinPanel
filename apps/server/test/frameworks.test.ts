import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { mergeEnvText, parseEnv } from "../src/services/deploy.js";
import { detectFrameworks, getFramework, missingDefaultEnv, openRepo } from "../src/services/frameworks/index.js";
import { railsProductionDatabases } from "../src/services/frameworks/others.js";
import { settingEnvName } from "../src/services/frameworks/python.js";

function repo(files: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xb-fw-"));
  for (const [f, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), c);
  }
  return root;
}

test("Django settings.py'nin okuduğu değişken adı bulunur", () => {
  assert.equal(settingEnvName('ALLOWED_HOSTS = os.environ.get("HOSTS", "").split(",")', "ALLOWED_HOSTS"), "HOSTS");
  assert.equal(settingEnvName('ALLOWED_HOSTS = env_list("DJANGO_ALLOWED_HOSTS")', "ALLOWED_HOSTS"), "DJANGO_ALLOWED_HOSTS");
  assert.equal(settingEnvName("SECRET_KEY = os.environ['MY_SECRET']", "SECRET_KEY"), "MY_SECRET");
  assert.equal(settingEnvName('ALLOWED_HOSTS = ["example.com"]', "ALLOWED_HOSTS"), undefined);
});

test("Django için eksik değişkenler doğru adlarla eklenir", () => {
  const fw = getFramework("django")!;
  const add = missingDefaultEnv(fw, {}, (n) => "x".repeat(n), { DJANGO_ALLOWED_HOSTS: "ALLOWED_HOSTS" });
  assert.deepEqual(add.map((e) => e.key).sort(), ["ALLOWED_HOSTS", "CSRF_TRUSTED_ORIGINS", "DJANGO_DEBUG", "DJANGO_SECRET_KEY"]);
  assert.equal(add.find((e) => e.key === "ALLOWED_HOSTS")?.value, "{{XUDBIN_DOMAINS}}");
});

test("PHP sürümü composer.lock'taki paketlere göre seçilir", () => {
  const root = repo({
    artisan: "",
    "composer.json": JSON.stringify({ require: { php: "^8.3" } }),
    "composer.lock": JSON.stringify({ packages: [{ require: { php: ">=8.4.1" } }, { require: { php: "^8.2|^8.3|^8.4|^8.5" } }, { require: { php: "8.1 - 8.5" } }] }),
  });
  assert.equal(detectFrameworks(root).matches[0]?.options.phpVersion, "8.4");
});

test("Rails üretim SQLite yolları eksikse bulunur", () => {
  const multi = "default: &default\n  adapter: sqlite3\nproduction:\n  primary:\n    <<: *default\n  cache:\n    <<: *default\n    migrations_paths: db/cache_migrate\n";
  assert.deepEqual(railsProductionDatabases(multi), ["primary", "cache"]);
  assert.equal(railsProductionDatabases("default: &default\n  adapter: sqlite3\nproduction:\n  <<: *default\n  database: storage/p.sqlite3\n"), null);
  assert.equal(railsProductionDatabases("default: &default\n  adapter: postgresql\nproduction:\n  <<: *default\n"), null);
  const rails = getFramework("rails")!;
  const root = repo({ Gemfile: "", "config/application.rb": "", "config/database.yml": multi });
  const auto = rails.autoConfig!(openRepo(root), {});
  assert.deepEqual(auto.env, { DATABASE_URL: "sqlite3:storage/production.sqlite3", CACHE_DATABASE_URL: "sqlite3:storage/production_cache.sqlite3" });
});

test("framework algılama", () => {
  const cases: [Record<string, string>, string][] = [
    [{ "package.json": JSON.stringify({ dependencies: { next: "15" } }) }, "nextjs"],
    [{ "package.json": JSON.stringify({ dependencies: { express: "4" } }) }, "node"],
    [{ "deno.json": "{}" }, "deno"],
    [{ "go.mod": "module x\n\ngo 1.24\n" }, "go"],
    [{ "Cargo.toml": '[package]\nname="a"' }, "rust"],
    [{ "requirements.txt": "fastapi\n", "main.py": "app = FastAPI()" }, "fastapi"],
    [{ "index.php": "<?php" }, "php"],
    [{ "index.html": "<h1>" }, "static"],
    [{ Dockerfile: "FROM alpine" }, "dockerfile"],
  ];
  for (const [files, id] of cases) assert.equal(detectFrameworks(repo(files)).matches[0]?.id, id, id);
});

test("env metni birleştirme ve ayrıştırma", () => {
  assert.equal(mergeEnvText("# c\nA=1\nB=2\n\n", { B: "3", C: "4" }), "# c\nA=1\nB=3\nC=4\n");
  assert.deepEqual(parseEnv('A="x y"\n# yorum\nB=2'), { A: "x y", B: "2" });
});
