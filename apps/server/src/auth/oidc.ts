import { createHash, createPublicKey, createVerify, randomBytes, timingSafeEqual } from "node:crypto";
import { decrypt } from "../lib/crypto.js";
import { getSettings } from "../lib/settings.js";

/**
 * OpenID Connect ile giriş (Google, Microsoft Entra, Keycloak, Authentik, GitLab, Okta...).
 * Yetkilendirme kodu akışı + PKCE (S256); state ve nonce sunucuda tutulur. id_token, sağlayıcının JWKS
 * anahtarlarıyla (RS256/ES256) imza, iss, aud, exp ve nonce açısından doğrulanır. Bağımlılık yok.
 */
export type OidcConfig = {
  issuer: string;
  clientId: string;
  clientSecret: string; // şifreli
  label: string;
  autoCreate: boolean;
  allowedDomains: string; // virgülle; boşsa yalnız mevcut kullanıcılar
  /** Yerel şifresi olan bir üye hesabına SSO ile girişe izin verir (varsayılan kapalı). Şifreli yönetici hesapları hiçbir zaman bağlanmaz. */
  linkExisting?: boolean;
};

/**
 * Var olan bir hesaba SSO ile girilebilir mi? Kimlik sağlayıcıya güven, hesabın yerel korumasını (şifre, 2FA) aşmamalı:
 *  - SSO ile oluşturulmuş hesaplar ('!sso', yerel şifresi yok): evet.
 *  - Yerel şifreli yönetici ya da 2FA'lı hesap: hayır (e-posta eşleşmesiyle devralma ve 2FA atlama kapalı).
 *  - Yerel şifreli üye: yalnız yönetici "mevcut hesaplara bağlanmaya izin ver" ayarını açtıysa.
 */
export function ssoMayLogInto(user: { password_hash: string; role: string; totp_secret: string | null }, cfg: Pick<OidcConfig, "linkExisting">) {
  if (user.password_hash === "!sso") return true;
  if (user.role === "admin" || user.totp_secret) return false;
  return cfg.linkExisting === true;
}

type Jwk = { kty: string; kid?: string; alg?: string; [k: string]: unknown };

type Discovery = { issuer: string; authorization_endpoint: string; token_endpoint: string; jwks_uri: string };

let discoveryCache: { issuer: string; at: number; doc: Discovery } | null = null;
let jwksCache: { uri: string; at: number; keys: Jwk[] } | null = null;

export function oidcConfig(): OidcConfig | null {
  const c = getSettings().oidc;
  return c?.issuer && c.clientId && c.clientSecret ? c : null;
}

async function discovery(issuer: string): Promise<Discovery> {
  if (discoveryCache?.issuer === issuer && Date.now() - discoveryCache.at < 3_600_000) return discoveryCache.doc;
  const res = await fetch(`${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Sağlayıcı yapılandırması okunamadı (HTTP ${res.status})`);
  const doc = (await res.json()) as Discovery;
  if (!doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri) throw new Error("Sağlayıcı yapılandırması eksik");
  discoveryCache = { issuer, at: Date.now(), doc };
  return doc;
}

