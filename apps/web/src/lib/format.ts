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
  if (d > 0) return h > 0 ? `${d} gün ${h} saat` : `${d} gün`;
  if (h > 0) return m > 0 ? `${h} saat ${m} dakika` : `${h} saat`;
  return m > 0 ? `${m} dakika` : "az";
}

export const percent = (used: number, total: number) => (total > 0 ? (used / total) * 100 : 0);
