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

test("nextRun: seyrek ifadeler olay döngüsünü kilitlemez ve 29 Şubat bulunur", () => {
  const from = Date.UTC(2026, 9, 27, 12, 0);
  const s = performance.now();
  assert.equal(nextRun("0 0 29 2 *", from, "UTC"), Date.UTC(2028, 1, 29, 0, 0));
  assert.equal(nextRun("0 3 1 1 *", from, "Europe/Istanbul"), Date.UTC(2027, 0, 1, 0, 0));
  assert.equal(nextRun("0 0 31 2 *", from, "UTC"), null); // hiç gelmeyen gün
  assert.ok(performance.now() - s < 500, "toplam hesap yarım saniyenin altında kalmalı");
});

test("nextRun: atlamalı arama, dakika dakika aramayla aynı sonucu verir (yaz saati geçişleri dahil)", () => {
  const brute = (expr: string, from: number, tz: string) => {
    const c = parseCron(expr);
    let t = Math.floor(from / 60_000) * 60_000 + 60_000;
    for (let i = 0; i < 60 * 24 * 60; i++, t += 60_000) if (cronMatches(c, t, tz)) return t;
    return null;
  };
  const exprs = ["30 2 * * *", "0 0 * * *", "59 23 * * *", "15 1,3 * * 0", "0 0 1 * *", "*/20 */7 * * *", "0 12 15 * 1", "45 2 * * 0"];
  const zones = ["UTC", "Europe/Istanbul", "Europe/Berlin", "America/New_York", "Asia/Kolkata", "Australia/Lord_Howe"];
  // Yaz saati geçişlerinin hemen öncesi + rastgele anlar.
  const starts = [Date.UTC(2026, 2, 28, 22, 37), Date.UTC(2026, 2, 7, 23, 59), Date.UTC(2026, 9, 24, 22, 10), Date.UTC(2026, 10, 1, 4, 30), Date.UTC(2026, 3, 4, 14, 0)];
  let seed = 7;
  for (let i = 0; i < 5; i++) starts.push(Date.UTC(2026, 0, 1) + ((seed = (seed * 48271) % 2147483647) % (365 * 24 * 60)) * 60_000);
  for (const e of exprs) for (const tz of zones) for (const f of starts) assert.equal(nextRun(e, f, tz), brute(e, f, tz), `${e} ${tz} ${new Date(f).toISOString()}`);
});
