import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Compose dosyasında sunucunun kendisine ya da başka projelere erişim verebilecek ayarları bulur.
 * Bunlar açıksa konteyner sunucuda root yetkisi alabilir (privileged, / klasörünü bağlamak,
 * docker.sock, panelin volume'larını devralmak...). Uygulamada "sunucu erişimi" yalnız
 * yöneticinin açabileceği bir izindir.
 *
 * Yaklaşım İZİN LİSTESİ: yalnız güvenli olduğu bilinen anahtarlar serbest; bilinmeyen her anahtar
 * de izin ister. Önceki kara liste `build.context`, `volumes_from`, dış volume/ağ gibi yolları
 * kaçırıyordu (bağımsız inceleme 2026-10-17, K2/K3/Y1/Y2).
 *
 * Denetim Compose'un gerçekten uygulayacağı hâl üzerinde yapılır: `docker compose config` çıktısında
 * değişkenler açılmış, `<<` birleştirmeleri uygulanmış, yollar mutlaktır; yollar derleme klasörüne göre
 * gerçek yol karşılaştırmasıyla sınırlanır. Komut çalışmazsa ham YAML katı kurallarla denetlenir:
 * değişken içeren yollar (`$`) ve `<<` anahtarları reddedilir (ham YAML'da `./${A:-..}` denetimden geçip
 * Compose tarafından klasör dışına açılıyordu).
 */
type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

/** Servis düzeyinde serbest anahtarlar. Değerleri ayrıca denetlenenler aşağıda. */
const SERVICE_KEYS = new Set([
  "image", "build", "command", "entrypoint", "environment", "env_file", "depends_on", "healthcheck",
  "restart", "volumes", "volumes_from", "expose", "ports", "labels", "working_dir", "user", "stop_signal",
  "stop_grace_period", "tty", "stdin_open", "init", "deploy", "mem_limit", "mem_reservation", "memswap_limit",
  "cpus", "cpu_shares", "ulimits", "logging", "hostname", "domainname", "networks", "shm_size", "tmpfs",
  "read_only", "platform", "pull_policy", "profiles", "secrets", "configs", "extra_hosts", "dns",
  "dns_search", "dns_opt", "security_opt", "cap_drop", "extends", "annotations", "attach", "scale",
  "post_start", "pre_stop", "develop", "network_mode", "pid", "ipc", "uts", "userns_mode", "cgroup",
]);

/** Değerine bakılmadan izin isteyen servis anahtarları (sunucu ya da başka konteyner etkisi). */
const HOST_SERVICE_KEYS = new Set([
  "privileged", "cap_add", "devices", "device_cgroup_rules", "sysctls", "container_name", "cgroup_parent",
  "runtime", "isolation", "oom_kill_disable", "oom_score_adj", "external_links", "links", "gpus",
  "storage_opt", "group_add", "volume_driver", "credential_spec", "mac_address", "blkio_config",
]);

const HOST_MODES = ["network_mode", "pid", "ipc", "uts", "userns_mode", "cgroup"] as const;
const BUILD_KEYS = new Set([
  "context", "dockerfile", "dockerfile_inline", "args", "target", "labels", "cache_from", "cache_to",
  "shm_size", "extra_hosts", "platforms", "pull", "no_cache", "tags", "additional_contexts", "secrets",
]);
const LOGGING_DRIVERS = new Set(["json-file", "local", "none"]);

/**
 * Ham YAML: yalnız compose dosyasının kendi klasörü içindeki göreli yollar güvenli kabul edilir (., ./data gibi).
 * `$` içeren yol reddedilir; Compose değişkeni açınca yol klasör dışına çıkabilir (`./${A:-..}`).
 */
export const safeRelative = (p: unknown) =>
  typeof p === "string" && !p.includes("$") && (p === "." || /^\.\//.test(p)) && !p.split("/").includes("..");

/** Var olmayan uçları da hesaba katan gerçek yol. Kırık kısayol (symlink) gibi çözülemeyen durumda null. */
function realPath(p: string): string | null {
  let current = path.resolve(p);
  const rest: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(current), ...rest);
    } catch {
      if (fs.lstatSync(current, { throwIfNoEntry: false })) return null; // var ama çözülemiyor (kırık kısayol)
      const parent = path.dirname(current);
      if (parent === current) return null;
      rest.unshift(path.basename(current));
      current = parent;
    }
  }
}

