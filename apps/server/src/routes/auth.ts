import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { SESSION_COOKIE } from "../auth/middleware.js";
import { hashPassword, verifyPassword } from "../auth/password.js";
import { createSession, destroySession, validateSession } from "../auth/session.js";
import { checkSetupToken, clearSetupToken } from "../auth/setup-token.js";
import { verifyTotp } from "../auth/totp.js";
import { decrypt } from "../lib/crypto.js";
import { recordPanelEvent } from "../services/security.js";
import { config } from "../config.js";
import { db } from "../db.js";
import { clientIp } from "../lib/client-ip.js";
import { createRateLimiter } from "../lib/rate-limit.js";

// Aynı IP'den 15 dakikada en fazla 10 başarısız giriş denemesi.
const loginLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 10 });

// Kullanıcı bulunamadığında da hash doğrulaması yapmak için kullanılır.
const DUMMY_HASH = await hashPassword("zamanlama-saldirisina-karsi-sahte-sifre");

const userCount = () => (db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;

const credentials = z.object({
  email: z.email("Geçerli bir e-posta girin").max(254),
  password: z.string().min(1).max(256),
  code: z.string().max(10).optional(),
});

const setupSchema = credentials.extend({
  setupToken: z.string({ error: "Kurulum anahtarı gerekli" }).min(1, "Kurulum anahtarı gerekli").max(100),
  name: z.string().trim().min(1, "İsim gerekli").max(100),
  password: z.string().min(10, "Şifre en az 10 karakter olmalı").max(256),
});

function startSession(c: Context, userId: number) {
  const { token, expiresAt } = createSession(userId, { ip: clientIp(c), userAgent: c.req.header("user-agent") });
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: "Strict",
    path: "/",
    expires: expiresAt,
  });
}

export const authRoutes = new Hono()
  .get("/status", (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    return c.json({
      setupRequired: userCount() === 0,
      user: token ? validateSession(token) : null,
    });
  })

  // İlk kurulum: henüz hiç kullanıcı yoksa yönetici hesabını oluşturur.
  .post("/setup", async (c) => {
    if (userCount() > 0) return c.json({ error: "Kurulum zaten tamamlanmış" }, 409);
    const parsed = setupSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "Geçersiz istek" }, 400);

    const retryAfter = loginLimiter.hit(clientIp(c));
    if (retryAfter) return c.json({ error: "Çok fazla deneme. Biraz sonra tekrar deneyin." }, 429);
    if (!checkSetupToken(parsed.data.setupToken)) {
      return c.json({ error: "Kurulum anahtarı geçersiz. Kurulum çıktısındaki linki kullan." }, 403);
    }

    const { email, name, password } = parsed.data;
    const result = db
      .prepare("INSERT INTO users (email, name, password_hash, created_at) VALUES (?, ?, ?, ?)")
      .run(email, name, await hashPassword(password), Date.now());
    clearSetupToken();
    startSession(c, Number(result.lastInsertRowid));
    return c.json({ ok: true });
  })

  .post("/login", async (c) => {
    const ip = clientIp(c);
    const parsed = credentials.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "E-posta veya şifre hatalı" }, 400);

    const retryAfter = loginLimiter.hit(ip);
    if (retryAfter) {
      c.header("Retry-After", String(retryAfter));
      return c.json({ error: `Çok fazla deneme. ${Math.ceil(retryAfter / 60)} dakika sonra tekrar deneyin.` }, 429);
    }

    const user = db.prepare("SELECT id, password_hash, totp_secret FROM users WHERE email = ?").get(parsed.data.email) as
      | { id: number; password_hash: string; totp_secret: string | null }
      | undefined;
    // Kullanıcı yoksa da hash doğrulaması yapılır ki yanıt süresi e-postanın varlığını ele vermesin.
    const valid = await verifyPassword(parsed.data.password, user?.password_hash ?? DUMMY_HASH);
    if (!user || !valid) {
      recordPanelEvent(ip, "panel_login", "/api/auth/login", c.req.header("user-agent"));
      return c.json({ error: "E-posta veya şifre hatalı" }, 401);
    }
    if (user.totp_secret) {
      if (!parsed.data.code) return c.json({ error: "Doğrulama kodu gerekli", needsCode: true }, 401);
      if (!verifyTotp(decrypt(user.totp_secret), parsed.data.code)) {
        recordPanelEvent(ip, "panel_login", "/api/auth/login (2FA)", c.req.header("user-agent"));
        return c.json({ error: "Doğrulama kodu hatalı", needsCode: true }, 401);
      }
    }

    loginLimiter.reset(ip);
    startSession(c, user.id);
    return c.json({ ok: true });
  })

  .post("/logout", (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) destroySession(token);
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true });
  });
