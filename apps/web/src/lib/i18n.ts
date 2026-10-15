import { useSyncExternalStore } from "react";
import { en } from "./i18n-en";

/**
 * Basit çeviri: kaynak dil Türkçe, metinlerin kendisi anahtar. İngilizce sözlükte karşılığı
 * yoksa Türkçe metin gösterilir. Değişkenler {ad} biçiminde: t("{n} uygulama", { n: 3 }).
 */
export type Lang = "tr" | "en";
const KEY = "xudbin-lang";

function initial(): Lang {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "tr" || v === "en") return v;
  } catch {}
  return navigator.language?.toLowerCase().startsWith("tr") ? "tr" : "en";
}

let lang: Lang = initial();
const listeners = new Set<() => void>();
document.documentElement.lang = lang;

export function setLang(next: Lang) {
  lang = next;
  document.documentElement.lang = next;
  try {
    localStorage.setItem(KEY, next);
  } catch {}
  listeners.forEach((l) => l());
}

export const getLang = () => lang;

export function t(text: string, vars?: Record<string, string | number>) {
  let out = lang === "en" ? (en[text] ?? text) : text;
  if (vars) for (const [k, v] of Object.entries(vars)) out = out.split(`{${k}}`).join(String(v));
  return out;
}

/** Dil değişince bileşenin yeniden çizilmesi için. */
export function useLang() {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => lang,
  );
}

/** Tarih/sayı biçimleri için yerel ayar. */
export const locale = () => (lang === "en" ? "en-US" : "tr-TR");
