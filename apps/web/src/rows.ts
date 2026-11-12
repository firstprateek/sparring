// How the Articles screen words a row and its head, from `_meta.sparring`. Pure, so it is tested alone.
import { TOPICS } from "@sparring/protocol/commands";
import type { SparringMeta } from "@sparring/protocol/meta";

/** A span of age: `12s`, `5m`, `2h`, `3d`. */
export function ago(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86_400)}d`;
}

/** A token count: `640 tok`, `18k tok`. */
export function tok(n: number): string {
  return n < 1000 ? `${n} tok` : `${Math.round(n / 1000)}k tok`;
}

/** The stage as the menu and the rows say it: `interview 4/6` while interviewing, else the stage. */
export function stageLabel(stage: string, covered: readonly string[] | undefined): string {
  return stage === "interview"
    ? `interview ${Math.min(covered?.length ?? 0, TOPICS.length)}/${TOPICS.length}`
    : stage;
}

export interface TailPart {
  text: string;
  /** `save` hides on hover, `tok` shows only on hover (as the mock has it). */
  cls?: "save" | "tok" | "tag";
}

/** The mono tail of a row. Once a PR exists it is the PR alone. */
export function rowTail(m: SparringMeta, now = Date.now()): TailPart[] {
  if (m.prNumber) return [{ text: `PR #${m.prNumber}` }];
  const out: TailPart[] = [];
  // The coach wrote this article's draft: the row says so before anything else.
  if (m.authorship === "drafted") out.push({ text: "drafted", cls: "tag" });
  out.push({ text: stageLabel(m.stage, m.covered) });
  if (m.wordCount > 0) out.push({ text: `${m.wordCount} words` });
  if (m.openComments > 0) out.push({ text: `${m.openComments} ${m.openComments === 1 ? "note" : "notes"}` });
  const saved = m.savedAt ? Date.parse(m.savedAt) : Number.NaN;
  if (!Number.isNaN(saved)) out.push({ text: `${ago(now - saved)} ago`, cls: "save" });
  if (m.tokens > 0) out.push({ text: tok(m.tokens), cls: "tok" });
  return out;
}

/** The line under a row's title: the coach's open question, else the last host line. */
export function rowSub(m: SparringMeta): string {
  return m.openQuestion || m.lastLine || "";
}

/** The head's `claude · 41k tok`: the engines of the rows and the sum of their tokens. */
export function headLine(metas: readonly SparringMeta[]): string {
  if (metas.length === 0) return "";
  const engines = [...new Set(metas.map((m) => m.provider).filter(Boolean))].join(" / ");
  const total = metas.reduce((n, m) => n + (m.tokens || 0), 0);
  return [engines, tok(total)].filter(Boolean).join(" · ");
}
