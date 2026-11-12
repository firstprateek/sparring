// The scripted coach, the `demo` provider: a small ACP agent that runs inside the daemon over in-memory streams,
// with no process, no network and no tokens. It speaks ACP to the daemon exactly as an adapter does, so its
// turns go through the same acp-connection and acp-mapper path as a real coach's. Each prompt plays the next move
// of its script; a move streams its reply as agent_message_chunk updates and ends the turn. The script is the
// interview: one question per turn, from a fixed list, then a line saying there are no more.
//
// In the interview stage (it reads the stage from the prompt's header) a move also does what a real coach does
// with tools: it reads dump.md, calls note_brief with a sentence from it, and on its first interview turn asks
// to edit article.md with the built-in `Edit`, which the host's policy must reject. Sparring calls go to the
// daemon's tool handler directly, with the session's secret from `session/new`, and each is announced as a
// `tool_call` named `mcp__sparring__<tool>` and preceded by a `session/request_permission` offering `allow_once`
// and `reject_once`. If the Edit were allowed it would really write the file.
//
// In a critique turn (the header's pass or stage is `critique`) it reads article.md and leaves two notes with
// `comment`, once per session. A `re c09: …` turn is answered with `resolve_comment`: it sharpens the note, or
// withdraws it when the writer's reply asks for that. A `/reader` turn reads the brief and answers as the reader.
//
// The later stages each get their own move, so the Room shows them apart. In `outline` it reads the page and
// names the `##` headings it found; in `draft` it stays out of the way; in `polish` it asks for a pass. `/next`
// names the first heading with nothing under it, and `done` after it leaves one note on the last paragraph.
// `/ask` leaves one note on the paragraph the question was parked at. A named pass (`/pass filler`, or one of a
// `/queue`) reads the page and flags what a few fixed patterns find, fewer or more by the strictness in the
// header: `filler`, `repeats`, `passive`, `typos` and `cut` can leave notes, every other pass finds nothing.
//
// The draft turn (the header's pass is `sendit`) reads the dump and the brief and writes one draft with
// `write_draft`: a heading, the dump's paragraphs, what the brief adds, and a closing block of its own. A plain
// message that asks it to write (`write it for me`, `rewrite this`) makes it try `write_draft` with no draft turn
// behind it, so the refusal shows: in a coached article, and again after a draft, when the grant is spent. In a
// drafted article `/next`, `/ask` and plain messages get a short answer and no notes.
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { TOPICS } from "@sparring/protocol/commands";
import type { AgentProcess, Launch } from "./ahp/agent-process.ts";

type Json = Record<string, unknown>;

/** The daemon's tool handler, as the MCP socket calls it. */
export type DemoTools = (
  secret: string,
  tool: string,
  args: Json,
) => Promise<{ ok: boolean; text?: string; error?: string }>;

/** What the Edit writes if the host ever allows it. */
export const DEMO_EDIT_TEXT = "The coach's own sentence, which should never land.\n";

/** The interview, one question per topic: thesis, reader, evidence, counter, uncertainty, scar. */
export const QUESTIONS = [
  "What is the one sentence you want a reader to walk away with?",
  "Who is this for, and what do they believe before they start reading?",
  "What happened that makes you sure? Tell me the specific case.",
  "Who would disagree with you, and what is their best argument?",
  "Which part are you still unsure about?",
  "When did you get this wrong yourself?",
];

export const NO_MORE = "I have no more questions. The brief is yours to write now.";

export const NOTHING = "nothing in this pass";
export const EMPTY_PAGE = "article.md is empty. Write a few paragraphs, then ask again.";
export const READER_SAYS =
  "Reading as the reader your brief names. I got through the opening, and I still do not know what I lose if I stop here. Where do you tell me?";
export const NOTE_BODIES = [
  "Nothing here says how you know this. What did you see first-hand? The reader named in the brief will ask.",
  (words: string) =>
    `You open with "${words}" and the paragraph does not come back to it. What does the reader know after it that they did not before?`,
] as const;
export const NO_HEADINGS =
  "There are no ## headings on the page yet. Which line of your brief does the reader need first?";
export const DRAFT_SAYS =
  "I stay quiet while you draft. /next names the section to write, and /ask parks a question at a paragraph.";
export const POLISH_SAYS =
  "Polish runs one pass at a time. Which lens first? /pass filler runs one, and /queue filler repeats cut runs several.";
