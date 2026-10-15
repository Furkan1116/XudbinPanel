import { randomInt } from "node:crypto";
import { hashPassword } from "../auth/password.js";
import { db } from "../db.js";
import { HttpError } from "../lib/http.js";

export type UserRow = { id: number; email: string; name: string; role: "admin" | "member"; totp_secret: string | null; must_change_password: number; created_at: number };

export const publicUser = (u: UserRow) => ({
  id: u.id,
  email: u.email,
  name: u.name,
  role: u.role,
  totpEnabled: Boolean(u.totp_secret),
  mustChangePassword: Boolean(u.must_change_password),
  createdAt: u.created_at,
});

/** Okunabilir geçici şifre (karışan 0/O, 1/l harfleri yok). */
function tempPassword() {
  const chars = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";
  return Array.from({ length: 4 }, () => Array.from({ length: 4 }, () => chars[randomInt(chars.length)]).join("")).join("-");
}

/** Kullanıcı oluşturur; geçici şifreyi bir kez döndürür, ilk girişte değiştirilmesi istenir. */
export async function createUser(input: { email: string; name: string; role: "admin" | "member" }) {
  if (db.prepare("SELECT 1 FROM users WHERE email = ?").get(input.email)) throw new HttpError(409, "Bu e-postayla bir kullanıcı zaten var");
  const password = tempPassword();
  const res = db
    .prepare("INSERT INTO users (email, name, password_hash, role, must_change_password, created_at) VALUES (?, ?, ?, ?, 1, ?)")
    .run(input.email, input.name, await hashPassword(password), input.role, Date.now());
  return { id: Number(res.lastInsertRowid), password };
}

export async function resetPassword(userId: number) {
  const password = tempPassword();
  db.prepare("UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?").run(await hashPassword(password), userId);
  db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
  return password;
}

export function adminCount() {
  return (db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get() as { n: number }).n;
}

export function deleteUser(id: number) {
  const u = db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
  if (!u) throw new HttpError(404, "Kullanıcı bulunamadı");
  if (u.role === "admin" && adminCount() <= 1) throw new HttpError(409, "Son yönetici silinemez");
  db.prepare("DELETE FROM users WHERE id = ?").run(id);
}
