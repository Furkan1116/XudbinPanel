import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;

// OWASP'ın scrypt için önerdiği parametreler (N=2^17, r=8, p=1).
const PARAMS = { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
const KEY_LEN = 64;

/** Biçim: scrypt$N$r$p$salt$hash (base64url) */
export function hashPassword(password: string): Promise<string> {
  return withSlot(() => hashPasswordNow(password));
}

async function hashPasswordNow(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, KEY_LEN, PARAMS);
  return ["scrypt", PARAMS.N, PARAMS.r, PARAMS.p, salt.toString("base64url"), hash.toString("base64url")].join("$");
}

/**
 * Her doğrulama ~128 MB bellek kullanır. Aynı anda en fazla 2 doğrulama çalışır, en fazla 20'si sırada bekler;
 * fazlası reddedilir. Böylece çok sayıda eşzamanlı giriş denemesi sunucunun belleğini tüketemez.
 */
const MAX_ACTIVE = 2;
const MAX_WAITING = 20;
let active = 0;
const waiting: (() => void)[] = [];

export class TooBusyError extends Error {}

async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_ACTIVE) {
    if (waiting.length >= MAX_WAITING) throw new TooBusyError("Sunucu şu an çok fazla giriş denemesi işliyor. Biraz sonra tekrar dene.");
    await new Promise<void>((r) => waiting.push(r));
  }
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

export function verifyPassword(password: string, stored: string): Promise<boolean> {
  return withSlot(() => verifyPasswordNow(password, stored));
}

async function verifyPasswordNow(password: string, stored: string): Promise<boolean> {
  const [algo, N, r, p, salt, hash] = stored.split("$");
  if (algo !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64url");
  const actual = await scryptAsync(password, Buffer.from(salt, "base64url"), expected.length, {
    N: Number(N),
    r: Number(r),
    p: Number(p),
    maxmem: PARAMS.maxmem,
  });
  return timingSafeEqual(actual, expected);
}
