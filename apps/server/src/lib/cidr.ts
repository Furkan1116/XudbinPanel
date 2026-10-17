import { isIPv4, isIPv6 } from "node:net";

/** IP'yi 128 bitlik BigInt'e çevirir; IPv4 adresleri ::ffff:a.b.c.d olarak eşlenir ki iki aile karşılaştırılabilsin. */
function toBig(ip: string): bigint | null {
  const v4 = (s: string) => s.split(".").reduce((n, p) => (n << 8n) | BigInt(Number(p)), 0n);
  if (isIPv4(ip)) return (0xffffn << 32n) | v4(ip);
  let s = ip.toLowerCase();
  if (!isIPv6(s)) return null;
  const mapped = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/); // ::ffff:1.2.3.4 gibi yazımlar
  if (mapped) {
    const n = v4(mapped[2]!);
    s = `${mapped[1]}${((n >> 16n) & 0xffffn).toString(16)}:${(n & 0xffffn).toString(16)}`;
  }
  const [head, tail] = s.split("::") as [string, string | undefined];
  const parts = (x: string) => (x ? x.split(":") : []);
  const h = parts(head);
  const t = tail === undefined ? [] : parts(tail);
  const fill = tail === undefined ? [] : Array(8 - h.length - t.length).fill("0");
  const groups = [...h, ...fill, ...t];
  if (groups.length !== 8) return null;
  return groups.reduce((n, g) => (n << 16n) | BigInt(parseInt(g, 16)), 0n);
}

/** "1.2.3.4", "10.0.0.0/8", "2001:db8::/32" biçimlerini (başlangıç, bit uzunluğu) olarak çözer; geçersizse null. */
export function parseCidr(entry: string): { base: bigint; bits: number } | null {
  const [addr, len] = entry.trim().split("/") as [string, string | undefined];
  const base = toBig(addr);
  if (base === null) return null;
  const v4 = isIPv4(addr);
  const max = v4 ? 32 : 128;
  const n = len === undefined ? max : /^\d{1,3}$/.test(len) ? Number(len) : NaN;
  if (!(n >= 0 && n <= max)) return null;
  return { base, bits: v4 ? n + 96 : n };
}

export function isValidIpOrCidr(entry: string) {
  return parseCidr(entry) !== null;
}

export function ipInCidr(ip: string, entry: string): boolean {
  const addr = toBig(ip);
  const net = parseCidr(entry);
  if (addr === null || !net) return false;
  const shift = BigInt(128 - net.bits);
  return addr >> shift === net.base >> shift;
}

export function ipInList(ip: string, list: string[]): boolean {
  return list.some((e) => ipInCidr(ip, e));
}
