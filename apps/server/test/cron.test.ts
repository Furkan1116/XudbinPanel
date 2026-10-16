import assert from "node:assert/strict";
import { test } from "node:test";
import { cronMatches, nextRun, parseCron } from "../src/lib/cron.js";

const at = (iso: string) => Date.parse(iso);

test("cron ayrıştırma ve eşleşme", () => {
  const tz = "UTC";
  assert.ok(cronMatches(parseCron("*/15 * * * *"), at("2026-10-16T10:30:00Z"), tz));
  assert.ok(!cronMatches(parseCron("*/15 * * * *"), at("2026-10-16T10:31:00Z"), tz));
  assert.ok(cronMatches(parseCron("0 3 * * *"), at("2026-10-16T03:00:00Z"), tz));
  assert.ok(cronMatches(parseCron("0 9 * * 1-5"), at("2026-10-16T09:00:00Z"), tz)); // Cuma
  assert.ok(!cronMatches(parseCron("0 9 * * 1-5"), at("2026-10-17T09:00:00Z"), tz)); // Cumartesi
  assert.ok(cronMatches(parseCron("0 0 * * 7"), at("2026-10-18T00:00:00Z"), tz)); // Pazar = 7
  assert.ok(cronMatches(parseCron("@daily"), at("2026-10-16T00:00:00Z"), tz));
  assert.ok(cronMatches(parseCron("30 2 1,15 * *"), at("2026-10-15T02:30:00Z"), tz));
  assert.throws(() => parseCron("* * *"));
  assert.throws(() => parseCron("61 * * * *"));
  assert.throws(() => parseCron("*/0 * * * *"));
});

test("saat dilimi ve sonraki çalışma", () => {
  // İstanbul UTC+3: yerel 03:00 = 00:00 UTC
  assert.ok(cronMatches(parseCron("0 3 * * *"), at("2026-10-16T00:00:00Z"), "Europe/Istanbul"));
  assert.equal(nextRun("0 3 * * *", at("2026-10-16T00:00:00Z"), "UTC"), at("2026-10-16T03:00:00Z"));
  assert.equal(nextRun("*/5 * * * *", at("2026-10-16T10:02:30Z"), "UTC"), at("2026-10-16T10:05:00Z"));
});
