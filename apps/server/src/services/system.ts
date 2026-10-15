import fs from "node:fs";
import os from "node:os";
import { config } from "../config.js";

type CpuTimes = { idle: number; total: number };

const HISTORY_SIZE = 60; // 2 sn aralıkla son 2 dakika
const history: { t: number; cpu: number; mem: number }[] = [];
let lastCpu = readCpuTimes();
let cpuPercent = 0;

function readCpuTimes(): CpuTimes {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    const t = cpu.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

/** Linux'ta "free" değil "available" bellek gerçek boş alanı gösterir (cache hariç). */
function readMemory() {
  const total = os.totalmem();
  let available = os.freemem();
  if (process.platform === "linux") {
    const match = fs.readFileSync("/proc/meminfo", "utf8").match(/^MemAvailable:\s+(\d+) kB/m);
    if (match) available = Number(match[1]) * 1024;
  }
  return { total, used: total - available };
}

function readDisk() {
  try {
    const s = fs.statfsSync(config.diskPath);
    const total = s.blocks * s.bsize;
    return { total, used: total - s.bavail * s.bsize };
  } catch {
    return null;
  }
}

function sample() {
  const now = readCpuTimes();
  const totalDiff = now.total - lastCpu.total;
  cpuPercent = totalDiff > 0 ? (1 - (now.idle - lastCpu.idle) / totalDiff) * 100 : 0;
  lastCpu = now;

  const mem = readMemory();
  history.push({ t: Date.now(), cpu: round(cpuPercent), mem: round((mem.used / mem.total) * 100) });
  if (history.length > HISTORY_SIZE) history.shift();
}

const round = (n: number) => Math.round(n * 10) / 10;

export function startSystemSampler() {
  sample();
  setInterval(sample, 2000).unref();
}

export function getSystemStats() {
  const cpus = os.cpus();
  return {
    // Konteyner içinde os.hostname() konteyner adını verir; kurulum gerçek adı env ile geçirir.
    hostname: process.env.HOST_HOSTNAME ?? os.hostname(),
    platform: `${os.type()} ${os.release()}`,
    arch: os.arch(),
    uptime: os.uptime(),
    cpu: {
      model: cpus[0]?.model.trim() ?? "Bilinmiyor",
      cores: cpus.length,
      usage: round(cpuPercent),
      load: os.loadavg().map(round),
    },
    memory: readMemory(),
    disk: readDisk(),
    history,
  };
}
