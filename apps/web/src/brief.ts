// The interview's notes on the page: the dump blocks a `note_brief` quote comes from carry a mono `?` in the
// gutter, and the brief leaf's margin lists the quotes under `quoted from dump.md`. When `commentsRev` moves the
// Room fetches the snapshot again and takes the new brief.md, unless the writer has unsaved changes in it.
import type { BriefNote } from "./api.ts";
import type { Leaf } from "./leaf.ts";

/** The notes from a snapshot, keeping only well-formed entries. */
export function briefNotesOf(raw: unknown): BriefNote[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (n): n is BriefNote =>
      !!n && typeof n === "object" && typeof n.topic === "string" && typeof n.quote === "string",
  );
}

/** For each block, whether a brief quote is a substring of it. Empty quotes mark nothing. */
export function quoteMarks(blocks: readonly string[], notes: readonly BriefNote[]): boolean[] {
  const quotes = notes.map((n) => n.quote.trim()).filter((q) => q !== "");
  return blocks.map((b) => quotes.some((q) => b.includes(q)));
}

/** The brief leaf's margin: `quoted from dump.md`, then each quote in quotation marks, in the order noted. */
export function renderQuotes(el: HTMLElement, notes: readonly BriefNote[]): void {
  const head = document.createElement("div");
  head.className = "mono muted";
  head.textContent = "quoted from dump.md";
  const list = document.createElement("div");
  list.className = "quotes";
  for (const n of notes) {
    const q = n.quote.trim();
    if (!q) continue;
    const s = document.createElement("span");
    s.textContent = `"${q}"`;
    s.title = n.topic;
    list.append(s);
  }
  el.replaceChildren(head, list);
}

/**
 * Takes brief.md as the daemon now has it, unless the leaf holds text the daemon has not taken (dirty, a save
 * in flight or a conflict open). Returns true when the leaf took it.
 */
export function adoptBrief(leaf: Leaf, file: { text: string; sha: string } | undefined): boolean {
  if (!file) return false;
  return leaf.adopt(file.text, file.sha);
}
