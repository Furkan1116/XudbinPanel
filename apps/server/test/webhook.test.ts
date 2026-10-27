import assert from "node:assert/strict";
import { test } from "node:test";
import { db } from "../src/db.js";
import { updateSettings } from "../src/lib/settings.js";
import { webhookBase, webhookRoutes } from "../src/routes/apps.js";

function seedApp(over: { auto_deploy?: number } = {}) {
  const now = Date.now();
  const tag = Math.random().toString(36).slice(2, 8);
  if (!db.prepare("SELECT 1 FROM servers WHERE id = 987101").get())
    db.prepare("INSERT INTO servers (id, name, kind, status, created_at) VALUES (987101, 'wh', 'ssh', 'ready', ?)").run(now);
  const pid = Number(db.prepare("INSERT INTO projects (name, description, created_at) VALUES (?, '', ?)").run(`wp-${tag}`, now).lastInsertRowid);
  const id = Number(
    db.prepare("INSERT INTO apps (project_id, server_id, name, slug, source_type, git_branch, port, webhook_token, auto_deploy, created_at) VALUES (?, 987101, 'a', ?, 'git', 'main', 80, ?, ?, ?)")
      .run(pid, `w-${tag}`, `tok-${tag}`, over.auto_deploy ?? 0, now).lastInsertRowid,
  );
  return { id, token: `tok-${tag}` };
}
const last = (id: number) => JSON.parse((db.prepare("SELECT last_webhook FROM apps WHERE id = ?").get(id) as { last_webhook: string }).last_webhook);

test("webhook adresi panelin alan adından kurulur; alan adı yoksa boş (arayüz tarayıcı adresini kullanır)", () => {
  updateSettings({ panelDomain: "", panelHttps: true });
  assert.equal(webhookBase(), "");
  updateSettings({ panelDomain: "panel.ornek.com", panelHttps: true });
  assert.equal(webhookBase(), "https://panel.ornek.com");
  updateSettings({ panelDomain: "" });
});

test("son webhook kaydedilir: atlanan olay, ping ve geçersiz token", async () => {
  const a = seedApp();
  const post = (token: string, headers: Record<string, string> = {}) =>
    webhookRoutes.request(`/deploy/${token}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: '{"ref":"refs/heads/main"}' });

  assert.equal((await post(a.token, { "x-github-event": "push" })).status, 200);
  let w = last(a.id);
  assert.equal(w.event, "push");
  assert.equal(w.ok, true);
  assert.equal(w.result, "Otomatik deploy kapalı");
  assert.ok(Date.now() - w.at < 5000);

  db.prepare("UPDATE apps SET auto_deploy = 1 WHERE id = ?").run(a.id);
  await post(a.token, { "x-github-event": "ping" });
  w = last(a.id);
  assert.equal(w.event, "ping");
  assert.match(w.result, /deploy başlatmaz/);

  assert.equal((await post("yok-boyle-token")).status, 404);
});
