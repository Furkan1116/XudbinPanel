import { createHmac, sign, timingSafeEqual } from "node:crypto";
import { db } from "../db.js";
import { decrypt, encrypt, signedToken, verifySignedToken } from "../lib/crypto.js";
import { getSettings, updateSettings } from "../lib/settings.js";

/**
 * GitHub App entegrasyonu. Panel, GitHub'ın "manifest" akışıyla kendi GitHub App'ini birkaç tıkla oluşturur
 * (anahtar, webhook gizli anahtarı ve izinler otomatik). Sonra:
 *  - özel repolar token girmeden klonlanır (repo başına kısa ömürlü, yalnız okuma yetkili kurulum token'ı),
 *  - uygulama oluştururken erişim verilen repolar listelenir,
 *  - tek webhook adresi push ve PR olaylarını eşleşen uygulamalara dağıtır (repo başına webhook kurmaya gerek yok),
 *  - PR önizlemelerinin adresi PR'a yorum olarak yazılır.
 * İzinler: contents:read, metadata:read, pull_requests:write (yalnız yorum için). Olaylar: push, pull_request.
 */
export type GithubAppConfig = {
  id: number;
  slug: string;
  name: string;
  htmlUrl: string;
  owner: string;
  pem: string; // şifreli
  webhookSecret: string; // şifreli
  clientId: string;
  clientSecret: string; // şifreli
};

const API = "https://api.github.com";

export function githubApp(): GithubAppConfig | null {
  const g = getSettings().githubApp;
  return g?.id && g.pem ? g : null;
}

/** Uygulama manifesti: GitHub bu bilgilerle App'i oluşturur. */
export function appManifest(origin: string, name: string) {
  return {
    name,
    url: origin,
    hook_attributes: { url: `${origin}/api/webhooks/github`, active: true },
    redirect_url: `${origin}/api/webhooks/github/manifest`,
    setup_url: `${origin}/settings?tab=github`,
    setup_on_update: true,
    public: false,
    default_permissions: { contents: "read", metadata: "read", pull_requests: "write" },
    default_events: ["push", "pull_request"],
  };
}

// Manifest akışının state değeri: imzalı ve 1 saat geçerli (panel bu arada yeniden başlasa da doğrulanır).
export const newManifestState = () => signedToken("github-manifest");

/** GitHub'ın döndürdüğü kodla App bilgilerini (özel anahtar dahil) alır ve şifreli saklar. */
export async function completeManifest(code: string, state: string) {
  if (!verifySignedToken("github-manifest", state, 3_600_000)) throw new Error("İsteğin süresi doldu veya geçersiz; panelden tekrar başlat");
  if (!/^[\w-]{1,100}$/.test(code)) throw new Error("Geçersiz kod");
  const res = await fetch(`${API}/app-manifests/${code}/conversions`, {
    method: "POST",
    headers: { Accept: "application/vnd.github+json", "User-Agent": "xudbin" },
    signal: AbortSignal.timeout(15_000),
  });
  const b = (await res.json().catch(() => ({}))) as Record<string, any>;
  if (!res.ok || !b.id || !b.pem) throw new Error(`GitHub App oluşturulamadı: ${b.message ?? res.status}`);
  const cfg: GithubAppConfig = {
    id: Number(b.id),
    slug: String(b.slug),
    name: String(b.name),
    htmlUrl: String(b.html_url),
    owner: String(b.owner?.login ?? ""),
    pem: encrypt(String(b.pem)),
    webhookSecret: encrypt(String(b.webhook_secret ?? "")),
    clientId: String(b.client_id ?? ""),
    clientSecret: encrypt(String(b.client_secret ?? "")),
  };
  updateSettings({ githubApp: cfg });
  tokenCache.clear();
  installCache.clear();
  return cfg;
}

export function disconnectGithubApp() {
  updateSettings({ githubApp: null });
  tokenCache.clear();
  installCache.clear();
}

/** App kimliğiyle imzalı kısa ömürlü JWT (RS256, 9 dakika). */
function appJwt(cfg: GithubAppConfig) {
  const now = Math.floor(Date.now() / 1000);
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = `${enc({ alg: "RS256", typ: "JWT" })}.${enc({ iat: now - 60, exp: now + 540, iss: String(cfg.id) })}`;
  return `${head}.${sign("RSA-SHA256", Buffer.from(head), decrypt(cfg.pem)).toString("base64url")}`;
}

