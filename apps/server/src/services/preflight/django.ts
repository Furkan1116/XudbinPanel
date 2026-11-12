import { type BuildPlan, startText } from "./build.js";
import { FindingList } from "./findings.js";
import type { Note, PreflightContext, PreflightFinding } from "./types.js";
import { joinRel, type SourceTree } from "./tree.js";

/**
 * Django kontrolü. Üretimde hangi ayar dosyasının kullanılacağı kesin bilinmiyorsa (birden çok aday, ortamda ya da
 * yapılandırmada açık bir DJANGO_SETTINGS_MODULE yok) DEBUG bulgusu kritik değil uyarı olur ve bakılan dosyalar yazılır.
 */

type Settings = {
  /** Kullanılacağı kestirilen ayar modülü ve dosyası (kökten göreli). */
  module: string | null;
  file: string | null;
  /** Modülün nereden bulunduğu. */
  origin: "env" | "options" | "dockerfile" | "manage.py" | null;
  /** Dosyanın üretimde kullanılacağı kesin mi. */
  certain: boolean;
  /** Modülün kendisi + yıldızlı içe aktardığı kardeş modüller (içe aktarılanlar önce). */
  chain: { rel: string; text: string }[];
  /** Kaynaktaki tüm ayar dosyası adayları. */
  candidates: string[];
};

const SERVERS = /\b(gunicorn|uvicorn|daphne|hypercorn|granian|waitress|uwsgi|mod_wsgi)\b/i;
const RUNSERVER = /\b(?:manage\.py|django-admin|-m\s+django)\s+runserver\b/;

/** Bağlamda Django projesi var mı. */
export function isDjango(tree: SourceTree, plan: BuildPlan) {
  return plan.frameworkId === "django" || tree.has(joinRel(plan.context, "manage.py"));
}

