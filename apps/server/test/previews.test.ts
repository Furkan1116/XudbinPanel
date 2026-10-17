import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { encrypt } from "../src/lib/crypto.js";
import { stripRemoteToken } from "../src/services/deploy.js";
import { buildPreviewEnv } from "../src/services/previews.js";

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
