import net from "node:net";
import tls from "node:tls";

/**
 * Bağımlılıksız, küçük SMTP istemcisi (bildirim e-postaları için).
 * 465: doğrudan TLS; 587/25: STARTTLS (sunucu destekliyorsa zorunlu tutulur).
 */
export type SmtpConfig = { host: string; port: number; user?: string; pass?: string; from: string; to: string[] };

type Conn = { write: (s: string) => void; read: () => Promise<{ code: number; text: string }>; socket: net.Socket };

function wrap(socket: net.Socket): Conn {
  let buffer = "";
  const waiters: ((s: string) => void)[] = [];
  const lines: string[] = [];
  socket.setEncoding("utf8");
  socket.on("data", (d: string) => {
    buffer += d;
    let i;
    while ((i = buffer.indexOf("\r\n")) >= 0) {
      const line = buffer.slice(0, i);
      buffer = buffer.slice(i + 2);
      const w = waiters.shift();
      if (w) w(line);
      else lines.push(line);
    }
  });
  const nextLine = () => new Promise<string>((resolve, reject) => {
    const l = lines.shift();
    if (l !== undefined) return resolve(l);
    waiters.push(resolve);
    socket.once("error", reject);
  });
  return {
    socket,
    write: (s) => socket.write(s + "\r\n"),
    async read() {
      let text = "";
      for (;;) {
        const line = await nextLine();
        text += line.slice(4) + "\n";
        if (line[3] !== "-") return { code: Number(line.slice(0, 3)), text };
      }
    },
  };
}

async function expect(c: Conn, ok: number[], what: string) {
  const r = await c.read();
  if (!ok.includes(r.code)) throw new Error(`SMTP ${what}: ${r.code} ${r.text.trim()}`);
  return r;
}

const encodeWord = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s).toString("base64")}?=`);

export async function sendMail(cfg: SmtpConfig, subject: string, text: string) {
  const timeout = 20_000;
  let socket: net.Socket =
    cfg.port === 465 ? tls.connect({ host: cfg.host, port: cfg.port, servername: cfg.host }) : net.connect({ host: cfg.host, port: cfg.port });
  socket.setTimeout(timeout, () => socket.destroy(new Error("SMTP zaman aşımı")));
  let c = wrap(socket);
  try {
    await expect(c, [220], "bağlantı");
    c.write(`EHLO xudbin`);
    let ehlo = await expect(c, [250], "EHLO");
    if (cfg.port !== 465) {
      if (!/STARTTLS/i.test(ehlo.text)) throw new Error("SMTP sunucusu STARTTLS desteklemiyor; şifresiz gönderim yapılmaz");
      c.write("STARTTLS");
      await expect(c, [220], "STARTTLS");
      socket.removeAllListeners("data");
      socket = tls.connect({ socket, servername: cfg.host });
      socket.setTimeout(timeout, () => socket.destroy(new Error("SMTP zaman aşımı")));
      await new Promise<void>((resolve, reject) => {
        socket.once("secureConnect", () => resolve());
        socket.once("error", reject);
      });
      c = wrap(socket);
      c.write("EHLO xudbin");
      ehlo = await expect(c, [250], "EHLO");
    }
    if (cfg.user) {
      c.write(`AUTH PLAIN ${Buffer.from(`\0${cfg.user}\0${cfg.pass ?? ""}`).toString("base64")}`);
      await expect(c, [235], "kimlik doğrulama");
    }
    const fromAddr = cfg.from.match(/<([^>]+)>/)?.[1] ?? cfg.from;
    c.write(`MAIL FROM:<${fromAddr}>`);
    await expect(c, [250], "MAIL FROM");
    for (const to of cfg.to) {
      c.write(`RCPT TO:<${to}>`);
      await expect(c, [250, 251], "RCPT TO");
    }
    c.write("DATA");
    await expect(c, [354], "DATA");
    const body = Buffer.from(text).toString("base64").replace(/.{1,76}/g, "$&\r\n");
    const msg = [
      `From: ${cfg.from}`,
      `To: ${cfg.to.join(", ")}`,
      `Subject: ${encodeWord(subject)}`,
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: <${Date.now()}.${Math.random().toString(36).slice(2)}@xudbin>`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: base64",
      "",
      body,
    ].join("\r\n");
    c.write(`${msg}\r\n.`);
    await expect(c, [250], "gönderim");
    c.write("QUIT");
  } finally {
    socket.end();
  }
}
