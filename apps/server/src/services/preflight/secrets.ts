import { FindingList, lineOf } from "./findings.js";
import type { PreflightContext, PreflightFinding } from "./types.js";
import { joinRel, type SourceTree } from "./tree.js";

/**
 * Gizli bilgi ve gereksiz dosya kontrolü. Kritik yalnız yüksek kesinlikli durumlar: gövdesi ve bitişiyle birlikte
 * özel anahtar, dolu gizli değer taşıyan .env, özel anahtarlı servis hesabı JSON'u. Gizli değerin kendisi hiçbir
 * yere yazılmaz; bulguda yalnız dosya yolu, satır ve anahtar adı bulunur.
 */

/** Başlık + base64 gövde + bitiş: yalnız başlığı anan kod ya da belge eşleşmez. */
const PRIVATE_KEY = /-----BEGIN ((?:RSA|EC|DSA|OPENSSH|ENCRYPTED|PGP) )?PRIVATE KEY( BLOCK)?-----\r?\n(?:[\w-]+: ?[^\r\n]*\r?\n)*(?:\r?\n)?(?:[A-Za-z0-9+/=]{16,}\r?\n)+(?:=[A-Za-z0-9+/]{4}\r?\n)?-----END /;
/** Koddaki ya da JSON'daki tek satırlık hâli ("-----BEGIN PRIVATE KEY-----\nMIIE...\n-----END"). */
const ESCAPED_KEY = /-----BEGIN ((?:RSA|EC|DSA|OPENSSH|ENCRYPTED) )?PRIVATE KEY-----\\n(?:[A-Za-z0-9+/=]{16,}\\n)+-----END /;

const ENV_FILE = /^\.env(\..+)?$/;
/** Örnek .env dosyaları kontrol dışıdır. */
const ENV_EXAMPLE = /\.(example|sample|template|dist)$/i;
/** Test ortamı .env'leri: bulgu uyarıya iner (genelde sahte değerler). */
const ENV_TEST = /^\.env\.(test|testing|ci)$/i;

/** Değeri gizli sayılan anahtar adları. */
const SECRET_NAME = /(SECRET|PASSW|PWD|TOKEN|API_?KEY|PRIVATE|CREDENTIAL|AUTH|ACCESS_KEY|_KEY$|^KEY$|DSN|SALT)/i;
/** Tarayıcıya zaten giden (gizli olmayan) değişkenler. */
const PUBLIC_NAME = /^(NEXT_PUBLIC_|VITE_|NUXT_PUBLIC_|PUBLIC_|REACT_APP_|VUE_APP_|EXPO_PUBLIC_|GATSBY_)/;
/** Kullanıcı adı ve parola içeren bağlantı adresi. */
const URL_WITH_PASSWORD = /:\/\/[^\s:@/]+:[^\s@/]+@/;
/** Yer tutucu sayılan değerler. */
const PLACEHOLDER = /^(|changeme|change[-_ ]?this|xxx+|\*+|todo|tbd|placeholder|your[-_ ].*|<.*>|\$\{.*\}|\.\.\.|null|none|example|dummy|secret|password|test)$/i;

/** Test ve örnek klasörleri: buradaki anahtar bulguları uyarıya iner. */
const TEST_PATH = /(^|\/)(tests?|spec|specs|__tests__|fixtures?|testdata|test-data|examples?|samples?|docs?)\//i;

/** Metin olarak taranmayan uzantılar (ikili ya da üretilmiş dosyalar). */
const SKIP_TEXT = /\.(png|jpe?g|gif|webp|avif|ico|bmp|tiff?|psd|svgz|mp[34]|m4a|mov|avi|mkv|webm|wav|ogg|flac|pdf|zip|gz|tgz|bz2|xz|7z|rar|tar|jar|war|whl|egg|so|dylib|dll|exe|bin|o|a|class|pyc|pyo|wasm|woff2?|ttf|otf|eot|lockb|map)$/i;
const LOCKFILES = new Set(["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock", "poetry.lock", "Pipfile.lock", "composer.lock", "Gemfile.lock", "Cargo.lock", "go.sum", "uv.lock"]);

