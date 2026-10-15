import { Monitor, Moon, Sun } from "lucide-react";
import { type ThemeChoice, useTheme } from "@/lib/theme";

const OPTIONS: { value: ThemeChoice; label: string; icon: typeof Sun }[] = [
  { value: "light", label: "Açık tema", icon: Sun },
  { value: "dark", label: "Koyu tema", icon: Moon },
  { value: "system", label: "Sistem temasını kullan", icon: Monitor },
];

export function ThemeSwitch() {
  const [choice, setChoice] = useTheme();
  return (
    <div role="radiogroup" aria-label="Tema" className="inline-flex rounded-md border border-line p-0.5">
      {OPTIONS.map((o) => (
        <button
          key={o.value}
          role="radio"
          aria-checked={choice === o.value}
          aria-label={o.label}
          title={o.label}
          onClick={() => setChoice(o.value)}
          className={`grid size-7 place-items-center rounded-[5px] transition-colors ${
            choice === o.value ? "bg-surface-2 text-fg" : "text-faint hover:text-fg"
          }`}
        >
          <o.icon className="size-[15px]" strokeWidth={1.8} />
        </button>
      ))}
    </div>
  );
}
