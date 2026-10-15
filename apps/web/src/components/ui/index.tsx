import { useMutation, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { ArrowLeft, Check, Copy, Loader2, X } from "lucide-react";
import { type ButtonHTMLAttributes, type ReactNode, useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { toast } from "./toast";
import { t } from "@/lib/i18n";

export { toast } from "./toast";

// ---------------------------------------------------------------------------

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "md" | "sm";
  loading?: boolean;
};

export function Button({ variant = "secondary", size = "md", loading, children, className = "", disabled, ...rest }: ButtonProps) {
  const base = "inline-flex shrink-0 items-center justify-center gap-2 rounded-md font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50";
  const sizes = { md: "h-9 px-3.5 text-[14px]", sm: "h-8 px-2.5 text-[13px]" };
  const variants = {
    primary: "bg-accent text-accent-fg hover:bg-accent-hover",
    secondary: "border border-line-strong bg-surface text-fg hover:bg-surface-2",
    ghost: "text-muted hover:bg-surface-2 hover:text-fg",
    danger: "border border-line-strong bg-surface text-accent hover:border-accent hover:bg-accent-soft",
  };
  return (
    <button className={`${base} ${sizes[size]} ${variants[variant]} ${className}`} disabled={disabled || loading} {...rest}>
      {loading && <Loader2 className="size-4 animate-spin" />}
      {children}
    </button>
  );
}

export function Field({ label, hint, error, children, className = "" }: { label: string; hint?: ReactNode; error?: string; children: ReactNode; className?: string }) {
  return (
    <label className={`block ${className}`}>
      <span className="mb-1.5 block text-[14px] font-medium">{label}</span>
      {children}
      {error ? <span className="mt-1.5 block text-[13px] text-accent">{error}</span> : hint && <span className="mt-1.5 block text-[13px] leading-snug text-faint">{hint}</span>}
    </label>
  );
}

export function Toggle({ checked, onChange, label, description, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; description?: ReactNode; disabled?: boolean }) {
  return (
    <label className={`flex items-start gap-3 ${disabled ? "opacity-50" : "cursor-pointer"}`}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors ${checked ? "bg-accent" : "bg-line-strong"}`}
      >
        <span className={`absolute top-0.5 left-0 size-4 rounded-full bg-white shadow transition-transform ${checked ? "translate-x-[18px]" : "translate-x-0.5"}`} />
      </button>
      <span>
        <span className="block text-[14px] font-medium">{label}</span>
        {description && <span className="mt-0.5 block text-[13px] leading-snug text-muted">{description}</span>}
      </span>
    </label>
  );
}

// ---------------------------------------------------------------------------

export function Dialog({ open, onClose, title, description, children, wide }: { open: boolean; onClose: () => void; title: string; description?: ReactNode; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => e.target === ref.current && onClose()}
      className={`m-auto w-[calc(100vw-2rem)] ${wide ? "max-w-2xl" : "max-w-lg"} rounded-[10px] border border-line bg-surface p-0 text-fg shadow-2xl backdrop:bg-black/50`}
    >
      {open && (
        <div className="p-5 sm:p-6">
          <div className="mb-5 flex items-start justify-between gap-4">
            <div>
              <h2 className="text-[18px] font-semibold tracking-[-0.01em]">{title}</h2>
              {description && <p className="mt-1 text-[14px] leading-relaxed text-muted">{description}</p>}
            </div>
            <button onClick={onClose} className="-mt-1 -mr-2 rounded-md p-1.5 text-faint hover:bg-surface-2 hover:text-fg" aria-label={t("Kapat")}>
              <X className="size-4" />
            </button>
          </div>
          {children}
        </div>
      )}
    </dialog>
  );
}

/** Geri alınamaz işlemler için onay penceresi; istenirse adın yazılmasını şart koşar. */
export function ConfirmDialog(props: {
  open: boolean;
  onClose: () => void;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  typeToConfirm?: string;
  loading?: boolean;
  onConfirm: () => void;
  children?: ReactNode;
}) {
  const [typed, setTyped] = useState("");
  useEffect(() => setTyped(""), [props.open]);
  const ok = !props.typeToConfirm || typed === props.typeToConfirm;
  return (
    <Dialog open={props.open} onClose={props.onClose} title={props.title} description={props.description}>
      {props.children}
      {props.typeToConfirm && (
        <Field label={t("Onaylamak için \"{name}\" yaz", { name: props.typeToConfirm })} className="mb-5">
          <input className="input" value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus />
        </Field>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={props.onClose}>
          {t("Vazgeç")}
        </Button>
        <Button variant="primary" disabled={!ok} loading={props.loading} onClick={props.onConfirm}>
          {props.confirmLabel}
        </Button>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------

const STATUS: Record<string, { label: string; tone: "ok" | "warn" | "bad" | "muted" | "busy" }> = {
  running: { label: t("Çalışıyor"), tone: "ok" },
  ready: { label: t("Hazır"), tone: "ok" },
  success: { label: t("Başarılı"), tone: "ok" },
  deploying: { label: t("Deploy ediliyor"), tone: "busy" },
  setting_up: { label: t("Kuruluyor"), tone: "busy" },
  starting: { label: t("Başlatılıyor"), tone: "busy" },
  queued: { label: t("Sırada"), tone: "busy" },
  idle: { label: t("Henüz deploy edilmedi"), tone: "muted" },
  pending: { label: t("Kurulum bekliyor"), tone: "warn" },
  stopped: { label: t("Durduruldu"), tone: "muted" },
  cancelled: { label: t("İptal edildi"), tone: "muted" },
  failed: { label: t("Başarısız"), tone: "bad" },
  error: { label: t("Hata"), tone: "bad" },
  exited: { label: t("Durdu"), tone: "muted" },
  restarting: { label: t("Yeniden başlıyor"), tone: "warn" },
};

export function StatusBadge({ status, label }: { status: string; label?: string }) {
  const s = STATUS[status] ?? { label: status, tone: "muted" as const };
  const color = { ok: "text-ok", warn: "text-warn", bad: "text-accent", muted: "text-faint", busy: "text-warn" }[s.tone];
  return (
    <span className={`inline-flex items-center gap-1.5 text-[13px] whitespace-nowrap ${color}`}>
      {s.tone === "busy" ? <Loader2 className="size-3 animate-spin" /> : <span className="size-1.5 rounded-full bg-current" />}
      {label ?? s.label}
    </span>
  );
}

export function PageHeader({ title, description, actions, back }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; back?: { to: string; label: string } }) {
  return (
    <header className="mb-7">
      {back && (
        <Link to={back.to} className="mb-3 inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-fg">
          <ArrowLeft className="size-3.5" />
          {back.label}
        </Link>
      )}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-[26px] leading-tight font-semibold tracking-[-0.02em] break-words">{title}</h1>
          {description && <div className="mt-1.5 text-[14px] text-muted">{description}</div>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </header>
  );
}

export function Section({ title, description, actions, children, className = "" }: { title: string; description?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`mt-9 first:mt-0 ${className}`}>
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-[17px] font-semibold tracking-[-0.01em]">{title}</h2>
          {description && <p className="mt-0.5 text-[14px] text-muted">{description}</p>}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

export function Empty({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="panel flex flex-col items-start gap-4 px-5 py-7 text-[14px] text-muted sm:flex-row sm:items-center sm:justify-between">
      <div className="max-w-xl leading-relaxed">{children}</div>
      {action}
    </div>
  );
}

export function Notice({ tone, title, children }: { tone: "warn" | "danger" | "info"; title: string; children?: ReactNode }) {
  const border = { warn: "border-l-warn", danger: "border-l-accent", info: "border-l-line-strong" }[tone];
  return (
    <div className={`panel border-l-[3px] px-5 py-4 ${border}`}>
      <div className="text-[15px] font-medium">{title}</div>
      {children && <div className="mt-1 text-[14px] leading-relaxed text-muted">{children}</div>}
    </div>
  );
}

export function CopyButton({ value, label = "Kopyala" }: { value: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard.writeText(value).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        });
      }}
      className="inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-[13px] text-muted hover:bg-surface-2 hover:text-fg"
      aria-label={label}
      title={label}
    >
      {done ? <Check className="size-3.5 text-ok" /> : <Copy className="size-3.5" />}
    </button>
  );
}

/** Salt okunur, kopyalanabilir değer satırı (bağlantı adresi, webhook, açık anahtar...). */
export function CopyField({ value, secret, mono = true }: { value: string; secret?: boolean; mono?: boolean }) {
  const [shown, setShown] = useState(!secret);
  return (
    <div className="flex items-center gap-1 rounded-md border border-line bg-surface-2 py-1 pr-1 pl-3">
      <span className={`min-w-0 flex-1 truncate text-[13px] ${mono ? "font-mono" : ""}`}>{shown ? value : "•".repeat(Math.min(value.length, 24))}</span>
      {secret && (
        <button type="button" onClick={() => setShown(!shown)} className="rounded-md px-2 py-1 text-[13px] text-muted hover:bg-surface hover:text-fg">
          {shown ? t("Gizle") : t("Göster")}
        </button>
      )}
      <CopyButton value={value} />
    </div>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div role="tablist" className="-mx-4 mb-6 flex gap-1 overflow-x-auto border-b border-line px-4 md:mx-0 md:px-0">
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={value === t.id}
          onClick={() => onChange(t.id)}
          className={`relative shrink-0 px-3 pt-1 pb-2.5 text-[14px] transition-colors ${
            value === t.id ? "font-medium text-fg after:absolute after:inset-x-2 after:-bottom-px after:h-0.5 after:rounded-full after:bg-accent" : "text-muted hover:text-fg"
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

/** Mutasyon + başarı/hata bildirimi + ilgili sorguları tazeleme. */
export function useAction<TVars = void, TResult = unknown>(
  fn: (vars: TVars) => Promise<TResult>,
  opts: { success?: string | ((r: TResult) => string); invalidate?: QueryKey[]; onSuccess?: (r: TResult) => void } = {},
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (r) => {
      if (opts.success) toast(typeof opts.success === "function" ? opts.success(r) : opts.success);
      opts.invalidate?.forEach((k) => qc.invalidateQueries({ queryKey: k }));
      opts.onSuccess?.(r);
    },
    onError: (err) => toast(t(err.message), "error"),
  });
}

export function Spinner({ className = "" }: { className?: string }) {
  return <Loader2 className={`size-4 animate-spin text-faint ${className}`} />;
}

export function PageLoading() {
  return (
    <div className="animate-pulse">
      <div className="mb-7 h-9 w-56 rounded-md bg-surface-2" />
      <div className="panel h-64" />
    </div>
  );
}
