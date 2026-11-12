// Tells (design section 6, ui-spec section 7): seven counts of constructions that read as machine-written. Counts,
// not verdicts: careful human writers trip them too. One pure function, run in the browser for the foot and the
// Tells table and in the daemon for `_meta.sparring.tells` and the `tells` pass.
//
//   em            em-dashes: `—`, and `--` between words (spaced on both sides, or on neither)
//   oneSentence   paragraphs of exactly one sentence
//   notXButY      "it's not X, it's Y", "not just X but also Y", "not X but Y", "is not X, but Y"
//   genuinely     the word
//   ruleOfThree   a list of three short items: "fast, cheap and good"
//   sentenceSigma the standard deviation of words per sentence, one decimal
//   firstPerson   the percent of sentences with I, me, my, we, us, our (and their kin)
//
// The last two are also given for the dump, the writer's own voice, to read beside the article's. Headings,
// lists, quotes, tables and code are not paragraphs: they are left out of the sentence counts. Code is left out
// of everything, and so is an HTML comment.
import { splitBlocks, wordCount } from "./blocks.ts";

export const TELL_KEYS = ["em", "oneSentence", "notXButY", "genuinely", "ruleOfThree"] as const;
export type TellKey = (typeof TELL_KEYS)[number];

/** Where a tell is: the block (an index into `splitBlocks(article)`) and the span inside that block's text. */
export interface TellHit {
  block: number;
  start: number;
  end: number;
  text: string;
}

export interface Tells {
  em: number;
  oneSentence: number;
  notXButY: number;
  genuinely: number;
  ruleOfThree: number;
  sentenceSigma: number;
  firstPerson: number;
  dump: { sentenceSigma: number; firstPerson: number };
  hits: Record<TellKey, TellHit[]>;
}

/** The rows of the Tells table, in order, and the foot's short name for the three it shows. */
export const TELL_ROWS: readonly { key: TellKey; label: string; foot?: string }[] = [
  { key: "em", label: "em-dash", foot: "em" },
  { key: "oneSentence", label: "single-sentence ¶", foot: "¶1" },
  { key: "notXButY", label: "not-X-but-Y", foot: "not-x-but-y" },
  { key: "genuinely", label: "genuinely" },
  { key: "ruleOfThree", label: "rule-of-three" },
];

/** The fixed last line of the Tells table. */
export const TELLS_CAVEAT = "counts, not verdicts. Cantrill's own post trips this.";

const EM = /—|(?<=[\p{L}\p{N}])--(?=[\p{L}\p{N}])|(?<=\S) -- (?=\S)/gu;
const GENUINELY = /\bgenuinely\b/gi;
const NOT = "(?:\\bnot|n['’]t)";
const BE = "(?:['’]s|['’]re|\\s+(?:is|was|are|were))";
const NOT_X_BUT_Y: readonly RegExp[] = [
  // not just X but (also) Y
  new RegExp(`${NOT}\\s+(?:just|only|merely|simply)\\b[^.!?\\n]{1,80}?\\bbut\\b(?:\\s+also\\b)?`, "gi"),
  // it's not X, it's Y
  new RegExp(`${NOT}\\b[^.!?;:\\n]{1,60}?[,;—–]\\s*(?:it|that|this|they|he|she|we|you)${BE}\\b`, "gi"),
  // It's not X. It's Y.
  new RegExp(`${NOT}\\b[^.!?\\n]{1,60}?\\.\\s+(?:It|That|This|They)${BE}\\b`, "g"),
  // is not X, but Y
  /(?:\b(?:is|are|was|were)|['’]s|['’]re)\s+not\s+[^.!?;:,\n]{1,40}?,\s+but\s/gi,
  // not X but Y, and not X, but rather Y
  new RegExp(`${NOT}\\s+[^.!?;:,\\n]{1,40}?(?:,\\s+but\\s+rather|\\s+but)\\s`, "gi"),
];
const ITEM = "[\\p{L}\\p{N}'’-]+";
const RULE_OF_THREE = new RegExp(
  `(?<!, )(?<![\\p{L}\\p{N}'’-])${ITEM}(?: ${ITEM}){0,2}, ${ITEM}(?: ${ITEM}){0,2},? (?:and|or) ${ITEM}`,
  "gu",
);
const FIRST_PERSON =
  /\bI\b|\b(?:me|my|mine|myself|we|us|our|ours|ourselves|My|Me|Mine|Myself|We|Our|Ours|Ourselves)\b/;
/** A full stop after one of these does not end a sentence. */
const ABBREVIATIONS = new Set(["e.g", "i.e", "etc", "vs", "cf", "mr", "mrs", "ms", "dr", "st", "no", "fig"]);

type BlockKind = "para" | "other" | "code";

