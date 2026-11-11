import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { db } from "../db.js";
import { decrypt, encrypt } from "../lib/crypto.js";
import { HttpError } from "../lib/http.js";
import { dockerFor, withTimeout } from "./docker.js";
import { listServers } from "./servers.js";

/**
 * Özel imaj kayıt depoları (GHCR, Docker Hub, GitLab, kendi registry'n) için yönetici girişleri.
 * Şifre/token `encrypt()` ile saklanır, API'den hiç dönmez. Panel imaj çekerken, temel imajı özel olan
 * bir derlemede ve Compose deploy'larında imaj adresindeki kayıt deposu adresine göre girişi kendisi kullanır.
 */

export type RegistryRow = {
  id: number;
  name: string;
  host: string;
  username: string;
  secret: string;
  created_at: number;
  verified_at: number | null;
};

export type RegistryLogin = { host: string; username: string; password: string };

/** Docker Hub'ın adları. Kullanıcı hangisini yazarsa yazsın "docker.io" olarak saklanır. */
const DOCKER_HUB = "docker.io";
const DOCKER_HUB_ALIASES = new Set(["docker.io", "index.docker.io", "registry-1.docker.io", "registry.hub.docker.com", "hub.docker.com"]);
/** docker CLI ve Engine, Docker Hub girişini bu anahtarla arar (config.json `auths`, X-Registry-Config). */
export const DOCKER_HUB_AUTH_KEY = "https://index.docker.io/v1/";

const HOST_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*(?::\d{1,5})?$|^\[[0-9a-f:]+\](?::\d{1,5})?$/;

/**
 * Kullanıcının yazdığı adresi kayıt deposu adına çevirir: şema, yol ve sondaki / atılır, küçük harfe
 * çevrilir, Docker Hub'ın bütün adları "docker.io" olur. Geçersizse null.
 */
export function normalizeRegistryHost(input: string): string | null {
  let s = input.trim().toLowerCase();
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  s = s.split("/")[0] ?? "";
  if (!s || s.includes("@") || !HOST_RE.test(s)) return null;
  const port = /:(\d+)$/.exec(s)?.[1];
  if (port && (Number(port) < 1 || Number(port) > 65535)) return null;
  if (DOCKER_HUB_ALIASES.has(s)) return DOCKER_HUB;
  // Docker Hub'ın 443 portuyla yazılmış hali de aynı depo.
  if (s.endsWith(":443") && DOCKER_HUB_ALIASES.has(s.slice(0, -4))) return DOCKER_HUB;
  return s;
}

/**
 * İmaj adresinin hangi kayıt deposunda olduğunu bulur (Docker'ın kendi kuralı): ilk "/" öncesindeki parça
 * nokta ya da port içeriyorsa veya "localhost" ise depo adresidir; değilse imaj Docker Hub'dadır
 * ("nginx", "kullanici/uygulama:1").
 */
export function registryHostOf(image: string): string {
  const ref = image.trim();
  const slash = ref.indexOf("/");
  if (slash === -1) return DOCKER_HUB;
  const first = ref.slice(0, slash);
  if (first.includes(".") || first.includes(":") || first === "localhost" || first.startsWith("[")) {
    return normalizeRegistryHost(first) ?? first.toLowerCase();
  }
  return DOCKER_HUB;
}

/** Docker'ın giriş anahtarı (config.json `auths`, X-Registry-Config, /auth serveraddress). */
export const authKeyFor = (host: string) => (host === DOCKER_HUB ? DOCKER_HUB_AUTH_KEY : host);

function rows() {
  return db.prepare("SELECT * FROM registry_credentials ORDER BY host").all() as RegistryRow[];
}

/** Kayıtlı bütün girişler, şifreleri çözülmüş olarak. Yalnız panelin içinde kullanılır; API'ye asla dönmez. */
export function registryLogins(): RegistryLogin[] {
  const out: RegistryLogin[] = [];
  for (const r of rows()) {
    try {
      out.push({ host: r.host, username: r.username, password: decrypt(r.secret) });
    } catch {
      // Bozuk ya da başka anahtarla şifrelenmiş kayıt: çekme girişsiz denenir, deploy logu Docker'ın hatasını gösterir.
    }
  }
  return out;
}

/** dockerode `pull` için giriş (imajın deposunda kayıtlı giriş yoksa undefined). */
export function pullAuthFor(image: string, logins = registryLogins()) {
  const host = registryHostOf(image);
  const login = logins.find((l) => l.host === host);
  return login ? { username: login.username, password: login.password, serveraddress: authKeyFor(host) } : undefined;
}

/** dockerode `buildImage` `registryconfig` (X-Registry-Config): temel imajı özel bir depodan çekebilsin. */
export function buildRegistryConfig(logins = registryLogins()) {
  if (!logins.length) return undefined;
  return Object.fromEntries(logins.map((l) => [authKeyFor(l.host), { username: l.username, password: l.password, serveraddress: authKeyFor(l.host) }]));
}

/** docker CLI'nin okuduğu config.json içeriği (`auths`). */
export function dockerConfigJson(logins: RegistryLogin[]) {
  return JSON.stringify({
    auths: Object.fromEntries(logins.map((l) => [authKeyFor(l.host), { auth: Buffer.from(`${l.username}:${l.password}`).toString("base64") }])),
  });
}

/** Deploy loglarında görünmemesi gereken değerler (şifre ve config.json'daki base64 hali). */
export function registrySecrets(logins: RegistryLogin[]) {
  return logins.flatMap((l) => [l.password, Buffer.from(`${l.username}:${l.password}`).toString("base64")]).filter((s) => s.length >= 4);
}

