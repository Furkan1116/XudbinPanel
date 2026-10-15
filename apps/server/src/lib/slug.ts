import { randomAlnum } from "./crypto.js";

const TR: Record<string, string> = { ç: "c", ğ: "g", ı: "i", ö: "o", ş: "s", ü: "u" };

/** "Benim Blog'um" -> "benim-blogum-x7k2". Konteyner, imaj ve alan adı olarak kullanılır. */
export function makeSlug(name: string) {
  const base = name
    .toLocaleLowerCase("tr")
    .replace(/[çğıöşü]/g, (c) => TR[c] ?? c)
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24) || "app";
  return `${base}-${randomAlnum(4).toLowerCase()}`;
}