/** `docker compose config` çıktısındaki mutlak yol, gerçek yol olarak derleme klasörünün içinde mi? */
export function insideDir(base: string, p: unknown): boolean {
  if (typeof p !== "string" || !path.isAbsolute(p)) return false;
  const root = realPath(base);
  const target = realPath(p);
  if (!root || !target) return false;
  const rel = path.relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** Yolların ve proje adlarının nasıl yorumlanacağı: ham YAML ya da `docker compose config` çıktısı. */
type Mode = {
  pathOk: (p: unknown) => boolean;
  dockerfileOk: (context: unknown, dockerfile: unknown) => boolean;
  /** Compose'un kendi verdiği ad mı (config çıktısında her volume/ağ/sır "<proje>_<anahtar>" adını taşır)? */
  ownName: (key: string, name: unknown) => boolean;
};

const STATIC_MODE: Mode = {
  pathOk: safeRelative,
  dockerfileOk: (_context, d) => typeof d === "string" && !d.includes("$") && !d.startsWith("/") && !d.split("/").includes(".."),
  ownName: () => false,
};

function configMode(base: string, project: string): Mode {
  return {
    pathOk: (p) => insideDir(base, p),
    dockerfileOk: (context, d) => typeof context === "string" && typeof d === "string" && insideDir(base, path.resolve(context, d)),
    ownName: (key, name) => name === `${project}_${key}`,
  };
}

/** YAML birleştirme anahtarı (`<<`) herhangi bir derinlikte var mı? `yaml` kütüphanesi bunu uygulamaz, Compose uygular. */
function hasMergeKey(v: unknown): boolean {
  if (Array.isArray(v)) return v.some(hasMergeKey);
  return isObj(v) && Object.entries(v).some(([k, x]) => k === "<<" || hasMergeKey(x));
}

function bindSource(v: unknown): string | null {
  if (typeof v === "string") {
    if (!v.includes(":")) return null; // yalnız hedef: anonim volume
    return v.split(":")[0] ?? "";
  }
  if (isObj(v)) {
    if (v.type === "bind") return typeof v.source === "string" ? v.source : "";
    if (v.type === "volume" || v.type === undefined) return typeof v.source === "string" ? v.source : null;
    return v.type === "tmpfs" ? null : `${String(v.type)}:`; // npipe, cluster... desteklenmiyor
  }
  return null;
}

const namedVolume = (s: string) => /^[a-zA-Z0-9][\w.-]*$/.test(s);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);

function checkFileRef(issues: string[], mode: Mode, at: string, what: string, p: unknown) {
  const file = isObj(p) ? p.path : p;
  if (!mode.pathOk(file)) issues.push(`${at}: ${what} compose klasörü dışını gösteriyor (${String(file)})`);
}

/** Ham YAML için katı (statik) denetim: `docker compose config` çalıştırılamadığında kullanılır. */
export function composeHostAccessIssues(doc: Obj & { services?: Record<string, Obj> }): string[] {
  return policyIssues(doc, STATIC_MODE);
}

/**
 * `docker compose config --format json` çıktısının denetimi. `base` derleme klasörü (yollar onun içinde kalmalı),
 * `project` compose proje adı (-p).
 */
export function composeConfigIssues(config: unknown, base: string, project: string): string[] {
  return policyIssues(config as Obj, configMode(base, project));
}

