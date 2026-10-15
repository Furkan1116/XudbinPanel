export const APP_NAME = "Xudbin";

export function Logo({ className = "" }: { className?: string }) {
  return (
    <div className={`flex items-center gap-2.5 ${className}`}>
      <svg viewBox="0 0 32 32" className="size-7" aria-hidden>
        <rect width="32" height="32" rx="8" className="fill-accent-dim" />
        <path d="M16 6l9 3.5v6.2c0 5.4-3.8 9.4-9 10.8-5.2-1.4-9-5.4-9-10.8V9.5L16 6z" fill="none" className="stroke-accent" strokeWidth="2.2" strokeLinejoin="round" />
        <path d="M12 16l3 3 5.5-6" fill="none" className="stroke-accent" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span className="text-[15px] font-semibold tracking-tight">{APP_NAME}</span>
    </div>
  );
}
