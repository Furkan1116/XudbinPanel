import type Docker from "dockerode";
import { CADDY_CONTAINER } from "./caddy.js";
import { execIn } from "./docker.js";

/**
 * Deploy Doktoru: uygulamaya gerçek bir HTTP isteği atar ve loglardaki bilinen hataları
 * kullanıcının anlayacağı bir açıklamaya ve mümkünse tek tıkla uygulanabilir bir düzeltmeye çevirir.
 */

export type Finding = {
  id: string;
  title: string;
  detail: string;
  /** Uygulanınca ortam değişkenlerine eklenir/güncellenir ve yeniden deploy edilir. */
  fix?: { label: string; env: Record<string, string> };
};

export type HttpProbe = { status: number | null; statusLine: string; error?: string };

/**
 * İsteği Caddy konteynerinden, uygulamanın kendi alan adıyla (Host) ve HTTPS arkasındaymış gibi atar.
 * Yönlendirmeler takip edilmez; yalnız durum satırı okunur.
 */
export async function probeHttp(docker: Docker, container: string, port: number, host: string, path = "/"): Promise<HttpProbe> {
  const request = `GET ${path} HTTP/1.0\\r\\nHost: ${host}\\r\\nUser-Agent: xudbin-doctor\\r\\nX-Forwarded-Proto: https\\r\\nX-Forwarded-Host: ${host}\\r\\nAccept: text/html,*/*\\r\\n\\r\\n`;
  const res = await execIn(docker, CADDY_CONTAINER, ["sh", "-c", `printf '${request}' | nc -w 10 ${container} ${port} | head -1`], { timeoutMs: 15_000 }).catch(
    (e: Error) => ({ exitCode: 1, stdout: "", stderr: e.message }),
  );
  const line = res.stdout.trim();
  const m = line.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/);
  if (!m) return { status: null, statusLine: line, error: line ? `Beklenmeyen yanıt: ${line.slice(0, 80)}` : "Uygulama HTTP isteğine yanıt vermedi" };
  return { status: Number(m[1]), statusLine: line };
}

/** Sağlık yolu verilmediyse "/" için 404 de kabul edilir (yalnız API olan uygulamalar). */
export function isHealthy(status: number, strict: boolean) {
  if (status >= 200 && status < 400) return true;
  if (strict) return false;
  return status === 401 || status === 403 || status === 404 || status === 405;
}

type Ctx = { framework: string; env: Record<string, string>; hosts: string[]; status?: number | null; exitCode?: number | null };

type Rule = { re: RegExp; make: (m: RegExpMatchArray, ctx: Ctx) => Finding | null };

