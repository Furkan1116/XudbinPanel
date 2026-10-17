/**
 * Sunucudaki `xudbin` komutunun panel tarafı. install.sh /usr/local/bin/xudbin betiğini kurar;
 * o betik bu dosyayı konteyner içinde çalıştırır:  docker exec -it xudbin node dist/cli.js <komut>
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { gunzipSync } from "node:zlib";
import QRCode from "qrcode";
import { ensureSetupToken } from "./auth/setup-token.js";
import { db } from "./db.js";
import { config } from "./config.js";
import { decrypt } from "./lib/crypto.js";
import { s3Download } from "./lib/s3.js";
import { getSettings } from "./lib/settings.js";
import { decryptArchive, unpackTar } from "./services/panel-backup.js";
import { createUser, deleteUser, resetPassword, type UserRow } from "./services/users.js";

const R = "\x1b[31m", G = "\x1b[32m", D = "\x1b[2m", B = "\x1b[1m", X = "\x1b[0m";
const [cmd, ...args] = process.argv.slice(2);

function panelUrl() {
  const s = getSettings();
  if (s.panelDomain) return `${s.panelHttps ? "https" : "http"}://${s.panelDomain}`;
  const ip = (db.prepare("SELECT public_ip FROM servers WHERE kind = 'local'").get() as { public_ip: string | null } | undefined)?.public_ip;
  return ip ? `http://${ip}` : "http://localhost";
}

/** Linki çerçeve içinde ve telefondan okutulabilir QR kodla gösterir. */
async function showLink(title: string, url: string, note?: string) {
  const width = Math.max(url.length, title.length, note?.length ?? 0) + 4;
  const line = "─".repeat(width);
  console.log(`\n  ${R}┌${line}┐${X}`);
  console.log(`  ${R}│${X}  ${B}${title}${X}${" ".repeat(width - title.length - 2)}${R}│${X}`);
  console.log(`  ${R}│${X}  ${G}${url}${X}${" ".repeat(width - url.length - 2)}${R}│${X}`);
  if (note) console.log(`  ${R}│${X}  ${D}${note}${X}${" ".repeat(width - note.length - 2)}${R}│${X}`);
  console.log(`  ${R}└${line}┘${X}\n`);
  const qr = await QRCode.toString(url, { type: "terminal", small: true, errorCorrectionLevel: "L" });
  console.log(qr.split("\n").map((l) => `  ${l}`).join("\n"));
}

const findUser = (email: string) => {
  const u = db.prepare("SELECT * FROM users WHERE email = ?").get(email) as UserRow | undefined;
  if (!u) throw new Error(`Kullanıcı bulunamadı: ${email}`);
  return u;
};

