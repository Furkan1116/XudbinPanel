/**
 * MaxMind DB (.mmdb) okuyucu — bağımlılıksız, yalnız okuma. DB-IP Lite ülke veritabanıyla kullanılır.
 * Biçim: https://maxmind.github.io/MaxMind-DB/
 */
import fs from "node:fs";
import net from "node:net";

const METADATA_MARKER = Buffer.from([0xab, 0xcd, 0xef, ...Buffer.from("MaxMind.com")]);

export class Mmdb {
  private buf: Buffer;
  private nodeCount: number;
  private recordSize: number;
  private nodeBytes: number;
  private treeSize: number;
  private dataStart: number;
  private ipv4Start = 0;
  readonly ipVersion: number;

  constructor(file: string) {
    this.buf = fs.readFileSync(file);
    const at = this.buf.lastIndexOf(METADATA_MARKER);
    if (at < 0) throw new Error("Geçersiz mmdb dosyası");
    const meta = this.decode(at + METADATA_MARKER.length, at + METADATA_MARKER.length)[0] as Record<string, number>;
    this.nodeCount = meta.node_count!;
    this.recordSize = meta.record_size!;
    this.ipVersion = meta.ip_version!;
    this.nodeBytes = (this.recordSize * 2) / 8;
    this.treeSize = this.nodeCount * this.nodeBytes;
    this.dataStart = this.treeSize + 16;
    if (this.ipVersion === 6) {
      // IPv4 adresleri ::a.b.c.d/96 altında: ilk 96 sıfır bit izlenir.
      let node = 0;
      for (let i = 0; i < 96 && node < this.nodeCount; i++) node = this.record(node, 0);
      this.ipv4Start = node;
    }
  }

  private record(node: number, bit: 0 | 1): number {
    const b = this.buf;
    const o = node * this.nodeBytes;
    switch (this.recordSize) {
      case 24:
        return bit === 0 ? b.readUIntBE(o, 3) : b.readUIntBE(o + 3, 3);
      case 28: {
        const middle = b[o + 3]!;
        return bit === 0 ? ((middle & 0xf0) << 20) | b.readUIntBE(o, 3) : ((middle & 0x0f) << 24) | b.readUIntBE(o + 4, 3);
      }
      case 32:
        return bit === 0 ? b.readUInt32BE(o) : b.readUInt32BE(o + 4);
      default:
        throw new Error(`Desteklenmeyen kayıt boyutu: ${this.recordSize}`);
    }
  }

  get(ip: string): unknown {
    let bytes: number[];
    let node: number;
    if (net.isIPv4(ip)) {
      bytes = ip.split(".").map(Number);
      node = this.ipVersion === 6 ? this.ipv4Start : 0;
    } else if (net.isIPv6(ip)) {
      if (this.ipVersion !== 6) return null;
      const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
      if (mapped) return this.get(mapped[1]!);
      bytes = ipv6Bytes(ip);
      node = 0;
    } else return null;
    for (let i = 0; i < bytes.length * 8 && node < this.nodeCount; i++) {
      const bit = ((bytes[i >> 3]! >> (7 - (i & 7))) & 1) as 0 | 1;
      node = this.record(node, bit);
    }
    if (node <= this.nodeCount) return null; // eşleşme yok
    const offset = node - this.nodeCount - 16 + this.dataStart;
    return this.decode(offset, this.dataStart)[0];
  }

  /** Veri bölümündeki bir değeri çözer; [değer, sonraki konum]. */
  private decode(offset: number, base: number): [unknown, number] {
    const b = this.buf;
    const ctrl = b[offset++]!;
    let type = ctrl >> 5;
    if (type === 1) {
      // işaretçi
      const size = (ctrl >> 3) & 0x3;
      const v = ctrl & 0x7;
      let ptr: number;
      if (size === 0) ptr = (v << 8) | b[offset]!;
      else if (size === 1) ptr = ((v << 16) | b.readUInt16BE(offset)) + 2048;
      else if (size === 2) ptr = ((v << 24) | b.readUIntBE(offset, 3)) + 526336;
      else ptr = b.readUInt32BE(offset);
      return [this.decode(base + ptr, base)[0], offset + size + 1];
    }
    if (type === 0) type = 7 + b[offset++]!; // genişletilmiş tür
    let size = ctrl & 0x1f;
    if (size === 29) size = 29 + b[offset++]!;
    else if (size === 30) {
      size = 285 + b.readUInt16BE(offset);
      offset += 2;
    } else if (size === 31) {
      size = 65821 + b.readUIntBE(offset, 3);
      offset += 3;
    }
    switch (type) {
      case 2:
        return [b.toString("utf8", offset, offset + size), offset + size];
      case 3:
        return [b.readDoubleBE(offset), offset + 8];
      case 4:
        return [b.subarray(offset, offset + size), offset + size];
      case 5:
      case 6:
      case 9:
      case 10: {
        let v = 0;
        for (let i = 0; i < size; i++) v = v * 256 + b[offset + i]!;
        return [v, offset + size];
      }
      case 8:
        return [size ? b.readIntBE(offset, size) : 0, offset + size];
      case 7: {
        const obj: Record<string, unknown> = {};
        for (let i = 0; i < size; i++) {
          const [k, o1] = this.decode(offset, base);
          const [v, o2] = this.decode(o1, base);
          obj[k as string] = v;
          offset = o2;
        }
        return [obj, offset];
      }
      case 11: {
        const arr: unknown[] = [];
        for (let i = 0; i < size; i++) {
          const [v, o] = this.decode(offset, base);
          arr.push(v);
          offset = o;
        }
        return [arr, offset];
      }
      case 14:
        return [size !== 0, offset];
      case 15:
        return [b.readFloatBE(offset), offset + 4];
      default:
        return [null, offset + size];
    }
  }
}

function ipv6Bytes(ip: string): number[] {
  const [head, tail] = ip.split("::");
  const parse = (s: string | undefined) => (s ? s.split(":").filter(Boolean) : []);
  const h = parse(head);
  const t = parse(tail);
  const groups = [...h, ...Array(8 - h.length - t.length).fill("0"), ...t];
  return groups.flatMap((g) => {
    const v = parseInt(g, 16);
    return [v >> 8, v & 0xff];
  });
}
