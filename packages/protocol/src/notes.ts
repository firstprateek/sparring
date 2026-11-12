// Notes: the coach's remarks on the article (design sections 3 and 6). A note is a row of `comments`, left with
// the `comment` tool. This file holds what the daemon and the browser must agree on: the kinds, the typed note
// actions (`done c08`), the rule a note's body passes, and what is computed from the file and never stored
// (which block a note sits on, whether it is stale, whether Done is live).
import { splitBlocks } from "./blocks.ts";

export const KINDS = [
  "unclear",
  "unsupported",
  "counter",
  "detail",
  "filler",
  "voice",
  "typo",
  "tell",
] as const;
export type NoteKind = (typeof KINDS)[number];

export type NoteStatus = "open" | "disagreed" | "done" | "dismissed" | "withdrawn";

/** A note as the snapshot carries it. The field names are the `comments` columns. */
export interface Note {
  id: string;
  file: string;
  kind: string;
  pass: string;
  brief_line: string | null;
  span: string;
  block_orig: string;
  body: string;
  body_v2: string | null;
  status: NoteStatus;
  muted: boolean;
  reply: string | null;
  seen_at: string | null;
  created_at: string;
  resolved_at: string | null;
}

export const BODY_MAX = 280;
/** At most this many notes from one coach turn. */
export const NOTES_PER_TURN = 10;

// ───────────────────────────── the note grammar ─────────────────────────────

export type NoteAction =
  | { action: "done" | "dismiss" | "mute"; id: string }
  | { action: "reply"; id: string; text: string };

/**
 * A composer line as a note action, or null when it is anything else: `done c08`, `dismiss c11`,
 * `dismiss c11 on purpose`, `mute c11` (the same as on purpose) and `re c09: …`. The note buttons send
 * exactly these lines.
 */
export function parseNoteAction(text: string): NoteAction | null {
  const t = text.trim();
  const re = /^re (c\d+):\s*([\s\S]+)$/i.exec(t);
  if (re) return { action: "reply", id: (re[1] as string).toLowerCase(), text: (re[2] as string).trim() };
  const m = /^(done|dismiss|mute) (c\d+)( on purpose)?$/i.exec(t);
  if (!m) return null;
  const verb = (m[1] as string).toLowerCase();
  const id = (m[2] as string).toLowerCase();
  if (m[3]) return verb === "dismiss" ? { action: "mute", id } : null;
  return { action: verb as "done" | "dismiss" | "mute", id };
}

// ───────────────────────────── the body rule ─────────────────────────────

const QUOTE_RE = /"([^"]+)"|“([^”]+)”/g;
/** Words that announce fix text. A quote right after one is the coach writing copy. */
const FIX_RE = /(?:\b(?:consider|try|rewrite):|\be\.g\.,?)$/i;

const fold = (s: string) =>
  s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim().toLowerCase();

/** The double-quoted spans of a note body, in order. */
export function quotedSpans(body: string): string[] {
  return [...body.matchAll(QUOTE_RE)].map((m) => m[1] ?? m[2] ?? "");
}

/**
 * Is this quoted span the writer's text? It is when it is an exact substring of a source. A quote that closes a
 * sentence ("…watching it.") or opens one with a capital also counts: the closing punctuation is dropped, and
 * case and runs of whitespace are folded, before it is looked for.
 */
export function quoteFound(quote: string, sources: readonly string[]): boolean {
  if (quote.trim() === "") return false;
  if (sources.some((s) => s.includes(quote))) return true;
  const q = fold(quote.replace(/[.,;:!?…]+$/, ""));
  if (q === "") return false;
  return sources.some((s) => fold(s).includes(q));
}

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * Why a note body is refused, or null when it passes. At most 280 characters. Every double-quoted span must be
 * the writer's own text (the article, the dump, the brief or a message they sent), and a quote that follows
 * `consider:`, `try:`, `rewrite:` or `e.g.` is fix text and refused. Unquoted explanation is allowed.
 */
