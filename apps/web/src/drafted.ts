// Drafted mode in the Room: the words and the small pieces of it. The tag `drafted · N% yours`, the quiet block
// that stands where the notes do while the coach holds them, the bar each block carries, and how fast a draft
// lands. The numbers come from the shared provenance function, computed here from the page as it is typed.
import { type Baseline, blockState, countsLine, type Provenance } from "@sparring/protocol/provenance";
import { DRAFTED_STRIP } from "./letter.ts";
import type { Prov } from "./page.ts";

/** A draft lands one block every 220 ms. */
export const REVEAL_MS = 220;

/** The step of the reveal: 0, so all at once, when the writer asked for reduced motion. */
export function revealStep(): number {
  const reduced =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  return reduced ? 0 : REVEAL_MS;
}

export const tagText = (pct: number) => `drafted · ${pct}% yours`;

export const QUIET_HEAD = "the coach is quiet. this review is yours.";
export const QUIET_HINT = "/critique when you want notes";
export const yoursLine = (pct: number) => `${pct}% of the words are yours`;

/** The bar a block carries: the coach's, edited, or none once it is the writer's. */
export function provOf(base: Baseline): (block: string) => Prov {
  return (block) => {
    const b = blockState(base, block);
    if (b.words === 0) return null;
    return b.state === "coach" ? "coach" : b.state === "edited" ? "edited" : null;
  };
}

function line(cls: string, text: string): HTMLDivElement {
  const d = document.createElement("div");
  d.className = cls;
  d.textContent = text;
  return d;
}

function legendItem(cls: string | null, text: string): HTMLSpanElement {
  const s = document.createElement("span");
  s.className = "lg";
  if (cls) {
    const bar = document.createElement("span");
    bar.className = cls;
    bar.setAttribute("aria-hidden", "true");
    s.append(bar);
  }
  s.append(text);
  return s;
}

/**
 * The quiet block, in this order: the two lines of copy, the counts, the percent, the legend. Redrawn only when
 * its numbers change. Under 760px it is a sheet that rises from the foot's `N% yours` button, so it also carries
 * the status strip (first) and a `close` (last); both are hidden where it sits in the coach panel.
 */
export function renderQuietBlock(el: HTMLElement, p: Provenance): void {
  const counts = countsLine(p);
  const key = `${counts}|${p.yoursPct}`;
  if (el.dataset.key === key) return;
  el.dataset.key = key;
  const legend = document.createElement("div");
  legend.className = "legend";
  legend.append(
    legendItem("prov", "coach"),
    legendItem("prov mixed", "edited"),
    legendItem(null, "no bar: yours"),
  );
  const close = document.createElement("button");
  close.type = "button";
  close.className = "hb qb-close";
  close.dataset.act = "close";
  close.textContent = "close";
  el.replaceChildren(
    line("qb-strip", DRAFTED_STRIP.join(" · ")),
    line("qb-head", QUIET_HEAD),
    line("qb-hint", QUIET_HINT),
    line("qb-counts", counts),
    line("qb-pct", yoursLine(p.yoursPct)),
    legend,
    close,
  );
}
