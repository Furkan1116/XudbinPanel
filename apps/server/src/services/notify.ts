import { db } from "../db.js";
import { decrypt } from "../lib/crypto.js";

export const NOTIFY_EVENTS = {
  deploy_success: "Deploy başarılı",
  deploy_failed: "Deploy başarısız",
  ip_banned: "Saldırgan IP banlandı",
  backup_failed: "Yedekleme başarısız",
  server_down: "Sunucuya ulaşılamıyor",
} as const;
export type NotifyEvent = keyof typeof NOTIFY_EVENTS;

type Channel = { id: number; kind: "discord" | "telegram" | "slack" | "webhook"; config: string; events: string };

/** Olayı, o olaya abone olan tüm bildirim kanallarına gönderir. Hata deploy'u etkilemez. */
export function notify(event: NotifyEvent, title: string, body: string) {
  const channels = db.prepare("SELECT id, kind, config, events FROM notifications WHERE enabled = 1").all() as Channel[];
  for (const ch of channels) {
    let events: string[] = [];
    try {
      events = JSON.parse(ch.events);
    } catch {}
    if (!events.includes(event)) continue;
    sendTo(ch.kind, JSON.parse(decrypt(ch.config)), title, body, event).catch((err) =>
      console.error(`Bildirim gönderilemedi (#${ch.id}):`, (err as Error).message),
    );
  }
}

export async function sendTo(kind: Channel["kind"], cfg: Record<string, string>, title: string, body: string, event = "test") {
  const text = `${title}\n${body}`;
  let res: Response;
  const signal = AbortSignal.timeout(10_000);
  switch (kind) {
    case "discord":
      res = await fetch(cfg.url!, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ embeds: [{ title, description: body, color: event.includes("fail") || event.includes("ban") || event.includes("down") ? 0xb4233a : 0x2d7a4c }] }),
        signal,
      });
      break;
    case "slack":
      res = await fetch(cfg.url!, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }), signal });
      break;
    case "telegram":
      res = await fetch(`https://api.telegram.org/bot${cfg.botToken}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: cfg.chatId, text }),
        signal,
      });
      break;
    case "webhook":
      res = await fetch(cfg.url!, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ event, title, body, at: new Date().toISOString() }),
        signal,
      });
      break;
  }
  if (!res.ok) throw new Error(`Kanal ${res.status} döndürdü`);
}
