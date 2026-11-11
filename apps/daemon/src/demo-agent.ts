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
    };
    this.sessions.set(sessionId, s);
    const n = s.played++;
    const stage = /^<sparring stage="([a-z]+)"/m.exec(text)?.[1];
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

/** The launch for the `demo` provider: every article's coach is a fresh scripted one. */
export const demoLaunch =
  (o: DemoOptions = { delayMs: 30 }): Launch =>
  () =>
    new DemoCoach(o).asProcess();
