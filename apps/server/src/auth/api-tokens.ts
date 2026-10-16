import { createHash, randomBytes } from "node:crypto";
import { db } from "../db.js";
import type { SessionUser } from "./session.js";

/**
 * API anahtarları: CI/CD ve CLI için. Biçim "xb_<rastgele>"; veritabanında yalnız SHA-256 özeti tutulur.
 * Anahtar, sahibinin yetkileriyle çalışır; salt okunur anahtarlar hiçbir şeyi değiştiremez.
 */
const hash = (t: string) => createHash("sha256").update(t).digest("hex");

export function createApiToken(userId: number, name: string, opts: { readOnly?: boolean; expiresInDays?: number | null } = {}) {
  const token = `xb_${randomBytes(30).toString("base64url")}`;
  const expires = opts.expiresInDays ? Date.now() + opts.expiresInDays * 86_400_000 : null;
  const res = db
    .prepare("INSERT INTO api_tokens (user_id, name, token_hash, prefix, read_only, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(userId, name, hash(token), token.slice(0, 10), opts.readOnly ? 1 : 0, expires, Date.now());
  return { id: Number(res.lastInsertRowid), token };
}

export function validateApiToken(token: string): { user: SessionUser; readOnly: boolean } | null {
  if (!token.startsWith("xb_")) return null;
  const row = db
    .prepare(
      `SELECT t.id AS tid, t.read_only, t.expires_at, u.id, u.email, u.name, u.role
       FROM api_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ?`,
    )
    .get(hash(token)) as { tid: number; read_only: number; expires_at: number | null; id: number; email: string; name: string; role: "admin" | "member" } | undefined;
  if (!row) return null;
  if (row.expires_at && row.expires_at < Date.now()) return null;
  db.prepare("UPDATE api_tokens SET last_used_at = ? WHERE id = ?").run(Date.now(), row.tid);
  return { user: { id: row.id, email: row.email, name: row.name, role: row.role, mustChangePassword: false }, readOnly: Boolean(row.read_only) };
}
