/**
 * Beş alanlı cron ifadesi: dakika saat ayın-günü ay haftanın-günü. Desteklenen: *, sayı, a-b, a,b,c, *\/n, a-b/n
 * ve kısaltmalar (@hourly, @daily, @weekly, @monthly, @yearly). Zaman, verilen saat diliminde değerlendirilir.
 */
const ALIASES: Record<string, string> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};
const RANGES: [number, number][] = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];

function field(spec: string, [min, max]: [number, number]): Set<number> {
  const out = new Set<number>();
  for (const part of spec.split(",")) {
    const [rangePart, stepPart] = part.split("/");
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1) throw new Error(`Geçersiz adım: ${part}`);
    let lo: number;
    let hi: number;
    if (rangePart === "*") [lo, hi] = [min, max];
    else if (rangePart!.includes("-")) [lo, hi] = rangePart!.split("-").map(Number) as [number, number];
    else {
      lo = Number(rangePart);
      hi = stepPart === undefined ? lo : max;
    }
    if (![lo, hi].every((n) => Number.isInteger(n) && n >= min && n <= max) || lo > hi) throw new Error(`Geçersiz değer: ${part}`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

export type Cron = { minutes: Set<number>; hours: Set<number>; days: Set<number>; months: Set<number>; weekdays: Set<number>; anyDay: boolean; anyWeekday: boolean };

export function parseCron(expr: string): Cron {
  const e = ALIASES[expr.trim()] ?? expr.trim();
  const parts = e.split(/\s+/);
  if (parts.length !== 5) throw new Error("Cron ifadesi 5 alandan oluşmalı: dakika saat gün ay haftanın-günü");
  const [m, h, d, mo, w] = parts.map((p, i) => field(p, RANGES[i]!));
  if (w!.has(7)) w!.add(0); // 7 = Pazar
  return { minutes: m!, hours: h!, days: d!, months: mo!, weekdays: w!, anyDay: parts[2] === "*", anyWeekday: parts[4] === "*" };
}

function parts(ms: number, tz: string) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, minute: "numeric", hour: "numeric", day: "numeric", month: "numeric", weekday: "short", hourCycle: "h23" });
  const p = Object.fromEntries(f.formatToParts(ms).map((x) => [x.type, x.value]));
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday!);
  return { minute: Number(p.minute), hour: Number(p.hour), day: Number(p.day), month: Number(p.month), weekday: wd };
}

/** Verilen dakika bu ifadeye uyuyor mu (standart cron: gün ve haftanın günü ikisi de kısıtlıysa biri yeter). */
export function cronMatches(c: Cron, ms: number, tz: string) {
  const t = parts(ms, tz);
  if (!c.minutes.has(t.minute) || !c.hours.has(t.hour) || !c.months.has(t.month)) return false;
  const dayOk = c.days.has(t.day);
  const wdOk = c.weekdays.has(t.weekday);
  if (c.anyDay && c.anyWeekday) return true;
  if (c.anyDay) return wdOk;
  if (c.anyWeekday) return dayOk;
  return dayOk || wdOk;
}

/** Sonraki çalışma zamanı (en fazla 1 yıl ileri bakar). */
export function nextRun(expr: string, from: number, tz: string): number | null {
  const c = parseCron(expr);
  let t = Math.floor(from / 60_000) * 60_000 + 60_000;
  for (let i = 0; i < 366 * 24 * 60; i++, t += 60_000) if (cronMatches(c, t, tz)) return t;
  return null;
}
