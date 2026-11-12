// Publishing (design sections 2, 3 and 4), the parts the daemon and the browser share: the preflight's shape,
// the three questions, and the gate. The browser's check is a courtesy; the daemon runs the same function and
// its answer is the one that counts.
import type { BlockState } from "./provenance.ts";

/** The three cold questions of the sheet. The answers are stored in meta.json and never published. */
export const QUESTIONS = [
  "what did you learn writing this?",
  "would you say this to a friend?",
  "who is this for and what do they lose?",
] as const;

export const TICK_LABEL = "I chose these words";

export interface PostMeta {
  title: string;
  description: string;
  /** `YYYY-MM-DD`: the publish date. */
  date: string;
  answers: [string, string, string];
}

export const EMPTY_META: PostMeta = { title: "", description: "", date: "", answers: ["", "", ""] };

/** Whatever meta.json holds, as a PostMeta. */
export function postMeta(raw: unknown): PostMeta {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  const a = Array.isArray(r.answers) ? r.answers : [];
  return {
    title: s(r.title),
    description: s(r.description),
    date: s(r.date),
    answers: [s(a[0]), s(a[1]), s(a[2])],
  };
}

/** Is `YYYY-MM-DD` a real calendar date? `2026-02-30` is not. */
export function realDate(date: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.toISOString().slice(0, 10) === date;
}

export type PublishKind = "first" | "update_open" | "edit_merged";

/** A run of the coach's words in the text (coached mode): ticked by its hash. */
export interface PublishSpan {
  hash: string;
  text: string;
  /** The paragraph it stands in, counted from 1. */
  block: number;
  /** Where the coach said it: `interview q6`, `pasted from note c08`. */
  source: string;
}

export interface PublishBlock {
  n: number;
  hash: string;
  state: BlockState;
  first_words: string;
}

export interface PublishCheck {
  id: string;
  ok: boolean;
  text: string;
  /** A warning does not stop a publish. */
  warn?: boolean;
}

export interface PublishCounts {
  questions: number;
  comments: number;
  done: number;
  dismissed: number;
  disagreed: number;
  violations: number;
  pastedWords: number;
  /** Runs of the coach's words in the text, in either mode. */
  spans: number;
  words: number;
}

/** A publish job as `_meta.sparring.publish` carries it. */
export interface PublishJob {
  id: number;
  step: string;
  lines: string[];
  error?: string;
}

/** `GET /api/articles/:slug/publish`. Everything the sheet shows comes from here. */
export interface Preflight {
  slug: string;
  /** The commit of the writing repo the sheet shows, and the one a publish names. */
  article_commit: string;
  /** False until `site_repo`, the git identity and the clone are in place. `setup` says what is missing. */
  configured: boolean;
  setup: string[];
  /** `clean`: fetched, and no worktree left over. `bad`: the site could not be read at all. */
  origin: { sha: string; clean: boolean; text: string; bad?: boolean };
  kind: PublishKind;
  branch: string;
  meta: PostMeta;
  counts: PublishCounts;
  authorship: "coached" | "drafted";
  yoursPct: number;
  blockCounts: { coach: number; edited: number; yours: number };
  spans: PublishSpan[];
  blocks: PublishBlock[];
  checks: PublishCheck[];
  /** The exact file a publish writes: `buildPost(meta, article)`. */
  post: string;
  /** The post's path in the site repo. */
  path: string;
  /** The body's disclosure line, or "". */
  disclosure: string;
  /** For `edit_merged`: the diff against the file on `origin/main`. */
  diff?: string;
  pr: { number: number; url: string; state: string } | null;
  /** The article commit of the last publish that finished. */
  published_commit: string | null;
  publish: PublishJob | null;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The hashes a publish still needs a tick for: coach blocks when drafted, agent-word spans when coached. */
export function unticked(p: Pick<Preflight, "authorship" | "spans" | "blocks">, ticked: readonly string[]) {
  const have = new Set(ticked);
  const need =
    p.authorship === "drafted"
      ? p.blocks.filter((b) => b.state === "coach").map((b) => b.hash)
      : p.spans.map((s) => s.hash);
  return [...new Set(need)].filter((h) => !have.has(h));
}

/**
 * Why a publish cannot start, most pressing first, or [] when it can. The words are the button's reason line:
 * `disabled: 1 span unticked`.
 */
export function blockers(p: Preflight, ticked: readonly string[]): string[] {
  const out: string[] = [];
  if (!p.configured) out.push("publishing is not set up");
  for (const c of p.checks) if (!c.ok && !c.warn) out.push(c.text);
  const left = unticked(p, ticked).length;
  if (left > 0)
    out.push(
      p.authorship === "drafted"
        ? `${plural(left, "block", "blocks")} unticked`
        : `${plural(left, "span", "spans")} unticked`,
    );
  return out;
}

/** Is a job still going? */
export const jobRunning = (j: PublishJob | null | undefined): boolean =>
  !!j && j.step !== "done" && j.step !== "failed";