export function bodyProblem(body: string, sources: readonly string[]): string | null {
  if (body.trim() === "") return "body is required: say what is wrong and why";
  if (body.length > BODY_MAX) return `body is at most ${BODY_MAX} characters (this one is ${body.length})`;
  for (const m of body.matchAll(QUOTE_RE)) {
    const quote = m[1] ?? m[2] ?? "";
    const before = body.slice(0, m.index).trimEnd();
    if (FIX_RE.test(before))
      return "no fix text: a quote after consider:, try:, rewrite: or e.g. is refused. Point, don't write.";
    if (!quoteFound(quote, sources))
      return (
        `"${cut(quote, 60)}" is not the writer's text: every double-quoted span must be an exact substring ` +
        "of article.md, dump.md, brief.md or a writer message"
      );
  }
  return null;
}

/** `brief: evidence`, or `no brief line`. */
export function briefLabel(briefLine: string | null | undefined): string {
  return briefLine ? `brief: ${briefLine}` : "no brief line";
}

/** A `brief_line` argument as it is stored: the bare name, or null for none (`(no brief line)` included). */
export function briefLineOf(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = raw
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\(?(.*?)\)?$/, "$1")
    .replace(/^brief:\s*/i, "")
    .trim();
  return t === "" || /^no brief line$/i.test(t) ? null : t.slice(0, 80);
}

// ───────────────────────────── computed from the file ─────────────────────────────

/** The first block of a file that holds a span, with its index. */
export function blockOf(text: string, span: string): { index: number; block: string } | null {
  const blocks = splitBlocks(text);
  const index = blocks.findIndex((b) => b.includes(span));
  return index < 0 ? null : { index, block: blocks[index] as string };
}

export const isLive = (n: Pick<Note, "status">) => n.status === "open" || n.status === "disagreed";

export interface NoteView {
  note: Note;
  /** The index of the block its span sits in, or -1 when the span has left the file. */
  block: number;
  /** The span has left the file: the note goes to the shelf. */
  stale: boolean;
  /** The anchored block differs from `block_orig`: Done is live. */
  edited: boolean;
}

/** Has the block a note was left on changed? True once no block of the file is `block_orig` word for word. */
export function blockEdited(blockOrig: string, blocks: readonly string[]): boolean {
  return !blocks.includes(blockOrig);
}

export function viewNote(note: Note, blocks: readonly string[]): NoteView {
  const block = blocks.findIndex((b) => b.includes(note.span));
  return { note, block, stale: block < 0, edited: blockEdited(note.block_orig, blocks) };
}

const RANK: Record<NoteStatus, number> = { open: 0, disagreed: 0, dismissed: 1, done: 2, withdrawn: 3 };
const num = (id: string) => Number(id.replace(/\D/g, "")) || 0;

/**
 * The notes in the order the margin shows them: live ones in page order, then dismissed, done and withdrawn.
 * Live notes whose span has left the file come last, under the shelf rule.
 */
export function arrange(notes: readonly Note[], text: string): { list: NoteView[]; shelf: NoteView[] } {
  const blocks = splitBlocks(text);
  const views = notes.map((n) => viewNote(n, blocks));
  const order = (a: NoteView, b: NoteView) =>
    RANK[a.note.status] - RANK[b.note.status] || a.block - b.block || num(a.note.id) - num(b.note.id);
  const onShelf = (v: NoteView) => v.stale && isLive(v.note);
  return { list: views.filter((v) => !onShelf(v)).sort(order), shelf: views.filter(onShelf).sort(order) };
}

export interface FilterItem {
  key: string;
  label: string;
  count: number;
}

/** The filter row: `all 6`, `open 5`, then one item per pass (`critique 4`, `filler 1`), in first-seen order. */
export function filterItems(notes: readonly Note[]): FilterItem[] {
  const out: FilterItem[] = [
    { key: "all", label: "all", count: notes.length },
    { key: "open", label: "open", count: notes.filter(isLive).length },
  ];
  for (const n of notes) {
    if (!n.pass) continue;
    const key = `pass:${n.pass}`;
    const have = out.find((i) => i.key === key);
    if (have) have.count++;
    else out.push({ key, label: n.pass, count: 1 });
  }
  return out;
}

/** The notes a filter key keeps. An unknown key keeps all. */
export function filterNotes(notes: readonly Note[], key: string): Note[] {
  if (key === "open") return notes.filter(isLive);
  if (key.startsWith("pass:")) return notes.filter((n) => n.pass === key.slice(5));
  return [...notes];
}
