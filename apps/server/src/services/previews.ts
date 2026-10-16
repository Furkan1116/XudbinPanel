import { db } from "../db.js";
import { decrypt, randomToken } from "../lib/crypto.js";
import { dockerFor, removeContainer } from "./docker.js";
import { applyCaddyConfig } from "./caddy.js";
import { enqueueDeploy, getApp, type AppRow } from "./deploy.js";
import { commentAsApp } from "./github-app.js";
import { getServer } from "./servers.js";

/**
 * Pull request önizlemeleri: PR açılınca o dal için ayrı bir uygulama (kendi adresiyle) oluşturulur,
 * yeni commit'lerde yeniden deploy edilir, PR kapanınca silinir. Önizleme ana uygulamanın ayarlarını ve
 * ortam değişkenlerini kopyalar (XUDBIN_PREVIEW=1 eklenir); kalıcı klasörleri ayrıdır.
 * Güvenlik: yalnız aynı repodan açılan PR'lar; fork'tan gelen kod uygulamanın gizli bilgileriyle çalıştırılmaz.
 */
export type PrEvent = { action: "open" | "update" | "close"; number: number; branch: string; title: string; sameRepo: boolean; commentUrl?: string; repo?: string };

/** GitHub / Gitea / Forgejo / GitLab PR olaylarını ortak biçime çevirir; PR olayı değilse null. */
export function parsePrEvent(header: (n: string) => string | undefined, payload: Record<string, any>): PrEvent | null {
  const gh = header("x-github-event") ?? header("x-gitea-event") ?? header("x-forgejo-event") ?? header("x-gogs-event");
  if (gh === "pull_request" && payload.pull_request) {
    const pr = payload.pull_request;
    const a = payload.action;
    const action = a === "opened" || a === "reopened" ? "open" : a === "synchronize" || a === "synchronized" ? "update" : a === "closed" ? "close" : null;
    if (!action) return null;
    const head = pr.head?.repo?.full_name ?? pr.head?.repo?.fullName;
    const base = pr.base?.repo?.full_name ?? pr.base?.repo?.fullName;
    return { action, number: Number(pr.number ?? payload.number), branch: pr.head?.ref, title: pr.title ?? "", sameRepo: Boolean(head && head === base), commentUrl: pr.comments_url ?? pr.issue_url, repo: base };
  }
  if (header("x-gitlab-event") === "Merge Request Hook" && payload.object_attributes) {
    const mr = payload.object_attributes;
    const action = mr.action === "open" || mr.action === "reopen" ? "open" : mr.action === "update" ? "update" : mr.action === "close" || mr.action === "merge" ? "close" : null;
    if (!action) return null;
    return { action, number: Number(mr.iid), branch: mr.source_branch, title: mr.title ?? "", sameRepo: mr.source_project_id === mr.target_project_id };
  }
  return null;
}

const previewOf = (parentId: number, pr: number) => db.prepare("SELECT * FROM apps WHERE parent_app_id = ? AND preview_pr = ?").get(parentId, pr) as AppRow | undefined;

