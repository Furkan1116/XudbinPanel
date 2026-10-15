import type { ReactNode } from "react";
import { Logo } from "./Logo";
import { ThemeSwitch } from "./ThemeSwitch";

export function AuthShell({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col px-4 py-5 md:px-8">
      <header className="flex items-center justify-between">
        <Logo />
        <ThemeSwitch />
      </header>
      <div className="grid flex-1 place-items-center py-10">
        <div className="w-full max-w-[22rem]">
          <h1 className="text-[26px] leading-tight font-semibold tracking-[-0.015em]">{title}</h1>
          <p className="mt-2 text-[15px] leading-relaxed text-muted">{subtitle}</p>
          <div className="mt-8">{children}</div>
        </div>
      </div>
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[14px] font-medium">{label}</span>
      {children}
      {hint && <span className="mt-1.5 block text-[13px] leading-snug text-faint">{hint}</span>}
    </label>
  );
}

export function FormError({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <div role="alert" className="rounded-md bg-accent-soft px-3 py-2.5 text-[14px] text-accent">
      {message}
    </div>
  );
}
