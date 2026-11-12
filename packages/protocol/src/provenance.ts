// Provenance (design section 4): which words on a drafted page are the writer's. Computed, never stored. The
// baseline is article.md as the coach's draft left it; the same pure function runs in the browser for the live
// tag and in the daemon for `_meta.sparring` and the publish gate.
//
// Both texts are split into blocks on blank lines. A block's words are the matches of /[a-z0-9'’]+/g on its
// lower-cased text with a leading `## ` stripped. Blocks are matched by content, never by index: a baseline block
// matches a block when the words they share are at least half of either one's words. A block's baseline is every
// baseline block that matches it, added together; its new words are its words minus that baseline.
//
//   coach   its words are a matching baseline block's words (or all of its matches', joined in order)
//   edited  changed, with under half its words new
//   yours   at least one word and half or more of them new; a block that matches nothing is all new
import { splitBlocks } from "./blocks.ts";
import { sha256Hex } from "./sha256.ts";

export type BlockState = "coach" | "edited" | "yours";

export interface BlockProvenance {
  /** The block as the file has it. */
  text: string;
  state: BlockState;
  /** How many words it has, and how many of them the baseline did not have. */
  words: number;
  fresh: number;
  /** SHA-256 hex of its words joined by single spaces: what a publish tick names. */
  hash: string;
}

export interface Provenance {
  blocks: BlockProvenance[];
  counts: { coach: number; edited: number; yours: number };
  /** `Math.round(100 * new / max(1, total))`, both summed over all blocks. */
  yoursPct: number;
}

/** A block's words: lower-cased, a leading `## ` stripped. */
export function blockWords(block: string): string[] {
  return (
    block
      .replace(/^## /, "")
      .toLowerCase()
      .match(/[a-z0-9'’]+/g) ?? []
  );
}

/** A block's hash: SHA-256 hex of its words joined by single spaces. */
export function blockHash(block: string): string {
  return sha256Hex(blockWords(block).join(" "));
}

function bag(words: readonly string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const w of words) m.set(w, (m.get(w) ?? 0) + 1);
  return m;
}

/** How many words two blocks share, counting repeats. */
function shared(a: Map<string, number>, b: Map<string, number>): number {
  let n = 0;
  for (const [w, c] of a) n += Math.min(c, b.get(w) ?? 0);
  return n;
}

const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((w, i) => w === b[i]);

/** The coach's draft, split and counted once, so each block of the page is judged against it cheaply. */
export interface Baseline {
  blocks: { words: string[]; bag: Map<string, number> }[];
}

export function baselineOf(text: string): Baseline {
  return {
    blocks: splitBlocks(text)
      .map((b) => {
        const words = blockWords(b);
        return { words, bag: bag(words) };
      })
      .filter((b) => b.words.length > 0),
  };
}

/** One block of the page against the baseline: its state, its words, and how many of them are new. */
export function blockState(
  base: Baseline,
  block: string,
): { state: BlockState; words: number; fresh: number } {
  const words = blockWords(block);
  // Nothing to own: an empty block, or one of punctuation only.
  if (words.length === 0) return { state: "yours", words: 0, fresh: 0 };
  const mine = bag(words);
  const matches = base.blocks.filter((b) => {
    const n = shared(mine, b.bag);
    return n * 2 >= words.length || n * 2 >= b.words.length;
  });
  if (matches.length === 0) return { state: "yours", words: words.length, fresh: words.length };
  const union = new Map<string, number>();
  for (const m of matches) for (const [w, c] of m.bag) union.set(w, (union.get(w) ?? 0) + c);
  let fresh = 0;
  for (const [w, c] of mine) fresh += Math.max(0, c - (union.get(w) ?? 0));
  const equal =
    matches.some((m) => sameList(m.words, words)) ||
    sameList(
      matches.flatMap((m) => m.words),
      words,
    );
  const state = equal ? "coach" : fresh * 2 >= words.length ? "yours" : "edited";
  return { state, words: words.length, fresh };
}

/** The provenance of `current` against the coach's draft `baseline`. Pure. */
export function provenance(baseline: string | Baseline, current: string): Provenance {
  const base = typeof baseline === "string" ? baselineOf(baseline) : baseline;
  const counts = { coach: 0, edited: 0, yours: 0 };
  let total = 0;
  let fresh = 0;
  const blocks: BlockProvenance[] = [];
  for (const text of splitBlocks(current)) {
    const b = blockState(base, text);
    // A block with no words is on nobody's count.
    if (b.words === 0 && text.trim() === "") continue;
    if (b.words > 0) counts[b.state]++;
    total += b.words;
    fresh += b.fresh;
    blocks.push({ text, ...b, hash: blockHash(text) });
  }
  return { blocks, counts, yoursPct: Math.round((100 * fresh) / Math.max(1, total)) };
}

/** `13 ¶ · 13 coach · 0 edited · 0 yours`, the counts line of the quiet block and the publish sheet. */
export function countsLine(p: Pick<Provenance, "counts">): string {
  const { coach, edited, yours } = p.counts;
  return `${coach + edited + yours} ¶ · ${coach} coach · ${edited} edited · ${yours} yours`;
}

/** The first words of a block, for a publish row: `"<first six words>…"`. */
export function firstWords(block: string, n = 6): string {
  const words = block.replace(/^## /, "").trim().split(/\s+/).filter(Boolean);
  return words.length > n ? `${words.slice(0, n).join(" ")}…` : words.join(" ");
}

/** A publish row per block: the shape the preflight lists (`blocks: [{n, hash, state, first_words}]`). */
export function publishBlocks(
  p: Provenance,
): { n: number; hash: string; state: BlockState; first_words: string }[] {
  return p.blocks
    .filter((b) => b.words > 0)
    .map((b, i) => ({ n: i + 1, hash: b.hash, state: b.state, first_words: firstWords(b.text) }));
}

/** The publish gate in drafted mode: the hashes of the blocks still `coach` that carry no tick. */
export function untickedCoach(p: Provenance, ticked: readonly string[]): string[] {
  const have = new Set(ticked);
  return p.blocks.filter((b) => b.state === "coach" && !have.has(b.hash)).map((b) => b.hash);
}
