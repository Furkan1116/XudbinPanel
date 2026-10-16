import { createMiddleware } from "hono/factory";
import { db } from "../db.js";
import { clientIp } from "../lib/client-ip.js";
import type { AppEnv } from "../lib/types.js";

/**
 * İşlem kaydı: bir şeyi değiştiren her API isteği (GET dışındakiler) kim, ne zaman, nereden, sonuç ile kaydedilir.
 * Gövde saklanmaz (şifre, token gibi gizli bilgiler kayda girmesin). 1 yıl tutulur.
 */
const LABELS: [RegExp, string, string?][] = [
  [/^POST \/api\/apps$/, "Uygulama oluşturdu"],
  [/^PATCH \/api\/apps\/\d+$/, "Uygulama ayarlarını değiştirdi"],
  [/^DELETE \/api\/apps\/\d+$/, "Uygulamayı sildi"],
  [/^PUT \/api\/apps\/\d+\/env$/, "Ortam değişkenlerini değiştirdi"],
  [/^POST \/api\/apps\/\d+\/env\/merge$/, "Deploy Doktoru düzeltmesini uyguladı"],
  [/^PUT \/api\/apps\/\d+\/security$/, "Uygulama güvenlik ayarlarını değiştirdi"],
  [/^POST \/api\/apps\/\d+\/deploy$/, "Deploy başlattı"],
  [/^POST \/api\/apps\/\d+\/rollback\/\d+$/, "Önceki sürüme döndü"],
  [/^POST \/api\/apps\/\d+\/(start|stop|restart)$/, "Uygulamayı başlattı/durdurdu"],
  [/^POST \/api\/apps\/\d+\/domains/, "Alan adı ekledi"],
  [/^DELETE \/api\/apps\/\d+\/domains\/\d+$/, "Alan adını sildi"],
  [/^POST \/api\/apps\/\d+\/upload$/, "Yeni sürüm yükledi"],
  [/^POST \/api\/apps\/\d+\/webhook\/regenerate$/, "Webhook adresini yeniledi"],
  [/^POST \/api\/databases$/, "Veritabanı oluşturdu"],
  [/^DELETE \/api\/databases\/\d+$/, "Veritabanını sildi"],
  [/^POST \/api\/databases\/\d+\/backups\/\d+\/restore$/, "Yedekten geri yükledi"],
  [/^POST \/api\/databases\/\d+\/backups$/, "Veritabanı yedeği aldı"],
  [/^PATCH \/api\/databases\/\d+$/, "Veritabanı ayarlarını değiştirdi"],
  [/^POST \/api\/projects$/, "Proje oluşturdu"],
  [/^DELETE \/api\/projects\/\d+$/, "Projeyi sildi"],
  [/^(PUT|DELETE) \/api\/projects\/\d+\/members\/\d+$/, "Proje üyelerini değiştirdi"],
  [/^POST \/api\/servers$/, "Sunucu ekledi"],
  [/^DELETE \/api\/servers\/\d+$/, "Sunucuyu sildi"],
  [/^POST \/api\/servers\/\d+\/(setup|harden)$/, "Sunucu kurulumu/sıkılaştırma başlattı"],
  [/^POST \/api\/users$/, "Kullanıcı ekledi"],
  [/^DELETE \/api\/users\/\d+$/, "Kullanıcıyı sildi"],
  [/^PATCH \/api\/users\/\d+$/, "Kullanıcının rolünü değiştirdi"],
  [/^POST \/api\/users\/\d+\/reset-password$/, "Kullanıcının şifresini sıfırladı"],
  [/^PUT \/api\/settings\/account\/password$/, "Şifresini değiştirdi"],
  [/^POST \/api\/settings\/account\/totp\/enable$/, "İki adımlı doğrulamayı açtı"],
  [/^POST \/api\/settings\/account\/totp\/disable$/, "İki adımlı doğrulamayı kapattı"],
  [/^(POST|DELETE) \/api\/settings\/account\/tokens/, "API anahtarlarını değiştirdi"],
  [/^PUT \/api\/settings\/(panel|backup|sso)$/, "Panel ayarlarını değiştirdi"],
  [/^(POST|DELETE) \/api\/settings\/notifications/, "Bildirim kanallarını değiştirdi"],
  [/^POST \/api\/security\/score\/fix$/, "Güvenlik düzeltmesi uyguladı"],
  [/^(POST|DELETE|PUT) \/api\/security/, "Güvenlik ayarlarını değiştirdi"],
];

export function actionLabel(method: string, path: string) {
  const key = `${method} ${path}`;
  return LABELS.find(([re]) => re.test(key))?.[1] ?? key;
}

export function recordAudit(e: { userId?: number | null; email?: string | null; action: string; method?: string; path?: string; status?: number; ip?: string; via?: string }) {
  db.prepare("INSERT INTO audit_log (user_id, user_email, action, method, path, status, ip, via, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    e.userId ?? null,
    e.email ?? null,
    e.action,
    e.method ?? null,
    e.path ?? null,
    e.status ?? null,
    e.ip ?? null,
    e.via ?? null,
    Date.now(),
  );
}

export const auditTrail = createMiddleware<AppEnv>(async (c, next) => {
  await next();
  if (c.req.method === "GET" || c.req.method === "HEAD" || c.req.method === "OPTIONS") return;
  const user = c.get("user");
  if (!user) return;
  try {
    recordAudit({
      userId: user.id,
      email: user.email,
      action: actionLabel(c.req.method, c.req.path),
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      ip: clientIp(c),
      via: c.get("viaToken") ? "api" : "panel",
    });
  } catch {}
});

export function pruneAudit() {
  db.prepare("DELETE FROM audit_log WHERE created_at < ?").run(Date.now() - 365 * 86_400_000);
}
