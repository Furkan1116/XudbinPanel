import type { PreflightFinding, PreflightGroup } from "./types.js";

/** Bulgu toplayıcı: aynı kimlikli bulgulardan en fazla `perKind` tanesini tutar, fazlasını sayar. */
export class FindingList {
  readonly items: PreflightFinding[] = [];
  private readonly perId = new Map<string, number>();

  constructor(
    private readonly group: PreflightGroup,
    private readonly perKind = 10,
  ) {}

  add(finding: Omit<PreflightFinding, "group">) {
    const n = (this.perId.get(finding.id) ?? 0) + 1;
    this.perId.set(finding.id, n);
    if (n <= this.perKind) this.items.push({ ...finding, group: this.group });
  }

  /** Toplanan bulgular ve sınırı aşan türler için birer özet satırı. */
  result(): PreflightFinding[] {
    const extra: PreflightFinding[] = [];
    for (const [id, n] of this.perId) {
      if (n <= this.perKind) continue;
      extra.push({ id: `${id}-more`, group: this.group, level: "info", title: "Aynı türden {n} bulgu daha var", detail: "Raporu kısa tutmak için ilk {max} tanesi gösterildi.", vars: { n: n - this.perKind, max: this.perKind } });
    }
    return [...this.items, ...extra];
  }
}

/** 0 tabanlı karakter konumunun satır numarası. */
export function lineOf(text: string, index: number) {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}
