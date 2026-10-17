import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { removeEscapingSymlinks, writeInside } from "../src/lib/paths.js";

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "xb-paths-"));
}

test("writeInside kısayolu izlemez, dış dosyayı ezmez (K4)", () => {
  const root = tmp();
  const outside = tmp();
  const victim = path.join(outside, "panel-dosyasi.js");
  fs.writeFileSync(victim, "ORIJINAL");
  fs.symlinkSync(victim, path.join(root, ".env"));
  writeInside(root, ".env", "A='1'\n", 0o600);
  assert.equal(fs.readFileSync(victim, "utf8"), "ORIJINAL");
  assert.ok(!fs.lstatSync(path.join(root, ".env")).isSymbolicLink());
  assert.equal(fs.readFileSync(path.join(root, ".env"), "utf8"), "A='1'\n");
  // Dışarıyı gösteren klasör kısayolu üzerinden de yazılamaz.
  fs.symlinkSync(outside, path.join(root, "kacis"));
  assert.throws(() => writeInside(root, "kacis/x.txt", "x"));
  assert.throws(() => writeInside(root, "../x.txt", "x"));
});

test("removeEscapingSymlinks yalnız dışarıyı gösteren kısayolları siler", () => {
  const root = tmp();
  const outside = tmp();
  fs.writeFileSync(path.join(root, "a.txt"), "a");
  fs.symlinkSync(path.join(root, "a.txt"), path.join(root, "ic"));
  fs.symlinkSync(path.join(outside), path.join(root, "dis"));
  fs.symlinkSync("/olmayan/yol", path.join(root, "kirik"));
  fs.mkdirSync(path.join(root, "alt"));
  fs.symlinkSync("../../", path.join(root, "alt", "yukari"));
  assert.equal(removeEscapingSymlinks(root), 3);
  assert.ok(fs.existsSync(path.join(root, "ic")));
  assert.ok(!fs.existsSync(path.join(root, "dis")));
});