function policyIssues(doc: Obj, mode: Mode): string[] {
  const issues: string[] = [];
  if (!isObj(doc)) return ["Compose dosyası okunamadı"];
  if (hasMergeKey(doc)) issues.push("YAML birleştirme anahtarı (<<) desteklenmiyor");

  for (const key of Object.keys(doc)) {
    if (key.startsWith("x-")) continue;
    if (!["services", "volumes", "networks", "secrets", "configs", "name", "version"].includes(key)) {
      issues.push(key === "include" ? "include ile başka compose dosyası ekleniyor" : `üst düzey "${key}" ayarı desteklenmiyor`);
    }
  }

  const services = isObj(doc.services) ? doc.services : {};
  const serviceNames = new Set(Object.keys(services));
  const declaredVolumes = new Set(Object.keys(isObj(doc.volumes) ? doc.volumes : {}));
  const declaredNetworks = new Set(Object.keys(isObj(doc.networks) ? doc.networks : {}));

  for (const [name, svc] of Object.entries(services)) {
    if (!isObj(svc)) continue;
    const at = `"${name}" servisi`;
    for (const key of Object.keys(svc)) {
      if (key.startsWith("x-")) continue;
      if (HOST_SERVICE_KEYS.has(key)) issues.push(`${at}: ${key}`);
      else if (!SERVICE_KEYS.has(key)) issues.push(`${at}: tanınmayan ayar "${key}"`);
    }

    if (isObj(svc.extends) && svc.extends.file) issues.push(`${at}: extends ile başka dosya kullanılıyor`);
    if (Array.isArray(svc.security_opt) && svc.security_opt.some((o) => /unconfined|no-new-privileges[:=]false|seccomp|apparmor|label/i.test(String(o)))) {
      issues.push(`${at}: security_opt`);
    }
    // "container:<ad>" başka bir konteynerin (ör. panel veya Caddy) ad alanına girer; "service:<ad>" aynı compose'ta olmalı.
    for (const k of HOST_MODES) {
      const v = svc[k];
      if (v === undefined) continue;
      const s = String(v);
      // "service:<ad>" Compose tarafından yalnız aynı proje içinde çözülür.
      const sameCompose = s.startsWith("service:");
      if (!(k === "network_mode" && (s === "bridge" || s === "none")) && !sameCompose) issues.push(`${at}: ${k}: ${s}`);
    }

    // volumes_from: yalnız aynı compose dosyasındaki servisler (panel konteyneri "container:xudbin" olamaz).
    for (const v of list(svc.volumes_from)) {
      const ref = String(v).split(":")[0] ?? "";
      if (String(v).startsWith("container:") || !serviceNames.has(ref)) issues.push(`${at}: volumes_from başka bir konteyneri gösteriyor (${String(v)})`);
    }

    for (const v of list(svc.volumes)) {
      const src = bindSource(v);
      if (src === null || src === "") continue;
      if (namedVolume(src)) {
        if (!declaredVolumes.has(src)) issues.push(`${at}: tanımlanmamış volume "${src}" (başka bir projenin volume'u olabilir)`);
      } else if (!mode.pathOk(src)) {
        issues.push(`${at}: sunucu klasörü bağlanıyor (${src})`);
      }
    }

    for (const f of list(svc.env_file)) checkFileRef(issues, mode, at, "env_file", f);

    if (svc.build !== undefined) {
      const b = typeof svc.build === "string" ? { context: svc.build } : isObj(svc.build) ? svc.build : {};
      for (const key of Object.keys(b)) if (!BUILD_KEYS.has(key) && !key.startsWith("x-")) issues.push(`${at}: build.${key}`);
      if (b.context !== undefined && !mode.pathOk(b.context)) issues.push(`${at}: build.context compose klasörü dışını gösteriyor (${String(b.context)})`);
      if (b.dockerfile !== undefined && !mode.dockerfileOk(b.context, b.dockerfile)) {
        issues.push(`${at}: build.dockerfile klasör dışını gösteriyor`);
      }
      const extra = isObj(b.additional_contexts) ? Object.values(b.additional_contexts) : list(b.additional_contexts);
      for (const ctx of extra) {
        const s = String(ctx).includes("=") ? String(ctx).split("=").slice(1).join("=") : String(ctx);
        const sameCompose = s.startsWith("service:");
        if (!mode.pathOk(s) && !sameCompose) issues.push(`${at}: build.additional_contexts klasör dışını gösteriyor (${s})`);
      }
    }

    if (isObj(svc.logging) && svc.logging.driver !== undefined && !LOGGING_DRIVERS.has(String(svc.logging.driver))) {
      issues.push(`${at}: logging.driver ${String(svc.logging.driver)}`);
    }

    const nets = Array.isArray(svc.networks) ? svc.networks : isObj(svc.networks) ? Object.keys(svc.networks) : [];
    for (const n of nets) if (n !== "default" && !declaredNetworks.has(String(n))) issues.push(`${at}: tanımlanmamış ağ "${String(n)}"`);
  }

  // Üst düzey volume'lar: yalnız yerel ve bu projeye ait. "name"/"external" var olan bir volume'u
  // (panelin verisi, başka uygulamalar) devralmayı sağlar.
  for (const [name, vol] of Object.entries(isObj(doc.volumes) ? doc.volumes : {})) {
    if (vol === null || vol === undefined) continue;
    if (!isObj(vol)) continue;
    if (vol.external) issues.push(`"${name}" volume'u dış (external) bir volume`);
    if (vol.name !== undefined && !mode.ownName(name, vol.name)) issues.push(`"${name}" volume'u başka bir adla (name) var olan volume'u gösterebilir`);
    if (vol.driver !== undefined && vol.driver !== "local") issues.push(`"${name}" volume'u ${String(vol.driver)} sürücüsü kullanıyor`);
    if (vol.driver_opts !== undefined) issues.push(`"${name}" volume'u driver_opts kullanıyor (sunucu klasörüne bağlanabilir)`);
  }

  // Üst düzey ağlar: yalnız bu projeye ait köprü ağları. Dış ağ başka projelere ve panele erişim verir.
  for (const [name, net] of Object.entries(isObj(doc.networks) ? doc.networks : {})) {
    if (!isObj(net)) continue;
    if (net.external) issues.push(`"${name}" ağı dış (external) bir ağ`);
    if (net.name !== undefined && !mode.ownName(name, net.name)) issues.push(`"${name}" ağı başka bir adla (name) var olan ağa bağlanabilir`);
    if (net.driver !== undefined && net.driver !== "bridge") issues.push(`"${name}" ağı ${String(net.driver)} sürücüsü kullanıyor`);
    if (net.driver_opts !== undefined) issues.push(`"${name}" ağı driver_opts kullanıyor`);
  }

  // secrets/configs: yalnız compose klasöründeki dosyalar ya da satır içi içerik. "environment"
  // panel sürecinin ortamını okur; "external"/"name" başka kaynakları gösterir.
  for (const kind of ["secrets", "configs"] as const) {
    for (const [name, s] of Object.entries(isObj(doc[kind]) ? (doc[kind] as Obj) : {})) {
      if (!isObj(s)) continue;
      if (s.file !== undefined) checkFileRef(issues, mode, `"${name}" (${kind})`, "file", s.file);
      if (s.environment !== undefined) issues.push(`"${name}" (${kind}): environment panelin ortam değişkenlerini okur`);
      if (s.external || (s.name !== undefined && !mode.ownName(name, s.name))) issues.push(`"${name}" (${kind}): dış kaynak`);
    }
  }

  return issues;
}

/**
 * `docker compose config --format json` çıktısını okur: değişkenler açılmış, birleştirmeler uygulanmış, yollar
 * mutlak. Profilli servisler de denetlensin diye tüm profiller açılır. Docker'a bağlanmaz; uzak sunucuda da
 * yereldeki docker CLI ile çalışır. Çalıştırılamazsa (Docker yok, eski sürüm) null döner.
 */
export function composeConfig(docker: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; signal?: AbortSignal }): Promise<unknown> {
  return new Promise((resolve) => {
    const child = spawn(docker, [...args, "--profile", "*", "config", "--format", "json"], {
      cwd: opts.cwd, env: { ...process.env, ...opts.env }, signal: opts.signal, stdio: ["ignore", "pipe", "ignore"],
    });
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve(code === 0 ? parseJson(out) : null));
  });
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
