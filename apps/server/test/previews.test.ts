import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { encrypt } from "../src/lib/crypto.js";
import { stripRemoteToken } from "../src/services/deploy.js";
import { buildPreviewEnv, pushSkipReason } from "../src/services/previews.js";

test("önizleme ortamı: üretim değişkenleri kopyalanmaz, yalnız ayrı liste + XUDBIN_PREVIEW (O10)", () => {
  // Üretim env'i ayrı alanda; buildPreviewEnv yalnız preview_env'e bakar.
  const parent = { env: encrypt("DATABASE_URL=prod\nSECRET_KEY=hunter2"), preview_env: encrypt("DATABASE_URL=test\n") };
  const env = buildPreviewEnv(parent);
  assert.equal(env, "DATABASE_URL=test\nXUDBIN_PREVIEW=1\n");
  assert.ok(!env.includes("hunter2") && !env.includes("prod"));
  assert.equal(buildPreviewEnv({ preview_env: null }), "XUDBIN_PREVIEW=1\n");
});

test("git token'ı klonlamadan sonra .git/config'te kalmaz (O10)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xb-git-"));
  try {
    execFileSync("git", ["init", "-q", dir]);
    execFileSync("git", ["-C", dir, "remote", "add", "origin", "https://x-access-token:SIR123@example.com/o/r.git"]);
    assert.ok(fs.readFileSync(path.join(dir, ".git/config"), "utf8").includes("SIR123"));
    await stripRemoteToken(dir, "https://example.com/o/r.git", "SIR123");
    const cfg = fs.readFileSync(path.join(dir, ".git/config"), "utf8");
    assert.ok(!cfg.includes("SIR123"));
    assert.ok(cfg.includes("https://example.com/o/r.git"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("push webhook'u: ping ve push olmayan olaylar deploy başlatmaz, düz istek eskisi gibi deploy eder", () => {
  const h = (headers: Record<string, string>) => (n: string) => headers[n];
  const push = { ref: "refs/heads/main", head_commit: { message: "x" } };
  // GitHub webhook'u eklenince gelen ping (ref yok) deploy başlatmamalı.
  assert.match(pushSkipReason(h({ "x-github-event": "ping" }), { zen: "z", hook_id: 1 }, "main")!, /ping/);
  assert.match(pushSkipReason(h({ "x-github-event": "pull_request" }), { action: "labeled" }, "main")!, /pull_request/);
  assert.match(pushSkipReason(h({ "x-gitea-event": "create" }), {}, "main")!, /create/);
  assert.match(pushSkipReason(h({ "x-gitlab-event": "Tag Push Hook" }), { ref: "refs/tags/v1" }, "main")!, /Tag Push Hook/);
  assert.match(pushSkipReason(h({ "x-github-event": "push" }), { ...push, deleted: true }, "main")!, /Silinen/);
  assert.match(pushSkipReason(h({ "x-github-event": "push" }), { ref: "refs/heads/dev" }, "main")!, /main/);
  assert.equal(pushSkipReason(h({ "x-github-event": "push" }), push, "main"), null);
  assert.equal(pushSkipReason(h({ "x-gitlab-event": "Push Hook" }), push, "main"), null);
  // Olay başlığı olmayan düz istek (CI'dan curl) deploy eder.
  assert.equal(pushSkipReason(h({}), {}, "main"), null);
});
