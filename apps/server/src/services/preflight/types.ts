/**
 * Yayın kontrolü (preflight): kaynak alındıktan sonra, derlemeden önce yalnız dosyalara bakan sezgisel statik kontrol.
 * Kod çalıştırmaz, ağa ve Docker'a çıkmaz; bir güvenlik garantisi değildir, bilinen yaygın hataları erken gösterir.
 *
 * Metinler Türkçe kaynak metindir; {ad} yer tutucuları `vars` ile doldurulur. Arayüz aynı metni anahtar olarak
 * İngilizceye çevirir, günlük satırları Türkçe yazılır. Gizli bir değerin kendisi hiçbir zaman `vars`'a konmaz:
 * yalnız dosya yolu, satır numarası ve anahtar adı.
 */

export type PreflightLevel = "critical" | "warning" | "info";
export type PreflightGroup = "secrets" | "django" | "node" | "docker" | "compose";
export type PreflightMode = "block" | "warn" | "off";
export type PreflightSourceType = "git" | "upload" | "compose" | "image";
export type Vars = Record<string, string | number>;

export type PreflightFinding = {
  id: string;
  group: PreflightGroup;
  level: PreflightLevel;
  title: string;
  detail: string;
  /** Nasıl düzeltilir (kısa). */
  fix?: string;
  vars?: Vars;
  file?: string;
  line?: number;
};

export type Note = { text: string; vars?: Vars };

/** Yayının sonucu: geçti, uyarıyla geçti, kritik bulgu yüzünden durdu, bilerek geçildi, kontrol tamamlanamadı, atlandı. */
export type PreflightOutcome = "passed" | "warned" | "blocked" | "bypassed" | "error" | "skipped";

export type PreflightReport = {
  v: 1;
  at: number;
  status: "done" | "skipped" | "error";
  source: { type: PreflightSourceType; commit?: string | null; uploadedAt?: number | null };
  counts: { critical: number; warning: number; info: number };
  findings: PreflightFinding[];
  /** Çalışan kontrol grupları. */
  groups: PreflightGroup[];
  notes: Note[];
  scanned: { files: number; truncated: boolean; ms: number };
  /** status "error" ise kısa açıklama (yol ya da gizli değer içermez). */
  error?: string;
  /** Yalnız yayına bağlı raporlarda: o andaki mod ve sonuç. */
  mode?: PreflightMode;
  outcome?: PreflightOutcome;
  /** Rapor bir yayına aitse o yayının numarası. */
  deploymentId?: number;
};

/** Kontrolün ihtiyaç duyduğu uygulama bilgileri (veritabanından bağımsız). */
export type PreflightContext = {
  sourceType: PreflightSourceType;
  /** "auto" ise deploy'daki gibi algılanır. */
  framework: string;
  buildOptions: Record<string, string | boolean | undefined>;
  buildContext: string;
  dockerfilePath: string;
  port: number;
  /** Panelde tanımlı başlatma komutu (konteynerin CMD'sini ezer). */
  command: string | null;
  /** Ortam değişkenindeki DJANGO_SETTINGS_MODULE (varsa); başka değer alınmaz. */
  settingsModule?: string;
};

/** Metindeki {ad} yer tutucularını doldurur (günlük satırları için). */
export function format(text: string, vars?: Vars) {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (all, k: string) => (k in vars ? String(vars[k]) : all));
}
