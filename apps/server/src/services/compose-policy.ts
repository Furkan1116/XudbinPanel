/**
 * Compose dosyasında sunucunun kendisine ya da başka projelere erişim verebilecek ayarları bulur.
 * Bunlar açıksa konteyner sunucuda root yetkisi alabilir (privileged, / klasörünü bağlamak,
 * docker.sock, panelin volume'larını devralmak...). Uygulamada "sunucu erişimi" yalnız
 * yöneticinin açabileceği bir izindir.
 *
 * Yaklaşım İZİN LİSTESİ: yalnız güvenli olduğu bilinen anahtarlar serbest; bilinmeyen her anahtar
 * de izin ister. Önceki kara liste `build.context`, `volumes_from`, dış volume/ağ gibi yolları
 * kaçırıyordu (bağımsız inceleme 2026-10-17, K2/K3/Y1/Y2).
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

/** Yalnız compose dosyasının kendi klasörü içindeki göreli yollar güvenli kabul edilir (., ./data gibi). */
export const safeRelative = (p: unknown) =>
  typeof p === "string" && (p === "." || /^\.\//.test(p)) && !p.split("/").includes("..");

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

function checkFileRef(issues: string[], at: string, what: string, p: unknown) {
  const path = isObj(p) ? p.path : p;
  if (!safeRelative(path)) issues.push(`${at}: ${what} compose klasörü dışını gösteriyor (${String(path)})`);
}

export function composeHostAccessIssues(doc: Obj & { services?: Record<string, Obj> }): string[] {
  const issues: string[] = [];
  if (!isObj(doc)) return ["Compose dosyası okunamadı"];

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
      } else if (!safeRelative(src)) {
        issues.push(`${at}: sunucu klasörü bağlanıyor (${src})`);
      }
    }

    for (const f of list(svc.env_file)) checkFileRef(issues, at, "env_file", f);

    if (svc.build !== undefined) {
      const b = typeof svc.build === "string" ? { context: svc.build } : isObj(svc.build) ? svc.build : {};
      for (const key of Object.keys(b)) if (!BUILD_KEYS.has(key) && !key.startsWith("x-")) issues.push(`${at}: build.${key}`);
      if (b.context !== undefined && !safeRelative(b.context)) issues.push(`${at}: build.context compose klasörü dışını gösteriyor (${String(b.context)})`);
      if (b.dockerfile !== undefined && (typeof b.dockerfile !== "string" || b.dockerfile.startsWith("/") || b.dockerfile.split("/").includes(".."))) {
        issues.push(`${at}: build.dockerfile klasör dışını gösteriyor`);
      }
      const extra = isObj(b.additional_contexts) ? Object.values(b.additional_contexts) : list(b.additional_contexts);
      for (const ctx of extra) {
        const s = String(ctx).includes("=") ? String(ctx).split("=").slice(1).join("=") : String(ctx);
        const sameCompose = s.startsWith("service:");
        if (!safeRelative(s) && !sameCompose) issues.push(`${at}: build.additional_contexts klasör dışını gösteriyor (${s})`);
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
    if (vol.name !== undefined) issues.push(`"${name}" volume'u başka bir adla (name) var olan volume'u gösterebilir`);
    if (vol.driver !== undefined && vol.driver !== "local") issues.push(`"${name}" volume'u ${String(vol.driver)} sürücüsü kullanıyor`);
    if (vol.driver_opts !== undefined) issues.push(`"${name}" volume'u driver_opts kullanıyor (sunucu klasörüne bağlanabilir)`);
  }

  // Üst düzey ağlar: yalnız bu projeye ait köprü ağları. Dış ağ başka projelere ve panele erişim verir.
  for (const [name, net] of Object.entries(isObj(doc.networks) ? doc.networks : {})) {
    if (!isObj(net)) continue;
    if (net.external) issues.push(`"${name}" ağı dış (external) bir ağ`);
    if (net.name !== undefined) issues.push(`"${name}" ağı başka bir adla (name) var olan ağa bağlanabilir`);
    if (net.driver !== undefined && net.driver !== "bridge") issues.push(`"${name}" ağı ${String(net.driver)} sürücüsü kullanıyor`);
    if (net.driver_opts !== undefined) issues.push(`"${name}" ağı driver_opts kullanıyor`);
  }

  // secrets/configs: yalnız compose klasöründeki dosyalar ya da satır içi içerik. "environment"
  // panel sürecinin ortamını okur; "external"/"name" başka kaynakları gösterir.
  for (const kind of ["secrets", "configs"] as const) {
    for (const [name, s] of Object.entries(isObj(doc[kind]) ? (doc[kind] as Obj) : {})) {
      if (!isObj(s)) continue;
      if (s.file !== undefined) checkFileRef(issues, `"${name}" (${kind})`, "file", s.file);
      if (s.environment !== undefined) issues.push(`"${name}" (${kind}): environment panelin ortam değişkenlerini okur`);
      if (s.external || s.name !== undefined) issues.push(`"${name}" (${kind}): dış kaynak`);
    }
  }

  return issues;
}
