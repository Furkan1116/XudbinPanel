import { zipSync } from "fflate";
import { FolderUp, Loader2 } from "lucide-react";
import { useRef, useState } from "react";
import { t } from "@/lib/i18n";

/** Arşive girmeyecekler: bağımlılık klasörleri, derleme önbellekleri ve gizli bilgi içeren .env dosyaları. */
const SKIP = /(^|\/)(node_modules|\.git|venv|\.venv|__pycache__|\.next|\.nuxt|\.svelte-kit|\.turbo|\.cache|\.DS_Store|\.idea|\.vscode)(\/|$)|(^|\/)\.env(\.[\w-]+)?$/;
const KEEP_ENV = /(^|\/)\.env\.(example|sample|template|dist)$/;

export type Packed = { blob: Blob; name: string; files: number; skippedEnv: boolean };

async function readEntry(entry: FileSystemEntry, prefix: string, out: Record<string, File>): Promise<void> {
  const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
  if (SKIP.test(rel) && !KEEP_ENV.test(rel)) {
    if (/\.env/.test(rel)) out.__skippedEnv = new File([], "x");
    return;
  }
  if (entry.isFile) {
    out[rel] = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
  } else if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
      if (!batch.length) break;
      for (const e of batch) await readEntry(e, rel, out);
    }
  }
}

async function pack(files: Record<string, File>, name: string): Promise<Packed> {
  const skippedEnv = Boolean(files.__skippedEnv);
  delete files.__skippedEnv;
  const entries = Object.entries(files);
  if (!entries.length) throw new Error(t("Klasör boş"));
  const data: Record<string, Uint8Array> = {};
  for (const [p, f] of entries) data[p] = new Uint8Array(await f.arrayBuffer());
  const zipped = zipSync(data, { level: 6 });
  return { blob: new Blob([zipped], { type: "application/zip" }), name, files: entries.length, skippedEnv };
}

/**
 * Proje klasörünü veya .zip dosyasını sürükle-bırak ile alır. Klasörler tarayıcıda zip'lenir.
 */
export function DropZone({ onReady, busy, hint }: { onReady: (p: Packed) => void; busy?: boolean; hint?: string }) {
  const [over, setOver] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirInput = useRef<HTMLInputElement>(null);
  const zipInput = useRef<HTMLInputElement>(null);

  const handle = async (fn: () => Promise<Packed>) => {
    setError(null);
    setWorking(true);
    try {
      onReady(await fn());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setWorking(false);
    }
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setOver(false);
    const items = [...e.dataTransfer.items].map((i) => i.webkitGetAsEntry()).filter(Boolean) as FileSystemEntry[];
    const zip = [...e.dataTransfer.files].find((f) => /\.zip$/i.test(f.name));
    if (items.length === 1 && items[0]!.isFile && zip) {
      return handle(async () => ({ blob: zip, name: zip.name, files: 0, skippedEnv: false }));
    }
    handle(async () => {
      const out: Record<string, File> = {};
      // Tek klasör bırakıldıysa içindekiler köke alınır.
      if (items.length === 1 && items[0]!.isDirectory) {
        const reader = (items[0] as FileSystemDirectoryEntry).createReader();
        for (;;) {
          const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
          if (!batch.length) break;
          for (const en of batch) await readEntry(en, "", out);
        }
        return pack(out, items[0]!.name);
      }
      for (const en of items) await readEntry(en, "", out);
      return pack(out, "proje");
    });
  };

  const fromDirInput = (list: FileList | null) => {
    if (!list?.length) return;
    handle(async () => {
      const out: Record<string, File> = {};
      for (const f of list) {
        const rel = f.webkitRelativePath.split("/").slice(1).join("/");
        if (SKIP.test(rel) && !KEEP_ENV.test(rel)) {
          if (/\.env/.test(rel)) out.__skippedEnv = new File([], "x");
          continue;
        }
        out[rel] = f;
      }
      return pack(out, list[0]!.webkitRelativePath.split("/")[0] ?? "proje");
    });
  };

  const loading = working || busy;
  return (
    <div>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
        className={`flex flex-col items-center justify-center gap-2 rounded-[10px] border-2 border-dashed px-4 py-8 text-center transition-colors ${
          over ? "border-accent bg-accent-soft/40" : "border-line-strong"
        }`}
      >
        {loading ? <Loader2 className="size-7 animate-spin text-accent" /> : <FolderUp className="size-7 text-faint" strokeWidth={1.6} />}
        <div className="text-[15px] font-medium">{loading ? (working ? t("Hazırlanıyor...") : t("Yükleniyor...")) : t("Proje klasörünü veya .zip dosyasını buraya bırak")}</div>
        <div className="text-[13px] text-muted">
          {hint ?? t("node_modules, .git, venv ve .env dosyaları otomatik atlanır.")} En fazla 300 MB.
        </div>
        {!loading && (
          <div className="mt-1 flex gap-2">
            <button type="button" className="text-[13px] text-accent hover:underline" onClick={() => dirInput.current?.click()}>
              {t("Klasör seç")}
            </button>
            <span className="text-faint">{t("ya da")}</span>
            <button type="button" className="text-[13px] text-accent hover:underline" onClick={() => zipInput.current?.click()}>
              {t("Zip seç")}
            </button>
          </div>
        )}
        <input ref={dirInput} type="file" className="hidden" {...({ webkitdirectory: "", directory: "" } as object)} onChange={(e) => fromDirInput(e.target.files)} />
        <input ref={zipInput} type="file" accept=".zip,application/zip" className="hidden" onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) handle(async () => ({ blob: f, name: f.name, files: 0, skippedEnv: false }));
        }} />
      </div>
      {error && <p className="mt-2 text-[13px] text-accent">{error}</p>}
    </div>
  );
}

/** Zip'i panelin yükleme ucuna gönderir. */
export async function uploadZip<T>(path: string, blob: Blob): Promise<T> {
  const res = await fetch(`/api${path}`, { method: "POST", body: blob, headers: { "content-type": "application/zip" }, credentials: "same-origin" });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? t("Yükleme başarısız ({status})", { status: res.status }));
  return body as T;
}
