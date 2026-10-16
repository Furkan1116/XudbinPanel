import { Resolver } from "node:dns/promises";

/**
 * Alan adının DNS kaydı sunucuyu gösteriyor mu? Sistem önbelleğine takılmamak için herkese açık çözücüler
 * (Cloudflare, Google) kullanılır. Cloudflare proxy (turuncu bulut) arkasındaysa IP farklı görünür; bu durum ayrıca söylenir.
 */
const resolver = new Resolver({ timeout: 4000, tries: 2 });
resolver.setServers(["1.1.1.1", "8.8.8.8"]);

const CLOUDFLARE = [/^104\.(1[6-9]|2[0-9]|3[01])\./, /^172\.(6[4-9]|7[01])\./, /^188\.114\.(9[6-9]|1[01][0-9])\./, /^162\.15[89]\./, /^141\.101\./, /^108\.162\./, /^190\.93\./, /^198\.41\./, /^173\.245\./, /^103\.(21|22|31)\./];

export type DnsStatus = { host: string; ok: boolean; addresses: string[]; reason: "ok" | "missing" | "mismatch" | "proxied" | "error"; message: string };

export async function checkDomain(host: string, expectedIp: string | null): Promise<DnsStatus> {
  let v4: string[] = [];
  let v6: string[] = [];
  try {
    v4 = await resolver.resolve4(host).catch((e: NodeJS.ErrnoException) => (e.code === "ENODATA" || e.code === "ENOTFOUND" ? [] : Promise.reject(e)));
    v6 = await resolver.resolve6(host).catch(() => []);
  } catch (e) {
    return { host, ok: false, addresses: [], reason: "error", message: `DNS sorgulanamadı: ${(e as Error).message}` };
  }
  const addresses = [...v4, ...v6];
  if (!addresses.length) return { host, ok: false, addresses, reason: "missing", message: `${host} için DNS kaydı yok. Alan adı sağlayıcında A kaydı ekle: ${host} → ${expectedIp ?? "sunucunun IP'si"}` };
  if (!expectedIp || v4.includes(expectedIp)) return { host, ok: true, addresses, reason: "ok", message: "DNS kaydı bu sunucuyu gösteriyor." };
  if (v4.some((ip) => CLOUDFLARE.some((re) => re.test(ip))))
    return { host, ok: false, addresses, reason: "proxied", message: "Alan adı Cloudflare proxy'si (turuncu bulut) arkasında. Sertifika alınabilmesi için Cloudflare'de SSL modunu \"Full (strict)\" yap ya da proxy'yi kapat." };
  return { host, ok: false, addresses, reason: "mismatch", message: `DNS kaydı ${v4.join(", ") || addresses.join(", ")} adresini gösteriyor, sunucu ise ${expectedIp}. A kaydını ${expectedIp} olarak değiştir.` };
}
