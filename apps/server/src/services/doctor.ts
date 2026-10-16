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
  /** Uygulanınca ortam değişkenleri ve/veya derleme ayarları güncellenir ve yeniden deploy edilir. */
  fix?: { label: string; env?: Record<string, string>; buildOptions?: Record<string, string | boolean> };
};

export type HttpProbe = { status: number | null; statusLine: string; error?: string };

/**
 * İsteği Caddy konteynerinden, uygulamanın kendi alan adıyla (Host) ve HTTPS arkasındaymış gibi atar; ilk yanıtın
 * durum satırı okunur. busybox wget kullanılır: nc, isteği gönderince bağlantıyı kapattığı için bazı sunucular
 * (uvicorn, Kestrel, Node) yanıt vermeden bağlantıyı bırakıyordu.
 */
export async function probeHttp(docker: Docker, container: string, port: number, host: string, path = "/"): Promise<HttpProbe> {
  if (!/^[a-z0-9.-]+$/i.test(host) || !/^\/[\w\-./?=&%~]*$/.test(path) || !/^[\w.-]+$/.test(container)) {
    return { status: null, statusLine: "", error: "Geçersiz kontrol adresi" };
  }
  const cmd = `wget -q -S -O /dev/null -T 10 -U xudbin-doctor --header 'Host: ${host}' --header 'X-Forwarded-Proto: https' --header 'X-Forwarded-Host: ${host}' 'http://${container}:${port}${path}' 2>&1 | grep -m1 'HTTP/'`;
  const res = await execIn(docker, CADDY_CONTAINER, ["sh", "-c", cmd], { timeoutMs: 20_000 }).catch((e: Error) => ({ exitCode: 1, stdout: "", stderr: e.message }));
  const line = res.stdout.trim();
  const m = line.match(/HTTP\/\d(?:\.\d)?\s+(\d{3})/);
  if (!m) return { status: null, statusLine: line, error: "Uygulama HTTP isteğine yanıt vermedi" };
  return { status: Number(m[1]), statusLine: line.replace(/^\s+/, "") };
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
  // --- Derleme hataları -------------------------------------------------------------------------
  {
    re: /npm error Cannot read properties of null \(reading '(edgesOut|edgesIn|package)'\)/,
    make: () => ({
      id: "npm-arborist",
      title: "npm bağımlılıkları çözemedi",
      detail: "Bu, eski npm sürümlerinde kilit dosyası (package-lock.json) olmayan projelerde görülen bilinen bir npm hatası. Node 24 ile gelen npm'de düzeldi; projeye package-lock.json eklemek de çözer.",
      fix: { label: "Node 24 ile yeniden derle", buildOptions: { nodeVersion: "24" } },
    }),
  },
  {
    re: /`npm ci` can only install packages when your package\.json and package-lock\.json[^\n]*in sync/,
    make: () => ({
      id: "npm-lock-sync",
      title: "package-lock.json, package.json ile uyuşmuyor",
      detail: "package.json değişmiş ama package-lock.json güncellenmemiş. Yerelde npm install çalıştırıp kilit dosyasını commit'le ya da kurulumu npm install ile yap.",
      fix: { label: "Kurulumu npm install ile yap", buildOptions: { installCommand: "npm install" } },
    }),
  },
  {
    re: /npm error code ERESOLVE|ERESOLVE unable to resolve dependency tree|ERESOLVE could not resolve/,
    make: () => ({
      id: "npm-peer",
      title: "Paket sürümleri birbiriyle çakışıyor (peer dependency)",
      detail: "Bazı paketler birbirinin farklı sürümlerini istiyor. Kalıcı çözüm sürümleri uyumlu hale getirmek; hızlı çözüm npm install --legacy-peer-deps.",
      fix: { label: "--legacy-peer-deps ile kur", buildOptions: { installCommand: "npm install --legacy-peer-deps" } },
    }),
  },
  {
    re: /requires php [>=^~]*\s*8\.(\d+)[^\n]*your php version \((8\.\d+)/,
    make: (m) => ({
      id: "php-version",
      title: `PHP ${m[2]} yetmiyor, en az PHP 8.${m[1]} gerekli`,
      detail: `composer.lock'taki paketler PHP 8.${m[1]} istiyor. Derleme PHP sürümü yükseltilmeli.`,
      fix: { label: `PHP 8.${m[1]} ile yeniden derle`, buildOptions: { phpVersion: `8.${m[1]}` } },
    }),
  },
  {
    re: /No database file specified\. Missing argument: database/,
    make: () => ({
      id: "rails-sqlite",
      title: "Rails üretim veritabanının yolu tanımlı değil",
      detail: "config/database.yml'de production için database: yolu yok. Yeniden deploy edildiğinde Xudbin storage/ klasörünü kalıcı yapıp DATABASE_URL değişkenlerini kendisi ekler; harici bir veritabanı kullanacaksan DATABASE_URL'i kendin ver.",
    }),
  },
  {
    re: /No matching distribution found for ([\w.-]+)|requires a different Python: ([\d.]+) not in '([^']+)'/,
    make: (m) => ({
      id: "pip",
      title: m[1] ? `Python paketi bulunamadı: ${m[1]}` : "Python sürümü uygun değil",
      detail: m[1]
        ? "Paket adı veya sürümü yanlış ya da bu Python sürümü için yayınlanmamış. requirements.txt'yi ve Python sürümünü kontrol et."
        : `Paket ${m[3]} Python sürümünü istiyor, derlemede ${m[2]} kullanıldı. Uygulama ayarlarından Python sürümünü değiştir.`,
    }),
  },
  {
    re: /Module not found: (?:Error: )?Can't resolve '([^']+)'/,
    make: (m) => ({
      id: "bundler-module",
      title: `Derlemede modül bulunamadı: ${m[1]}`,
      detail: m[1]!.startsWith(".") || m[1]!.startsWith("@/")
        ? "Kodda içe aktarılan dosya bulunamıyor. Dosya adı büyük/küçük harf farkıyla yazılmış olabilir (Linux büyük/küçük harfe duyarlıdır)."
        : `"${m[1]}" paketi package.json'da yok. dependencies kısmına ekle.`,
    }),
  },
  {
    re: /no space left on device/i,
    make: () => ({ id: "disk-full", title: "Sunucunun diski dolu", detail: "Derleme için yer kalmadı. Sunucular sayfasından disk kullanımına bak; eski imajları ve derleme önbelleğini temizle." }),
  },
  {
    re: /exec format error/,
    make: () => ({ id: "arch", title: "İmaj bu sunucunun işlemcisi için derlenmemiş", detail: "İmaj farklı bir mimari (ör. arm64 / amd64) için hazırlanmış. Çok mimarili bir imaj kullan veya kaynaktan derle." }),
  },
  {
    re: /pull access denied|manifest unknown|repository does not exist/,
    make: () => ({ id: "image-pull", title: "Docker imajı indirilemedi", detail: "İmaj adı veya etiketi yanlış ya da imaj özel (giriş gerektiriyor). Adı ve etiketi kontrol et." }),
  },
  {
    re: /error: release version (\d+) not supported|invalid target release: (\d+)/,
    make: (m) => ({
      id: "java-version",
      title: `Java ${m[1] ?? m[2]} gerekli`,
      detail: "Proje daha yeni bir Java sürümüyle derlenmek istiyor.",
      fix: { label: `Java ${m[1] ?? m[2]} ile derle`, buildOptions: { javaVersion: String(m[1] ?? m[2]) } },
    }),
  },
  // --- Çalışma zamanı hataları ------------------------------------------------------------------
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
