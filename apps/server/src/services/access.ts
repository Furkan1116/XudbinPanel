import { db } from "../db.js";
import type { SessionUser } from "../auth/session.js";

/** Kullanıcının görebildiği uygulamalar (proje yetkileri bu dosyada tanımlanır). */
export function accessibleAppIds(user: SessionUser): number[] {
  return (db.prepare("SELECT id FROM apps").all() as { id: number }[]).map((r) => r.id);
}
