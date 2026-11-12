// `_meta.sparring` on each article's AHP session (design section 7). The daemon builds it with metaFor() and
// sends the whole object on every change; clients only read it.
import type { Stage } from "./commands.ts";

export type LetterKind =
  | "refused"
  | "quarantine"
  | "passDone"
  | "passEmpty"
  | "draftFailed"
  | "draftEmpty"
  | "interrupted";

export interface SparringMeta {
  slug: string;
  stage: Stage;
  covered: string[];
  authorship: "coached" | "drafted";
  drafting: boolean;
  coachQuiet: boolean;
  offline: boolean;
  yoursPct?: number;
  blocks?: { coach: number; edited: number; yours: number };
  wordCount: number;
  savedAt: string | null;
  articleSha: string | null;
  commit: string | null;
  tells: { em: number; oneSentence: number; notXButY: number };
  pastedWords: number;
  openComments: number;
  unreadComments: number;
  commentsRev: number;
  run: { pass: string; startedAt: string } | null;
  queued: number;
  letter: { id: string; kind: LetterKind; text: string; at: string }[];
  openQuestion?: string;
  lastLine?: string;
  thesis?: string;
  reader?: string;
  /** The article's last publish job: its step, its log, and why it failed. */
  publish: { id: number; step: string; lines: string[]; error?: string } | null;
  prNumber?: number;
  prUrl?: string;
  tokens: number;
  provider: "claude" | "demo";
  /** The engine answered a prompt with -32000: the Room shows `sign-in needed · <provider>` and no coach starts. */
  signInNeeded?: boolean;
}

/** The key under the session's `_meta`. */
export const META_KEY = "sparring";
