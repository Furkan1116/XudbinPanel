import assert from "node:assert/strict";
import { test } from "node:test";
import { diagnose } from "../src/services/doctor.js";

const ids = (lines: string[], ctx: Partial<Parameters<typeof diagnose>[1]> = {}) =>
  diagnose(lines, { framework: "node", env: {}, hosts: ["a.example.com"], ...ctx }).map((f) => f.id);

test("npm arborist hatası Node 24 düzeltmesi önerir", () => {
  const f = diagnose(["npm error Cannot read properties of null (reading 'edgesOut')"], { framework: "nuxt", env: {}, hosts: [] });
  assert.equal(f[0]?.id, "npm-arborist");
  assert.deepEqual(f[0]?.fix?.buildOptions, { nodeVersion: "24" });
});

test("composer PHP sürüm uyuşmazlığı doğru sürümü önerir", () => {
  const f = diagnose(["    - symfony/string v8.1.9 requires php >=8.4.1 -> your php version (8.3.35) does not satisfy that requirement."], { framework: "laravel", env: {}, hosts: [] });
  assert.equal(f[0]?.id, "php-version");
  assert.deepEqual(f[0]?.fix?.buildOptions, { phpVersion: "8.4" });
});

test("Rails veritabanı yolu eksik", () => {
  assert.deepEqual(ids(["ArgumentError: No database file specified. Missing argument: database (ArgumentError)"], { framework: "rails" }), ["rails-sqlite"]);
});

test("Django DisallowedHost alan adı düzeltmesi önerir", () => {
  const f = diagnose(["django.core.exceptions.DisallowedHost: Invalid HTTP_HOST header: 'x.example.com'."], { framework: "django", env: {}, hosts: ["x.example.com"] });
  assert.equal(f[0]?.id, "django-allowed-hosts");
  assert.ok(f[0]?.fix?.env);
});

test("Django 400, yanlış ALLOWED_HOSTS değerine alan adlarını ekler", () => {
  const f = diagnose([], { framework: "django", env: { ALLOWED_HOSTS: "eski.com" }, hosts: ["x.example.com"], status: 400 });
  assert.deepEqual(f[0]?.fix?.env, { ALLOWED_HOSTS: "eski.com,{{XUDBIN_DOMAINS}}" });
});

test("ortam değişkeni kuralı sıradan kelimeleri değişken sanmaz", () => {
  assert.deepEqual(ids(["the environment variable is not set"]), []);
  assert.deepEqual(ids(["Error: DATABASE_URL is not set"]), ["env-DATABASE_URL"]);
});

test("çıkış kodu 137 bellek yetmezliği olarak açıklanır", () => {
  assert.deepEqual(ids(["x"], { exitCode: 137 }), ["oom"]);
});