const IDENTITY_NAME = /^id_(rsa|dsa|ecdsa|ed25519)$/;
const KEYSTORE_EXT = /\.(p12|pfx|jks|keystore)$/i;
const SQLITE_EXT = /\.(sqlite3?|db)$/i;
const SQLITE_MAGIC = Buffer.from("SQLite format 3\0");
/** Yalnız sertifika ya da açık anahtar taşıyan .pem gizli değildir. */
const PUBLIC_PEM = /-----BEGIN (CERTIFICATE|PUBLIC KEY|X509 CRL|DH PARAMETERS|TRUSTED CERTIFICATE)/;

export type EnvAnalysis = { secretKeys: string[]; filledKeys: string[]; publicOnly: boolean };

/** .env satırlarını anahtar adlarına göre sınıflar. Değerlere yalnız boş/yer tutucu mu diye bakılır, saklanmaz. */
export function analyzeEnv(text: string): EnvAnalysis {
  const secretKeys: string[] = [];
  const filledKeys: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().replace(/^export\s+/, "");
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i <= 0) continue;
    const key = line.slice(0, i).trim();
    let value = line.slice(i + 1).trim();
    const quote = value[0];
    if (quote === '"' || quote === "'") {
      const end = value.indexOf(quote, 1);
      value = end > 0 ? value.slice(1, end) : value.slice(1);
    } else value = value.replace(/\s+#.*$/, "");
    value = value.trim();
    if (PLACEHOLDER.test(value) || /change[-_ ]?me/i.test(value)) continue;
    filledKeys.push(key);
    if (!PUBLIC_NAME.test(key) && (SECRET_NAME.test(key) || URL_WITH_PASSWORD.test(value))) secretKeys.push(key);
  }
  return { secretKeys, filledKeys, publicOnly: filledKeys.length > 0 && filledKeys.every((k) => PUBLIC_NAME.test(k)) };
}

