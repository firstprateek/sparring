// The letter's host lines from `_meta.sparring.letter`: most recent first, at most three, each in its kind's copy.
// A quarantine line ends in `restore it`, which posts `{action: 'restore'}` for that line. The mock draws no
// dismiss on the other kinds, so they have no action here.
import type { LetterKind, SparringMeta } from "@sparring/protocol/meta";

export type LetterLine = SparringMeta["letter"][number];

/** The copy for a kind when the daemon sent no text of its own. */
const COPY: Partial<Record<LetterKind, string>> = {
  refused: "write refused · the coach tried to edit article.md · logged",
  quarantine: "article.md changed outside a save · quarantined as article.agent.md",
  passEmpty: "nothing in this pass",
  draftEmpty: "nothing to draft from · dump.md is empty",
  interrupted: "the coach was interrupted · ask again",
};

const RESTORE = "restore it";

/** The lines to show: most recent first, at most three. */
export function letterLines(letter: readonly LetterLine[] | undefined): LetterLine[] {
  return [...(letter ?? [])]
    .map((l, i) => ({ l, i }))
    .sort((a, b) => (Date.parse(b.l.at) || 0) - (Date.parse(a.l.at) || 0) || b.i - a.i)
    .slice(0, 3)
    .map(({ l }) => l);
}

/** A line's words, split at ` · ` so each part is its own span. The quarantine line's `restore it` is the button. */
export function letterParts(line: LetterLine): string[] {
  const text = (line.text ?? "").trim() || COPY[line.kind] || line.kind;
  const parts = text
    .split(/\s+·\s+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (line.kind === "quarantine" && parts.at(-1) === RESTORE) parts.pop();
  return parts;
}

export type Restore = (id: string) => Promise<void>;

/** One `.ln` row per line, ready for the letter. `restore` posts the restore and throws on failure. */
export function letterRows(letter: readonly LetterLine[] | undefined, restore: Restore): HTMLDivElement[] {
  return letterLines(letter).map((line) => {
    const row = document.createElement("div");
    row.className = "ln";
    row.dataset.id = line.id;
    row.dataset.kind = line.kind;
    letterParts(line).forEach((p, i) => {
      if (i > 0) row.append(span("·"));
      row.append(span(p));
    });
    if (line.kind === "quarantine") {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "t";
      b.textContent = RESTORE;
      b.addEventListener("click", async () => {
        b.disabled = true;
        b.textContent = "restoring…";
        row.querySelector(".err")?.remove();
        try {
          await restore(line.id);
        } catch (e) {
          b.disabled = false;
          b.textContent = RESTORE;
          const err = span(`not restored · ${e instanceof Error ? e.message : String(e)}`);
          err.className = "err";
          b.after(err);
        }
      });
      row.append(span("·"), b);
    }
    return row;
  });
}

function span(text: string): HTMLSpanElement {
  const s = document.createElement("span");
  s.textContent = text;
  return s;
}
