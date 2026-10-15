/**
 * Compose dosyasında sunucunun kendisine erişim veren ayarları bulur. Bunlar açıksa konteyner,
 * sunucuda root yetkisi alabilir (ör. privileged, / klasörünü bağlamak, docker.sock).
 * Uygulamada "sunucu erişimi" yalnız yöneticinin açabileceği bir izindir.
 */
type Service = Record<string, unknown>;

const HOST_MODES = ["network_mode", "pid", "ipc", "uts", "userns_mode", "cgroup"] as const;

function bindSource(v: unknown): string | null {
  if (typeof v === "string") {
    const src = v.split(":")[0] ?? "";
    return v.includes(":") ? src : null;
  }
  if (v && typeof v === "object") {
    const o = v as { type?: string; source?: string };
    return o.type === "bind" ? (o.source ?? "") : null;
  }
  return null;
}

/** Yalnız compose dosyasının kendi klasörü içindeki göreli yollar güvenli kabul edilir (./data gibi). */
const safeBind = (src: string) => /^\.{1}\//.test(src) && !src.split("/").includes("..");

export function composeHostAccessIssues(doc: { services?: Record<string, Service>; volumes?: Record<string, unknown>; include?: unknown }): string[] {
  const issues: string[] = [];
  // Başka dosyalardan gelen tanımlar burada denetlenemez.
  if (doc.include) issues.push("include ile başka compose dosyası ekleniyor");
  for (const [name, svc] of Object.entries(doc.services ?? {})) {
    if (!svc || typeof svc !== "object") continue;
    const at = `"${name}" servisi`;
    if (svc.extends && typeof svc.extends === "object" && (svc.extends as { file?: string }).file) issues.push(`${at}: extends ile başka dosya kullanılıyor`);
    if (svc.privileged === true || svc.privileged === "true") issues.push(`${at}: privileged`);
    if (Array.isArray(svc.cap_add) && svc.cap_add.length) issues.push(`${at}: cap_add (${svc.cap_add.join(", ")})`);
    if (Array.isArray(svc.devices) && svc.devices.length) issues.push(`${at}: devices`);
    if (Array.isArray(svc.device_cgroup_rules) && svc.device_cgroup_rules.length) issues.push(`${at}: device_cgroup_rules`);
    if (Array.isArray(svc.security_opt) && svc.security_opt.some((o) => /unconfined|no-new-privileges[:=]false/i.test(String(o)))) issues.push(`${at}: security_opt`);
    // "container:<ad>" başka bir konteynerin (ör. panel veya Caddy) ad alanına girer; aynı compose'taki "service:<ad>" serbest.
    for (const k of HOST_MODES) if (typeof svc[k] === "string" && /^(host$|container:)/.test(svc[k] as string)) issues.push(`${at}: ${k}: ${svc[k]}`);
    for (const v of Array.isArray(svc.volumes) ? svc.volumes : []) {
      const src = bindSource(v);
      if (src !== null && src !== "" && !/^[a-zA-Z0-9][\w.-]*$/.test(src) && !safeBind(src)) issues.push(`${at}: sunucu klasörü bağlanıyor (${src})`);
    }
  }
  for (const [name, vol] of Object.entries(doc.volumes ?? {})) {
    const opts = (vol as { driver_opts?: Record<string, string> } | null)?.driver_opts;
    if (opts && (opts.device || /bind/.test(opts.o ?? ""))) issues.push(`"${name}" volume'u sunucu klasörüne bağlanıyor`);
  }
  return issues;
}
