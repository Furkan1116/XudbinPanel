#!/usr/bin/env node
/**
 * xb — Xudbin komut satırı aracı. Bağımlılık yok, Node.js 18+ yeterli.
 *
 *   xb login https://panel.ornek.com xb_...   # adresi ve API anahtarını kaydeder
 *   xb apps                                    # uygulamaları listeler
 *   xb deploy <uygulama> [--wait]              # deploy başlatır; --wait ile logu izler, sonuca göre çıkış kodu verir
 *   xb logs <uygulama>                         # uygulama loglarını canlı izler
 *   xb status <uygulama>                       # durum, alan adları, son deploy
 *   xb rollback <uygulama> <deploy-no>         # önceki bir sürüme döner
 *
 * Ayarlar yerine ortam değişkenleri de kullanılabilir: XUDBIN_URL, XUDBIN_TOKEN (CI için).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CONFIG = path.join(os.homedir(), ".config", "xudbin", "cli.json");
const [cmd, ...args] = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const pos = args.filter((a) => !a.startsWith("--"));

function config() {
  let c = {};
  try {
    c = JSON.parse(fs.readFileSync(CONFIG, "utf8"));
  } catch {}
  const url = (process.env.XUDBIN_URL || c.url || "").replace(/\/+$/, "");
  const token = process.env.XUDBIN_TOKEN || c.token;
  if (!url || !token) fail("Önce giriş yap: xb login <panel-adresi> <api-anahtarı>  (Panel > Ayarlar > Hesap > API anahtarları)");
  return { url, token };
}

function fail(msg, code = 1) {
  console.error(`\x1b[31mHata:\x1b[0m ${msg}`);
  process.exit(code);
}

async function api(method, p, body) {
  const { url, token } = config();
  const res = await fetch(`${url}/api${p}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).catch((e) => fail(`Panele ulaşılamadı: ${e.cause?.code ?? e.message}`));
  const data = await res.json().catch(() => ({}));
  if (!res.ok) fail(data.error ?? `HTTP ${res.status}`);
  return data;
}

/** Ad, kısa ad (slug) veya numarayla uygulamayı bulur. */
async function findApp(ref) {
  if (!ref) fail("Uygulama adı gerekli");
  const { apps } = await api("GET", "/apps");
  const hit = apps.find((a) => String(a.id) === ref || a.slug === ref || a.name === ref) ?? apps.filter((a) => a.name.toLowerCase().includes(ref.toLowerCase()));
  if (Array.isArray(hit)) {
    if (hit.length === 1) return hit[0];
    fail(hit.length ? `Birden çok uygulama eşleşti: ${hit.map((a) => a.name).join(", ")}` : `Uygulama bulunamadı: ${ref}`);
  }
  return hit;
}

/** Sunucunun SSE akışını satır satır okur. */
async function stream(p, onEvent) {
  const { url, token } = config();
  const res = await fetch(`${url}/api${p}`, { headers: { Authorization: `Bearer ${token}`, Accept: "text/event-stream" } });
  if (!res.ok || !res.body) fail(`Akış açılamadı (HTTP ${res.status})`);
  const decoder = new TextDecoder();
  let buf = "";
  let event = "message";
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, "");
      buf = buf.slice(i + 1);
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) {
        if ((await onEvent(event, line.slice(5).replace(/^ /, ""))) === false) return;
      } else if (line === "") event = "message";
    }
  }
}

const commands = {
  async login() {
    const [url, token] = pos;
    if (!url || !token) fail("Kullanım: xb login <panel-adresi> <api-anahtarı>");
    fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
    fs.writeFileSync(CONFIG, JSON.stringify({ url: url.replace(/\/+$/, ""), token }, null, 2), { mode: 0o600 });
    const { apps } = await api("GET", "/apps");
    console.log(`\x1b[32m✓\x1b[0m Giriş yapıldı. Erişebildiğin uygulama sayısı: ${apps.length}`);
  },
  async apps() {
    const { apps } = await api("GET", "/apps");
    if (!apps.length) return console.log("Uygulama yok.");
    const w = Math.max(...apps.map((a) => a.name.length), 4);
    for (const a of apps) console.log(`${String(a.id).padStart(4)}  ${a.name.padEnd(w)}  ${a.status.padEnd(9)}  ${a.domains[0] ?? ""}`);
  },
  async status() {
    const app = await findApp(pos[0]);
    const { app: a, deployments } = await api("GET", `/apps/${app.id}`);
    console.log(`${a.name} (#${a.id}) — ${a.status}`);
    for (const d of a.domains) console.log(`  ${d.url}`);
    const last = deployments[0];
    if (last) console.log(`Son deploy #${last.id}: ${last.status}${last.title ? ` — ${last.title}` : ""}`);
  },
  async deploy() {
    const app = await findApp(pos[0]);
    const { deploymentId } = await api("POST", `/apps/${app.id}/deploy`, {});
    console.log(`Deploy #${deploymentId} başladı: ${app.name}`);
    if (!flags.has("--wait")) return;
    await stream(`/deployments/${deploymentId}/stream`, (event, data) => {
      if (event === "snapshot") {
        const snap = JSON.parse(data);
        if (snap.log) process.stdout.write(snap.log);
      } else if (event === "line") console.log(data);
      else if (event === "done") return false;
    });
    const { deployment } = await api("GET", `/deployments/${deploymentId}`);
    if (deployment.status === "success") console.log(`\x1b[32m✓ Deploy tamamlandı\x1b[0m`);
    else fail(`Deploy ${deployment.status === "cancelled" ? "iptal edildi" : "başarısız"}`, 2);
  },
  async logs() {
    const app = await findApp(pos[0]);
    await stream(`/apps/${app.id}/logs/stream`, (event, data) => {
      if (event === "line") console.log(data);
    });
  },
  async rollback() {
    const app = await findApp(pos[0]);
    if (!pos[1]) fail("Kullanım: xb rollback <uygulama> <deploy-no>");
    const { deploymentId } = await api("POST", `/apps/${app.id}/rollback/${pos[1]}`, {});
    console.log(`Geri dönüş deploy'u #${deploymentId} başladı.`);
  },
};

if (!cmd || !commands[cmd]) {
  console.log(fs.readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(2, 15).map((l) => l.replace(/^ \* ?/, "")).join("\n"));
  process.exit(cmd ? 1 : 0);
}
await commands[cmd]();