export const NO_PARAGRAPH =
  "I have no paragraph to pin that to. Click in a paragraph of the article, then ask again.";
export const QUIET_ANSWER =
  "You asked for quiet, so I am answering here and leaving no note. What would the reader say to that question?";
export const ASK_BODY =
  "This paragraph does not answer your question yet. What would you say if the reader asked you the same thing?";
export const SECTION_BODY =
  "This tells me what happened and not what you saw. What was in front of you when it did?";
export const CUT_BODY =
  "The reader named in the brief may not miss this paragraph. What do they lose without it?";
export const PASSIVE_BODY = "Who did this? The sentence does not say, and the reader will want to know.";
export const TYPO_BODY = "word doubled";
export const fillerBody = (word: string) => `"${word}" adds no degree here. Does the claim need it?`;
export const repeatBody = (word: string) =>
  `"${word}" comes back within a few lines. Is the echo on purpose?`;
/** How many notes the scripted coach leaves in one pass, by strictness. */
export const DEMO_LIMIT: Record<string, number> = { "howlers only": 1, normal: 2, "every nit": 10 };
const FILLER = /\b(very|really|quite|actually|basically|just|simply|kind of|sort of)\s+[\w'’-]+/gi;
const PASSIVE = /\b(?:was|were|is|are|been|being|be)\s+\w+ed\b/g;
const DOUBLED = /\b([A-Za-z]+)\s+\1\b/g;

export const DRAFTED_SAYS =
  "Drafted from your sentences where you had them. The review is yours; I stay quiet until you ask.";
export const DRAFT_NOT_WRITTEN = "The draft was not written. Your page is as it was.";
export const WRITE_REFUSED_SAYS =
  "I asked to write and the host refused, as it should. What are you trying to say there?";
export const DRAFTED_QUIET_SAYS =
  "This review is yours, so I am leaving no notes. /critique when you want them.";
export const DRAFTED_NEXT_SAYS =
  "The page is yours to review. Start with the block that sounds least like you and say it your way.";
/** The closing block of the scripted draft: the coach's own words, there to be rewritten. */
export const DEMO_CLOSER =
  "This is where the piece should land. Say what you want the reader to do next, and say it the way you would say it out loud.";
/** What the scripted coach tries to write when it is asked to with no draft turn. */
export const DEMO_UNASKED = "A sentence the coach wrote without being asked to draft.";
const WRITE_ASK = /\b(?:re)?write (?:it|this|that|the (?:draft|article|piece|paragraph))\b/i;

/** The scripted draft: a heading, the dump's paragraphs, what the brief adds, a closing block. */
export function demoDraft(dump: string, brief: string): string[] {
  const clean = (b: string) =>
    b
      .split("\n")
      .map((l) => l.replace(/^\s*(?:[-*]|#+)\s+/, "").trim())
      .filter(Boolean)
      .join(" ");
  const paras = dump
    .split(/\n\s*\n/)
    .map(clean)
    .filter((b) => b && !b.startsWith("("))
    .slice(0, 8);
  const title = (paras[0] ?? "The draft")
    .replace(/[^\p{L}\p{N}'’ -]/gu, "")
    .split(/\s+/)
    .slice(0, 5)
    .join(" ");
  const extra = brief
    .split("\n")
    .filter((l) => l.trim() && !l.trim().startsWith("#") && !l.trim().startsWith("("))
    .map((l) =>
      l
        .replace(/^\s*[-*]\s+/, "")
        .replace(/^[a-z]+:\s*/, "")
        .replace(/^"(.*)"$/, "$1")
        .trim(),
    )
    .filter((l) => l && !paras.some((p) => p.includes(l)))
    .slice(0, 4);
  return [
    `## ${title || "The draft"}`,
    ...paras,
    ...(extra.length > 0 ? ["## What it is for", ...extra] : []),
    "## Where it lands",
    DEMO_CLOSER,
  ];
}

export const SHARPENED =
  "Sharpened. The sentence still names no source. Say where it comes from, or say it is a guess.";
export const WITHDRAWN = "Withdrawn. Your reply covers it.";

export interface DemoOptions {
  /** Pause between streamed pieces, in ms. Tests pass 0. */
  delayMs?: number;
  /** The daemon's tool handler. Without it the coach only asks. */
  tools?: DemoTools;
}

interface DemoSession {
  secret: string;
  cwd: string;
  /** How far it is into the script. */
  played: number;
  editAsked: boolean;
  quoted: Set<string>;
  /** The critique's two notes are left once per session. */
  critiqued: boolean;
}

/** One move of the script: what the coach does with one prompt. Resolves with the ACP stop reason. */
type Move = (sessionId: string, prompt: string) => Promise<"end_turn" | "cancelled">;

const MODES = { currentModeId: "default", availableModes: [{ id: "default", name: "Ask" }] };

export class DemoCoach {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  private exitCode: number | null | undefined;
  private finish!: (code: number | null) => void;
  readonly exited = new Promise<number | null>((r) => {
    this.finish = r;
  });
  private buf = "";
  private seq = 0;
  private nextId = 1;
  private readonly waiting = new Map<number, (m: Json) => void>();
  private readonly cancelled = new Set<string>();
  private readonly sessions = new Map<string, DemoSession>();
  /** The moves in order; the last one repeats once the others are spent. */
  private readonly script: Move[] = [
    ...QUESTIONS.map(
      (q): Move =>
        (s) =>
          this.say(s, q),
    ),
    (s) => this.say(s, NO_MORE),
  ];

  constructor(private readonly o: DemoOptions = {}) {
    this.stdin.on("data", (chunk: Buffer) => {
      this.buf += chunk.toString();
      for (let i = this.buf.indexOf("\n"); i >= 0; i = this.buf.indexOf("\n")) {
        const line = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 1);
        let m: Json;
        try {
          m = JSON.parse(line) as Json;
        } catch {
          continue;
        }
        if (typeof m.method === "string") void this.handle(m);
        else if (typeof m.id === "number") {
          this.waiting.get(m.id)?.(m);
          this.waiting.delete(m.id);
        }
      }
    });
    this.stdin.on("end", () => this.die(0));
  }

  private out(m: Json): void {
    if (this.exitCode === undefined) this.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`);
  }

  private update(sessionId: string, u: Json): void {
    this.out({ method: "session/update", params: { sessionId, update: u } });
  }

  die(code: number | null): void {
    if (this.exitCode !== undefined) return;
    this.exitCode = code;
    this.stdout.end();
    for (const resolve of this.waiting.values()) resolve({ error: { code: -32099, message: "exited" } });
    this.waiting.clear();
    this.finish(code);
  }

  /** A request to the daemon (a permission prompt); resolves with the whole reply. */
  private ask(method: string, params: Json): Promise<Json> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      this.out({ id, method, params });
    });
  }

  /** Asks permission with the given options; true when the host picked an `allow` option. */
  private async permitted(sessionId: string, toolCall: Json, options: Json[]): Promise<boolean> {
    const res = await this.ask("session/request_permission", { sessionId, toolCall, options });
    const outcome = ((res.result ?? {}) as Json).outcome as Json | undefined;
    if (outcome?.outcome !== "selected") return false;
    return options.some((o) => o.optionId === outcome.optionId && String(o.kind).startsWith("allow"));
  }

  /** One Sparring tool call: announced, permission asked, the handler called, the result reported. */
  private async tool(
    sessionId: string,
    s: DemoSession,
    tool: string,
    args: Json,
  ): Promise<string | undefined> {
    const toolCallId = `demo-tc-${++this.seq}`;
    const title = `mcp__sparring__${tool}`;
    const _meta = { claudeCode: { toolName: title, mcpServer: { name: "sparring" } } };
    this.update(sessionId, {
      sessionUpdate: "tool_call",
      toolCallId,
      title,
      kind: "other",
      status: "pending",
      rawInput: args,
      _meta,
    });
    const ok = await this.permitted(sessionId, { toolCallId, title, kind: "other", rawInput: args, _meta }, [
      { optionId: "allow", name: "Allow", kind: "allow_once" },
      { optionId: "reject", name: "Reject", kind: "reject_once" },
    ]);
    if (!ok || !this.o.tools) {
      this.update(sessionId, { sessionUpdate: "tool_call_update", toolCallId, status: "failed" });
      return undefined;
    }
    const reply = await this.o.tools(s.secret, tool, args);
    const text = reply.ok ? String(reply.text ?? "") : String(reply.error ?? "refused");
    this.update(sessionId, {
      sessionUpdate: "tool_call_update",
      toolCallId,
      status: reply.ok ? "completed" : "failed",
      content: [{ type: "content", content: { type: "text", text } }],
    });
    return reply.ok ? text : undefined;
  }

  /** The built-in Edit of article.md, which the host must reject. If it is allowed, the file really changes. */
  private async edit(sessionId: string, s: DemoSession): Promise<void> {
    const toolCallId = `demo-edit-${++this.seq}`;
    const path = join(s.cwd, "article.md");
    const call = {
      toolCallId,
      title: `Edit ${path}`,
      kind: "edit",
      rawInput: { file_path: path, new_string: DEMO_EDIT_TEXT },
      locations: [{ path }],
      _meta: { claudeCode: { toolName: "Edit" } },
    };
    this.update(sessionId, { sessionUpdate: "tool_call", ...call, status: "pending" });
    const ok = await this.permitted(sessionId, call, [
      { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
      { optionId: "allow-always", name: "Always allow", kind: "allow_always" },
      { optionId: "reject-once", name: "Reject", kind: "reject_once" },
      { optionId: "reject-always", name: "Always reject", kind: "reject_always" },
    ]);
    if (ok) appendFileSync(path, DEMO_EDIT_TEXT);
    this.update(sessionId, {
      sessionUpdate: "tool_call_update",
      toolCallId,
      status: ok ? "completed" : "failed",
    });
  }

  /** The interview's tool moves: read the dump, note a sentence of it not yet quoted, ask once to edit. */
  private async interviewTools(sessionId: string, s: DemoSession, n: number): Promise<void> {
    if (!this.o.tools || !s.secret) return;
    const dump = await this.tool(sessionId, s, "read_source", { name: "dump" });
    const sentence = (dump ?? "")
      .split(/(?<=[.!?])\s+|\n+/)
      .map((x) => x.trim())
      .find((x) => x && !x.startsWith("(") && !s.quoted.has(x));
    if (sentence) {
      s.quoted.add(sentence);
      await this.tool(sessionId, s, "note_brief", { topic: TOPICS[n % TOPICS.length], quote: sentence });
    }
    if (!s.editAsked) {
      s.editAsked = true;
      await this.edit(sessionId, s);
    }
  }

  /** The critique: reads the page and leaves two notes, each anchored to the first sentence of a paragraph. */
  private async critique(sessionId: string, s: DemoSession): Promise<string> {
    if (!this.o.tools || !s.secret) return NOTHING;
    const numbered = (await this.tool(sessionId, s, "read_article", {})) ?? "";
    if (numbered.startsWith("(")) return EMPTY_PAGE;
    const text = numbered
      .split("\n")
      .map((l) => l.replace(/^\s*\d+ {2}/, ""))
      .join("\n");
    const paras = text
      .split(/\n\s*\n/)
      .map((b) => b.trim())
      .filter((b) => b && !b.startsWith("#"));
    const anchors = [...new Set([paras[0], paras.at(-1)].filter((b) => b !== undefined).map(firstSentence))];
    if (anchors.length === 0) return EMPTY_PAGE;
    s.critiqued = true;
    let left = 0;
    for (const [i, anchor] of anchors.entries()) {
      const words = anchor.split(/\s+/).slice(0, 3).join(" ");
      const made = await this.tool(
        sessionId,
        s,
        "comment",
        i === 0
          ? { anchor, kind: "unsupported", body: NOTE_BODIES[0], pass: "critique", brief_line: "evidence" }
          : { anchor, kind: "unclear", body: NOTE_BODIES[1](words), pass: "critique" },
      );
      if (made !== undefined) left++;
    }
    if (left === 0) return NOTHING;
    return left === 1
      ? "One item. It cites a brief line. Nothing on structure."
      : "Two items. One cites a brief line. Nothing on structure.";
  }

  /** The page as blocks, with the line numbers of `read_article` taken off; null when it is empty. */
  private async page(sessionId: string, s: DemoSession): Promise<string[] | null> {
    const numbered = (await this.tool(sessionId, s, "read_article", {})) ?? "";
    if (numbered.startsWith("(")) return null;
    const blocks = numbered
      .split("\n")
      .map((l) => l.replace(/^\s*\d+ {2}/, ""))
      .join("\n")
      .split(/\n\s*\n/)
      .map((b) => b.trim())
      .filter(Boolean);
    return blocks.length > 0 ? blocks : null;
  }

  /** The outline turn: names the `##` headings on the page and asks about the first. */
  private async outline(sessionId: string, s: DemoSession): Promise<string> {
    const heads = ((await this.page(sessionId, s)) ?? []).filter((b) => /^##+ /.test(b));
    const first = heads[0];
    if (first === undefined) return NO_HEADINGS;
    const n = heads.length === 1 ? "one section" : `${heads.length} sections`;
    return `I count ${n}. What does the reader know after "${first}" that they did not know before it?`;
  }

  /** `/next`: the first heading with nothing written under it. */
  private async next(sessionId: string, s: DemoSession): Promise<string> {
    const blocks = (await this.page(sessionId, s)) ?? [];
    const isHead = (b: string | undefined) => b !== undefined && /^##+ /.test(b);
    if (!blocks.some(isHead)) return NO_HEADINGS;
    const at = blocks.findIndex((b, i) => isHead(b) && (i === blocks.length - 1 || isHead(blocks[i + 1])));
    if (at < 0) return "Every section has something under it. Which one would the reader call thin?";
    return `Write the section under "${blocks[at]}". Ugly is fine. Say done when it is in the file.`;
  }

  /** `done` after `/next`: one note on the last paragraph, standing in for the section just written. */
  private async section(sessionId: string, s: DemoSession): Promise<string> {
    const paras = ((await this.page(sessionId, s)) ?? []).filter((b) => !b.startsWith("#"));
    const last = paras.at(-1);
    if (last === undefined) return EMPTY_PAGE;
    const made = await this.tool(sessionId, s, "comment", {
      anchor: firstSentence(last),
      kind: "detail",
      body: SECTION_BODY,
      pass: "section",
    });
    return made === undefined ? NOTHING : "One note on that section.";
  }

  /** `/ask`: one note anchored in the paragraph the question was parked at. */
  private async askNote(sessionId: string, s: DemoSession, prompt: string): Promise<string> {
    const para = /<paragraph>\n([\s\S]*?)\n<\/paragraph>/.exec(prompt)?.[1];
    if (/^The writer asked for quiet\.$/m.test(prompt)) return QUIET_ANSWER;
    if (DRAFTED.test(prompt)) return DRAFTED_QUIET_SAYS;
    if (para === undefined) return NO_PARAGRAPH;
    const made = await this.tool(sessionId, s, "comment", {
      anchor: firstSentence(para),
      kind: "unclear",
      body: ASK_BODY,
      pass: "ask",
    });
    return made === undefined
      ? "I could not leave a note on that paragraph."
      : "Answered in a note on that paragraph.";
  }

  /** The draft turn: reads the dump and the brief, then writes the one draft. */
  private async draft(sessionId: string, s: DemoSession): Promise<string> {
    const dump = (await this.tool(sessionId, s, "read_source", { name: "dump" })) ?? "";
    const brief = (await this.tool(sessionId, s, "read_source", { name: "brief" })) ?? "";
    const done = await this.tool(sessionId, s, "write_draft", { blocks: demoDraft(dump, brief) });
    return done === undefined ? DRAFT_NOT_WRITTEN : DRAFTED_SAYS;
  }

  /** Asked to write with no draft turn: it tries `write_draft`, and the host refuses. */
  private async unasked(sessionId: string, s: DemoSession): Promise<string> {
    const done = await this.tool(sessionId, s, "write_draft", { blocks: [DEMO_UNASKED] });
    return done === undefined ? WRITE_REFUSED_SAYS : "The host let me write. That should never happen.";
  }

  /** A named pass: what its fixed patterns find, as notes, at most as many as the strictness allows. */
  private async pass(sessionId: string, s: DemoSession, pass: string, strictness: string): Promise<string> {
    const blocks = await this.page(sessionId, s);
    if (!blocks) return EMPTY_PAGE;
    const paras = blocks.filter((b) => !b.startsWith("#"));
    const finds: { anchor: string; kind: string; body: string }[] = [];
    const each = (re: RegExp, kind: string, body: (m: RegExpExecArray) => string) => {
      for (const p of paras)
        for (const m of p.matchAll(re)) finds.push({ anchor: m[0], kind, body: body(m as RegExpExecArray) });
    };
    if (pass === "filler") each(FILLER, "filler", (m) => fillerBody(m[1] ?? ""));
    else if (pass === "passive") each(PASSIVE, "unclear", () => PASSIVE_BODY);
    else if (pass === "typos") each(DOUBLED, "typo", () => TYPO_BODY);
    else if (pass === "repeats") {
      for (const p of paras) {
        const seen = new Set<string>();
        for (const m of p.matchAll(/\b[A-Za-z]{6,}\b(?: [\w'’-]+){0,2}/g)) {
          const word = (/^[A-Za-z]+/.exec(m[0])?.[0] ?? "").toLowerCase();
          if (seen.has(word)) finds.push({ anchor: m[0].trim(), kind: "filler", body: repeatBody(word) });
          seen.add(word);
        }
      }
    } else if (pass === "cut" && paras.length >= 3) {
      finds.push({ anchor: firstSentence(paras.at(-1) as string), kind: "filler", body: CUT_BODY });
    }
    let left = 0;
    for (const f of finds) {
      if (left >= (DEMO_LIMIT[strictness] ?? 2)) break;
      if ((await this.tool(sessionId, s, "comment", { ...f, pass })) !== undefined) left++;
    }
    if (left === 0) return NOTHING;
    return `${left === 1 ? "One note" : `${left} notes`} in the ${pass} pass, at ${strictness}.`;
  }

  /** The answer to `re c09: …`: one resolve_comment, sharpen unless the writer's reply asks to withdraw. */
  private async resolve(sessionId: string, s: DemoSession, id: string, prompt: string): Promise<string> {
    const reply = /^The writer's reply: (.*)$/m.exec(prompt)?.[1] ?? "";
    const withdraw = /\bwithdraw\b/i.test(reply);
    const done = await this.tool(
      sessionId,
      s,
      "resolve_comment",
      withdraw ? { id, action: "withdraw", body: WITHDRAWN } : { id, action: "sharpen", body: SHARPENED },
    );
    if (done === undefined) return `I could not resolve ${id}.`;
    return withdraw ? `${id} withdrawn.` : `${id} v2`;
  }

  /** Streams text a few words at a time, the way a model does. */
  private async say(sessionId: string, text: string): Promise<"end_turn" | "cancelled"> {
    for (const piece of text.match(/\S+\s*/g) ?? []) {
      if (this.cancelled.has(sessionId)) return "cancelled";
      this.update(sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: piece },
      });
      if (this.o.delayMs) await new Promise((r) => setTimeout(r, this.o.delayMs));
    }
    return "end_turn";
  }

  private async prompt(sessionId: string, blocks: Json[]): Promise<Json> {
    const text = blocks
      .filter((b) => b.type === "text")
      .map((b) => String(b.text))
      .join("\n");
    const s = this.sessions.get(sessionId) ?? {
      secret: "",
      cwd: "",
      played: 0,
      editAsked: false,
      quoted: new Set(),
      critiqued: false,
    };
    this.sessions.set(sessionId, s);
    const head = /^<sparring stage="([a-z]+)" pass="([a-z0-9-]*)" strictness="([^"]*)"/m.exec(text);
    const stage = head?.[1];
    const pass = head?.[2] ?? "";
    const strictness = head?.[3] ?? "normal";
    const can = !!this.o.tools && !!s.secret;
    const end = async (said: string) => ({ stopReason: await this.say(sessionId, said) });
    // The notes: a disagreement, the reader, the critique. None of them uses up an interview question.
    const disputed = /^The writer disagrees with your note (c\d+)/m.exec(text)?.[1];
    if (disputed)
      return { stopReason: await this.say(sessionId, await this.resolve(sessionId, s, disputed, text)) };
    if (pass === "reader") {
      if (this.o.tools && s.secret) await this.tool(sessionId, s, "read_source", { name: "brief" });
      return { stopReason: await this.say(sessionId, READER_SAYS) };
    }
    // A named pass comes with its file: `Pass: filler · from passes/filler.md`.
    if (pass && new RegExp(`^Pass: ${pass} · from passes/${pass}\\.md$`, "m").test(text))
      return end(can ? await this.pass(sessionId, s, pass, strictness) : NOTHING);
    if (pass === "sendit") return end(can ? await this.draft(sessionId, s) : DRAFT_NOT_WRITTEN);
    if (pass === "next" && DRAFTED.test(text)) return end(DRAFTED_NEXT_SAYS);
    if (pass === "next") return end(can ? await this.next(sessionId, s) : NO_HEADINGS);
    if (pass === "section") return end(can ? await this.section(sessionId, s) : NOTHING);
    if (pass === "ask") return end(can ? await this.askNote(sessionId, s, text) : NO_PARAGRAPH);
    if (pass === "critique" || stage === "critique") {
      const said = s.critiqued ? NOTHING : await this.critique(sessionId, s);
      return { stopReason: await this.say(sessionId, said) };
    }
    // Asked to write, with no draft turn: the attempt is refused and shown.
    const message = String(blocks.filter((b) => b.type === "text").at(-1)?.text ?? "");
    if (pass === "" && can && WRITE_ASK.test(message)) return end(await this.unasked(sessionId, s));
    if (DRAFTED.test(text) && /^.*leave no notes: comment is refused/m.test(text))
      return end(DRAFTED_QUIET_SAYS);
    // The later stages, each with its own move. None of them uses up an interview question.
    if (stage === "outline") return end(can ? await this.outline(sessionId, s) : NO_HEADINGS);
    if (stage === "draft") return end(DRAFT_SAYS);
    if (stage === "polish") return end(POLISH_SAYS);
    const n = s.played++;
    if (stage === "interview") await this.interviewTools(sessionId, s, n);
    if (this.cancelled.has(sessionId)) return { stopReason: "cancelled" };
    const move = this.script[Math.min(n, this.script.length - 1)] as Move;
    return { stopReason: await move(sessionId, text) };
  }

  private async handle(m: Json): Promise<void> {
    const id = m.id as number | string | undefined;
    const p = (m.params ?? {}) as Json;
    const reply = (result: Json) => this.out({ id, result });
    switch (m.method) {
      case "initialize":
        return reply({
          protocolVersion: 1,
          agentCapabilities: {
            loadSession: false,
            promptCapabilities: { image: false, embeddedContext: false },
          },
          authMethods: [],
        });
      case "session/new": {
        const sessionId = `demo-${++this.seq}`;
        const servers = (Array.isArray(p.mcpServers) ? p.mcpServers : []) as Json[];
        const env = (servers.find((x) => x.name === "sparring")?.env ?? []) as {
          name: string;
          value: string;
        }[];
        const secret = env.find((e) => e.name === "SPARRING_MCP_SECRET")?.value ?? "";
        this.sessions.set(sessionId, {
          secret,
          cwd: String(p.cwd ?? ""),
          played: 0,
          editAsked: false,
          quoted: new Set(),
          critiqued: false,
        });
        return reply({ sessionId, modes: MODES });
      }
      case "session/set_mode":
        if (p.modeId !== "default")
          return this.out({ id, error: { code: -32602, message: `no mode ${String(p.modeId)}` } });
        return reply({});
      case "session/prompt": {
        const sessionId = String(p.sessionId);
        this.cancelled.delete(sessionId);
        try {
          const result = await this.prompt(sessionId, (p.prompt ?? []) as Json[]);
          reply(this.cancelled.delete(sessionId) ? { stopReason: "cancelled" } : result);
        } catch (e) {
          this.out({ id, error: { code: -32603, message: e instanceof Error ? e.message : String(e) } });
        }
        return;
      }
      case "session/cancel":
        this.cancelled.add(String(p.sessionId));
        return;
      default:
        if (id !== undefined)
          this.out({ id, error: { code: -32601, message: `unknown method ${String(m.method)}` } });
    }
  }

  asProcess(): AgentProcess {
    return {
      stdin: this.stdin,
      stdout: this.stdout,
      stderr: this.stderr,
      kill: () => this.die(null),
      exited: this.exited,
    };
  }
}

/** The host's words for a drafted article, in a prompt. */
const DRAFTED = /This article is drafted and the review is the writer's alone\./;

/** The first sentence of a paragraph, the anchor of a note about the whole of it. */
const firstSentence = (b: string) => (/^[^.!?\n]+[.!?]?/.exec(b)?.[0] ?? b).trim();

/** The launch for the `demo` provider: every article's coach is a fresh scripted one. */
export const demoLaunch =
  (o: DemoOptions = { delayMs: 30 }): Launch =>
  () =>
    new DemoCoach(o).asProcess();