async function gh<T>(path: string, auth: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path.startsWith("http") ? path : `${API}${path}`, {
    ...init,
    headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${auth}`, "User-Agent": "xudbin", "X-GitHub-Api-Version": "2022-11-28", ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(15_000),
  });
  const b = (await res.json().catch(() => ({}))) as T & { message?: string };
  if (!res.ok) throw Object.assign(new Error(`GitHub: ${b.message ?? res.status}`), { status: res.status });
  return b;
}

/** "https://github.com/owner/repo(.git)" → "owner/repo"; GitHub değilse null. */
export function githubRepoOf(url: string | null | undefined) {
  const m = /^https:\/\/(?:[^@/]+@)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(url ?? "");
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
}

const tokenCache = new Map<number, { token: string; exp: number }>();
const installCache = new Map<string, { id: number | null; at: number }>();

async function installationToken(cfg: GithubAppConfig, installationId: number) {
  const c = tokenCache.get(installationId);
  if (c && c.exp - Date.now() > 5 * 60_000) return c.token;
  const b = await gh<{ token: string; expires_at: string }>(`/app/installations/${installationId}/access_tokens`, appJwt(cfg), { method: "POST" });
  tokenCache.set(installationId, { token: b.token, exp: Date.parse(b.expires_at) });
  return b.token;
}

async function installationFor(cfg: GithubAppConfig, repo: string) {
  const c = installCache.get(repo);
  if (c && Date.now() - c.at < 10 * 60_000) return c.id;
  let id: number | null = null;
  try {
    id = (await gh<{ id: number }>(`/repos/${repo}/installation`, appJwt(cfg))).id;
  } catch (err) {
    if ((err as { status?: number }).status !== 404) throw err;
  }
  installCache.set(repo, { id, at: Date.now() });
  return id;
}

/**
 * Repo için klonlama token'ı: App bu repoya kuruluysa kısa ömürlü kurulum token'ı, değilse uygulamanın
 * kendi token'ı (varsa). GitHub'a ulaşılamazsa sessizce kendi token'ına düşer.
 */
export async function gitTokenFor(gitUrl: string | null | undefined, ownToken: string) {
  const cfg = githubApp();
  const repo = githubRepoOf(gitUrl);
  if (!cfg || !repo || ownToken) return ownToken;
  try {
    const inst = await installationFor(cfg, repo);
    return inst ? await installationToken(cfg, inst) : ownToken;
  } catch {
    return ownToken;
  }
}

export type GithubRepo = { fullName: string; url: string; defaultBranch: string; private: boolean; account: string };

/** App'in erişim izni verilen tüm repoları (kurulum başına en fazla 300). */
export async function listRepos(): Promise<{ installations: { id: number; account: string; type: string; settingsUrl: string }[]; repos: GithubRepo[] }> {
  const cfg = githubApp();
  if (!cfg) return { installations: [], repos: [] };
  const inst = await gh<{ id: number; account: { login: string; type: string }; html_url: string }[]>("/app/installations?per_page=100", appJwt(cfg));
  const repos: GithubRepo[] = [];
  for (const i of inst) {
    const token = await installationToken(cfg, i.id);
    for (let page = 1; page <= 3; page++) {
      const b = await gh<{ repositories: { full_name: string; clone_url: string; default_branch: string; private: boolean }[] }>(`/installation/repositories?per_page=100&page=${page}`, token);
      for (const r of b.repositories) {
        repos.push({ fullName: r.full_name, url: r.clone_url, defaultBranch: r.default_branch, private: r.private, account: i.account.login });
        installCache.set(r.full_name.toLowerCase(), { id: i.id, at: Date.now() });
      }
      if (b.repositories.length < 100) break;
    }
  }
  repos.sort((a, b) => a.fullName.localeCompare(b.fullName));
  return { installations: inst.map((i) => ({ id: i.id, account: i.account.login, type: i.account.type, settingsUrl: i.html_url })), repos };
}

export function verifyGithubSignature(raw: string, header: string | undefined) {
  const cfg = githubApp();
  const secret = cfg ? decrypt(cfg.webhookSecret) : "";
  if (!secret || !header?.startsWith("sha256=")) return false;
  const expected = Buffer.from(`sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`);
  const got = Buffer.from(header);
  return got.length === expected.length && timingSafeEqual(got, expected);
}

/** Push/PR olayının repo'suna bağlı uygulamalar (ana uygulamalar; önizlemeler hariç). */
export function appsForRepo(repo: string) {
  const rows = db.prepare("SELECT id, git_url FROM apps WHERE source_type = 'git' AND parent_app_id IS NULL").all() as { id: number; git_url: string | null }[];
  return rows.filter((r) => githubRepoOf(r.git_url) === repo.toLowerCase()).map((r) => r.id);
}

/** PR'a App kimliğiyle yorum yazar (App kurulu değilse false). */
export async function commentAsApp(repo: string, prNumber: number, bodyText: string) {
  const cfg = githubApp();
  if (!cfg) return false;
  const inst = await installationFor(cfg, repo.toLowerCase()).catch(() => null);
  if (!inst) return false;
  const token = await installationToken(cfg, inst);
  await gh(`/repos/${repo}/issues/${prNumber}/comments`, token, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ body: bodyText }) });
  return true;
}
