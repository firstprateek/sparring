// The scripted coach, the `demo` provider: a small ACP agent that runs inside the daemon over in-memory streams,
// with no process, no network and no tokens. It speaks ACP to the daemon exactly as an adapter does, so its
// turns go through the same acp-connection and acp-mapper path as a real coach's. Each prompt plays the next move
// of its script; a move streams its reply as agent_message_chunk updates and ends the turn. The script is the
// interview: one question per turn, from a fixed list, then a line saying there are no more.
import { PassThrough } from "node:stream";
import type { AgentProcess, Launch } from "./ahp/agent-process.ts";

type Json = Record<string, unknown>;

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
  private readonly cancelled = new Set<string>();
  /** How far each ACP session is into the script. */
  private readonly played = new Map<string, number>();
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
    this.finish(code);
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
    const n = this.played.get(sessionId) ?? 0;
    this.played.set(sessionId, n + 1);
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
