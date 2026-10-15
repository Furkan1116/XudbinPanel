import { createHash, createHmac } from "node:crypto";
import fs from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/**
 * S3 uyumlu depolama için küçük istemci (AWS S3, Cloudflare R2, Backblaze B2, MinIO, Wasabi...).
 * AWS Signature V4 ile imzalar, path-style adres kullanır (ör. https://<hesap>.r2.cloudflarestorage.com/<bucket>/<anahtar>).
 */
export type S3Target = { endpoint: string; region: string; bucket: string; accessKey: string; secretKey: string; prefix: string };

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const hmac = (key: string | Buffer, data: string) => createHmac("sha256", key).update(data).digest();
const encodeKey = (key: string) => key.split("/").map(encodeURIComponent).join("/");

function sign(t: S3Target, method: string, key: string, query: Record<string, string>, headers: Record<string, string>, payloadHash: string) {
  const url = new URL(t.endpoint.replace(/\/+$/, ""));
  const path = `${url.pathname.replace(/\/$/, "")}/${encodeURIComponent(t.bucket)}${key ? `/${encodeKey(key)}` : ""}`;
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const day = amzDate.slice(0, 8);
  const region = t.region || "auto";
  const all: Record<string, string> = { ...headers, host: url.host, "x-amz-date": amzDate, "x-amz-content-sha256": payloadHash };
  const names = Object.keys(all).map((h) => h.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(all).map(([k, v]) => [k.toLowerCase(), String(v).trim()]));
  const qs = Object.keys(query)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(query[k]!)}`)
    .join("&");
  const canonical = [method, path, qs, names.map((h) => `${h}:${lower[h]}\n`).join(""), names.join(";"), payloadHash].join("\n");
  const scope = `${day}/${region}/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n");
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${t.secretKey}`, day), region), "s3"), "aws4_request");
  const signature = createHmac("sha256", kSigning).update(toSign).digest("hex");
  lower.authorization = `AWS4-HMAC-SHA256 Credential=${t.accessKey}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`;
  delete lower.host;
  return { url: `${url.origin}${path}${qs ? `?${qs}` : ""}`, headers: lower };
}

async function request(t: S3Target, method: string, key: string, opts: { query?: Record<string, string>; body?: Buffer | Readable; size?: number; headers?: Record<string, string> } = {}) {
  const headers = { ...(opts.headers ?? {}) };
  if (opts.size !== undefined) headers["content-length"] = String(opts.size);
  const payloadHash = Buffer.isBuffer(opts.body) ? sha256(opts.body) : opts.body ? "UNSIGNED-PAYLOAD" : sha256("");
  const signed = sign(t, method, key, opts.query ?? {}, headers, payloadHash);
  const res = await fetch(signed.url, {
    method,
    headers: signed.headers,
    body: opts.body ? (Buffer.isBuffer(opts.body) ? opts.body : (Readable.toWeb(opts.body) as ReadableStream)) : undefined,
    ...(opts.body && !Buffer.isBuffer(opts.body) ? { duplex: "half" } : {}),
  } as RequestInit);
  if (!res.ok && !(method === "DELETE" && res.status === 404)) {
    const text = await res.text().catch(() => "");
    const code = text.match(/<Code>([^<]+)<\/Code>/)?.[1];
    const msg = text.match(/<Message>([^<]+)<\/Message>/)?.[1];
    throw new Error(`Depolama ${res.status} döndürdü${code ? `: ${code}` : ""}${msg ? ` (${msg})` : ""}`);
  }
  return res;
}

function fullKey(t: S3Target, key: string) {
  const prefix = t.prefix.replace(/^\/+|\/+$/g, "");
  return prefix ? `${prefix}/${key}` : key;
}

export async function s3Upload(t: S3Target, key: string, file: string) {
  const size = fs.statSync(file).size;
  await request(t, "PUT", fullKey(t, key), { body: fs.createReadStream(file), size, headers: { "content-type": "application/octet-stream" } });
  return fullKey(t, key);
}

/** Tam anahtarla (önek dahil) indirir. */
export async function s3Download(t: S3Target, absoluteKey: string, dest: string) {
  const res = await request(t, "GET", absoluteKey);
  await pipeline(Readable.fromWeb(res.body as never), fs.createWriteStream(dest));
}

export async function s3Delete(t: S3Target, absoluteKey: string) {
  await request(t, "DELETE", absoluteKey);
}

/** Bağlantıyı ve yazma iznini dener: küçük bir dosya yazıp siler. */
export async function s3Test(t: S3Target) {
  const key = fullKey(t, `.xudbin-test-${Date.now()}`);
  await request(t, "PUT", key, { body: Buffer.from("ok"), size: 2 });
  await request(t, "DELETE", key);
}
