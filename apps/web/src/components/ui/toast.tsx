import { useSyncExternalStore } from "react";

type Toast = { id: number; tone: "ok" | "error"; text: string };
let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function toast(text: string, tone: Toast["tone"] = "ok") {
  const id = nextId++;
  toasts = [...toasts, { id, tone, text }];
  emit();
  setTimeout(() => {
    toasts = toasts.filter((t) => t.id !== id);
    emit();
  }, tone === "error" ? 7000 : 3500);
}

export function Toaster() {
  const list = useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => toasts,
  );
  return (
    <div aria-live="polite" className="pointer-events-none fixed right-4 bottom-4 z-50 flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2">
      {list.map((t) => (
        <div
          key={t.id}
          role={t.tone === "error" ? "alert" : "status"}
          className={`pointer-events-auto rounded-md border px-4 py-3 text-[14px] shadow-lg ${
            t.tone === "error" ? "border-accent/40 bg-surface text-fg" : "border-line bg-surface text-fg"
          }`}
        >
          <div className="flex gap-2.5">
            <span className={`mt-1.5 size-2 shrink-0 rounded-full ${t.tone === "error" ? "bg-accent" : "bg-ok"}`} />
            <span className="leading-snug">{t.text}</span>
          </div>
        </div>
      ))}
    </div>
  );
}
