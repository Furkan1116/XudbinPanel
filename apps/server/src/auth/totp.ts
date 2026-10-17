import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// RFC 6238 TOTP (30 sn, 6 hane, SHA-1) — Google Authenticator, 1Password vb. ile uyumlu.
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function generateTotpSecret() {
  const bytes = randomBytes(20);
  let bits = "";
  for (const b of bytes) bits += b.toString(2).padStart(8, "0");
  let out = "";
  for (let i = 0; i + 5 <= bits.length; i += 5) out += ALPHABET[parseInt(bits.slice(i, i + 5), 2)];
  return out;
}

function base32Decode(s: string) {
  let bits = "";
  for (const c of s.replace(/=+$/, "").toUpperCase()) {
    const v = ALPHABET.indexOf(c);
    if (v < 0) continue;
    bits += v.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

export function codeAt(secret: string, counter: number) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const h = createHmac("sha1", base32Decode(secret)).update(buf).digest();
  const o = h[h.length - 1]! & 0xf;
  const n = ((h[o]! & 0x7f) << 24) | (h[o + 1]! << 16) | (h[o + 2]! << 8) | h[o + 3]!;
  return String(n % 1_000_000).padStart(6, "0");
}

/** Kod geçerliyse eşleştiği 30 sn'lik pencerenin numarası (saat kaymasına karşı ±1 pencere), değilse null. */
export function totpCounter(secret: string, code: string): number | null {
  const clean = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(clean)) return null;
  const now = Math.floor(Date.now() / 30_000);
  for (const d of [-1, 0, 1]) if (timingSafeEqual(Buffer.from(codeAt(secret, now + d)), Buffer.from(clean))) return now + d;
  return null;
}

export function verifyTotp(secret: string, code: string) {
  return totpCounter(secret, code) !== null;
}

export const totpUri = (secret: string, account: string) =>
  `otpauth://totp/Xudbin:${encodeURIComponent(account)}?secret=${secret}&issuer=Xudbin&algorithm=SHA1&digits=6&period=30`;