export async function handlePrEvent(parent: AppRow, ev: PrEvent) {
  if (!ev.sameRepo) return { ok: false, reason: "Fork'tan açılan PR'lar için önizleme oluşturulmaz (güvenlik)" };
  if (!/^[\w./-]{1,200}$/.test(ev.branch ?? "")) return { ok: false, reason: "Geçersiz dal adı" };
  const existing = previewOf(parent.id, ev.number);
  if (ev.action === "close") {
    if (existing) await deletePreview(existing);
    return { ok: true, removed: Boolean(existing) };
  }
  let app = existing;
  if (!app) {
    const server = getServer(parent.server_id);
    const base = parent.slug.replace(/-[a-z0-9]{4}$/, "");
    const slug = `${base}-pr${ev.number}-${randomToken(3).toLowerCase().replace(/[^a-z0-9]/g, "x").slice(0, 4)}`;
    const env = (decrypt(parent.env).trimEnd() + "\nXUDBIN_PREVIEW=1\n").trimStart();
    const { encrypt } = await import("../lib/crypto.js");
    const res = db
      .prepare(
        `INSERT INTO apps (project_id, server_id, name, slug, source_type, git_url, git_branch, git_token, build_type, framework, build_options,
           dockerfile_path, build_context, port, command, env, volumes, security, webhook_token, webhook_secret, webhook_signed, auto_deploy,
           http_check, health_path, memory_limit, cpu_limit, kind, parent_app_id, preview_pr, created_at)
         VALUES (?, ?, ?, ?, 'git', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        parent.project_id, parent.server_id, `${parent.name} PR #${ev.number}`, slug, parent.git_url, ev.branch, parent.git_token, parent.build_type,
        parent.framework, parent.build_options, parent.dockerfile_path, parent.build_context, parent.port, parent.command, encrypt(env), parent.volumes,
        parent.security, randomToken(24), randomToken(24), parent.http_check, parent.health_path, parent.memory_limit, parent.cpu_limit, parent.kind,
        parent.id, ev.number, Date.now(),
      );
    const id = Number(res.lastInsertRowid);
    if (server.public_ip) {
      const host = `${slug}.${server.public_ip.replace(/\./g, "-")}.sslip.io`;
      db.prepare("INSERT INTO domains (app_id, host, https, generated, created_at) VALUES (?, ?, ?, 1, ?)").run(id, host, server.https_mode === "off" ? 0 : 1, Date.now());
    }
    app = getApp(id)!;
  } else if (app.git_branch !== ev.branch) {
    db.prepare("UPDATE apps SET git_branch = ? WHERE id = ?").run(ev.branch, app.id);
  }
  const deploymentId = enqueueDeploy(app.id, "webhook", { title: `PR #${ev.number}: ${ev.title}`.slice(0, 200) });
  if (!existing && (ev.commentUrl || ev.repo)) void commentOnPr(parent, ev, app.id).catch(() => {});
  return { ok: true, previewAppId: app.id, deploymentId };
}

/** GitHub'da PR'a önizleme adresini yorum olarak yazar: GitHub App kuruluysa onun adına, değilse uygulamanın git token'ıyla. */
async function commentOnPr(parent: AppRow, ev: PrEvent, previewId: number) {
  const d = db.prepare("SELECT host, https FROM domains WHERE app_id = ? LIMIT 1").get(previewId) as { host: string; https: number } | undefined;
  if (!d) return;
  const text = `🚀 **Xudbin önizlemesi** hazırlanıyor: ${d.https ? "https" : "http"}://${d.host}\n\nYeni commit'lerde otomatik güncellenir, PR kapanınca silinir.`;
  if (ev.repo && (await commentAsApp(ev.repo, ev.number, text).catch(() => false))) return;
  const token = decrypt(parent.git_token);
  if (!token || !ev.commentUrl?.startsWith("https://api.github.com/")) return;
  await fetch(ev.commentUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
    body: JSON.stringify({ body: text }),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => {});
}

export async function deletePreview(app: AppRow) {
  const server = getServer(app.server_id);
  const docker = dockerFor(server);
  const containers = await docker.listContainers({ all: true, filters: { label: [`xudbin.app=${app.slug}`] } }).catch(() => []);
  for (const ct of containers) await removeContainer(docker, ct.Id);
  const images = await docker.listImages({ filters: { reference: [`xudbin/${app.slug}`] } }).catch(() => []);
  for (const img of images) await docker.getImage(img.Id).remove({ force: true }).catch(() => {});
  // Önizlemenin kalıcı klasörleri de silinir (ana uygulamanınkiler ayrıdır).
  const vols = await docker.listVolumes({ filters: { name: [`xb-${app.slug}-`] } }).catch(() => ({ Volumes: [] }));
  for (const v of vols.Volumes ?? []) await docker.getVolume(v.Name).remove().catch(() => {});
  db.prepare("DELETE FROM apps WHERE id = ?").run(app.id);
  if (server.status === "ready") await applyCaddyConfig(server).catch(() => {});
}
