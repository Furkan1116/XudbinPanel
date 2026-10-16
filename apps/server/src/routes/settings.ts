import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import QRCode from "qrcode";
import { z } from "zod";
import { SESSION_COOKIE } from "../auth/middleware.js";
import { hashPassword, verifyPassword } from "../auth/password.js";
import { generateTotpSecret, totpUri, verifyTotp } from "../auth/totp.js";
import { db } from "../db.js";
import { decrypt, encrypt } from "../lib/crypto.js";
import { body, HttpError, idParam } from "../lib/http.js";
import { getSettings, updateSettings } from "../lib/settings.js";
import { VERSION } from "../lib/version.js";
import { updateInfo } from "../lib/update-check.js";
import { config } from "../config.js";
import { hostExec } from "../services/firewall.js";
import { createApiToken } from "../auth/api-tokens.js";
import type { AppEnv } from "../lib/types.js";
import { applyCaddyConfig } from "../services/caddy.js";
import { NOTIFY_EVENTS, sendTo } from "../services/notify.js";
import { listServers } from "../services/servers.js";
import { createPanelBackup, PANEL_BACKUP_DIR } from "../services/panel-backup.js";
import { s3Test } from "../lib/s3.js";

const pendingTotp = new Map<number, string>();
const sessionKey = (hash: string) => hash.slice(0, 16);

