import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import YAML from "yaml";
import { resolveInside } from "../src/lib/paths.js";
import { verifyWebhook } from "../src/routes/apps.js";
import { composeHostAccessIssues } from "../src/services/compose-policy.js";
import { openRepo } from "../src/services/frameworks/util.js";

test("compose: zararsız dosyada sorun yok", () => {
  const doc = YAML.parse("services:\n  web:\n    image: nginx\n    volumes: [data:/d, ./conf:/etc/x]\n    network_mode: 'service:db'\nvolumes: {data: {}}");
  assert.deepEqual(composeHostAccessIssues(doc), []);
});

test("compose: sunucuya erişim veren her ayar yakalanır", () => {
  const doc = YAML.parse(`services:
  web:
    image: nginx
    privileged: true
    cap_add: [SYS_ADMIN]
    pid: host
    network_mode: "container:xudbin-caddy"
    volumes: ["/:/host", "/var/run/docker.sock:/s", "../x:/y", {type: bind, source: /etc, target: /e}]
volumes:
  evil: {driver_opts: {type: none, o: bind, device: /}}
include: [other.yml]`);
  const issues = composeHostAccessIssues(doc).join("\n");
  for (const s of ["privileged", "cap_add", "pid: host", "container:xudbin-caddy", "(/)", "docker.sock", "../x", "(/etc)", "evil", "include"]) assert.ok(issues.includes(s), s);
});

test("yol kaçışı ve klasör dışına giden kısayollar engellenir", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xb-paths-"));
  fs.writeFileSync(path.join(root, "ok.txt"), "x");
  fs.symlinkSync("/etc/hosts", path.join(root, ".env.example"));
  fs.mkdirSync(path.join(root, "src"));
  assert.ok(resolveInside(root, "ok.txt"));
  assert.ok(resolveInside(root, "src/../ok.txt"));
  assert.equal(resolveInside(root, "../etc/passwd"), null);
  assert.equal(resolveInside(root, ".env.example"), null);
  const repo = openRepo(root);
  assert.equal(repo.read(".env.example"), "");
  assert.equal(repo.has(".env.example"), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test("webhook imzaları doğrulanır", () => {
  const app = { webhook_secret: "s3cret", webhook_signed: 1 };
  const body = '{"ref":"refs/heads/main"}';
  const sig = "sha256=" + createHmac("sha256", "s3cret").update(body).digest("hex");
  const h = (o: Record<string, string>) => (n: string) => o[n];
  assert.equal(verifyWebhook(app, body, h({ "x-hub-signature-256": sig })), true);
  assert.equal(verifyWebhook(app, body + " ", h({ "x-hub-signature-256": sig })), false);
  assert.equal(verifyWebhook(app, body, h({ "x-gitlab-token": "s3cret" })), true);
  assert.equal(verifyWebhook(app, body, h({})), false);
  assert.equal(verifyWebhook({ ...app, webhook_signed: 0 }, body, h({})), true);
});

test("PR olayları: GitHub, GitLab ve fork koruması", async () => {
  const { parsePrEvent } = await import("../src/services/previews.js");
  const gh = (o: Record<string, string>) => (n: string) => o[n];
  const ev = parsePrEvent(gh({ "x-github-event": "pull_request" }), {
    action: "synchronize",
    number: 7,
    pull_request: { number: 7, title: "Yeni sayfa", head: { ref: "ozellik", repo: { full_name: "a/b" } }, base: { repo: { full_name: "a/b" } } },
  });
  assert.deepEqual({ ...ev, commentUrl: undefined }, { action: "update", number: 7, branch: "ozellik", title: "Yeni sayfa", sameRepo: true, commentUrl: undefined, repo: "a/b" });
  const fork = parsePrEvent(gh({ "x-github-event": "pull_request" }), {
    action: "opened",
    pull_request: { number: 8, head: { ref: "x", repo: { full_name: "kotu/b" } }, base: { repo: { full_name: "a/b" } } },
  });
  assert.equal(fork?.sameRepo, false);
  const gl = parsePrEvent(gh({ "x-gitlab-event": "Merge Request Hook" }), { object_attributes: { action: "merge", iid: 3, source_branch: "f", source_project_id: 1, target_project_id: 1 } });
  assert.equal(gl?.action, "close");
  assert.equal(parsePrEvent(gh({ "x-github-event": "push" }), { ref: "refs/heads/main" }), null);
});

test("GitHub App: repo adı eşleme ve webhook imzası", async () => {
  const { githubRepoOf, verifyGithubSignature } = await import("../src/services/github-app.js");
  assert.equal(githubRepoOf("https://github.com/Furkan1116/XudbinPanel.git"), "furkan1116/xudbinpanel");
  assert.equal(githubRepoOf("https://x-access-token:t@github.com/a/b"), "a/b");
  assert.equal(githubRepoOf("https://gitlab.com/a/b.git"), null);
  assert.equal(githubRepoOf("https://github.com.evil.com/a/b"), null);
  // App bağlı değilken hiçbir imza kabul edilmez.
  assert.equal(verifyGithubSignature("{}", "sha256=00"), false);
});
