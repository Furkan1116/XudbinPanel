import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LIMITS, SourceTree } from "../src/services/preflight/tree.js";

test("süre sınırı dolunca dosya içeriği okunmaz, rapor eksik işaretlenir", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xb-preflight-sure-"));
  fs.writeFileSync(path.join(dir, "a.txt"), "merhaba");
  const tree = SourceTree.scan(dir, { ...LIMITS, timeMs: 5 });
  assert.equal(tree.text("a.txt"), "merhaba");
  const until = Date.now() + 20;
  while (Date.now() < until) {
    /* süre dolsun */
  }
  assert.equal(tree.text("a.txt"), null);
  assert.equal(tree.readLimited, true);
  fs.rmSync(dir, { recursive: true, force: true });
});
