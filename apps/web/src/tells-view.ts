// The Tells table (ui-spec section 7): seven rows over "counts, not verdicts", opened from a tell count in the
// foot. The numbers come from the shared `tells()` on the page as it is typed. A row with hits opens to them;
// a hit is a button that puts the caret on its span. The last two rows stand beside the dump's.
import { TELL_ROWS, TELLS_CAVEAT, type TellHit, type TellKey, type Tells } from "@sparring/protocol/tells";

const clip = (s: string, max: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** What a row says beside its count while it is closed: its one hit, or the paragraphs its hits are in. */
export function hitSummary(hits: readonly TellHit[]): string {
  if (hits.length === 0) return "";
  if (hits.length === 1) return `¶${(hits[0] as TellHit).block + 1} "${clip((hits[0] as TellHit).text, 48)}"`;
  return [...new Set(hits.map((h) => `¶${h.block + 1}`))].join(", ");
}

/** The rows as text: label, number, and what stands beside it. Pure, so it is tested alone. */
export function tellRows(
  t: Tells,
): { key: TellKey | "sigma" | "first"; label: string; n: string; beside: string }[] {
  return [
    ...TELL_ROWS.map((r) => ({
      key: r.key,
      label: r.label,
      n: String(t[r.key]),
      beside: hitSummary(t.hits[r.key]),
    })),
    {
      key: "sigma" as const,
      label: "sentence-length σ",
      n: t.sentenceSigma.toFixed(1),
      beside: `dump ${t.dump.sentenceSigma.toFixed(1)}`,
    },
    {
      key: "first" as const,
      label: "first-person",
      n: `${t.firstPerson}%`,
      beside: `dump ${t.dump.firstPerson}%`,
    },
  ];
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export class TellsView {
  private shown = "";
  private opened: TellKey | null = null;
  private last: Tells | null = null;

  constructor(
    private readonly root: HTMLElement,
    private readonly o: {
      /** A hit was clicked: put the caret there. */
      jump: (hit: TellHit) => void;
      close: () => void;
    },
  ) {}

  /** Opens one row's hits (the count that was clicked in the foot); null closes them all. */
  expand(key: TellKey | null): void {
    this.opened = key;
    if (this.last) this.set(this.last);
  }

  set(t: Tells): void {
    this.last = t;
    if (this.opened && t.hits[this.opened].length === 0) this.opened = null;
    const rows = tellRows(t);
    const key = JSON.stringify([rows, this.opened, this.opened ? t.hits[this.opened] : null]);
    if (key === this.shown) return;
    this.shown = key;
    const head = el("div", "tells-head");
    const close = el("button", "hb tells-close", "close");
    close.type = "button";
    close.addEventListener("click", () => this.o.close());
    head.append(el("span", "text", "tells"), el("span", "muted", "in article.md"), close);
    const grid = el("div", "tells-grid");
    for (const r of rows) {
      const hits = r.key === "sigma" || r.key === "first" ? [] : t.hits[r.key];
      const open = hits.length > 0 && this.opened === r.key;
      if (hits.length > 0) {
        const b = el("button", "t tells-row", r.label);
        b.type = "button";
        b.setAttribute("aria-expanded", String(open));
        b.title = open ? "Hide where they are" : "Show where they are";
        b.addEventListener("click", () => this.expand(open ? null : (r.key as TellKey)));
        grid.append(b);
      } else grid.append(el("span", "", r.label));
      grid.append(el("span", "text n", r.n), el("span", "muted beside", open ? "" : r.beside));
      if (!open) continue;
      const list = el("div", "tells-hits");
      for (const h of hits) {
        const b = el("button", "t tells-hit", `¶${h.block + 1} "${clip(h.text, 72)}"`);
        b.type = "button";
        b.title = "Go to it in the article";
        b.addEventListener("click", () => this.o.jump(h));
        list.append(b);
      }
      grid.append(list);
    }
    this.root.replaceChildren(head, grid, el("div", "muted tells-caveat", TELLS_CAVEAT));
  }
}
