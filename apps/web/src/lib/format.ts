import { getLang, locale, t } from "./i18n";

export function formatBytes(bytes: number, digits = 1) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (bytes >= 1024 && i < units.length - 1) {
    bytes /= 1024;
    i++;
  }
  return `${bytes.toFixed(i === 0 ? 0 : digits)} ${units[i]}`;
}

export function formatUptime(seconds: number) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return h > 0 ? t("{d} gün {h} saat", { d, h }) : t("{d} gün", { d });
  if (h > 0) return m > 0 ? t("{h} saat {m} dakika", { h, m }) : t("{h} saat", { h });
  return m > 0 ? t("{m} dakika", { m }) : t("az");
}

export const percent = (used: number, total: number) => (total > 0 ? (used / total) * 100 : 0);

const rtf = new Intl.RelativeTimeFormat(getLang(), { numeric: "auto" });

/** "3 dakika önce", "dün" gibi göreli zaman. */
export function timeAgo(ms: number) {
  const diff = (ms - Date.now()) / 1000;
  const abs = Math.abs(diff);
  if (abs < 45) return t("az önce");
  if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), "hour");
  if (abs < 86400 * 30) return rtf.format(Math.round(diff / 86400), "day");
  return new Date(ms).toLocaleDateString(locale());
}

export function duration(start: number, end: number | null) {
  const s = Math.round(((end ?? Date.now()) - start) / 1000);
  return s < 60 ? t("{s} sn", { s }) : t("{m} dk {s} sn", { m: Math.floor(s / 60), s: s % 60 });
}

export const dateTime = (ms: number) =>
  new Date(ms).toLocaleString(locale(), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
