export const APP_NAME = "Xudbin";

/** Dört konteyner karesi; aralarındaki boşluk X harfini çizer. */
export function LogoMark({ className = "size-7" }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden>
      <g transform="rotate(45 16 16)" className="fill-accent">
        <rect x="5.5" y="5.5" width="9.5" height="9.5" rx="2" />
        <rect x="17" y="5.5" width="9.5" height="9.5" rx="2" />
        <rect x="5.5" y="17" width="9.5" height="9.5" rx="2" />
        <rect x="17" y="17" width="9.5" height="9.5" rx="2" />
      </g>
    </svg>
  );
}

export function Logo({ className = "" }: { className?: string }) {
  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <LogoMark />
      <span className="text-[17px] font-semibold tracking-[-0.01em]">{APP_NAME}</span>
    </div>
  );
}
