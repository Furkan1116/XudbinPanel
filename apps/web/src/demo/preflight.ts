/** Demo: yayın kontrolü raporları (sunucudaki services/preflight biçimi). Metinler sunucudakiyle aynı kaynak metinlerdir. */
import type { PreflightFinding, PreflightReport } from "@/lib/api";

const NOW = Date.now();
const HOUR = 3_600_000;

const report = (findings: PreflightFinding[], extra: Partial<PreflightReport> = {}): PreflightReport => ({
  v: 1,
  at: NOW - 2 * HOUR,
  status: "done",
  source: { type: "git", commit: "9f3c2a1" },
  counts: {
    critical: findings.filter((f) => f.level === "critical").length,
    warning: findings.filter((f) => f.level === "warning").length,
    info: findings.filter((f) => f.level === "info").length,
  },
  findings,
  groups: ["secrets", "docker"],
  notes: [],
  scanned: { files: 214, truncated: false, ms: 38 },
  mode: "block",
  outcome: "passed",
  ...extra,
});

const csrf: PreflightFinding = {
  id: "django-csrf-origins",
  group: "django",
  level: "info",
  title: "CSRF_TRUSTED_ORIGINS tanımlı değil",
  detail: "Django 4 ve sonrası HTTPS arkasındaki form gönderimlerini bu liste olmadan reddedebilir (CSRF verification failed).",
  fix: 'CSRF_TRUSTED_ORIGINS = os.environ.get("CSRF_TRUSTED_ORIGINS", "").split(",") yaz; panel değeri alan adlarından doldurur.',
  file: "config/settings.py",
};

const reports: Record<number, PreflightReport> = {
  1: report(
    [
      {
        id: "next-standalone",
        group: "node",
        level: "info",
        title: 'Next.js output: "standalone" kullanılmıyor',
        detail: "Standalone çıktı imajı küçültür ve geliştirme bağımlılıklarını dışarıda bırakır; panel ikisini de çalıştırabilir.",
        fix: 'next.config dosyasına output: "standalone" ekle.',
      },
    ],
    { groups: ["secrets", "node", "docker"], notes: [{ text: "Dockerfile panel tarafından üretilecek ({name}); Dockerfile kontrolleri atlandı.", vars: { name: "Next.js" } }] },
  ),
  2: report(
    [
      {
        id: "sqlite",
        group: "secrets",
        level: "warning",
        title: "Veritabanı dosyası kaynakta: {file}",
        detail: "SQLite dosyası kullanıcı verisi ve parola özetleri taşıyabilir; her yayında yerel kopya canlının yerine geçer.",
        fix: "Dosyayı .gitignore ve .dockerignore'a ekle; canlı veritabanını kalıcı klasörde ya da panelin veritabanında tut.",
        vars: { file: "db.sqlite3" },
        file: "db.sqlite3",
      },
      {
        id: "dir-pycache",
        group: "secrets",
        level: "warning",
        title: "__pycache__ klasörü kaynakta: {file}",
        detail: "Derlenmiş Python önbelleği gereksizdir ve eski kodu taşıyabilir ({n} yerde).",
        fix: "Klasörü .gitignore ve .dockerignore'a ekle; depoya girdiyse depodan çıkar.",
        vars: { file: "config/__pycache__", n: 4 },
        file: "config/__pycache__",
      },
      csrf,
    ],
    {
      groups: ["secrets", "django", "docker"],
      outcome: "warned",
      notes: [
        { text: "Django ayarları: {file} ({origin})", vars: { file: "config/settings.py", origin: "uygulama ayarı" } },
        { text: "Dockerfile panel tarafından üretilecek ({name}); Dockerfile kontrolleri atlandı.", vars: { name: "Django" } },
      ],
    },
  ),
};

/** Durdurulan örnek yayının raporu (flask-deneme). */
export const blocked = report(
  [
    {
      id: "env-secret",
      group: "secrets",
      level: "critical",
      title: "{file} dosyasında dolu gizli değer var",
      detail: "Depoya giren .env dosyası gizli değerleri git geçmişine ve imaja taşır: {keys}. Değerler rapora yazılmadı.",
      fix: "Değerleri uygulamanın ortam değişkenlerine taşı, .env'i .gitignore ve .dockerignore'a ekle. Depoya girdiyse değerleri yenile.",
      vars: { file: ".env", keys: "SECRET_KEY, MAIL_PASSWORD" },
      file: ".env",
    },
    {
      id: "no-gitignore",
      group: "secrets",
      level: "info",
      title: ".gitignore yok",
      detail: "Depoda .gitignore olmadan .env, veritabanı dosyası ve bağımlılık klasörleri kolayca depoya girer.",
      fix: "Kullandığın dil için hazır bir .gitignore ekle (ör. github.com/github/gitignore).",
    },
  ],
  { at: NOW - 40 * 60_000, source: { type: "git", commit: "4be81d0" }, outcome: "blocked" },
);

export function preflightOf(appId: number, sourceType: string): PreflightReport | null {
  if (sourceType === "image") return null;
  if (appId === 9) return { ...blocked, deploymentId: undefined };
  return reports[appId] ?? report([], { groups: sourceType === "compose" ? ["secrets"] : ["secrets", "docker"] });
}
