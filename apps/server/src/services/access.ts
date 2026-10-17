import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import type { SessionUser } from "../auth/session.js";
import { db } from "../db.js";
import { HttpError } from "../lib/http.js";
import type { AppEnv } from "../lib/types.js";

/**
 * Proje yetkileri: yönetici her şeyi görür. Üye yalnız eklendiği projeleri görür;
 * "developer" her şeyi yapabilir, "viewer" yalnız okuyabilir.
 */
export type ProjectRole = "developer" | "viewer";

export function projectRole(user: SessionUser, projectId: number): ProjectRole | "admin" | null {
  if (user.role === "admin") return "admin";
  const r = db.prepare("SELECT role FROM project_members WHERE project_id = ? AND user_id = ?").get(projectId, user.id) as { role: ProjectRole } | undefined;
  return r?.role ?? null;
}

export function accessibleProjectIds(user: SessionUser): number[] {
  if (user.role === "admin") return (db.prepare("SELECT id FROM projects").all() as { id: number }[]).map((r) => r.id);
  return (db.prepare("SELECT project_id AS id FROM project_members WHERE user_id = ?").all(user.id) as { id: number }[]).map((r) => r.id);
}

export function accessibleAppIds(user: SessionUser): number[] {
  if (user.role === "admin") return (db.prepare("SELECT id FROM apps").all() as { id: number }[]).map((r) => r.id);
  return (
    db.prepare("SELECT a.id FROM apps a JOIN project_members m ON m.project_id = a.project_id WHERE m.user_id = ?").all(user.id) as { id: number }[]
  ).map((r) => r.id);
}

/** İsteğin yolu bir projeye ait kaynağı gösteriyorsa o projenin numarası; kaynak yoksa null, proje kaynağı değilse undefined. */
export function projectOfPath(path: string): number | null | undefined {
  const m = path.match(/^\/api\/(projects|apps|databases|deployments)\/(\d+)(?:\/|$)/);
  if (!m) return undefined;
  const id = Number(m[2]);
  const q = {
    projects: "SELECT id AS pid FROM projects WHERE id = ?",
    apps: "SELECT project_id AS pid FROM apps WHERE id = ?",
    databases: "SELECT project_id AS pid FROM databases WHERE id = ?",
    deployments: "SELECT a.project_id AS pid FROM deployments d JOIN apps a ON a.id = d.app_id WHERE d.id = ?",
  }[m[1] as "projects" | "apps" | "databases" | "deployments"];
  const row = db.prepare(q).get(id) as { pid: number } | undefined;
  return row ? row.pid : null;
}

/** Üyelerin proje kaynaklarına erişimini denetler (yönetici için etkisiz). */
export const projectAccess = createMiddleware<AppEnv>(async (c, next) => {
  const user = c.get("user");
  if (user.role === "admin") return next();
  // Proje kaynağı yolunda ikinci bölüm ya düz rakam (kimlik) ya da düz kelime (ör. /detect)
  // olmalı. "1e0", "%31", "0x1" gibi biçimler denetimi atlatmasın diye üyelere hiç açılmaz.
  const seg = c.req.path.match(/^\/api\/(?:projects|apps|databases|deployments)\/([^/]+)/)?.[1];
  if (seg !== undefined && !/^\d+$/.test(seg) && !/^[a-z][a-z-]*$/.test(seg)) return c.json({ error: "Bulunamadı" }, 404);
  const pid = projectOfPath(c.req.path);
  if (pid === undefined || pid === null) return next();
  const role = projectRole(user, pid);
  // Erişimi olmayan kaynak "yok" gibi görünür; varlığı da sızmasın.
  if (!role) return c.json({ error: "Bulunamadı" }, 404);
  if (role === "viewer" && c.req.method !== "GET") return c.json({ error: "Bu projede yalnız görüntüleme yetkin var" }, 403);
  await next();
});

/** Yeni kaynak oluştururken (gövdede projectId) yazma yetkisi. */
export function canWriteProject(user: SessionUser, projectId: number) {
  const r = projectRole(user, projectId);
  return r === "admin" || r === "developer";
}

/**
 * Sır yetkisi: ortam değişkenleri, webhook sırrı/adresi ve veritabanı parolası okuma yetkisiyle
 * değil yazma yetkisiyle açılır. Yönetici ve proje "developer"ı görür; "viewer" ve salt okunur
 * API anahtarı göremez (anahtar sahibi yönetici olsa bile: sızarsa sır çıkmasın).
 */
export function canSeeSecrets(user: SessionUser, projectId: number, tokenReadOnly = false) {
  if (tokenReadOnly) return false;
  return canWriteProject(user, projectId);
}

/** İstek bağlamından sır yetkisi (GET yanıtlarında maskeleme kararı için). */
export function secretsVisible(c: Context<AppEnv>, projectId: number) {
  return canSeeSecrets(c.get("user"), projectId, Boolean(c.get("tokenReadOnly")));
}

/** Yedek dosyası gibi sır içeren indirmeler için: yetkisi yoksa 403. */
export function requireSecretAccess(c: Context<AppEnv>, projectId: number) {
  if (!secretsVisible(c, projectId)) throw new HttpError(403, "Bu dosya sır içerebilir; indirmek için yazma yetkisi gerekiyor");
}

/** Maskelenmiş sır değerlerinin yerine konan sabit metin. */
export const SECRET_MASK = "••••";