export const settingsRoutes = new Hono<AppEnv>()
  .get("/", (c) => {
    const s = getSettings();
    const local = listServers().find((x) => x.kind === "local");
    return c.json({ panelDomain: s.panelDomain, panelHttps: s.panelHttps, localServerIp: local?.public_ip ?? null, version: VERSION, timezone: s.timezone, uptimeEnabled: s.uptimeEnabled });
  })

  .get("/update", async (c) => c.json({ ...(await updateInfo()), canSelfUpdate: config.isProd }))

  // Panelden güncelleme: install.sh --update sunucunun systemd'sinde ayrı bir iş olarak çalışır (panel yeniden
  // başlasa da devam eder). İlerleme: journalctl -u xudbin-update
  .post("/update/apply", async (c) => {
    if (c.get("user").role !== "admin") throw new HttpError(403, "Yalnız yönetici güncelleyebilir");
    if (!config.isProd) throw new HttpError(422, "Geliştirme ortamında panelden güncelleme yapılmaz");
    const local = listServers().find((x) => x.kind === "local");
    if (!local) throw new HttpError(500, "Panel sunucusu bulunamadı");
    try {
      await hostExec(
        local,
        `test -f /opt/xudbin/install.sh || { echo "Kurulum klasörü /opt/xudbin bulunamadı"; exit 3; }
systemctl reset-failed xudbin-update >/dev/null 2>&1 || true
systemd-run --unit=xudbin-update --collect --description="Xudbin güncellemesi" /bin/bash /opt/xudbin/install.sh --update`,
        60_000,
      );
    } catch (err) {
      throw new HttpError(500, `Güncelleme başlatılamadı: ${(err as Error).message}`);
    }
    return c.json({ ok: true, note: "Güncelleme başladı. Panel birkaç dakika içinde yeniden başlayacak." }, 202);
  })

  .put("/panel", async (c) => {
    const input = await body(
      c,
      z.object({
        panelDomain: z.union([z.string().trim().toLowerCase().regex(/^([a-z0-9-]+\.)+[a-z]{2,63}$/, "Geçerli bir alan adı gir"), z.literal("")]),
        panelHttps: z.boolean(),
        timezone: z.string().max(60).refine((tz) => Intl.supportedValuesOf("timeZone").includes(tz) || tz === "UTC", "Geçersiz saat dilimi").optional(),
        uptimeEnabled: z.boolean().optional(),
      }),
    );
    updateSettings(input);
    const local = listServers().find((x) => x.kind === "local");
    if (local?.status === "ready") await applyCaddyConfig(local);
    return c.json({ ok: true });
  })

  // --- Hesap ---------------------------------------------------------------
  .get("/account", (c) => {
    const user = c.get("user");
    const row = db.prepare("SELECT totp_secret FROM users WHERE id = ?").get(user.id) as { totp_secret: string | null };
    const current = createHash("sha256").update(getCookie(c, SESSION_COOKIE) ?? "").digest("hex");
    const sessions = (
      db.prepare("SELECT id, ip, user_agent, created_at, expires_at FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY created_at DESC").all(user.id, Date.now()) as {
        id: string;
        ip: string | null;
        user_agent: string | null;
        created_at: number;
        expires_at: number;
      }[]
    ).map((s) => ({ id: sessionKey(s.id), ip: s.ip, userAgent: s.user_agent, createdAt: s.created_at, expiresAt: s.expires_at, current: s.id === current }));
    return c.json({ user, totpEnabled: Boolean(row.totp_secret), sessions });
  })

  .put("/account/profile", async (c) => {
    const user = c.get("user");
    const input = await body(c, z.object({ name: z.string().trim().min(1).max(100), email: z.email().max(254), password: z.string().max(256).optional() }));
    // E-posta giriş bilgisidir; değiştirmek için mevcut şifre istenir (açık bırakılmış bir oturumla hesap ele geçirilemesin).
    if (input.email !== user.email) {
      const row = db.prepare("SELECT password_hash FROM users WHERE id = ?").get(user.id) as { password_hash: string };
      if (!input.password || !(await verifyPassword(input.password, row.password_hash))) throw new HttpError(403, "E-postayı değiştirmek için mevcut şifreni gir");
    }
    try {
      db.prepare("UPDATE users SET name = ?, email = ? WHERE id = ?").run(input.name, input.email, user.id);
    } catch {
      throw new HttpError(409, "Bu e-posta başka bir hesapta kullanılıyor");
    }
    return c.json({ ok: true });
  })

  .put("/account/password", async (c) => {
    const user = c.get("user");
    const input = await body(c, z.object({ current: z.string().min(1).max(256), next: z.string().min(10, "Yeni şifre en az 10 karakter olmalı").max(256) }));
    const row = db.prepare("SELECT password_hash FROM users WHERE id = ?").get(user.id) as { password_hash: string };
    if (!(await verifyPassword(input.current, row.password_hash))) throw new HttpError(403, "Mevcut şifre hatalı");
    db.prepare("UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?").run(await hashPassword(input.next), user.id);
    // Diğer cihazlardaki oturumları kapat.
    const current = createHash("sha256").update(getCookie(c, SESSION_COOKIE) ?? "").digest("hex");
    db.prepare("DELETE FROM sessions WHERE user_id = ? AND id != ?").run(user.id, current);
    return c.json({ ok: true });
  })

  .post("/account/totp/setup", async (c) => {
    const user = c.get("user");
    const secret = generateTotpSecret();
    pendingTotp.set(user.id, secret);
    const uri = totpUri(secret, user.email);
    return c.json({ secret, qr: await QRCode.toDataURL(uri, { margin: 1, width: 220 }) });
  })

  .post("/account/totp/enable", async (c) => {
    const user = c.get("user");
    const { code } = await body(c, z.object({ code: z.string().max(10) }));
    const secret = pendingTotp.get(user.id);
    if (!secret) throw new HttpError(409, "Önce kurulumu başlat");
    if (!verifyTotp(secret, code)) throw new HttpError(400, "Kod hatalı. Uygulamadaki güncel kodu gir.");
    db.prepare("UPDATE users SET totp_secret = ? WHERE id = ?").run(encrypt(secret), user.id);
    pendingTotp.delete(user.id);
    return c.json({ ok: true });
  })

  .post("/account/totp/disable", async (c) => {
    const user = c.get("user");
    const { code } = await body(c, z.object({ code: z.string().max(10) }));
    const row = db.prepare("SELECT totp_secret FROM users WHERE id = ?").get(user.id) as { totp_secret: string | null };
    if (!row.totp_secret) return c.json({ ok: true });
    if (!verifyTotp(decrypt(row.totp_secret), code)) throw new HttpError(400, "Kod hatalı");
    db.prepare("UPDATE users SET totp_secret = NULL WHERE id = ?").run(user.id);
    return c.json({ ok: true });
  })

  .delete("/account/sessions/:key", (c) => {
    const user = c.get("user");
    const key = c.req.param("key");
    const rows = db.prepare("SELECT id FROM sessions WHERE user_id = ?").all(user.id) as { id: string }[];
    const match = rows.find((r) => sessionKey(r.id) === key);
    if (match) db.prepare("DELETE FROM sessions WHERE id = ?").run(match.id);
    return c.json({ ok: true });
  })

  // --- Bildirimler ---------------------------------------------------------
  .get("/notifications", (c) => {
    const rows = db.prepare("SELECT id, name, kind, events, enabled, created_at AS createdAt FROM notifications ORDER BY id").all() as {
      events: string;
      enabled: number;
    }[];
    return c.json({
      notifications: rows.map((r) => ({ ...r, events: JSON.parse(r.events), enabled: Boolean(r.enabled) })),
      events: NOTIFY_EVENTS,
    });
  })

  .post("/notifications", async (c) => {
    const input = await body(c, notificationSchema);
    validateChannel(input.kind, input.config);
    const res = db
      .prepare("INSERT INTO notifications (name, kind, config, events, enabled, created_at) VALUES (?, ?, ?, ?, 1, ?)")
      .run(input.name, input.kind, encrypt(JSON.stringify(input.config)), JSON.stringify(input.events), Date.now());
    return c.json({ id: Number(res.lastInsertRowid) }, 201);
  })

  .patch("/notifications/:id", async (c) => {
    const input = await body(c, z.object({ enabled: z.boolean().optional(), events: z.array(z.string()).optional() }));
    const id = idParam(c);
    if (input.enabled !== undefined) db.prepare("UPDATE notifications SET enabled = ? WHERE id = ?").run(input.enabled ? 1 : 0, id);
    if (input.events) db.prepare("UPDATE notifications SET events = ? WHERE id = ?").run(JSON.stringify(input.events), id);
    return c.json({ ok: true });
  })

  .delete("/notifications/:id", (c) => {
    db.prepare("DELETE FROM notifications WHERE id = ?").run(idParam(c));
    return c.json({ ok: true });
  })

  .post("/notifications/test", async (c) => {
    const input = await body(c, notificationSchema.pick({ kind: true, config: true }));
    validateChannel(input.kind, input.config);
    try {
      await sendTo(input.kind, input.config, "Xudbin test bildirimi", "Bu kanal Xudbin bildirimlerini alabiliyor.");
    } catch (err) {
      throw new HttpError(400, `Gönderilemedi: ${(err as Error).message}`);
    }
    return c.json({ ok: true });
  })

  // --- API anahtarları -------------------------------------------------------------------------
  .get("/account/tokens", (c) => {
    const tokens = db
      .prepare("SELECT id, name, prefix, read_only AS readOnly, last_used_at AS lastUsedAt, expires_at AS expiresAt, created_at AS createdAt FROM api_tokens WHERE user_id = ? ORDER BY id DESC")
      .all(c.get("user").id);
    return c.json({ tokens });
  })
  .post("/account/tokens", async (c) => {
    const input = await body(c, z.object({ name: z.string().trim().min(1, "Ad gerekli").max(60), readOnly: z.boolean().default(false), expiresInDays: z.number().int().min(1).max(3650).nullable().default(null) }));
    const created = createApiToken(c.get("user").id, input.name, input);
    return c.json({ id: created.id, token: created.token }, 201);
  })
  .delete("/account/tokens/:id", (c) => {
    db.prepare("DELETE FROM api_tokens WHERE id = ? AND user_id = ?").run(idParam(c), c.get("user").id);
    return c.json({ ok: true });
  })

  // --- İşlem kaydı (yalnız yönetici) ---------------------------------------------------------
  .get("/audit", (c) => {
    const q = c.req.query("q")?.trim();
    const before = Number(c.req.query("before")) || Number.MAX_SAFE_INTEGER;
    const rows = db
      .prepare(
        `SELECT id, user_email AS email, action, method, path, status, ip, via, created_at AS createdAt FROM audit_log
         WHERE id < ? ${q ? "AND (user_email LIKE ? OR action LIKE ? OR path LIKE ? OR ip LIKE ?)" : ""} ORDER BY id DESC LIMIT 100`,
      )
      .all(before, ...(q ? [`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`] : []));
    return c.json({ entries: rows });
  })

  // --- Yedekleme: uzak depolama, panel yedeği, doğrulama sıklığı ---------------------------
  .get("/backup", (c) => {
    const s = getSettings();
    const panelBackups = db
      .prepare("SELECT id, file, size, status, error, remote_key IS NOT NULL AS remote, remote_error AS remoteError, created_at AS createdAt FROM panel_backups ORDER BY id DESC LIMIT 20")
      .all();
    return c.json({
      s3: s.backupS3 ? { ...s.backupS3, secretKey: "", hasSecret: Boolean(s.backupS3.secretKey) } : null,
      panelBackup: { enabled: Boolean(s.panelBackupPassphrase), intervalH: s.panelBackupIntervalH, keep: s.panelBackupKeep, lastAt: s.lastPanelBackupAt },
      verifyEveryH: s.verifyBackupsEveryH,
      panelBackups,
    });
  })

  .put("/backup", async (c) => {
    const input = await body(
      c,
      z.object({
        s3: s3Schema.nullable().optional(),
        passphrase: z.string().min(12, "Yedek şifresi en az 12 karakter olmalı").max(200).nullable().optional(),
        intervalH: z.number().int().min(0).max(24 * 30).optional(),
        keep: z.number().int().min(1).max(100).optional(),
        verifyEveryH: z.number().int().min(0).max(24 * 30).optional(),
      }),
    );
    const current = getSettings();
    updateSettings({
      backupS3: input.s3 === undefined ? undefined : input.s3 === null ? null : { ...input.s3, secretKey: input.s3.secretKey ? encrypt(input.s3.secretKey) : (current.backupS3?.secretKey ?? "") },
      panelBackupPassphrase: input.passphrase === undefined ? undefined : input.passphrase === null ? "" : encrypt(input.passphrase),
      panelBackupIntervalH: input.intervalH,
      panelBackupKeep: input.keep,
      verifyBackupsEveryH: input.verifyEveryH,
    });
    // updateSettings null'ı yazmaz; hedef kaldırıldıysa ayrıca sil.
    if (input.s3 === null) db.prepare("DELETE FROM settings WHERE key = 'backupS3'").run();
    return c.json({ ok: true });
  })

  .post("/backup/test", async (c) => {
    const input = await body(c, s3Schema);
    const secret = input.secretKey || (getSettings().backupS3?.secretKey ? decrypt(getSettings().backupS3!.secretKey) : "");
    if (!secret) throw new HttpError(400, "Gizli anahtar (secret key) gerekli");
    try {
      await s3Test({ ...input, secretKey: secret });
    } catch (err) {
      throw new HttpError(400, `Bağlanılamadı: ${(err as Error).message}`);
    }
    return c.json({ ok: true });
  })

  .post("/backup/panel", async (c) => {
    try {
      await createPanelBackup();
    } catch (err) {
      throw new HttpError(500, `Panel yedeği alınamadı: ${(err as Error).message}`);
    }
    return c.json({ ok: true }, 201);
  })

  .get("/backup/panel/:id/download", (c) => {
    const b = db.prepare("SELECT file FROM panel_backups WHERE id = ? AND status = 'success'").get(idParam(c)) as { file: string } | undefined;
    if (!b) throw new HttpError(404, "Yedek bulunamadı");
    const full = path.join(PANEL_BACKUP_DIR, path.basename(b.file));
    if (!fs.existsSync(full)) throw new HttpError(404, "Yedek dosyası diskte yok");
    c.header("Content-Type", "application/octet-stream");
    c.header("Content-Disposition", `attachment; filename="${b.file}"`);
    c.header("Content-Length", String(fs.statSync(full).size));
    return c.body(Readable.toWeb(fs.createReadStream(full)) as ReadableStream);
  });