/** What each block is: a paragraph, something else with words in it, or code. A fence may run over blank lines. */
function kinds(blocks: readonly string[]): BlockKind[] {
  let fence: string | null = null;
  return blocks.map((b) => {
    const wasIn = fence !== null;
    let sawFence = false;
    for (const line of b.split("\n")) {
      const m = /^\s{0,3}(```+|~~~+)/.exec(line);
      if (!m) continue;
      sawFence = true;
      const mark = (m[1] as string).slice(0, 3);
      if (fence === null) fence = mark;
      else if (fence === mark) fence = null;
    }
    if (wasIn || sawFence) return "code";
    // A comment is not part of the piece: publishing strips it.
    if (/^<!--[\s\S]*-->$/.test(b.trim())) return "code";
    if (/^ {4}|^\t/.test(b)) return "code";
    if (/^\s*(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|>|\|)/.test(b) || wordCount(b) === 0) return "other";
    return "para";
  });
}

/** The sentences of a paragraph. A terminator ends one only before a capital, a digit or an opening quote. */
export function sentences(para: string): string[] {
  const out: string[] = [];
  let from = 0;
  for (const m of para.matchAll(/[.!?…]+["'”’)\]*_]*\s+/g)) {
    const at = m.index ?? 0;
    const next = para.slice(at + m[0].length);
    if (!/^["'“‘([*_]*[\p{Lu}\p{N}]/u.test(next)) continue;
    if (m[0].startsWith(".") && !m[0].startsWith("..")) {
      const before = /[\p{L}.]+$/u.exec(para.slice(from, at))?.[0] ?? "";
      if (ABBREVIATIONS.has(before.toLowerCase()) || /^\p{Lu}$/u.test(before)) continue;
    }
    out.push(para.slice(from, at + m[0].length).trim());
    from = at + m[0].length;
  }
  const rest = para.slice(from).trim();
  if (rest) out.push(rest);
  return out.filter((s) => wordCount(s) > 0);
}

/** Sentence-length σ (one decimal) and first-person percent of a text's paragraphs. */
function voice(paras: readonly string[]): { sentenceSigma: number; firstPerson: number } {
  const all = paras.flatMap(sentences);
  if (all.length === 0) return { sentenceSigma: 0, firstPerson: 0 };
  const lengths = all.map(wordCount);
  const mean = lengths.reduce((a, b) => a + b, 0) / lengths.length;
  const variance = lengths.reduce((a, b) => a + (b - mean) ** 2, 0) / lengths.length;
  const first = all.filter((s) => FIRST_PERSON.test(s)).length;
  return {
    sentenceSigma: Math.round(Math.sqrt(variance) * 10) / 10,
    firstPerson: Math.round((100 * first) / all.length),
  };
}

const paragraphs = (text: string): string[] => {
  const blocks = splitBlocks(text);
  const k = kinds(blocks);
  return blocks.filter((_, i) => k[i] === "para");
};

/** The seven numbers of `article`, the last two also for `dump`, and where each counted tell is. Pure. */
export function tells(article: string, dump = ""): Tells {
  const blocks = splitBlocks(article);
  const k = kinds(blocks);
  const hits: Record<TellKey, TellHit[]> = {
    em: [],
    oneSentence: [],
    notXButY: [],
    genuinely: [],
    ruleOfThree: [],
  };
  blocks.forEach((text, block) => {
    if (k[block] === "code") return;
    const add = (key: TellKey, start: number, end: number) =>
      hits[key].push({ block, start, end, text: text.slice(start, end) });
    for (const m of text.matchAll(EM)) add("em", m.index ?? 0, (m.index ?? 0) + m[0].length);
    for (const m of text.matchAll(GENUINELY)) add("genuinely", m.index ?? 0, (m.index ?? 0) + m[0].length);
    for (const m of text.matchAll(RULE_OF_THREE))
      add("ruleOfThree", m.index ?? 0, (m.index ?? 0) + m[0].length);
    // The patterns overlap: each stretch of text is counted once, by the match that starts first.
    const found = NOT_X_BUT_Y.flatMap((re) => [...text.matchAll(re)])
      .map((m) => ({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length }))
      .sort((a, b) => a.start - b.start || b.end - a.end);
    let past = 0;
    for (const f of found) {
      if (f.start < past) continue;
      // The hit runs to the end of its clause, so it reads whole: "not broken, it is very confident".
      const tail = /^[^.!?;\n]{0,60}/.exec(text.slice(f.end))?.[0] ?? "";
      let end = f.end + tail.length;
      while (end > f.start + 1 && /\s/.test(text[end - 1] as string)) end--;
      add("notXButY", f.start, end);
      past = end;
    }
    if (k[block] === "para" && sentences(text).length === 1) add("oneSentence", 0, text.length);
  });
  return {
    em: hits.em.length,
    oneSentence: hits.oneSentence.length,
    notXButY: hits.notXButY.length,
    genuinely: hits.genuinely.length,
    ruleOfThree: hits.ruleOfThree.length,
    ...voice(blocks.filter((_, i) => k[i] === "para")),
    dump: voice(paragraphs(dump)),
    hits,
  };
}

/** The foot's three counts: `em 0 · ¶1 1 · not-x-but-y 1`. */
export function tellsLine(t: Pick<Tells, "em" | "oneSentence" | "notXButY">): string {
  return `em ${t.em} · ¶1 ${t.oneSentence} · not-x-but-y ${t.notXButY}`;
}

/** The seven numbers on one line, as the fixture header and the `tells` pass prompt give them. */
export function tellsSummary(t: Tells): string {
  return [
    `em-dash ${t.em}`,
    `single-sentence ¶ ${t.oneSentence}`,
    `not-X-but-Y ${t.notXButY}`,
    `genuinely ${t.genuinely}`,
    `rule-of-three ${t.ruleOfThree}`,
    `sentence-length σ ${t.sentenceSigma.toFixed(1)}`,
    `first-person ${t.firstPerson}%`,
  ].join(" · ");
}