/**
 * Compose deploy'u için geçici DOCKER_CONFIG klasörü: yalnız `config.json` (girişler) ve varsa docker CLI'nin
 * eklenti klasörüne (cli-plugins, `docker compose` orada olabilir) bağlantı. Klasör deploy klasörünün (ve
 * compose dosyasının erişebileceği yolların) dışında, 0700 izinle açılır; çağıran iş bitince `cleanup()` çağırır.
 * Kayıtlı giriş yoksa null: davranış bugünkü gibi kalır.
 */
export function prepareComposeDockerConfig(logins = registryLogins(), opts: { baseDir?: string; pluginsFrom?: string | null } = {}) {
  if (!logins.length) return null;
  const dir = fs.mkdtempSync(path.join(opts.baseDir ?? os.tmpdir(), "xudbin-auth-"));
  fs.chmodSync(dir, 0o700);
  fs.writeFileSync(path.join(dir, "config.json"), dockerConfigJson(logins), { mode: 0o600 });
  const plugins = opts.pluginsFrom === undefined ? defaultPluginsDir() : opts.pluginsFrom;
  if (plugins && fs.existsSync(plugins)) {
    try {
      fs.symlinkSync(plugins, path.join(dir, "cli-plugins"));
    } catch {}
  }
  return { dir, secrets: registrySecrets(logins), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** Panel sürecinin normalde kullandığı docker CLI eklenti klasörü (geliştirme makinesinde compose burada olabilir). */
function defaultPluginsDir() {
  const base = process.env.DOCKER_CONFIG || path.join(os.homedir(), ".docker");
  return path.join(base, "cli-plugins");
}

// ---------------------------------------------------------------------------
// Yönetim (yalnız yönetici; rota middleware'i denetler)
// ---------------------------------------------------------------------------

export type RegistryInfo = { id: number; name: string; host: string; username: string; createdAt: number; verifiedAt: number | null };

const info = (r: RegistryRow): RegistryInfo => ({ id: r.id, name: r.name, host: r.host, username: r.username, createdAt: r.created_at, verifiedAt: r.verified_at });

export function listRegistries(): RegistryInfo[] {
  return rows().map(info);
}

function requireHost(input: string) {
  const host = normalizeRegistryHost(input);
  if (!host) throw new HttpError(400, "Kayıt deposu adresi geçersiz (ör. ghcr.io, registry.gitlab.com, docker.io)");
  return host;
}

export function createRegistry(input: { name: string; host: string; username: string; password: string }, verified = false): RegistryInfo {
  const host = requireHost(input.host);
  if (db.prepare("SELECT 1 FROM registry_credentials WHERE host = ?").get(host)) throw new HttpError(409, `${host} için zaten bir giriş var. Değiştirmek için onu düzenle.`);
  const now = Date.now();
  const id = Number(
    db
      .prepare("INSERT INTO registry_credentials (name, host, username, secret, created_at, verified_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(input.name || host, host, input.username, encrypt(input.password), now, verified ? now : null).lastInsertRowid,
  );
  return info(getRegistry(id));
}

export function getRegistry(id: number) {
  const row = db.prepare("SELECT * FROM registry_credentials WHERE id = ?").get(id) as RegistryRow | undefined;
  if (!row) throw new HttpError(404, "Giriş bulunamadı");
  return row;
}

/** Ad, kullanıcı adı ya da şifre değişir; şifre boş bırakılırsa eskisi kalır. Depo adresi değişmez (yeni giriş ekle). */
export function updateRegistry(id: number, input: { name?: string; username?: string; password?: string }, verified = false) {
  const row = getRegistry(id);
  const changedLogin = (input.username !== undefined && input.username !== row.username) || Boolean(input.password);
  db.prepare("UPDATE registry_credentials SET name = ?, username = ?, secret = ?, verified_at = ? WHERE id = ?").run(
    input.name || row.name,
    input.username ?? row.username,
    input.password ? encrypt(input.password) : row.secret,
    verified ? Date.now() : changedLogin ? null : row.verified_at,
    id,
  );
  return info(getRegistry(id));
}

export function deleteRegistry(id: number) {
  getRegistry(id);
  db.prepare("DELETE FROM registry_credentials WHERE id = ?").run(id);
}

export function savedLogin(id: number): RegistryLogin {
  const row = getRegistry(id);
  return { host: row.host, username: row.username, password: decrypt(row.secret) };
}

export function markVerified(id: number) {
  db.prepare("UPDATE registry_credentials SET verified_at = ? WHERE id = ?").run(Date.now(), id);
}

/**
 * Girişi kayıt deposuna karşı doğrular: panelin kendi sunucusundaki Docker Engine'in /auth uç noktası
 * (`docker login` ile aynı denetim). Hata metninde şifre geçerse gizlenir.
 */
export async function testRegistryLogin(login: RegistryLogin): Promise<void> {
  const local = listServers().find((s) => s.kind === "local");
  if (!local) throw new HttpError(503, "Panelin yerel sunucusu bulunamadı");
  try {
    await withTimeout(
      dockerFor(local).checkAuth({ username: login.username, password: login.password, serveraddress: authKeyFor(login.host) }),
      20_000,
      "Kayıt deposu 20 saniyede yanıt vermedi",
    );
  } catch (err) {
    let msg = String((err as { json?: { message?: string } }).json?.message ?? (err as Error).message ?? "bilinmeyen hata");
    for (const s of registrySecrets([login])) msg = msg.split(s).join("***");
    msg = msg.replace(/^\(HTTP code \d+\)\s*[\w ]*-\s*/, "").trim();
    throw new HttpError(422, `Giriş doğrulanamadı: ${msg.slice(0, 300)}`);
  }
}