const appendList = (current: string | undefined, add: string) => {
  const items = (current ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return items.includes(add) ? null : [...items, add].join(",");
};

const RULES: Rule[] = [
  {
    re: /Invalid HTTP_HOST header: '([^']+)'/,
    make: (m, ctx) => {
      const host = m[1]!.replace(/:\d+$/, "");
      const key = Object.keys(ctx.env).find((k) => /ALLOWED_HOSTS/.test(k)) ?? "DJANGO_ALLOWED_HOSTS";
      const placeholder = ctx.env[key]?.includes("{{XUDBIN_DOMAINS}}");
      const next = placeholder ? null : appendList(ctx.env[key], host);
      return {
        id: "django-allowed-hosts",
        title: "Django alan adını tanımıyor (ALLOWED_HOSTS)",
        detail: `Django, "${host}" adresinden gelen istekleri reddedip 400 döndürüyor. ${key} değişkenine alan adı eklenmeli ve settings.py içinde ALLOWED_HOSTS bu değişkenden okunmalı: ALLOWED_HOSTS = os.environ["${key}"].split(",")`,
        fix: next ? { label: `${key} değişkenini uygulamanın alan adlarıyla doldur`, env: { [key]: "{{XUDBIN_DOMAINS}}" } } : undefined,
      };
    },
  },
  {
    re: /(CSRF verification failed|Origin checking failed - (\S+) does not match any trusted origins)/,
    make: (_m, ctx) => ({
      id: "csrf-origins",
      title: "Form gönderimleri CSRF kontrolüne takılıyor",
      detail: "HTTPS arkasında Django, sitenin adresini CSRF_TRUSTED_ORIGINS içinde görmek ister. settings.py bu değişkeni okumalı.",
      fix: ctx.env.CSRF_TRUSTED_ORIGINS ? undefined : { label: "CSRF_TRUSTED_ORIGINS ekle", env: { CSRF_TRUSTED_ORIGINS: "{{XUDBIN_ORIGINS}}" } },
    }),
  },
  {
    re: /(The SECRET_KEY setting must not be empty|DJANGO_SECRET_KEY tanımlı değil|Missing `secret_key_base`|No application encryption key has been specified)/,
    make: (m) => {
      const laravel = /encryption key/.test(m[1]!);
      const rails = /secret_key_base/.test(m[1]!);
      const key = laravel ? "APP_KEY" : rails ? "SECRET_KEY_BASE" : "DJANGO_SECRET_KEY";
      return {
        id: "secret-key",
        title: "Gizli anahtar tanımlı değil",
        detail: `Uygulama ${key} olmadan başlamıyor. Panel güvenli rastgele bir anahtar üretebilir.`,
        fix: { label: `${key} üret`, env: { [key]: laravel ? "{{XUDBIN_LARAVEL_KEY}}" : "{{XUDBIN_SECRET}}" } },
      };
    },
  },
  {
    re: /(ECONNREFUSED|Connection refused|could not connect to server|Can't connect to (?:local )?MySQL server|connection to server at "?([\w.-]+)"?.*failed)[^\n]*?(?:127\.0\.0\.1|localhost|::1)?/i,
    make: (_m, ctx) => {
      const url = Object.entries(ctx.env).find(([k, v]) => /DATABASE_URL|DB_HOST|REDIS_URL|MONGO/.test(k) && /localhost|127\.0\.0\.1/.test(v));
      return {
        id: "db-connection",
        title: "Veritabanına bağlanılamıyor",
        detail: url
          ? `${url[0]} "localhost" gösteriyor. Konteyner içinde localhost uygulamanın kendisidir; Xudbin veritabanının iç adresini (ör. xb-db-...:5432) kullan. Adres veritabanı sayfasındaki "İç bağlantı" alanında.`
          : "Uygulama veritabanına bağlanamıyor. Veritabanının çalıştığını, aynı sunucuda olduğunu ve bağlantı adresinin (DATABASE_URL) veritabanı sayfasındaki iç adresle aynı olduğunu kontrol et.",
      };
    },
  },
  {
    re: /(getaddrinfo (?:ENOTFOUND|EAI_AGAIN) ([\w.-]+)|could not translate host name "([\w.-]+)")/,
    make: (m) => ({
      id: "db-host",
      title: `"${m[2] ?? m[3]}" adresi bulunamıyor`,
      detail: "Bağlantı adresindeki sunucu adı çözülemiyor. Xudbin veritabanları için iç adres xb-db-<ad> biçimindedir; veritabanı başka bir sunucudaysa dış adresini kullan.",
    }),
  },
  {
    re: /(no such table: (\w+)|relation "([\w.]+)" does not exist|Table '([\w.]+)' doesn't exist|You have \d+ unapplied migration)/,
    make: () => ({
      id: "migrations",
      title: "Veritabanı tabloları oluşturulmamış (migration)",
      detail: "Uygulama henüz oluşturulmamış bir tabloyu arıyor. Django'da \"Her deploy'da migrate çalıştır\" ayarını aç; diğer frameworklerde başlatma komutuna migrate adımını ekle (ör. npx prisma migrate deploy && npm start).",
    }),
  },
  {
    re: /ModuleNotFoundError: No module named '([\w.]+)'/,
    make: (m) => ({
      id: "py-module",
      title: `Python paketi eksik: ${m[1]!.split(".")[0]}`,
      detail: `"${m[1]}" modülü kurulu değil. Paketi requirements.txt (veya pyproject.toml) dosyasına ekleyip yeniden deploy et.`,
    }),
  },
  {
    re: /Error: Cannot find module '([^']+)'/,
    make: (m) => ({
      id: "node-module",
      title: `Node modülü bulunamadı: ${m[1]}`,
      detail: m[1]!.startsWith("/") || m[1]!.startsWith(".")
        ? "Başlatılan dosya imajda yok. Derleme çıktısının yolu (ör. dist/main.js) veya başlatma komutu yanlış olabilir."
        : `"${m[1]}" paketi kurulu değil. package.json dosyasındaki dependencies kısmına ekle (devDependencies üretimde kurulmaz).`,
    }),
  },
  {
    re: /(JavaScript heap out of memory|MemoryError|OOMKilled|Killed\s*$)/m,
    make: () => ({
      id: "oom",
      title: "Uygulamanın belleği yetmedi",
      detail: "Uygulama bellek sınırını aştığı için kapatıldı. Uygulama ayarlarından bellek sınırını artır veya sunucuda boş bellek olduğundan emin ol.",
    }),
  },
  {
    re: /Environment variable not found: (\w+)|KeyError: '([A-Z][A-Z0-9_]+)'|[Mm]issing (?:required )?env(?:ironment)? var(?:iable)?s?:? ["'`]?([A-Z][A-Z0-9_]{2,})|["'`]?\b([A-Z][A-Z0-9_]{2,})["'`]? (?:env(?:ironment)? variable )?is (?:not set|missing|required|undefined)/,
    make: (m, ctx) => {
      const key = m[1] ?? m[2] ?? m[3] ?? m[4];
      if (!key || key in ctx.env) return null;
      return { id: `env-${key}`, title: `Ortam değişkeni eksik: ${key}`, detail: `Uygulama ${key} değişkenini okuyor ama tanımlı değil. Ortam değişkenleri sekmesinden ekle.` };
    },
  },
  {
    re: /(EACCES: permission denied|PermissionError: \[Errno 13\] Permission denied|Permission denied)[^\n]*?(\/[\w./-]+)?/,
    make: (m) => ({
      id: "permission",
      title: "Dosya izni hatası",
      detail: `Uygulama ${m[2] ? `"${m[2]}" yoluna` : "bir dosyaya"} yazamıyor. Kalıcı depolama klasörü bağladıysan imajdaki kullanıcının o klasöre yazma izni olmalı.`,
    }),
  },
  {
    re: /(EADDRINUSE|address already in use)/i,
    make: () => ({ id: "port-in-use", title: "Port zaten kullanımda", detail: "Uygulama aynı portu iki kez açmaya çalışıyor. Başlatma komutunda aynı sunucunun iki kez başlatılmadığını kontrol et." }),
  },
];

export function diagnose(lines: string[], ctx: Ctx): Finding[] {
  const text = lines.slice(-400).join("\n");
  const out: Finding[] = [];
  for (const rule of RULES) {
    const m = text.match(rule.re);
    if (!m) continue;
    const f = rule.make(m, ctx);
    if (f && !out.some((o) => o.id === f.id)) out.push(f);
  }
  if (ctx.exitCode === 137 && !out.some((o) => o.id === "oom")) {
    out.push({ id: "oom", title: "Uygulamanın belleği yetmedi", detail: "Konteyner 137 koduyla kapandı; genellikle bellek sınırı aşıldığında olur. Bellek sınırını artır." });
  }
  if (!out.length && ctx.status) {
    const s = ctx.status;
    if (s >= 500) out.push({ id: "http-5xx", title: `Uygulama ${s} hatası veriyor`, detail: "Uygulama çalışıyor ama istekleri işlerken hata veriyor. Hatanın ayrıntısı uygulama loglarında; çoğu zaman eksik bir ortam değişkeni veya veritabanı bağlantısıdır." });
    else if (s === 400 && ctx.framework === "django") {
      // Alan adlarını içermeyen *ALLOWED_HOSTS değişkenlerine, mevcut değer korunarak alan adları eklenir.
      const stale = Object.entries(ctx.env).filter(([k, v]) => /ALLOWED_HOSTS$/.test(k) && !v.includes("{{XUDBIN_DOMAINS}}") && !ctx.hosts.every((h) => v.split(",").includes(h)));
      out.push({
        id: "django-allowed-hosts",
        title: "Django alan adını tanımıyor (ALLOWED_HOSTS)",
        detail: stale.length
          ? `${stale.map(([k, v]) => `${k}=${v}`).join(", ")} uygulamanın alan adlarını (${ctx.hosts.join(", ")}) içermiyor; Django bu adreslerden gelen isteklere 400 döndürüyor.`
          : `Django, izin verilmeyen bir alan adından gelen isteklere 400 döndürür. settings.py içindeki ALLOWED_HOSTS bir ortam değişkeninden okunmalı ve o değişken alan adlarını içermeli, ör. ALLOWED_HOSTS = os.environ["DJANGO_ALLOWED_HOSTS"].split(","). Uygulamanın alan adları: ${ctx.hosts.join(", ") || "-"}.`,
        fix: stale.length
          ? { label: "Alan adlarını ekle ve yeniden deploy et", env: Object.fromEntries(stale.map(([k, v]) => [k, v.trim() ? `${v},{{XUDBIN_DOMAINS}}` : "{{XUDBIN_DOMAINS}}"])) }
          : undefined,
      });
    }
    else if (s === 400) out.push({ id: "http-400", title: "Uygulama 400 (Bad Request) döndürüyor", detail: "Çoğu zaman uygulama alan adını tanımadığı için olur (Django ALLOWED_HOSTS, Vite/Nuxt allowedHosts, Rails config.hosts). Alan adını izinli adreslere ekle." });
    else if (s === 421) out.push({ id: "http-421", title: "Uygulama alan adını reddediyor (421)", detail: "Uygulama yalnız belirli alan adlarına yanıt veriyor; Xudbin'deki alan adını uygulamanın izinli adreslerine ekle." });
  }
  return out;
}
