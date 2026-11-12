import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import YAML from "yaml";
import { composeConfig, composeConfigIssues, composeHostAccessIssues } from "../src/services/compose-policy.js";
import { TEMPLATES } from "../src/services/templates.js";

/** Compose politikası ham YAML yerine Compose'un yorumladığı hâli denetler (değişken açma, << birleştirme). */
const ATTACK = `x-panel: &panel
  external: true
  name: xudbin_xudbin-data
services:
  web:
    image: alpine
    build: {context: "./\${A:-..}/\${A:-..}"}
    volumes: ["./\${A:-..}/\${A:-..}:/h", "veri:/d"]
volumes:
  veri:
    <<: *panel
`;

const hasDocker = spawnSync(process.env.DOCKER_BIN || "docker", ["compose", "version"], { stdio: "ignore" }).status === 0;
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "xb-compose-")));

test("compose (statik): değişkenli yol ve << birleştirmesi reddedilir", () => {
  const issues = composeHostAccessIssues(YAML.parse(ATTACK)).join("\n");
  assert.ok(issues.includes("build.context"), issues);
  assert.ok(issues.includes("sunucu klasörü bağlanıyor"), issues);
  assert.ok(issues.includes("<<"), issues);
  // Ad (name) ya da external doğrudan yazılmasa bile << ile gelen blok yakalanır.
  const merged = composeHostAccessIssues(YAML.parse("services:\n  web: {image: alpine, volumes: [v:/d]}\nvolumes:\n  v: {<<: {external: true, name: xudbin_xudbin-data}}"));
  assert.ok(merged.some((i) => i.includes("<<")), merged.join("\n"));
  for (const p of ["${HOME}", "./$X", "./a/${B}"]) assert.ok(composeHostAccessIssues(YAML.parse(`services:\n  web: {image: alpine, volumes: ["${p}:/h"]}`)).length, p);
  assert.ok(composeHostAccessIssues(YAML.parse("services:\n  web: {build: {context: ., dockerfile: '${D:-../../x}'}}")).some((i) => i.includes("dockerfile")));
});

test("compose (config çıktısı): mutlak yollar gerçek yolla derleme klasörüne sınırlanır", () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, "veri"));
  fs.symlinkSync("/etc", path.join(dir, "kisayol"));
  const config = (svc: object, extra: object = {}) => ({ name: "xb-a", services: { web: { image: "alpine", command: null, entrypoint: null, networks: { default: null }, ...svc } }, networks: { default: { name: "xb-a_default", ipam: {} } }, ...extra });
  const bind = (source: string) => ({ volumes: [{ type: "bind", source, target: "/h", bind: {} }] });

  // Zararsız: klasör içi bağlama ve derleme, Compose'un kendi verdiği adlar.
  assert.deepEqual(composeConfigIssues(config({ ...bind(path.join(dir, "veri")), build: { context: dir, dockerfile: "Dockerfile" }, volumes: [{ type: "volume", source: "d", target: "/d", volume: {} }] }, { volumes: { d: { name: "xb-a_d" } } }), dir, "xb-a"), []);
  assert.deepEqual(composeConfigIssues(config(bind(path.join(dir, "yeni", "klasor"))), dir, "xb-a"), []);

  // Klasör dışı: üst klasör, kardeş klasör ön eki, klasör dışını gösteren kısayol.
  for (const src of [path.dirname(dir), "/data", `${dir}-baska`, path.join(dir, "kisayol"), path.join(dir, "kisayol", "x")]) {
    assert.ok(composeConfigIssues(config(bind(src)), dir, "xb-a").some((i) => i.includes("sunucu klasörü")), src);
  }
  assert.ok(composeConfigIssues(config({ build: { context: path.dirname(dir), dockerfile: "Dockerfile" } }), dir, "xb-a").some((i) => i.includes("build.context")));
  assert.ok(composeConfigIssues(config({ build: { context: dir, dockerfile: "/data/secret.key" } }), dir, "xb-a").some((i) => i.includes("dockerfile")));
  // Başka bir projenin ya da panelin volume'u: ad Compose'un vereceği addan farklı.
  const foreign = composeConfigIssues(config({ volumes: [{ type: "volume", source: "d", target: "/d" }] }, { volumes: { d: { name: "xudbin_xudbin-data" } } }), dir, "xb-a");
  assert.ok(foreign.some((i) => i.includes("name")), foreign.join("\n"));
});

test("compose (docker compose config): değişken ve << açıldıktan sonra kaçış yakalanır; şablonlar geçer", { skip: !hasDocker && "Docker yok" }, async () => {
  const dir = path.join(tmp(), "src");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "docker-compose.yml"), ATTACK);
  const args = (d: string) => ["compose", "-p", "xb-test", "-f", path.join(d, "docker-compose.yml")];
  const resolved = await composeConfig(process.env.DOCKER_BIN || "docker", args(dir), { cwd: dir, env: {} });
  assert.ok(resolved, "docker compose config çalışmadı");
  const issues = composeConfigIssues(resolved, dir, "xb-test").join("\n");
  for (const s of ["build.context", "sunucu klasörü bağlanıyor", "external", "name"]) assert.ok(issues.includes(s), s);

  for (const t of TEMPLATES) {
    const d = tmp();
    fs.writeFileSync(path.join(d, "docker-compose.yml"), t.compose);
    const cfg = await composeConfig(process.env.DOCKER_BIN || "docker", args(d), { cwd: d, env: {} });
    assert.ok(cfg, `${t.id}: docker compose config çalışmadı`);
    assert.deepEqual(composeConfigIssues(cfg, d, "xb-test"), [], `${t.id}: sunucu erişimi istememeli`);
  }
});

test("compose: docker çalıştırılamazsa config null döner (statik denetime düşülür)", async () => {
  assert.equal(await composeConfig("/olmayan/docker", ["compose"], { cwd: os.tmpdir(), env: {} }), null);
});
