import type { GithubAppConfig } from "../services/github-app.js";
import { db } from "../db.js";

export type Settings = {
  panelDomain: string;
  panelHttps: boolean;
  autoBanEnabled: boolean;
  autoBanThreshold: number;   // pencere içinde kaç engellenen istek
  autoBanWindowMin: number;
  autoBanDurationH: number;
  /** Uzak yedek hedefi (S3 uyumlu); secretKey şifreli saklanır. */
  backupS3: { endpoint: string; region: string; bucket: string; accessKey: string; secretKey: string; prefix: string } | null;
  /** Panel yedeğinin şifresi (panelin anahtarıyla şifreli). Boşsa panel yedeği alınmaz. */
  panelBackupPassphrase: string;
  panelBackupIntervalH: number;
  panelBackupKeep: number;
  lastPanelBackupAt: number | null;
  /** Veritabanı yedekleri en fazla bu sıklıkta geçici bir konteynere geri yüklenip doğrulanır. */
  verifyBackupsEveryH: number;
  /** Her başarılı deploy'dan sonra imaj Trivy ile taranır. */
  imageScanEnabled: boolean;
  /** Analitik gün sınırları ve grafikler için saat dilimi. */
  timezone: string;
  analyticsSalt: { day: string; value: string } | null;
  geoDbMonth: string | null;
  uptimeEnabled: boolean;
  /** OpenID Connect ile giriş; clientSecret şifreli. */
  oidc: { issuer: string; clientId: string; clientSecret: string; label: string; autoCreate: boolean; allowedDomains: string; linkExisting?: boolean } | null;
  githubApp: GithubAppConfig | null;
};

const DEFAULTS: Settings = {
  panelDomain: "",
  panelHttps: true,
  autoBanEnabled: true,
  autoBanThreshold: 30,
  autoBanWindowMin: 10,
  autoBanDurationH: 24,
  backupS3: null,
  panelBackupPassphrase: "",
  panelBackupIntervalH: 24,
  panelBackupKeep: 7,
  lastPanelBackupAt: null,
  verifyBackupsEveryH: 24,
  imageScanEnabled: true,
  timezone: "Europe/Istanbul",
  analyticsSalt: null,
  geoDbMonth: null,
  uptimeEnabled: true,
  oidc: null,
  githubApp: null,
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
