import { createHash, randomBytes } from "node:crypto";
import { config } from "../config.js";
import { db } from "../db.js";

export type SessionUser = { id: number; email: string; name: string };

// Veritabanında token'ın kendisi değil SHA-256 özeti saklanır;
// DB sızsa bile oturumlar ele geçirilemez.
const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export function createSession(userId: number, meta: { ip?: string; userAgent?: string }) {
  const token = randomBytes(32).toString("base64url");
  const now = Date.now();
  db.prepare(
    "INSERT INTO sessions (id, user_id, expires_at, created_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(hashToken(token), userId, now + config.sessionTtlMs, now, meta.ip ?? null, meta.userAgent ?? null);
  return { token, expiresAt: new Date(now + config.sessionTtlMs) };
}

export function validateSession(token: string): SessionUser | null {
  const row = db
    .prepare(
      `SELECT s.id AS sid, s.expires_at, u.id, u.email, u.name
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`,
    )
    .get(hashToken(token)) as { sid: string; expires_at: number; id: number; email: string; name: string } | undefined;
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    db.prepare("DELETE FROM sessions WHERE id = ?").run(row.sid);
    return null;
  }
  return { id: row.id, email: row.email, name: row.name };
}

export function destroySession(token: string) {
  db.prepare("DELETE FROM sessions WHERE id = ?").run(hashToken(token));
}

export function purgeExpiredSessions() {
  db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(Date.now());
}
