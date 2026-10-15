import { useSyncExternalStore } from "react";

export type ThemeChoice = "light" | "dark" | "system";
const KEY = "xudbin-theme";
const media = window.matchMedia("(prefers-color-scheme: dark)");

// Tema seçimi tek bir yerde tutulur; sayfadaki tüm tema seçicileri aynı değeri gösterir.
let choice: ThemeChoice = readChoice();
const listeners = new Set<() => void>();

function readChoice(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "light" || v === "dark") return v;
  } catch {}
  return "system";
}

function apply() {
  const dark = choice === "dark" || (choice === "system" && media.matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
}

// Sistem teması değişirse (ör. akşam otomatik koyu mod) "sistem" seçiliyken anında uy.
media.addEventListener("change", () => choice === "system" && apply());

export function setTheme(next: ThemeChoice) {
  choice = next;
  try {
    if (next === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, next);
  } catch {}
  apply();
  listeners.forEach((l) => l());
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function useTheme() {
  return [useSyncExternalStore(subscribe, () => choice), setTheme] as const;
}
