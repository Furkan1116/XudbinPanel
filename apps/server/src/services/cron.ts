import { db } from "../db.js";
import { cronMatches, parseCron } from "../lib/cron.js";
import { decrypt } from "../lib/crypto.js";
import { timeZone } from "./analytics.js";
import { demuxLogs, fillPlaceholders, getApp, parseEnv } from "./deploy.js";
import { dockerFor, removeContainer, withTimeout } from "./docker.js";
import { ensureProjectNetwork } from "./networks.js";
import { notify } from "./notify.js";
import { getServer } from "./servers.js";

/**
 * Zamanlanmış görevler: uygulamanın son imajı, ortam değişkenleri, kalıcı klasörleri ve proje ağıyla
 * kısa ömürlü bir konteynerde komut çalıştırır (ör. "python manage.py clearsessions", "php artisan schedule:run").
 * Aynı görev üst üste binmez; çıktının son 500 satırı saklanır, her görev için son 20 çalışma tutulur.
 */
export type CronJob = { id: number; app_id: number; name: string; schedule: string; command: string; enabled: number; timeout_min: number; last_run_at: number | null };

const running = new Set<number>();

export async function runCronJob(jobId: number, trigger: "schedule" | "manual" = "schedule") {
  const job = db.prepare("SELECT * FROM cron_jobs WHERE id = ?").get(jobId) as CronJob | undefined;
  if (!job) throw new Error("Görev bulunamadı");
  if (running.has(job.id)) throw new Error("Görev zaten çalışıyor");
  const app = getApp(job.app_id);
  if (!app?.current_image || app.source_type === "compose") throw new Error("Görev için uygulamanın deploy edilmiş bir imajı olmalı (Compose uygulamaları desteklenmez)");
  running.add(job.id);
  const runId = Number(db.prepare("INSERT INTO cron_runs (job_id, started_at, status, trigger) VALUES (?, ?, 'running', ?)").run(job.id, Date.now(), trigger).lastInsertRowid);
  db.prepare("UPDATE cron_jobs SET last_run_at = ? WHERE id = ?").run(Date.now(), job.id);
  const server = getServer(app.server_id);
  const docker = dockerFor(server);
  const name = `xb-cron-${app.slug}-${job.id}-${runId}`;
  let status = "failed";
  let exitCode: number | null = null;
  let output = "";
  try {
    const filled = fillPlaceholders(parseEnv(decrypt(app.env)), app.id, server.https_mode !== "off");
    const env = { PORT: String(app.port), XUDBIN_URL: filled.values.XUDBIN_URL!, XUDBIN_CRON: job.name, ...filled.env };
    const volumes = JSON.parse(app.volumes || "[]") as { name: string; path: string }[];
    const container = await docker.createContainer({
      name,
      Image: app.current_image,
      Entrypoint: ["sh", "-c"],
      Cmd: [job.command],
      Env: Object.entries(env).map(([k, v]) => `${k}=${v}`),
      Labels: { "xudbin.managed": "true", "xudbin.app": app.slug, "xudbin.task": "cron" },
      HostConfig: {
        NetworkMode: await ensureProjectNetwork(server, app.project_id),
        Binds: volumes.map((v) => `xb-${app.slug}-${v.name}:${v.path}`),
        ...(app.memory_limit ? { Memory: app.memory_limit * 1024 * 1024 } : {}),
        ...(app.cpu_limit ? { NanoCpus: Math.round(app.cpu_limit * 1e9) } : {}),
      },
    });
    await container.start();
    const res = (await withTimeout(container.wait(), job.timeout_min * 60_000, `Görev ${job.timeout_min} dakikada bitmedi ve durduruldu`)) as { StatusCode: number };
    exitCode = res.StatusCode;
    status = exitCode === 0 ? "success" : "failed";
    output = demuxLogs((await container.logs({ stdout: true, stderr: true, tail: 500 })) as Buffer).join("\n");
  } catch (err) {
    output = `${output}\n${(err as Error).message}`.trim();
  } finally {
    await removeContainer(docker, name).catch(() => {});
    running.delete(job.id);
    db.prepare("UPDATE cron_runs SET finished_at = ?, status = ?, exit_code = ?, output = ? WHERE id = ?").run(Date.now(), status, exitCode, output.slice(-100_000), runId);
    db.prepare("DELETE FROM cron_runs WHERE job_id = ? AND id NOT IN (SELECT id FROM cron_runs WHERE job_id = ? ORDER BY id DESC LIMIT 20)").run(job.id, job.id);
  }
  if (status !== "success") notify("cron_failed", `${app.name}: "${job.name}" görevi başarısız`, `Çıkış kodu ${exitCode ?? "-"}. Son çıktı:\n${output.split("\n").slice(-10).join("\n")}`);
  return { status, exitCode };
}

export function startCronScheduler() {
  const tick = () => {
    const now = Date.now();
    const minute = Math.floor(now / 60_000) * 60_000;
    const tz = timeZone();
    const jobs = db.prepare("SELECT j.* FROM cron_jobs j JOIN apps a ON a.id = j.app_id WHERE j.enabled = 1 AND a.status = 'running'").all() as CronJob[];
    for (const j of jobs) {
      try {
        if (!cronMatches(parseCron(j.schedule), minute, tz)) continue;
      } catch {
        continue;
      }
      // Aynı dakikada iki kez çalışmasın (panel yeniden başlarsa).
      if (j.last_run_at && j.last_run_at >= minute) continue;
      runCronJob(j.id).catch((err) => console.error(`Zamanlanmış görev çalışmadı (#${j.id}):`, (err as Error).message));
    }
  };
  // Her dakikanın başında.
  const align = 60_000 - (Date.now() % 60_000) + 500;
  setTimeout(() => {
    tick();
    setInterval(tick, 60_000).unref();
  }, align).unref();
}