const s3Schema = z.object({
  endpoint: z.string().trim().url("Geçerli bir adres gir (https://...)").max(300),
  region: z.string().trim().max(50).default("auto"),
  bucket: z.string().trim().min(3, "Bucket adı gerekli").max(100),
  accessKey: z.string().trim().min(1, "Access key gerekli").max(200),
  secretKey: z.string().max(200).default(""),
  prefix: z.string().trim().max(200).default("xudbin"),
});

const notificationSchema = z.object({
  name: z.string().trim().min(1).max(60),
  kind: z.enum(["discord", "telegram", "slack", "webhook", "email"]),
  config: z.record(z.string(), z.string().max(500)),
  events: z.array(z.enum(Object.keys(NOTIFY_EVENTS) as [string, ...string[]])).min(1, "En az bir olay seç"),
});

function validateChannel(kind: string, cfg: Record<string, string>) {
  if (kind === "email") {
    if (!cfg.host || !/^[a-z0-9.-]+$/i.test(cfg.host)) throw new HttpError(400, "SMTP sunucusu gerekli (ör. smtp.gmail.com)");
    if (!cfg.from || !/@/.test(cfg.from)) throw new HttpError(400, "Gönderen adresi gerekli");
    if (!cfg.to || !cfg.to.split(/[,\s]+/).filter(Boolean).every((a) => /^[^\s@<>]+@[^\s@<>]+$/.test(a))) throw new HttpError(400, "Alıcı e-posta adres(ler)i gerekli");
    return;
  }
  if (kind === "telegram") {
    if (!cfg.botToken || !cfg.chatId) throw new HttpError(400, "Bot token ve chat ID gerekli");
  } else if (!cfg.url || !/^https:\/\//.test(cfg.url)) throw new HttpError(400, "https:// ile başlayan bir adres gerekli");
}
