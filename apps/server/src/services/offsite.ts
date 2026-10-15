import { decrypt } from "../lib/crypto.js";
import { getSettings } from "../lib/settings.js";
import type { S3Target } from "../lib/s3.js";

/** Ayarlarda tanımlı uzak yedek hedefi; tanımlı değilse null. */
export function offsiteTarget(): S3Target | null {
  const s = getSettings().backupS3;
  if (!s?.endpoint || !s.bucket || !s.accessKey || !s.secretKey) return null;
  return { ...s, secretKey: decrypt(s.secretKey) };
}