/** .dockerignore bu dosyayı dışarıda bırakıyor mu (yaygın kalıplar; tam bir eşleştirici değildir). */
export function dockerIgnores(ignore: string | null, rel: string) {
  if (!ignore) return false;
  const name = rel.split("/").at(-1)!;
  return ignore
    .split(/\r?\n/)
    .map((l) => l.trim().replace(/^\/+/, "").replace(/^\*\*\//, ""))
    .filter((p) => p && !p.startsWith("#") && !p.startsWith("!"))
    .some((p) => p === rel || p === name || (p.endsWith("*") && (name.startsWith(p.slice(0, -1)) || rel.startsWith(p.slice(0, -1)))) || (p.startsWith("*") && name.endsWith(p.slice(1))));
}

function keyList(keys: string[]) {
  const unique = [...new Set(keys)];
  return unique.length > 8 ? `${unique.slice(0, 8).join(", ")} (+${unique.length - 8})` : unique.join(", ");
}

function identityFinding(rel: string) {
  return {
    id: "identity-file",
    level: "warning" as const,
    title: "Kimlik dosyası: {file}",
    detail: "SSH anahtarı, sertifika anahtarı ya da anahtar deposu olabilecek bir dosya kaynakta duruyor; içeriği doğrulanamadı.",
    fix: "Gizli bir anahtarsa depodan çıkar ve yenile; uygulamaya gerekiyorsa ortam değişkeni ya da kalıcı klasörle ver.",
    vars: { file: rel },
    file: rel,
  };
}

const HEAVY_TEXT = {
  node_modules: {
    title: "node_modules klasörü kaynakta: {file}",
    detail: "Bağımlılıklar derlemede yeniden kurulur; kaynaktaki kopya derlemeyi yavaşlatır, başka bir sistem için derlenmiş paketler çalışmayabilir ({n} yerde).",
  },
  venv: { title: "Python sanal ortamı kaynakta: {file}", detail: "Sanal ortam başka bir makineye özeldir ve imajda çalışmaz; derlemeyi şişirir ({n} yerde)." },
  pycache: { title: "__pycache__ klasörü kaynakta: {file}", detail: "Derlenmiş Python önbelleği gereksizdir ve eski kodu taşıyabilir ({n} yerde)." },
};

/** .env dosyasının bulgusu (yoksa null). */
function envFinding(tree: SourceTree, rel: string, name: string, opts: { isGit: boolean; relaxed: boolean; dockerignore: string | null; contextRel: string }): Omit<PreflightFinding, "group"> | null {
  const text = tree.text(rel, 256 * 1024);
  if (text === null) return null;
  const env = analyzeEnv(text);
  if (env.secretKeys.length) {
    // Git deposu değil (yüklenen dosya) ve .dockerignore imaja sokmuyorsa sır dışarı çıkmaz: uyarı yeter.
    const inContext = opts.contextRel ? rel.slice(opts.contextRel.length + 1) : rel;
    const keptOut = !opts.isGit && dockerIgnores(opts.dockerignore, inContext);
    return {
      id: "env-secret",
      level: opts.relaxed || keptOut || ENV_TEST.test(name) ? ("warning" as const) : ("critical" as const),
      title: "{file} dosyasında dolu gizli değer var",
      detail: opts.isGit
        ? "Depoya giren .env dosyası gizli değerleri git geçmişine ve imaja taşır: {keys}. Değerler rapora yazılmadı."
        : "Yüklenen .env dosyası gizli değerleri imaja taşır: {keys}. Değerler rapora yazılmadı.",
      fix: "Değerleri uygulamanın ortam değişkenlerine taşı, .env'i .gitignore ve .dockerignore'a ekle. Depoya girdiyse değerleri yenile.",
      vars: { file: rel, keys: keyList(env.secretKeys) },
      file: rel,
    };
  }
  if (env.publicOnly) return null;
  if (env.filledKeys.length) {
    return {
      id: "env-file",
      level: "warning" as const,
      title: "{file} kaynakta duruyor",
      detail: "Gizli görünen bir değer bulunmadı, ama .env dosyaları genelde sır taşır ve imaja da kopyalanır ({n} dolu değer).",
      fix: "Değerleri ortam değişkenlerine taşı; dosyayı .gitignore ve .dockerignore'a ekle.",
      vars: { file: rel, n: env.filledKeys.length },
      file: rel,
    };
  }
  return {
    id: "env-empty",
    level: "warning" as const,
    title: "{file} kaynakta duruyor (değerler boş)",
    detail: "Değerler boş ya da yer tutucu. Örnek dosyaysa adını .env.example yap; sonradan doldurulursa sır depoya girer.",
    fix: "Dosyayı .env.example olarak yeniden adlandır ya da .gitignore'a ekle.",
    vars: { file: rel },
    file: rel,
  };
}

export function checkSecrets(tree: SourceTree, ctx: PreflightContext, contextRel: string): PreflightFinding[] {
  const list = new FindingList("secrets");
  const dockerignore = tree.text(joinRel(contextRel, ".dockerignore"));
  const isGit = ctx.sourceType === "git" || ctx.sourceType === "compose";
  const critical = new Set<string>();

  for (const file of tree.files) {
    const testPath = TEST_PATH.test(file.rel);

    if (ENV_FILE.test(file.name) && !ENV_EXAMPLE.test(file.name)) {
      const f = envFinding(tree, file.rel, file.name, { isGit, relaxed: testPath, dockerignore, contextRel });
      if (f) list.add(f);
      continue;
    }

    if (file.size > tree.limits.bigFile) {
      list.add({
        id: "big-file",
        level: "warning",
        title: "Çok büyük dosya: {file}",
        detail: "{mb} MB. Büyük dosyalar derlemeyi ve imajı şişirir; çoğu zaman yanlışlıkla eklenmiş bir döküm, video ya da arşivdir.",
        fix: "Gerekmiyorsa kaldır ya da .dockerignore'a ekle; kalıcı veri için uygulamanın kalıcı klasörünü kullan.",
        vars: { file: file.rel, mb: Math.round(file.size / 1024 / 1024) },
        file: file.rel,
      });
    }

    if (SQLITE_EXT.test(file.name)) {
      const head = tree.bytes(file.rel, 16);
      if (head?.equals(SQLITE_MAGIC)) {
        list.add({
          id: "sqlite",
          level: "warning",
          title: "Veritabanı dosyası kaynakta: {file}",
          detail: "SQLite dosyası kullanıcı verisi ve parola özetleri taşıyabilir; her yayında yerel kopya canlının yerine geçer.",
          fix: "Dosyayı .gitignore ve .dockerignore'a ekle; canlı veritabanını kalıcı klasörde ya da panelin veritabanında tut.",
          vars: { file: file.rel },
          file: file.rel,
        });
      }
      continue;
    }

    if (KEYSTORE_EXT.test(file.name)) {
      list.add(identityFinding(file.rel));
      continue;
    }

    if (SKIP_TEXT.test(file.name) || LOCKFILES.has(file.name) || file.size > tree.limits.maxFileRead) continue;
    const text = tree.text(file.rel);
    if (text === null) {
      if (IDENTITY_NAME.test(file.name) || /\.pem$/i.test(file.name)) list.add(identityFinding(file.rel));
      continue;
    }

    if (text.includes("PRIVATE KEY")) {
      const serviceAccount = file.name.endsWith(".json") && /"type"\s*:\s*"service_account"/.test(text);
      const m = PRIVATE_KEY.exec(text) ?? ESCAPED_KEY.exec(text);
      if (m) {
        const level = testPath ? "warning" : "critical";
        if (level === "critical") critical.add(file.rel);
        list.add({
          id: serviceAccount ? "service-account" : "private-key",
          level,
          title: serviceAccount ? "Servis hesabı anahtarı: {file}" : "Özel anahtar: {file}",
          detail: testPath
            ? "Test ya da örnek klasöründe bir özel anahtar var. Gerçek bir anahtarsa depodan çıkar."
            : serviceAccount
              ? "Bulut servis hesabı JSON dosyası özel anahtarıyla birlikte kaynakta duruyor."
              : "Dosyada gövdesiyle birlikte bir özel anahtar var. Depoya ya da imaja giren anahtar ele geçmiş sayılmalı.",
          fix: "Anahtarı depodan ve git geçmişinden çıkar, yenisini üret; uygulamaya ortam değişkeni ya da kalıcı klasörle ver.",
          vars: { file: file.rel },
          file: file.rel,
          line: lineOf(text, m.index),
        });
        continue;
      }
    }
    if (IDENTITY_NAME.test(file.name) || (/\.pem$/i.test(file.name) && !PUBLIC_PEM.test(text))) list.add(identityFinding(file.rel));
  }

  const kinds = [...new Set(tree.heavyDirs.map((d) => d.kind))];
  for (const kind of kinds) {
    const dirs = tree.heavyDirs.filter((d) => d.kind === kind);
    list.add({
      id: `dir-${kind}`,
      level: "warning",
      title: HEAVY_TEXT[kind].title,
      detail: HEAVY_TEXT[kind].detail,
      fix: "Klasörü .gitignore ve .dockerignore'a ekle; depoya girdiyse depodan çıkar.",
      vars: { file: dirs[0]!.rel, n: dirs.length },
      file: dirs[0]!.rel,
    });
  }

  return list.result();
}

/** .gitignore ve .dockerignore yokluğu (bilgi). .dockerignore yalnız derlenen kaynakta anlamlıdır. */
export function checkIgnoreFiles(tree: SourceTree, ctx: PreflightContext, contextRel: string, builds: boolean): PreflightFinding[] {
  const out: PreflightFinding[] = [];
  if (ctx.sourceType === "git" && !tree.has(".gitignore")) {
    out.push({
      id: "no-gitignore",
      group: "secrets",
      level: "info",
      title: ".gitignore yok",
      detail: "Depoda .gitignore olmadan .env, veritabanı dosyası ve bağımlılık klasörleri kolayca depoya girer.",
      fix: "Kullandığın dil için hazır bir .gitignore ekle (ör. github.com/github/gitignore).",
    });
  }
  if (builds && !tree.has(joinRel(contextRel, ".dockerignore"))) {
    out.push({
      id: "no-dockerignore",
      group: "secrets",
      level: "info",
      title: ".dockerignore yok",
      detail: "Derleme klasöründeki her dosya (.env, yerel veritabanı, node_modules) Docker'a gönderilir ve COPY . . ile imaja girer.",
      fix: "Derleme klasörüne .git, .env, node_modules, venv gibi satırlar içeren bir .dockerignore ekle.",
    });
  }
  return out;
}
