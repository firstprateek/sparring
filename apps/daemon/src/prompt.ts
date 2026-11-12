// Prompt assembly (design section 3, "Prompt assembly and host-intercepted input"): the pieces `coach.ts` puts in
// each `session/prompt`, in order: the header, the stage prompt, the pass prompt, what changed in article.md, the
// message. Plus the rules a child gets once, and the continuation brief that opens a new child's first prompt.
// Pure functions over text; the coach reads the files.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** `packages/protocol/prompts`: RULES.md and stages/*.md. */
export const PROMPTS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../packages/protocol/prompts",
);

/** Under this many words a coach that has never seen the page gets all of it; over it, a pointer to read_article. */
export const FULL_TEXT_WORDS = 4000;
/** Coach replies in the continuation brief are cut to this. */
export const BRIEF_REPLY_CHARS = 600;

const readOr = (path: string, fallback = ""): string => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return fallback;
  }
};

/** RULES.md, then STYLE.md as it stands at spawn. Sent through `systemPrompt`, or as the first prompt block. */
export function rulesText(style: string, dir = PROMPTS_DIR): string {
  const rules = readOr(join(dir, "RULES.md")).trim();
  const s = style.trim();
  return s ? `${rules}\n\n---\n\nSTYLE.md, as it stands now:\n\n${s}\n` : `${rules}\n`;
}

/** `prompts/stages/<stage>.md`, or undefined for a stage that has none yet. */
export function stagePrompt(stage: string, dir = PROMPTS_DIR): string | undefined {
  if (!/^[a-z]+$/.test(stage)) return undefined;
  const text = readOr(join(dir, "stages", `${stage}.md`)).trim();
  return text || undefined;
}

const attr = (v: string | number) => String(v).replace(/[&"<>]/g, (c) => `&#${c.charCodeAt(0)};`);

export interface Header {
  stage: string;
  pass: string;
  strictness: string;
  words: number;
  commit: string;
  openComments: string[];
}

/** `<sparring stage="draft" pass="" strictness="normal" words="840" commit="abc1234" open_comments="c12,c15">` */
export function header(h: Header): string {
  return (
    `<sparring stage="${attr(h.stage)}" pass="${attr(h.pass)}" strictness="${attr(h.strictness)}" ` +
    `words="${h.words}" commit="${attr(h.commit.slice(0, 7))}" open_comments="${attr(h.openComments.join(","))}">`
  );
}

/** What each strictness asks of a pass. */
const STRICTNESS_MEANS: Record<string, string> = {
  "howlers only": "flag only what a reader would trip on; let the rest go",
  normal: "flag what a careful editor would mark; skip what is arguable",
  "every nit": "flag every instance, however small",
};

/** The strictness line of a pass header: `Strictness: every nit · flag every instance, however small`. */
export function strictnessLine(strictness: string): string {
  const means = STRICTNESS_MEANS[strictness];
  return means ? `Strictness: ${strictness} · ${means}` : `Strictness: ${strictness}`;
}

/** The pass prompt: a header naming the file and the strictness, then the pass file as the writer has it. */
export function passBlock(o: { pass: string; strictness: string; text: string }): string {
  return [`Pass: ${o.pass} · from passes/${o.pass}.md`, strictnessLine(o.strictness), "", o.text.trim()].join(
    "\n",
  );
}

/** Sent with a plain message while the writer has `/quiet` on. */
export const QUIET_LINE =
  "The writer asked for quiet. Answer what was asked in chat and leave no notes: comment is refused until the writer runs /critique or /pass.";

/** What the coach is shown of article.md: a diff since it last saw it, the whole text, or a pointer. */
export function articleBlock(o: {
  seen: string | null;
  commit: string;
  text: string;
  words: number;
  diff: string;
}): string {
  if (o.seen === null) {
    if (o.text.trim() === "") return "article.md is empty.";
    if (o.words >= FULL_TEXT_WORDS)
      return `article.md has ${o.words} words, too long to send whole. Read it with read_article.`;
    return `article.md as it stands (${o.words} words):\n<article>\n${o.text.replace(/\n$/, "")}\n</article>`;
  }
  if (o.seen === o.commit || o.diff.trim() === "") return "article.md has not changed since you last saw it.";
  return `article.md changed since you last saw it:\n<diff>\n${o.diff.replace(/\n$/, "")}\n</diff>`;
}

/** One earlier coach turn, for the continuation brief. */
export interface PastTurn {
  stage: string;
  writer: string;
  coach: string;
}

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/**
 * A new child knows nothing: its first prompt opens with this. The stage, brief.md, STYLE.md, the open note ids,
 * every writer message from the ideas and interview stages in full, and the last six turns of the current stage
 * with coach messages cut to 600 characters. Empty when there is no earlier turn.
 */
export function continuationBrief(o: {
  stage: string;
  brief: string;
  style: string;
  openComments: string[];
  turns: PastTurn[];
}): string {
  if (o.turns.length === 0) return "";
  const early = o.turns.filter((t) => (t.stage === "ideas" || t.stage === "interview") && t.writer.trim());
  const recent = o.turns.filter((t) => t.stage === o.stage).slice(-6);
  const out = [
    "<continuation>",
    "You are coaching this article in a new session; the one before it ended and you remember nothing of it. This is what you need from it.",
    `Stage: ${o.stage}`,
    "",
    "brief.md:",
    o.brief.trim() || "(empty)",
    "",
    "STYLE.md:",
    o.style.trim() || "(empty)",
    "",
    `Open notes: ${o.openComments.length ? o.openComments.join(", ") : "none"}`,
  ];
  if (early.length) {
    out.push("", "The writer's messages from the ideas and interview stages, in full, oldest first:");
    for (const t of early) out.push(`- [${t.stage}] ${t.writer}`);
  }
  if (recent.length) {
    out.push(
      "",
      `The last turns of the ${o.stage} stage, oldest first (your replies cut to ${BRIEF_REPLY_CHARS} characters):`,
    );
    for (const t of recent)
      out.push(`Writer: ${t.writer}`, `You: ${cut(t.coach.trim(), BRIEF_REPLY_CHARS) || "(no reply)"}`);
  }
  out.push("</continuation>");
  return out.join("\n");
}
