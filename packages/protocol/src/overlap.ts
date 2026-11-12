// The 5-word overlap check (design sections 1 and 6): which runs of words in a text are the coach's. A run counts
// when five words in a row, lower-cased and with punctuation dropped, also stand in a row in something the coach
// said. Runs that touch are one span. The daemon runs it on pasted text against everything the coach said (the
// `pastes` route), and later on the article for the publish sheet; the browser runs it on each block against the
// pasted spans the daemon recorded, which is what the underline follows as the block is rewritten.
//
// A run never crosses a blank line, in the text or in the corpus. Five-word runs that are also in the writer's
// own words (`own`: the dump and the writer's chat messages) are not the coach's: a coach that quotes the writer
// back does not make those words its own.

export const OVERLAP_WORDS = 5;

/** Something the coach said, and where: `interview q6`, `note c08`. */
export interface CorpusEntry {
  source: string;
  text: string;
}

export interface OverlapSpan {
  /** The span in the text that was checked. */
  start: number;
  end: number;
  text: string;
  words: number;
  /** Where the coach said it: the source of the first run in the span. */
  source: string;
}

interface Word {
  w: string;
  start: number;
  end: number;
}

/** The words of a text with their places, in stretches that hold no blank line. */
function stretches(text: string): Word[][] {
  const out: Word[][] = [];
  let at = 0;
  for (const part of text.split(/(\n[ \t]*(?:\r?\n[ \t]*)+)/)) {
    // The odd parts are the blank lines between stretches.
    const words: Word[] = [];
    if (!/^\n[ \t]*(?:\r?\n[ \t]*)+$/.test(part))
      for (const m of part.matchAll(/[\p{L}\p{N}'’]+/gu)) {
        const start = at + (m.index ?? 0);
        words.push({ w: m[0].toLowerCase().replace(/’/g, "'"), start, end: start + m[0].length });
      }
    if (words.length > 0) out.push(words);
    at += part.length;
  }
  return out;
}

const key = (words: readonly Word[], i: number, n: number) =>
  words
    .slice(i, i + n)
    .map((x) => x.w)
    .join(" ");

/** Every run of `n` words in the corpus, with the source that said it first. */
export type OverlapIndex = { n: number; grams: Map<string, string> };

/** Builds the index of a corpus once, so many texts can be checked against it. */
export function overlapIndex(
  corpus: readonly CorpusEntry[],
  own: readonly string[] = [],
  n = OVERLAP_WORDS,
): OverlapIndex {
  const mine = new Set<string>();
  for (const text of own)
    for (const words of stretches(text))
      for (let i = 0; i + n <= words.length; i++) mine.add(key(words, i, n));
  const grams = new Map<string, string>();
  for (const entry of corpus)
    for (const words of stretches(entry.text))
      for (let i = 0; i + n <= words.length; i++) {
        const k = key(words, i, n);
        if (!mine.has(k) && !grams.has(k)) grams.set(k, entry.source);
      }
  return { n, grams };
}

/** The spans of `text` that are the corpus's words: every maximal stretch covered by matching runs. Pure. */
export function overlap(text: string, corpus: OverlapIndex | readonly CorpusEntry[]): OverlapSpan[] {
  const index = "grams" in corpus ? corpus : overlapIndex(corpus);
  const { n, grams } = index;
  const out: OverlapSpan[] = [];
  if (grams.size === 0) return out;
  for (const words of stretches(text)) {
    let open: { from: number; to: number; source: string } | null = null;
    const close = () => {
      if (!open) return;
      const start = (words[open.from] as Word).start;
      const end = (words[open.to] as Word).end;
      out.push({
        start,
        end,
        text: text.slice(start, end),
        words: open.to - open.from + 1,
        source: open.source,
      });
      open = null;
    };
    for (let i = 0; i + n <= words.length; i++) {
      const source = grams.get(key(words, i, n));
      if (source === undefined) continue;
      if (open && i <= open.to + 1) open.to = i + n - 1;
      else {
        close();
        open = { from: i, to: i + n - 1, source };
      }
    }
    close();
  }
  return out;
}

/** How many words the spans hold together: the foot's `pasted N`. */
export function overlapWords(spans: readonly OverlapSpan[]): number {
  return spans.reduce((sum, s) => sum + s.words, 0);
}
