/**
 * Framework kataloğu: her framework kendi algılama kuralını, ayar alanlarını, gereken ortam
 * değişkenlerini ve Dockerfile üretimini tanımlar. Arayüz bu tanımları olduğu gibi gösterir.
 */

export type FieldDef = {
  key: string;
  label: string;
  hint?: string;
  placeholder?: string;
  type: "text" | "select" | "toggle";
  options?: { value: string; label: string }[];
};

/** auto: değer panelde tek tıkla üretilir. */
export type EnvHint = {
  key: string;
  description: string;
  value?: string;
  auto?: "secret" | "laravel-key" | "domains" | "url" | "https-origins";
  required?: boolean;
};

export type Options = Record<string, string | boolean | undefined>;

export type BuildResult = {
  dockerfile: string;
  port: number;
  /** Derleme bağlamına yazılacak ek dosyalar (ör. Caddyfile, WSGI sarmalayıcı). */
  files?: Record<string, string>;
  /** Derleme günlüğünde gösterilecek açıklama satırları. */
  notes?: string[];
};

export type Detection = { score: number; options?: Options; reason: string };

export type Framework = {
  id: string;
  name: string;
  language: string;
  /** Arayüzde gruplama için. */
  category: "Python" | "JavaScript" | "PHP" | ".NET" | "Go" | "Rust" | "Java" | "Ruby" | "Statik" | "Diğer";
  description: string;
  defaultPort: number;
  fields: FieldDef[];
  envHints: EnvHint[];
  /** Deploy sırasında ne olacağı, kullanıcıya adım adım gösterilir. */
  steps: string[];
  detect?: (repo: Repo) => Detection | null;
  build: (repo: Repo, opts: Options, env: Record<string, string>) => BuildResult;
  /**
   * Önerilen değişkenin projede gerçekte hangi adla okunduğu (ör. settings.py ALLOWED_HOSTS'u
   * "ALLOWED_HOSTS" adından okuyorsa { DJANGO_ALLOWED_HOSTS: "ALLOWED_HOSTS" }).
   */
  envAliases?: (repo: Repo, opts: Options) => Record<string, string>;
  /**
   * Projenin çalışması için gereken, kullanıcının vermediği ayarlar: eksikse eklenecek ortam değişkenleri ve
   * kalıcı klasörler (ör. Rails'in üretim SQLite dosyaları için storage/).
   */
  autoConfig?: (repo: Repo, opts: Options) => { env?: Record<string, string>; volumes?: { name: string; path: string }[]; notes?: string[] };
};

/** Repo içeriğine güvenli, salt okunur erişim. */
export type Repo = {
  has: (file: string) => boolean;
  read: (file: string) => string;
  list: (dir?: string) => string[];
  json: <T = Record<string, unknown>>(file: string) => T | null;
  /** Kök dizinde (veya verilen alt dizinde) desenle eşleşen ilk dosya. */
  find: (re: RegExp, dir?: string) => string | null;
};