async function main() {
  switch (cmd) {
    case "link": {
      const users = (db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;
      if (users === 0) await showLink("Kurulum linki: yönetici hesabını oluştur", `${panelUrl()}/?setup=${ensureSetupToken()}`, "Linki kimseyle paylaşma.");
      else await showLink("Xudbin paneli", panelUrl());
      return;
    }
    case "status": {
      const q = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
      console.log(`${B}Xudbin${X}  ${panelUrl()}`);
      console.log(`  Sunucular:    ${q("SELECT COUNT(*) n FROM servers")} (${q("SELECT COUNT(*) n FROM servers WHERE status = 'ready'")} hazır)`);
      console.log(`  Uygulamalar:  ${q("SELECT COUNT(*) n FROM apps")} (${q("SELECT COUNT(*) n FROM apps WHERE status = 'running'")} çalışıyor)`);
      console.log(`  Veritabanları: ${q("SELECT COUNT(*) n FROM databases")}`);
      console.log(`  Kullanıcılar: ${q("SELECT COUNT(*) n FROM users")}`);
      console.log(`  Banlı IP:     ${q("SELECT COUNT(*) n FROM blocked_ips")}`);
      return;
    }
    case "user": {
      const [sub, email, ...rest] = args;
      if (sub === "list" || !sub) {
        for (const u of db.prepare("SELECT * FROM users ORDER BY id").all() as UserRow[]) {
          console.log(`  ${u.email.padEnd(32)} ${u.role === "admin" ? "yönetici" : "üye    "}  ${u.totp_secret ? "2FA açık" : ""}`);
        }
        return;
      }
      if (!email) throw new Error("E-posta gerekli");
      if (sub === "create") {
        const role = rest.includes("--member") ? "member" : "admin";
        const name = rest.filter((a) => !a.startsWith("--")).join(" ") || email.split("@")[0]!;
        const r = await createUser({ email, name, role });
        console.log(`${G}Kullanıcı oluşturuldu${X} (${role === "admin" ? "yönetici" : "üye"}). Geçici şifre: ${B}${r.password}${X}`);
        console.log(`${D}İlk girişte şifresini değiştirmesi istenir.${X}`);
      } else if (sub === "delete") {
        deleteUser(findUser(email).id);
        console.log(`${G}Silindi:${X} ${email}`);
      } else if (sub === "reset-password") {
        const pw = await resetPassword(findUser(email).id);
        console.log(`${G}Şifre sıfırlandı.${X} Geçici şifre: ${B}${pw}${X}  ${D}(tüm oturumlar kapatıldı)${X}`);
      } else if (sub === "disable-2fa") {
        db.prepare("UPDATE users SET totp_secret = NULL WHERE id = ?").run(findUser(email).id);
        console.log(`${G}İki adımlı doğrulama kapatıldı:${X} ${email}`);
      } else throw new Error(`Bilinmeyen komut: user ${sub}`);
      return;
    }
    case "unban": {
      const ip = args[0];
      if (!ip) throw new Error("IP gerekli");
      const n = db.prepare("DELETE FROM blocked_ips WHERE ip = ?").run(ip).changes;
      console.log(n ? `${G}Ban kaldırıldı:${X} ${ip} (Caddy bir sonraki güncellemede uygular; panelde Güvenlik > Banlı IP'ler'den de kaldırabilirsin)` : `${ip} banlı değil`);
      return;
    }
    case "restore": {
      await restorePanel(args);
      return;
    }
    default:
      console.log(`Kullanım: xudbin <komut>
  link                          Panel adresini (ilk kurulumda kurulum linkini) QR kodla gösterir
  status                        Özet durum
  user list                     Kullanıcıları listeler
  user create <e-posta> [ad] [--member]   Kullanıcı ekler (varsayılan yönetici), geçici şifre verir
  user reset-password <e-posta> Geçici şifre üretir
  user disable-2fa <e-posta>    İki adımlı doğrulamayı kapatır (telefon kaybolduysa)
  user delete <e-posta>         Kullanıcıyı siler
  unban <ip>                    IP banını kaldırır
  restore <dosya | s3://bucket/anahtar> [--endpoint URL --access-key K --secret-key S --region R]
                                Panel yedeğini geri yükler (yedek şifresi sorulur), ardından paneli yeniden başlatır
  update                        Xudbin'i günceller (sunucudaki betik)
  logs                          Panel loglarını izler (sunucudaki betik)`);
  }
}

/** Panel yedeğini çözer ve data/restore klasörüne hazırlar; restore-boot.ts bir sonraki açılışta yerine koyar. */
async function restorePanel(argv: string[]) {
  const source = argv.find((a) => !a.startsWith("--"));
  if (!source) throw new Error("Yedek dosyası veya s3://bucket/anahtar gerekli");
  const opt = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  let file: string;
  if (source.startsWith("s3://")) {
    const [, , bucket, ...rest] = source.split("/");
    const saved = getSettings().backupS3;
    const target = {
      endpoint: opt("endpoint") ?? saved?.endpoint ?? "",
      region: opt("region") ?? saved?.region ?? "auto",
      bucket: bucket ?? "",
      accessKey: opt("access-key") ?? saved?.accessKey ?? "",
      secretKey: opt("secret-key") ?? (saved?.secretKey ? decrypt(saved.secretKey) : ""),
      prefix: "",
    };
    if (!target.endpoint || !target.accessKey || !target.secretKey) throw new Error("--endpoint, --access-key ve --secret-key gerekli");
    file = path.join(os.tmpdir(), `xudbin-restore-${Date.now()}.xbk`);
    console.log(`${D}İndiriliyor: ${source}${X}`);
    await s3Download(target, rest.join("/"), file);
  } else {
    // Panel konteyneri sunucu dosya sistemini görmez; `xudbin` betiği yerel dosyayı konteynere kopyalayıp yolunu verir.
    file = source;
    if (!fs.existsSync(file)) throw new Error(`Dosya bulunamadı: ${source} (konteyner içinde aranır; sunucudaki dosyayı \`sudo xudbin restore <dosya>\` ile ver)`);
  }
  const pass = opt("passphrase") ?? (await ask("Yedek şifresi: "));
  const files = await unpackTar(gunzipSync(decryptArchive(fs.readFileSync(file), pass)));
  if (!files["xudbin.db"] || !files["secret.key"]) throw new Error("Yedekte panel veritabanı veya anahtar yok");
  const stage = path.join(config.dataDir, "restore");
  fs.mkdirSync(stage, { recursive: true });
  fs.writeFileSync(path.join(stage, "xudbin.db"), files["xudbin.db"], { mode: 0o600 });
  fs.writeFileSync(path.join(stage, "secret.key"), files["secret.key"], { mode: 0o600 });
  const manifest = files["manifest.json"] ? (JSON.parse(files["manifest.json"].toString()) as { createdAt?: number }) : {};
  console.log(`${G}Yedek hazır${X}${manifest.createdAt ? ` (${new Date(manifest.createdAt).toLocaleString("tr-TR")})` : ""}. Panel yeniden başlayınca geri yüklenecek.`);
  console.log(`${D}Yeni bir sunucuya taşındıysan: uygulamaları yeniden deploy et, veritabanlarını yedeklerinden geri yükle (uzak depolamadan otomatik indirilir).${X}`);
}

function ask(question: string) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise<string>((resolve) =>
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    }),
  );
}

main().catch((e) => {
  console.error(`${R}Hata:${X} ${(e as Error).message}`);
  process.exit(1);
});
