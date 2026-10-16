import fs from "node:fs";

/** Panelin sürümü: kök package.json'dan (Docker imajında /app/package.json). */
function read(): string {
  for (const p of [new URL("../../../../package.json", import.meta.url), new URL("../../../package.json", import.meta.url)]) {
    try {
      const v = (JSON.parse(fs.readFileSync(p, "utf8")) as { version?: string }).version;
      if (v) return v;
    } catch {}
  }
  return "0.0.0";
}

export const VERSION = read();
