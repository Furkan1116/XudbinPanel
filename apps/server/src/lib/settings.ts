import { db } from "../db.js";

export type Settings = {
  panelDomain: string;
  panelHttps: boolean;
  autoBanEnabled: boolean;
  autoBanThreshold: number;   // pencere içinde kaç engellenen istek
  autoBanWindowMin: number;
  autoBanDurationH: number;
};

const DEFAULTS: Settings = {
  panelDomain: "",
  panelHttps: true,
  autoBanEnabled: true,
  autoBanThreshold: 30,
  autoBanWindowMin: 10,
  autoBanDurationH: 24,
};

export function getSettings(): Settings {
  const rows = db.prepare("SELECT key, value FROM settings").all() as { key: string; value: string }[];
  const stored = Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value)]));
  return { ...DEFAULTS, ...stored };
}

export function updateSettings(patch: Partial<Settings>) {
  const stmt = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) stmt.run(k, JSON.stringify(v));
  return getSettings();
}