async function jwks(uri: string, force = false) {
  if (!force && jwksCache?.uri === uri && Date.now() - jwksCache.at < 3_600_000) return jwksCache.keys;
  const res = await fetch(uri, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Sağlayıcı anahtarları okunamadı (HTTP ${res.status})`);
  const keys = ((await res.json()) as { keys: Jwk[] }).keys;
  jwksCache = { uri, at: Date.now(), keys };
  return keys;
}

const b64url = (b: Buffer) => b.toString("base64url");

// Bekleyen girişler: state → { nonce, verifier, redirectUri, at }. 10 dakika geçerli.
const pending = new Map<string, { nonce: string; verifier: string; redirectUri: string; at: number }>();
// /oidc/start yetkisiz olduğundan harita sınırlıdır: yüzlerce sahte başlatma belleği şişirmesin.
const MAX_PENDING = 500;
function sweep() {
  for (const [k, v] of pending) if (Date.now() - v.at > 10 * 60_000) pending.delete(k);
}

/** Giriş başlatır. `state` aynı zamanda tarayıcıya kısa ömürlü HttpOnly çerezle bağlanır (giriş-CSRF'ye karşı). */
export async function startLogin(redirectUri: string): Promise<{ url: string; state: string }> {
  const cfg = oidcConfig();
  if (!cfg) throw new Error("Tek oturum açma (SSO) yapılandırılmamış");
  const doc = await discovery(cfg.issuer);
  sweep();
  if (pending.size >= MAX_PENDING) throw new Error("Çok fazla bekleyen giriş var; birkaç dakika sonra tekrar dene");
  const state = b64url(randomBytes(24));
  const nonce = b64url(randomBytes(24));
  const verifier = b64url(randomBytes(48));
  pending.set(state, { nonce, verifier, redirectUri, at: Date.now() });
  const url = new URL(doc.authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", cfg.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("code_challenge", b64url(createHash("sha256").update(verifier).digest()));
  url.searchParams.set("code_challenge_method", "S256");
  return { url: url.toString(), state };
}

/** id_token'ı doğrular ve içeriğini döndürür. */
export async function verifyIdToken(token: string, cfg: { issuer: string; clientId: string }, jwksUri: string, nonce?: string) {
  const [h, p, sig] = token.split(".");
  if (!h || !p || !sig) throw new Error("id_token biçimi geçersiz");
  const header = JSON.parse(Buffer.from(h, "base64url").toString()) as { alg: string; kid?: string };
  const payload = JSON.parse(Buffer.from(p, "base64url").toString()) as Record<string, unknown>;
  const algs: Record<string, string> = { RS256: "RSA-SHA256", RS384: "RSA-SHA384", RS512: "RSA-SHA512", ES256: "SHA256", ES384: "SHA384", PS256: "RSA-SHA256" };
  if (!algs[header.alg]) throw new Error(`Desteklenmeyen imza algoritması: ${header.alg}`);
  let keys = await jwks(jwksUri);
  let jwk = keys.find((k) => !header.kid || k.kid === header.kid);
  if (!jwk) {
    keys = await jwks(jwksUri, true); // anahtar dönmüş olabilir
    jwk = keys.find((k) => !header.kid || k.kid === header.kid);
  }
  if (!jwk) throw new Error("İmza anahtarı bulunamadı");
  const key = createPublicKey({ key: jwk as never, format: "jwk" });
  const v = createVerify(algs[header.alg]!);
  v.update(`${h}.${p}`);
  const ok = header.alg.startsWith("ES")
    ? v.verify({ key, dsaEncoding: "ieee-p1363" }, Buffer.from(sig, "base64url"))
    : header.alg.startsWith("PS")
      ? v.verify({ key, padding: 6 /* RSA_PKCS1_PSS_PADDING */ }, Buffer.from(sig, "base64url"))
      : v.verify(key, Buffer.from(sig, "base64url"));
  if (!ok) throw new Error("id_token imzası geçersiz");
  const now = Date.now() / 1000;
  if (payload.iss !== cfg.issuer && payload.iss !== cfg.issuer.replace(/\/+$/, "")) throw new Error("id_token başka bir sağlayıcıya ait");
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(cfg.clientId)) throw new Error("id_token bu uygulama için verilmemiş");
  if (typeof payload.exp !== "number" || payload.exp < now - 60) throw new Error("id_token süresi dolmuş");
  if (nonce !== undefined && payload.nonce !== nonce) throw new Error("id_token nonce eşleşmiyor");
  return payload;
}

/** `browserState`: girişi başlatan tarayıcıya verilen çerezdeki değer; callback'teki state ile aynı olmalı. */
export async function finishLogin(state: string, code: string, browserState: string) {
  const cfg = oidcConfig();
  if (!cfg) throw new Error("Tek oturum açma (SSO) yapılandırılmamış");
  const p = pending.get(state);
  pending.delete(state);
  const a = Buffer.from(state);
  const b = Buffer.from(browserState);
  if (!state || a.length !== b.length || !timingSafeEqual(a, b)) throw new Error("Giriş isteği bu tarayıcıdan başlatılmamış; tekrar dene");
  if (!p || Date.now() - p.at > 10 * 60_000) throw new Error("Giriş isteğinin süresi doldu; tekrar dene");
  const doc = await discovery(cfg.issuer);
  const res = await fetch(doc.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: p.redirectUri,
      client_id: cfg.clientId,
      client_secret: decrypt(cfg.clientSecret),
      code_verifier: p.verifier,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await res.json().catch(() => ({}))) as { id_token?: string; error?: string; error_description?: string };
  if (!res.ok || !body.id_token) throw new Error(`Sağlayıcı girişi onaylamadı: ${body.error_description ?? body.error ?? res.status}`);
  const claims = await verifyIdToken(body.id_token, cfg, doc.jwks_uri, p.nonce);
  const email = String(claims.email ?? "").toLowerCase();
  if (!email) throw new Error("Sağlayıcı e-posta adresi göndermedi (scope: email)");
  if (claims.email_verified !== true) throw new Error("E-posta adresi sağlayıcıda doğrulanmamış");
  return { email, name: String(claims.name ?? claims.preferred_username ?? email.split("@")[0]), cfg };
}