/** Satır başındaki (girintisiz) son atamanın değeri; girintili (koşullu) atama varsa `conditional` true. */
export function topLevelAssignment(text: string, name: string): { value: string; line: number; conditional: boolean } | null {
  let found: { value: string; line: number } | null = null;
  let conditional = false;
  const lines = text.split(/\r?\n/);
  const re = new RegExp(`^(\\s*)${name}\\s*(?::[^=]+)?=\\s*(.+)$`);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(re);
    if (!m) continue;
    if (m[1]) conditional = true;
    else found = { value: m[2]!.replace(/\s+#.*$/, "").trim(), line: i + 1 };
  }
  return found ? { ...found, conditional } : null;
}

function moduleFile(tree: SourceTree, contextRel: string, module: string) {
  const base = joinRel(contextRel, module.replace(/\./g, "/"));
  if (tree.has(`${base}.py`)) return `${base}.py`;
  if (tree.has(`${base}/__init__.py`)) return `${base}/__init__.py`;
  return null;
}

/** "from .base import *" / "from config.settings.base import *" ile içe aktarılan kardeş modül dosyaları (bir düzey). */
function starImports(tree: SourceTree, contextRel: string, file: string, text: string) {
  const dir = file.split("/").slice(0, -1).join("/");
  const out: string[] = [];
  for (const m of text.matchAll(/^from\s+([\w.]+)\s+import\s+\*/gm)) {
    const mod = m[1]!;
    const rel = mod.startsWith(".") ? joinRel(dir, `${mod.replace(/^\.+/, "").replace(/\./g, "/")}.py`) : moduleFile(tree, contextRel, mod);
    if (rel && tree.has(rel) && rel !== file) out.push(rel);
  }
  return out;
}

/** Ayar modülünü çözer: ortam → panel ayarı (ön ayar) → depodaki Dockerfile ENV → manage.py. */
export function resolveSettings(tree: SourceTree, plan: BuildPlan, ctx: PreflightContext): Settings {
  const candidates = tree.files
    .filter((f) => f.rel === plan.context || !plan.context || f.rel.startsWith(`${plan.context}/`))
    .filter((f) => f.name.endsWith(".py") && (/^settings.*\.py$/.test(f.name) || /(^|\/)settings\/[^/]+\.py$/.test(f.rel)) && f.name !== "__init__.py")
    .map((f) => f.rel);
  let module: string | null = null;
  let origin: Settings["origin"] = null;
  if (ctx.settingsModule) [module, origin] = [ctx.settingsModule, "env"];
  else if (plan.frameworkId === "django" && typeof plan.options.settingsModule === "string" && plan.options.settingsModule.trim()) [module, origin] = [plan.options.settingsModule.trim(), "options"];
  else if (plan.dockerfile) {
    const env = plan.dockerfile.instrs.filter((i) => i.op === "ENV" && /DJANGO_SETTINGS_MODULE/.test(i.args)).at(-1);
    const value = env?.args.match(/DJANGO_SETTINGS_MODULE[=\s]+["']?([\w.]+)/)?.[1];
    if (value) [module, origin] = [value, "dockerfile"];
  }
  if (!module) {
    const manage = tree.text(joinRel(plan.context, "manage.py")) ?? "";
    const value = manage.match(/DJANGO_SETTINGS_MODULE["']\s*,\s*["']([\w.]+)["']/)?.[1];
    if (value) [module, origin] = [value, "manage.py"];
  }
  const file = module ? moduleFile(tree, plan.context, module) : null;
  const chain: Settings["chain"] = [];
  if (file) {
    const text = tree.text(file) ?? "";
    for (const rel of starImports(tree, plan.context, file, text)) chain.push({ rel, text: tree.text(rel) ?? "" });
    chain.push({ rel: file, text });
  }
  // Kesin: modül tek bir dosya ve ya açıkça verildi ya da kaynakta başka ayar dosyası adayı yok.
  const others = candidates.filter((c) => c !== file && !chain.some((x) => x.rel === c));
  const certain = Boolean(file && !file.endsWith("__init__.py") && (origin !== "manage.py" || others.length === 0));
  return { module, file, origin, certain, chain, candidates };
}

/** Zincirdeki son geçerli atama (modülün kendi ataması içe aktarılanı ezer). */
function effective(chain: Settings["chain"], name: string) {
  let hit: { rel: string; value: string; line: number; conditional: boolean } | null = null;
  let conditional = false;
  for (const { rel, text } of chain) {
    const a = topLevelAssignment(text, name);
    if (a?.conditional) conditional = true;
    if (a) hit = { rel, ...a };
  }
  return hit ? { ...hit, conditional: hit.conditional || conditional } : null;
}

const isTrue = (v: string) => /^True$/.test(v);
const isStringLiteral = (v: string) => /^[rbuRBU]{0,2}(["'])[^"'\n]{1,}\1$/.test(v);

export function checkDjango(tree: SourceTree, plan: BuildPlan, ctx: PreflightContext, notes: Note[]): PreflightFinding[] {
  const list = new FindingList("django");
  const settings = resolveSettings(tree, plan, ctx);
  const ownDockerfile = Boolean(plan.dockerfile);
  if (settings.file) {
    notes.push({ text: "Django ayarları: {file} ({origin})", vars: { file: settings.file, origin: { env: "ortam değişkeni", options: "uygulama ayarı", dockerfile: "Dockerfile", "manage.py": "manage.py" }[settings.origin!] } });
  } else notes.push({ text: "Django ayar dosyası bulunamadı; ayar kontrolleri kaynaktaki tüm settings dosyalarında yapıldı." });

  // Kesin değilse: modül zinciri + tüm adaylar taranır, bulgular uyarı olur.
  const scanned = settings.certain ? settings.chain : [...settings.chain, ...settings.candidates.filter((c) => !settings.chain.some((x) => x.rel === c)).map((rel) => ({ rel, text: tree.text(rel) ?? "" }))];
  const allText = scanned.map((s) => s.text).join("\n");

  // --- DEBUG ---------------------------------------------------------------------------------
  if (settings.certain) {
    const debug = effective(settings.chain, "DEBUG");
    if (debug && isTrue(debug.value)) {
      list.add({
        id: "django-debug",
        level: debug.conditional ? "warning" : "critical",
        title: "DEBUG = True sabit yazılmış",
        detail: debug.conditional
          ? "{file} dosyasında DEBUG True, koşullu bir atama da var; üretimde açık kalabilir. Hata sayfaları ayarları ve kodu ziyaretçiye gösterir."
          : "{file} üretimde kullanılacak ve DEBUG ortam değişkeninden okunmuyor. Hata sayfaları ayarları, yolları ve kodu ziyaretçiye gösterir.",
        fix: 'DEBUG = os.environ.get("DJANGO_DEBUG", "False") == "True" yaz; panel DJANGO_DEBUG=False verir.',
        vars: { file: debug.rel },
        file: debug.rel,
        line: debug.line,
      });
    }
  } else {
    for (const s of scanned) {
      const debug = topLevelAssignment(s.text, "DEBUG");
      if (!debug || !isTrue(debug.value)) continue;
      list.add({
        id: "django-debug-maybe",
        level: "warning",
        title: "DEBUG = True sabit yazılmış: {file}",
        detail: "Üretimde hangi ayar dosyasının kullanılacağı kesin bilinmiyor (bakılan dosyalar: {files}). Bu dosya kullanılıyorsa hata sayfaları kodu ziyaretçiye gösterir.",
        fix: "DEBUG'u ortam değişkeninden oku ya da uygulamanın DJANGO_SETTINGS_MODULE değişkeniyle üretim ayarını açıkça seç.",
        vars: { file: s.rel, files: scanned.map((x) => x.rel).join(", ") },
        file: s.rel,
        line: debug.line,
      });
    }
  }

  // --- runserver ------------------------------------------------------------------------------
  const start = startText(plan.start);
  if (plan.start && RUNSERVER.test(start)) {
    list.add({
      id: "django-runserver",
      level: "critical",
      title: "Başlatma komutu runserver",
      detail: "{where} manage.py runserver kullanıyor. runserver geliştirme sunucusudur; yük altında çöker, güvenlik denetiminden geçmemiştir.",
      fix: "gunicorn proje.wsgi --bind 0.0.0.0:$PORT kullan ya da Dockerfile'ı kaldırıp panelin Django ön ayarını seç.",
      vars: { where: plan.start.source === "panel" ? "Paneldeki başlatma komutu" : `${plan.start.file ?? "Dockerfile"}` },
      file: plan.start.file,
      line: plan.start.line,
    });
  }
  const procfile = tree.text(joinRel(plan.context, "Procfile"));
  const web = procfile?.match(/^web:\s*(.+)$/m);
  if (web && RUNSERVER.test(web[1]!) && !RUNSERVER.test(start)) {
    list.add({
      id: "django-procfile-runserver",
      level: "warning",
      title: "Procfile runserver kullanıyor",
      detail: "Panel Procfile'ı çalıştırmaz, ama bu satır projenin üretime geliştirme sunucusuyla hazırlandığını gösteriyor.",
      fix: "Procfile'daki web satırını gunicorn ile değiştir.",
      file: joinRel(plan.context, "Procfile"),
    });
  }

  // --- SECRET_KEY, ALLOWED_HOSTS ------------------------------------------------------------------
  for (const s of scanned) {
    const key = topLevelAssignment(s.text, "SECRET_KEY");
    if (key && isStringLiteral(key.value)) {
      list.add({
        id: "django-secret-key",
        level: "warning",
        title: "SECRET_KEY koda gömülü: {file}",
        detail: "Gizli anahtar ortamdan okunmuyor; depoyu gören herkes oturum çerezlerini ve parola sıfırlama bağlantılarını taklit edebilir. Değer rapora yazılmadı.",
        fix: 'SECRET_KEY = os.environ["DJANGO_SECRET_KEY"] yaz; panel değeri otomatik üretir. Depoya girdiyse anahtarı değiştir.',
        vars: { file: s.rel },
        file: s.rel,
        line: key.line,
      });
    }
    const hosts = topLevelAssignment(s.text, "ALLOWED_HOSTS");
    if (hosts && /^[[(]/.test(hosts.value) && /["']\*["']/.test(hosts.value)) {
      list.add({
        id: "django-allowed-hosts",
        level: "warning",
        title: 'ALLOWED_HOSTS = ["*"]: {file}',
        detail: "Her Host başlığı kabul ediliyor; parola sıfırlama e-postalarındaki bağlantılar başka bir alan adına yönlendirilebilir.",
        fix: 'ALLOWED_HOSTS = os.environ.get("DJANGO_ALLOWED_HOSTS", "").split(",") yaz; panel alan adlarını verir.',
        vars: { file: s.rel },
        file: s.rel,
        line: hosts.line,
      });
    }
  }

  // --- Uygulama sunucusu (yalnız depodaki Dockerfile: ön ayar gunicorn'u kendisi kurar) ---------------------------
  const deps = ["requirements.txt", "requirements/production.txt", "requirements/prod.txt", "requirements/base.txt", "pyproject.toml", "Pipfile"].map((f) => tree.text(joinRel(plan.context, f)) ?? "").join("\n");
  if (ownDockerfile && !SERVERS.test(deps) && !SERVERS.test(plan.dockerfile!.instrs.map((i) => i.args).join("\n")) && !SERVERS.test(start)) {
    list.add({
      id: "django-no-server",
      level: "warning",
      title: "Üretim sunucusu bağımlılığı yok",
      detail: "requirements dosyalarında ve Dockerfile'da gunicorn, uvicorn ya da daphne görünmüyor.",
      fix: "requirements.txt'ye gunicorn ekle ve Dockerfile'da gunicorn ile başlat.",
      file: plan.dockerfile!.rel,
    });
  }

  // --- Statik dosyalar ---------------------------------------------------------------------------
  const missing: string[] = [];
  if (allText && !/^STATIC_ROOT\s*=/m.test(allText)) missing.push("STATIC_ROOT");
  if (ownDockerfile && !/whitenoise/i.test(deps + allText)) missing.push("whitenoise");
  if (missing.length) {
    list.add({
      id: "django-static",
      level: "warning",
      title: "Statik dosya düzeni eksik",
      detail: "Eksik: {missing}. DEBUG kapalıyken Django statik dosyaları sunmaz; CSS ve görseller 404 verir.",
      fix: 'STATIC_ROOT = BASE_DIR / "staticfiles" ekle; kendi Dockerfile\'ında whitenoise kur ve collectstatic çalıştır.',
      vars: { missing: missing.join(", ") },
      file: settings.file ?? undefined,
    });
  }
  if (allText && !/CSRF_TRUSTED_ORIGINS/.test(allText)) {
    list.add({
      id: "django-csrf-origins",
      level: "info",
      title: "CSRF_TRUSTED_ORIGINS tanımlı değil",
      detail: "Django 4 ve sonrası HTTPS arkasındaki form gönderimlerini bu liste olmadan reddedebilir (CSRF verification failed).",
      fix: 'CSRF_TRUSTED_ORIGINS = os.environ.get("CSRF_TRUSTED_ORIGINS", "").split(",") yaz; panel değeri alan adlarından doldurur.',
      file: settings.file ?? undefined,
    });
  }
  return list.result();
}
