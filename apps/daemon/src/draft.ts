// Drafted mode (design section 4): the rules a `write_draft` call must pass, the lines the host says around a
// draft, and the one call that accepts a draft. The git and database work of that call is `Articles.writeDraft`,
// inside the git queue; this file is what is said and checked.
import { joinBlocks, splitBlocks, wordCount } from "@sparring/protocol/blocks";

/** A draft is at most this many words. */
export const DRAFT_MAX_WORDS = 6000;

export const SENDIT_LINE = "send it · the coach is drafting from dump.md and brief.md";
export const DRAFT_EMPTY = "nothing to draft from · dump.md is empty";
export const DRAFT_FAILED = "draft failed · nothing was written · your page is unchanged";
export const MODE_DRAFTED = "mode coached → drafted · never-write is off for this article";
export const MODE_COACHED = "mode drafted → coached · the coach's draft moved to the shelf";
export const stageMoved = (from: string, to: string) => `stage ${from} → ${to}`;
/** What an accepted `write_draft` answers, and so the tool's line in the transcript. */
export const draftWritten = (n: number) => `article.md · ${n} ¶ from dump.md and brief.md`;

/** Why `blocks` is not a draft, as the rule the coach reads, or null when it is one. */
export function draftProblem(blocks: unknown): string | null {
  if (!Array.isArray(blocks) || blocks.length === 0)
    return "blocks is a non-empty list of strings: one paragraph or ## heading per block";
  if (blocks.some((b) => typeof b !== "string")) return "every block is a string";
  const list = blocks as string[];
  if (list.some((b) => b.trim() === "")) return "no block may be blank";
  if (list.some((b) => splitBlocks(b).length > 1))
    return "one paragraph or ## heading per block: a block holds no blank line";
  if (list.some((b) => b.split("\n").some((l) => /^#(?!#)/.test(l.trim()))))
    return "headings start at ##: the title is not part of the draft";
  const words = wordCount(list.join("\n"));
  if (words > DRAFT_MAX_WORDS) return `a draft is at most ${DRAFT_MAX_WORDS} words: this one has ${words}`;
  return null;
}

/** article.md for a list of blocks: joined by blank lines. */
export function draftText(blocks: readonly string[]): string {
  return joinBlocks(blocks.map((b) => b.replace(/\r\n?/g, "\n").trim()));
}
