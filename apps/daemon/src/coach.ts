// The coach: the AgentBackend behind every article's AHP session (design section 3).
//
// One session `ahp-session:/<articleId>` and one chat per article. The session's config is the host's own, three
// keys with no agent running: stage, pass and strictness. Its `_meta.sparring` is `metaFor(article)`, pushed with
// `session/metaChanged` whenever it changes (a stage at once, saves and commits debounced).
//
// A client turn first meets its slash command, if the host read one: `/stage`, `/offline`, `/idea` and the
// client-only commands are answered with a host line and start no agent. Anything else goes to the article's
// coach, an ACP agent started on the first prompt (the pinned claude adapter, or the scripted coach for `demo`)
// and spoken to through acp-connection and acp-mapper. Every permission request it makes is answered by
// policy.ts. Each turn has a `turns` row, a turn-start commit, a 10-minute limit and the tripwire; a child idle
// for 15 minutes is let go, and a new child's first prompt opens with the continuation brief.
import {
  type AgentInfo,
  AhpErrorCodes,
  JsonRpcErrorCodes,
  type SessionConfigState,
} from "@microsoft/agent-host-protocol";
import { wordCount } from "@sparring/protocol/blocks";
import { STAGES, STRICTNESS, type Stage } from "@sparring/protocol/commands";
import { META_KEY } from "@sparring/protocol/meta";
import { AcpConnection, EXITED, type RpcReply, TIMED_OUT } from "./ahp/acp-connection.ts";
import { promptBlocks, TurnMapper } from "./ahp/acp-mapper.ts";
import type { Launch } from "./ahp/agent-process.ts";
import type {
  AgentBackend,
  OpenedSession,
  OpenSessionRequest,
  ParsedCommand,
  TurnOutcome,
  TurnRun,
} from "./ahp/backend.ts";
import { type AhpHost, RpcError } from "./ahp/host.ts";
import { ActionType, type Json, ResponsePartKind } from "./ahp/wire.ts";
import { type ArticleRow, type Articles, HttpError, sessionUri, type TurnStatus } from "./articles.ts";
import { DISALLOWED_TOOLS, killRecordedGroups } from "./claude.ts";
import { type Decision, decide, SPARRING_PREFIX } from "./policy.ts";
import {
  articleBlock,
  continuationBrief,
  header,
  type PastTurn,
  PROMPTS_DIR,
  rulesText,
  stagePrompt,
} from "./prompt.ts";
import { type Tools, WRITE_REFUSED } from "./tools.ts";

export type Provider = "claude" | "demo";
export const PROVIDERS: readonly Provider[] = ["demo", "claude"];

/** The kinds of host line, in the SystemNotification part's `_meta`. */
export type LineKind = "stage" | "refused" | "mode" | "divider";
export const LINE_META = "sparring.line";

export const signInLine = (provider: string) => `sign-in needed · ${provider}`;
export const INTERRUPTED = "the coach was interrupted · ask again";
export const QUARANTINED = "article.md changed outside a save · quarantined as article.agent.md · restore it";
export const MODE_REFUSED = "engine refused ask mode";
export const OFFLINE_ON = "offline · no coach for this article";
export const OFFLINE_OFF = "online · the coach starts on your next message";
export const OFFLINE_TURN = "offline · /offline brings the coach back";

const SESSION_PREFIX = "ahp-session:/";
const TURN_LIMIT_MS = 10 * 60_000;
const IDLE_MS = 15 * 60_000;
const HANDSHAKE_MS = 60_000;
const PASS_RE = /^[a-z0-9-]{0,40}$/;
/** The JSON-RPC error a prompt fails with when the engine has no credential (probe, 0.101.0). */
const AUTH_REQUIRED = -32000;

/** The `_meta` of `session/new`: zero built-in tools, no project or local settings, only the Sparring MCP server. */
export const SESSION_META = {
  disableBuiltInTools: true,
  claudeCode: {
    options: {
      tools: [],
      allowDangerouslySkipPermissions: false,
      disallowedTools: DISALLOWED_TOOLS,
      settingSources: ["user"],
      strictMcpConfig: true,
    },
  },
};

export interface CoachOptions {
  articles: Articles;
  /** The MCP tool handlers; the coach issues each ACP session its secret. */
  tools: Tools;
  /** How each provider's agent starts. A provider without one starts nothing. */
  launches: Partial<Record<Provider, Launch>>;
  /** The Sparring MCP server for `session/new`: the socket and the proxy script (run by `process.execPath`). */
  mcp?: { sock: string; server?: string; command?: string };
  /** Saves and commits reach `_meta.sparring` at most this often (ms). */
  metaDebounceMs?: number;
  /** The hard limit of one turn (ms): then `session/cancel`, then the group is killed. */
  turnLimitMs?: number;
  /** A child with no turn and an empty queue this long after its last turn is let go (ms). */
  idleMs?: number;
  /** `~/.sparring/run`: on start every group recorded there is killed. */
  runDir?: string;
  /** Where RULES.md and stages/*.md are. */
  promptsDir?: string;
  /** The `clientInfo.version` sent in `initialize`. */
  version?: string;
  log?: (m: string) => void;
}

/** The turn a live coach is working on. */
interface Turn {
  turnId: string;
  /** Everything the coach said in it. */
  text: string;
  violation: boolean;
  /** The mode the agent moved to, when it left `default` mid-turn. */
  modeLeft?: string;
}

/** An article's running agent. */
interface Live {
  conn: AcpConnection;
  sessionId: string;
  caps: Json;
  secret: string;
  /** The rules went in `systemPrompt`; otherwise they open the first prompt. */
  systemPrompt: boolean;
  /** Has it had a prompt yet? The first one carries the continuation brief. */
  prompted: boolean;
  mapper: TurnMapper | undefined;
  turn: Turn | undefined;
  /** When its last turn ended (or it started), for the idle kill. */
  lastEnded: number;
}

class StartError extends Error {
  constructor(
    readonly kind: "signin" | "mode",
    message: string,
  ) {
    super(message);
  }
}

/** The session config: three host-owned keys, built with no agent running and fixed at creation. */
export function configFor(row: ArticleRow): SessionConfigState {
  return {
    schema: {
      type: "object",
      properties: {
        stage: { type: "string", title: "Stage", sessionMutable: true, enum: [...STAGES] },
        pass: { type: "string", title: "Pass", description: "a pass name, or empty", sessionMutable: true },
        strictness: { type: "string", title: "Strictness", sessionMutable: true, enum: [...STRICTNESS] },
      },
    },
    values: { stage: row.stage, pass: "", strictness: row.strictness },
  };
}

const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export class Coach implements AgentBackend {
  private host: AhpHost | undefined;
  private readonly live = new Map<string, Promise<Live>>();
  /** The same agents, once started. */
  private readonly started = new Map<string, Live>();
  /** Articles with a coach turn running: `_meta.sparring.run`. */
  private readonly runs = new Map<string, { pass: string; startedAt: string }>();
  /** Providers whose engine answered -32000: their articles behave as if offline until /offline is toggled. */
  private readonly signedOut = new Set<string>();
  private readonly metaTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private sweeper: ReturnType<typeof setInterval> | undefined;
  private readonly log: (m: string) => void;

  constructor(private readonly o: CoachOptions) {
    this.log = o.log ?? (() => {});
  }

  private get h(): AhpHost {
    if (!this.host) throw new Error("the coach is not attached to a host");
    return this.host;
  }

  private get articles(): Articles {
    return this.o.articles;
  }

  // ───────────────────────────── wiring ─────────────────────────────

  attach(host: AhpHost): void {
    this.host = host;
    host.hooks.onCreateSession = (p) => this.createFromClient(p);
    host.hooks.canDisposeSession = () => false;
    this.articles.onCreated = (row) => this.open(row);
    this.articles.onChanged = (row) => this.metaSoon(row.id);
    this.articles.metaExtra = (row) => ({
      run: this.runs.get(row.id) ?? null,
      ...(this.signedOut.has(row.provider) ? { offline: true, signInNeeded: true } : {}),
    });
    this.o.tools.hooks = {
      ownerMessages: (id) => this.ownerMessages(id),
      refused: (id, text) => this.refused(id, text),
      changed: (id) => this.pushMeta(id),
    };
  }

  /**
   * At daemon start: the groups a dead daemon left are killed, every article gets its session and chat if it
   * lacks them, a turn that was running is marked interrupted with its host line, and the meta is fresh.
   */
  async start(): Promise<void> {
    if (this.o.runDir) killRecordedGroups(this.o.runDir, this.log);
    const interrupted = new Set(this.articles.interruptRunning());
    for (const row of this.articles.all()) {
      try {
        await this.open(row);
        const chat = this.articles.byId(row.id)?.chat;
        if (interrupted.has(row.id) && chat) {
          this.articles.addLetter(row.id, "interrupted", INTERRUPTED);
          this.line(row, chat, INTERRUPTED, "divider");
        }
        this.pushMeta(row.id);
      } catch (e) {
        this.log(`coach: no session for ${row.slug}: ${e instanceof Error ? e.message : e}`);
      }
    }
  }

  /** Every `everyMs`, lets go of the children that have been idle for `idleMs`. */
  startSweep(everyMs = 60_000): void {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => this.sweep(), everyMs);
    this.sweeper.unref?.();
  }

  /** Makes the article's session and chat, unless they exist; the row keeps the chat. */
  async open(row: ArticleRow): Promise<void> {
    const session = sessionUri(row.id);
    if (this.h.hasChannel(session)) {
      const chat = this.h.sessionState(session)?.defaultChat;
      if (chat && row.chat !== chat) this.articles.setChat(row.id, chat);
      return;
    }
    const { chat } = await this.h.createSession({ session, provider: row.provider, title: row.slug });
    this.articles.setChat(row.id, chat);
  }

  /**
   * `createSession` from an AHP client: `channel` is `ahp-session:/<uuid>` and `_meta.slug` the article's slug.
   * The article is made as `POST /api/articles` makes it, with that uuid as its id.
   */
  private async createFromClient(p: Json): Promise<void> {
    const invalid = (m: string) => new RpcError(JsonRpcErrorCodes.InvalidParams, m);
    const session = typeof p.channel === "string" ? p.channel : "";
    const id = session.startsWith(SESSION_PREFIX) ? session.slice(SESSION_PREFIX.length) : "";
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id))
      throw invalid("the session must be ahp-session:/<uuid>");
    const slug = isObj(p._meta) && typeof p._meta.slug === "string" ? p._meta.slug : "";
    if (!slug) throw invalid("createSession needs the article's slug in _meta.slug");
    const provider = p.provider === undefined ? undefined : String(p.provider);
    if (provider !== undefined && !PROVIDERS.includes(provider as Provider))
      throw new RpcError(AhpErrorCodes.ProviderNotFound, `no agent for provider ${provider}`);
    if (p.config !== undefined) throw invalid("set stage, pass and strictness with session/configChanged");
    if (this.articles.byId(id))
      throw new RpcError(AhpErrorCodes.SessionAlreadyExists, "session already exists");
    try {
      await this.articles.create(slug, provider, id);
    } catch (e) {
      if (e instanceof HttpError) throw invalid(e.message);
      throw e;
    }
  }

  private articleOfSession(session: string): ArticleRow | undefined {
    return session.startsWith(SESSION_PREFIX)
      ? this.articles.byId(session.slice(SESSION_PREFIX.length))
      : undefined;
  }

  // ───────────────────────────── AgentBackend ─────────────────────────────

  agents(): AgentInfo[] {
    return [
      {
        provider: "demo",
        displayName: "scripted coach",
        description: "Asks the interview from a script; spends no tokens",
        models: [],
      },
      {
        provider: "claude",
        displayName: "claude",
        description: "claude-agent-acp, pinned",
        models: [],
      },
    ];
  }

  async openSession(req: OpenSessionRequest): Promise<OpenedSession> {
    const row = this.articleOfSession(req.session);
    if (!row) throw new Error(`no article for ${req.session}`);
    return { title: row.slug, config: configFor(row), meta: { [META_KEY]: this.articles.metaFor(row) } };
  }

  async closeSession(session: string): Promise<void> {
    const row = this.articleOfSession(session);
    if (row) await this.stopAgent(row.id);
  }

  async runTurn(run: TurnRun): Promise<TurnOutcome> {
    const row = this.articleOfSession(run.session);
    if (!row) return { kind: "error", errorType: "no_article", message: "this session has no article" };
    if (run.command && (await this.hostCommand(row, run.chat, run.command))) return { kind: "complete" };
    if (Number(row.offline ?? 0) === 1) {
      this.line(row, run.chat, OFFLINE_TURN, "mode");
      return { kind: "complete" };
    }
    if (this.signedOut.has(row.provider)) {
      this.line(row, run.chat, signInLine(row.provider), "mode");
      return { kind: "complete" };
    }
    const launch = this.o.launches[row.provider as Provider];
    if (!launch) {
      this.line(row, run.chat, `no coach for ${row.provider}`);
      return { kind: "complete" };
    }
    return this.coachTurn(row, run, launch);
  }

  /** Every confirmation is answered by the host's policy, never left to a client: nothing waits here. */
  answerToolCall(): void {}

  /** stage, pass and strictness, which the host applied already: the article follows, or the host puts them back. */
  async setConfig(session: string, values: Json): Promise<void> {
    const row = this.articleOfSession(session);
    if (!row) throw new Error(`no article for ${session}`);
    for (const [k, v] of Object.entries(values)) {
      if (k === "stage" && !STAGES.includes(v as Stage)) throw new Error(`${String(v)} is not a stage`);
      else if (k === "strictness" && !STRICTNESS.includes(v as (typeof STRICTNESS)[number]))
        throw new Error(`${String(v)} is not a strictness`);
      else if (k === "pass" && (typeof v !== "string" || !PASS_RE.test(v)))
        throw new Error("a pass is a pass name, or empty");
      else if (k !== "stage" && k !== "strictness" && k !== "pass") throw new Error(`unknown config ${k}`);
    }
    if (typeof values.strictness === "string") this.articles.setStrictness(row.id, values.strictness);
    if (typeof values.stage === "string") this.stage(row, values.stage as Stage, false);
    else this.pushMeta(row.id);
  }

  // ───────────────────────────── host-only input ─────────────────────────────

  /** A command the host answers itself, with one host line and no agent. False: it goes to the coach as text. */
  private async hostCommand(
    row: ArticleRow,
    chat: string,
    { command, rest }: ParsedCommand,
  ): Promise<boolean> {
    switch (command.name) {
      case "stage": {
        const stage = STAGES.find((s) => s === rest);
        if (stage) this.stage(row, stage, true, chat);
        else this.line(row, chat, `no stage "${rest.slice(0, 40)}" · ${STAGES.join(" ")}`);
        return true;
      }
      case "offline": {
        const on = Number(row.offline ?? 0) !== 1;
        this.articles.setOffline(row.id, on);
        if (on) await this.stopAgent(row.id);
        // Back online is also how a sign-in is tried again.
        else this.signedOut.delete(row.provider);
        this.line(row, chat, on ? OFFLINE_ON : OFFLINE_OFF, "mode");
        return true;
      }
      case "idea": {
        if (!rest.trim()) {
          this.line(row, chat, "nothing to add · /idea <text>");
          return true;
        }
        try {
          await this.articles.addIdea(rest);
          this.line(row, chat, "idea added to inbox.md", "divider");
        } catch (e) {
          this.line(row, chat, `idea not added · ${e instanceof Error ? e.message : e}`);
        }
        return true;
      }
    }
    if (command.kind === "client") {
      this.line(row, chat, `/${command.name} opens in the web client · nothing changed`);
      return true;
    }
    return false;
  }

  /**
   * Moves the article to a stage: the row, the session's config (unless a client's `session/configChanged` set it
   * already), the host line `stage <name>` and the meta.
   */
  private stage(row: ArticleRow, stage: Stage, setConfig: boolean, chat = row.chat): void {
    this.articles.setStage(row.id, stage);
    if (setConfig)
      this.h.apply(sessionUri(row.id), { type: ActionType.SessionConfigChanged, config: { stage } });
    if (chat) this.line(row, chat, `stage ${stage}`, "stage");
    else this.pushMeta(row.id);
  }

  /** A host line in the article's chat: into the running turn, or a turn of its own. It is the row's last line. */
  line(row: ArticleRow, chat: string, text: string, kind: LineKind = "refused"): void {
    this.articles.setLastLine(row.id, text);
    this.h.hostLine(chat, text, { [LINE_META]: kind });
    this.pushMeta(row.id);
  }

  /** A write or tool the coach was refused: the turn's violation, the letter line and a host line. */
  private refused(articleId: string, text: string): void {
    const live = this.started.get(articleId);
    if (live?.turn) live.turn.violation = true;
    this.articles.addLetter(articleId, "refused", text);
    const row = this.articles.byId(articleId);
    if (row?.chat) this.line(row, row.chat, text, "refused");
    else this.pushMeta(articleId);
  }

  /** Every message the owner sent in the article's chat, the running turn's included. note_brief quotes these. */
  private ownerMessages(articleId: string): string[] {
    const chat = this.articles.byId(articleId)?.chat;
    const st = chat ? this.host?.chatState(chat) : undefined;
    if (!st) return [];
    const msgs = [...st.turns.map((t) => t.message), ...(st.activeTurn ? [st.activeTurn.message] : [])];
    return msgs.filter((m) => m.origin?.kind === "user" && m.text).map((m) => m.text);
  }

  // ───────────────────────────── meta ─────────────────────────────

  /** Sends the article's `_meta.sparring` now, if it changed, merged into the session's `_meta`. */
  pushMeta(articleId: string): void {
    const timer = this.metaTimers.get(articleId);
    if (timer) clearTimeout(timer);
    this.metaTimers.delete(articleId);
    const row = this.articles.byId(articleId);
    const session = sessionUri(articleId);
    const state = this.host?.sessionState(session);
    if (!row || !state) return;
    const meta = this.articles.metaFor(row);
    const current = state._meta ?? {};
    if (JSON.stringify(current[META_KEY]) === JSON.stringify(meta)) return;
    this.h.apply(session, { type: ActionType.SessionMetaChanged, _meta: { ...current, [META_KEY]: meta } });
  }

  /** The same, after the debounce: saves and commits come often. */
  metaSoon(articleId: string): void {
    if (this.metaTimers.has(articleId)) return;
    const timer = setTimeout(() => this.pushMeta(articleId), this.o.metaDebounceMs ?? 2000);
    timer.unref?.();
    this.metaTimers.set(articleId, timer);
  }

  // ───────────────────────────── a coach turn ─────────────────────────────

  /**
   * One turn that goes to the coach: the turn-start commit and the `turns` row, the agent (started if need be),
   * the prompt, and afterwards the tripwire, the tokens, the open question and the row's status.
   */
  private async coachTurn(row: ArticleRow, run: TurnRun, launch: Launch): Promise<TurnOutcome> {
    let commitBefore: string;
    let before: string;
    try {
      commitBefore = await this.articles.turnCommit(row.slug);
      before = await this.articles.diskSha(row.slug);
    } catch (e) {
      return { kind: "error", errorType: "git", message: `the turn-start commit failed: ${errText(e)}` };
    }
    const pass = this.passOf(row);
    this.articles.turnStarted({
      turnId: run.turnId,
      articleId: row.id,
      origin: "writer",
      stage: row.stage,
      pass,
      commitBefore,
    });
    this.runs.set(row.id, { pass, startedAt: new Date().toISOString() });
    this.pushMeta(row.id);
    const turn: Turn = { turnId: run.turnId, text: "", violation: false };
    let status: TurnStatus = "failed";
    let live: Live | undefined;
    try {
      try {
        live = await this.agent(row, launch);
      } catch (e) {
        return this.startFailed(row, run.chat, e);
      }
      live.turn = turn;
      const blocks = await this.promptFor(row, live, run, commitBefore);
      const sent = await this.send(row, live, run, blocks, turn);
      status = sent.status;
      return sent.outcome;
    } catch (e) {
      return { kind: "error", errorType: "host_error", message: errText(e) };
    } finally {
      if (live) {
        live.turn = undefined;
        live.mapper = undefined;
        live.lastEnded = Date.now();
      }
      await this.tripwire(row, run.chat, before, commitBefore, turn).catch((e: unknown) =>
        this.log(`tripwire ${row.slug}: ${errText(e)}`),
      );
      const said = turn.text.trim();
      if (status === "done") this.articles.setOpenQuestion(row.id, said.endsWith("?") ? said : null);
      this.articles.turnEnded(run.turnId, status, said.endsWith("?"), turn.violation);
      this.runs.delete(row.id);
      this.pushMeta(row.id);
    }
  }

  /** The pass the session's config names, or "". */
  private passOf(row: ArticleRow): string {
    const v = this.host?.sessionState(sessionUri(row.id))?.config?.values.pass;
    return typeof v === "string" && PASS_RE.test(v) ? v : "";
  }

  /** The agent did not start: a sign-in or a mode refusal is a host line; anything else is the turn's error. */
  private startFailed(row: ArticleRow, chat: string, e: unknown): TurnOutcome {
    if (e instanceof StartError && e.kind === "signin") {
      this.signedOut.add(row.provider);
      this.line(row, chat, signInLine(row.provider), "mode");
      return { kind: "complete" };
    }
    if (e instanceof StartError && e.kind === "mode") {
      this.line(row, chat, MODE_REFUSED, "mode");
      return { kind: "complete" };
    }
    return { kind: "error", errorType: "agent_start", message: `the coach did not start: ${errText(e)}` };
  }

  /**
   * The `session/prompt` blocks, in the design's order: (the rules, when `systemPrompt` was not offered, and the
   * continuation brief, on a new child's first prompt), the header, the stage prompt, the pass prompt, article.md
   * since the coach last saw it, the message.
   */
  private async promptFor(row: ArticleRow, live: Live, run: TurnRun, commitBefore: string): Promise<Json[]> {
    const fresh = this.articles.byId(row.id) ?? row;
    const blocks: Json[] = [];
    const text = (t: string) => blocks.push({ type: "text", text: t });
    const open = this.articles.openCommentIds(row.id);
    if (!live.prompted) {
      if (!live.systemPrompt) text(rulesText(await this.articles.style(), this.o.promptsDir ?? PROMPTS_DIR));
      const brief = await this.continuation(fresh, run.turnId, open);
      if (brief) text(brief);
      live.prompted = true;
    }
    const article = await this.articles.read(row.slug, "article");
    const words = wordCount(article);
    const pass = this.passOf(row);
    text(
      header({
        stage: fresh.stage,
        pass,
        strictness: fresh.strictness,
        words,
        commit: commitBefore,
        openComments: open,
      }),
    );
    const stage = stagePrompt(fresh.stage, this.o.promptsDir ?? PROMPTS_DIR);
    if (stage) text(stage);
    if (pass) {
      const p = await this.articles.pass(pass);
      if (p) text(`The pass is ${pass}:\n${p.trim()}`);
    }
    const seen = typeof fresh.agent_seen_commit === "string" ? fresh.agent_seen_commit : null;
    const diff =
      seen && seen !== commitBefore ? await this.articles.articleDiff(row.slug, seen, commitBefore) : "";
    text(articleBlock({ seen, commit: commitBefore, text: article, words, diff }));
    this.articles.setAgentSeen(row.id, commitBefore);
    blocks.push(...promptBlocks(run.message, live.caps));
    return blocks;
  }

  /** The continuation brief for a new child: from the `turns` rows and the chat that holds their words. */
  private async continuation(row: ArticleRow, turnId: string, open: string[]): Promise<string> {
    const rows = this.articles.coachTurns(row.id, turnId);
    if (rows.length === 0 || !row.chat) return "";
    const chat = this.h.chatState(row.chat);
    const byId = new Map((chat?.turns ?? []).map((t) => [t.id, t]));
    const turns: PastTurn[] = [];
    for (const r of rows) {
      const t = byId.get(r.turn_id);
      if (!t) continue;
      const coach = t.responseParts
        .map((p) => (p.kind === ResponsePartKind.Markdown ? p.content : ""))
        .join("")
        .trim();
      turns.push({ stage: r.stage, writer: t.message.text, coach });
    }
    return continuationBrief({
      stage: row.stage,
      brief: await this.articles.read(row.slug, "brief"),
      style: await this.articles.style(),
      openComments: open,
      turns,
    });
  }

  /** Sends the prompt and reads how it ended. */
  private async send(
    row: ArticleRow,
    live: Live,
    run: TurnRun,
    blocks: Json[],
    turn: Turn,
  ): Promise<{ outcome: TurnOutcome; status: TurnStatus }> {
    const mapper = new TurnMapper({
      turnId: run.turnId,
      emit: (a) => run.emit(a),
      put: (data, mime) => this.h.putContent(data, mime),
      side: (kind, u) => this.side(row, kind, u),
    });
    live.mapper = mapper;
    const cancel = () => live.conn.notify("session/cancel", { sessionId: live.sessionId });
    run.signal.addEventListener("abort", cancel, { once: true });
    try {
      const reply: RpcReply = await live.conn.request(
        "session/prompt",
        { sessionId: live.sessionId, prompt: blocks },
        this.o.turnLimitMs ?? TURN_LIMIT_MS,
      );
      mapper.finish();
      if (run.signal.aborted) return { outcome: { kind: "cancelled" }, status: "interrupted" };
      if (turn.modeLeft !== undefined) return { outcome: { kind: "complete" }, status: "failed" };
      if (reply.error) {
        const code = reply.error.code;
        if (code === AUTH_REQUIRED) {
          this.signedOut.add(row.provider);
          await this.stopAgent(row.id, true);
          this.line(row, run.chat, signInLine(row.provider), "mode");
          return { outcome: { kind: "complete" }, status: "failed" };
        }
        if (code === TIMED_OUT) {
          cancel();
          await this.stopAgent(row.id, true);
          const mins = Math.round((this.o.turnLimitMs ?? TURN_LIMIT_MS) / 60_000);
          return {
            outcome: {
              kind: "error",
              errorType: "agent_timeout",
              message: `the coach ran past ${mins} minutes · stopped`,
            },
            status: "failed",
          };
        }
        return {
          outcome: {
            kind: "error",
            errorType: code === EXITED ? "agent_exited" : "agent_error",
            message:
              code === EXITED ? "the coach stopped · ask again" : (reply.error.message ?? "the coach failed"),
          },
          status: "failed",
        };
      }
      this.usage(row, run, reply.result ?? {});
      if (reply.result?.stopReason === "cancelled")
        return { outcome: { kind: "cancelled" }, status: "interrupted" };
      return { outcome: { kind: "complete" }, status: "done" };
    } finally {
      run.signal.removeEventListener("abort", cancel);
    }
  }

  /** Tokens from the prompt's usage: summed into the article's two columns, and the turn's `chat/usage`. */
  private usage(row: ArticleRow, run: TurnRun, result: Json): void {
    const u = isObj(result.usage)
      ? result.usage
      : isObj(result._meta) && isObj(result._meta.usage)
        ? result._meta.usage
        : undefined;
    if (!u) return;
    const cacheRead = num(u.cachedReadTokens) + num(u.cacheReadTokens);
    const input = num(u.inputTokens) + cacheRead + num(u.cachedWriteTokens);
    const output = num(u.outputTokens);
    if (input + output === 0) return;
    this.articles.addTokens(row.id, input, output);
    run.emit({
      type: ActionType.ChatUsage,
      turnId: run.turnId,
      usage: {
        inputTokens: input,
        outputTokens: output,
        ...(cacheRead ? { cacheReadTokens: cacheRead } : {}),
      },
    } as never);
  }

  /**
   * The tripwire: article.md hashed before and after the turn. A change no recorded save explains is committed to
   * `refs/sparring/quarantine/<slug>`, the page is restored from the turn-start commit, and the letter says so.
   */
  private async tripwire(row: ArticleRow, chat: string, before: string, commitBefore: string, turn: Turn) {
    const after = await this.articles.diskSha(row.slug);
    if (after === before) return;
    // A save during the turn is recorded: the row's sha is what is on disk.
    if (this.articles.byId(row.id)?.article_sha === after) return;
    const kept = await this.articles.quarantine(row.slug, commitBefore);
    turn.violation = true;
    this.log(
      `tripwire ${row.slug}: article.md changed outside a save · kept at ${kept.slice(0, 7)}, restored`,
    );
    this.articles.addLetter(row.id, "quarantine", QUARANTINED);
    this.line(row, chat, QUARANTINED, "refused");
  }

  // ───────────────────────────── the agent ─────────────────────────────

  /** The article's agent, started (and its ACP session made) on first use, or again after it exited. */
  private async agent(row: ArticleRow, launch: Launch): Promise<Live> {
    const have = this.live.get(row.id);
    if (have) {
      const l = await have.catch(() => undefined);
      if (l && !l.conn.exited) return l;
    }
    const starting = this.startAgent(row, launch);
    this.live.set(row.id, starting);
    starting.catch(() => {
      if (this.live.get(row.id) === starting) this.live.delete(row.id);
    });
    return starting;
  }

  /** The MCP server entry of `session/new`: a stdio entry has no `type` key, and `env` is a list. */
  private mcpEntry(secret: string): Json {
    const server =
      this.o.mcp?.server ?? new URL("../../../packages/mcp/src/server.ts", import.meta.url).pathname;
    return {
      name: "sparring",
      command: this.o.mcp?.command ?? process.execPath,
      args: [server],
      env: [
        { name: "SPARRING_MCP_SOCK", value: this.o.mcp?.sock ?? "" },
        { name: "SPARRING_MCP_SECRET", value: secret },
      ],
    };
  }

  /** Spawns the agent and runs the handshake: initialize, session/new, the mode check. */
  private async startAgent(row: ArticleRow, launch: Launch): Promise<Live> {
    const cwd = this.articles.folder(row.slug);
    const secret = this.o.tools.issue(row.id);
    let conn: AcpConnection | undefined;
    try {
      const proc = await launch({ articleId: row.id, cwd, env: {} });
      const c = new AcpConnection(proc, this.log);
      conn = c;
      const live: Live = {
        conn: c,
        sessionId: "",
        caps: {},
        secret,
        systemPrompt: false,
        prompted: false,
        mapper: undefined,
        turn: undefined,
        lastEnded: Date.now(),
      };
      c.onNotification = (method, params) => {
        if (method !== "session/update" || params.sessionId !== live.sessionId || !isObj(params.update))
          return;
        const u = params.update;
        if (
          u.sessionUpdate === "agent_message_chunk" &&
          isObj(u.content) &&
          u.content.type === "text" &&
          live.turn
        )
          live.turn.text += String(u.content.text ?? "");
        // A Sparring tool shows by its own name: `note_brief`, not `mcp__sparring__note_brief`.
        if (typeof u.title === "string" && u.title.startsWith(SPARRING_PREFIX))
          u.title = u.title.slice(SPARRING_PREFIX.length);
        live.mapper?.update(u);
      };
      c.onRequest = (method, params) => this.onAgentRequest(row.id, method, params);
      c.onExit = (code) => {
        this.o.tools.revoke(secret);
        if (this.started.get(row.id) === live) {
          this.started.delete(row.id);
          this.live.delete(row.id);
        }
        this.log(`coach ${row.slug}: the agent exited (${code ?? "killed"})`);
      };
      const init = await c.request(
        "initialize",
        {
          protocolVersion: 1,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
          clientInfo: { name: "sparring", version: this.o.version ?? "0.0.0" },
        },
        HANDSHAKE_MS,
      );
      if (init.error) throw new Error(init.error.message ?? "initialize failed");
      live.caps = isObj(init.result?.agentCapabilities) ? init.result.agentCapabilities : {};
      const sessionCaps = isObj(live.caps.sessionCapabilities)
        ? live.caps.sessionCapabilities
        : isObj(init.result?.sessionCapabilities)
          ? init.result.sessionCapabilities
          : {};
      const params: Json = { cwd, mcpServers: [this.mcpEntry(secret)], _meta: SESSION_META };
      if (isObj(sessionCaps.systemPrompt)) {
        const rules = rulesText(await this.articles.style(), this.o.promptsDir ?? PROMPTS_DIR);
        params.systemPrompt = { mode: "append", content: [{ type: "text", text: rules }] };
        live.systemPrompt = true;
      }
      const made = await c.request("session/new", params, HANDSHAKE_MS);
      if (made.error?.code === AUTH_REQUIRED)
        throw new StartError("signin", made.error.message ?? "sign-in needed");
      const sessionId = made.result?.sessionId;
      if (made.error || typeof sessionId !== "string")
        throw new Error(made.error?.message ?? "session/new gave no session id");
      live.sessionId = sessionId;
      const modes = isObj(made.result?.modes) ? made.result.modes : undefined;
      const mode = modes?.currentModeId;
      if (mode !== undefined && mode !== "default") {
        const set = await c.request("session/set_mode", { sessionId, modeId: "default" }, HANDSHAKE_MS);
        if (set.error) throw new StartError("mode", MODE_REFUSED);
      }
      // A new child has seen nothing of the page.
      this.articles.setAgentSeen(row.id, null);
      this.started.set(row.id, live);
      return live;
    } catch (e) {
      this.o.tools.revoke(secret);
      conn?.kill();
      throw e;
    }
  }

  /**
   * Every request the agent makes of the daemon. A permission request is answered by policy.ts; anything else is
   * answered with -32601 by the connection.
   */
  private async onAgentRequest(articleId: string, method: string, params: Json): Promise<unknown> {
    if (method !== "session/request_permission") throw new Error(`not offered: ${method}`);
    const d = decide(params, { grantLive: false });
    const row = this.articles.byId(articleId);
    this.log(`policy ${row?.slug ?? articleId}: ${d.title.slice(0, 80)} → ${d.picked}`);
    if (!d.allowed) this.refused(articleId, refusalLine(d, params));
    return d.result;
  }

  /** ACP updates that are not chat actions (modes, config, commands, usage). The host owns all three keys. */
  private side(row: ArticleRow, kind: string, update: Json): void {
    if (kind === "current_mode_update") {
      const mode = update.currentModeId;
      const live = this.started.get(row.id);
      if (mode === "default" || !live) return;
      // A mode away from `default` is a violation: the host sets it back and ends the turn.
      this.log(`coach ${row.slug}: the agent moved to mode ${String(mode)}`);
      void live.conn.request(
        "session/set_mode",
        { sessionId: live.sessionId, modeId: "default" },
        HANDSHAKE_MS,
      );
      if (live.turn) {
        live.turn.violation = true;
        live.turn.modeLeft = String(mode);
        live.conn.notify("session/cancel", { sessionId: live.sessionId });
      }
      const chat = row.chat ?? this.articles.byId(row.id)?.chat;
      if (chat)
        this.line(
          row,
          chat,
          `mode ${String(mode).slice(0, 40)} refused · set back to default · turn ended`,
          "mode",
        );
      return;
    }
    if (kind.startsWith("unknown:") || kind.startsWith("dropped:")) this.log(`coach ${row.slug}: ${kind}`);
  }

  /** Lets go of the children with no turn, an empty queue, and `idleMs` since their last turn ended. */
  sweep(now = Date.now()): void {
    const idleMs = this.o.idleMs ?? IDLE_MS;
    for (const [id, live] of [...this.started]) {
      if (live.turn || this.runs.has(id) || now - live.lastEnded < idleMs) continue;
      const chat = this.articles.byId(id)?.chat;
      const st = chat ? this.host?.chatState(chat) : undefined;
      if (st?.activeTurn || st?.steeringMessage || (st?.queuedMessages?.length ?? 0) > 0) continue;
      this.log(`coach ${this.articles.byId(id)?.slug ?? id}: idle, let go`);
      void this.stopAgent(id);
    }
  }

  /** Ends an article's agent: stdin closed, then killed after a grace (at once with `now`). */
  private async stopAgent(articleId: string, now = false): Promise<void> {
    const p = this.live.get(articleId);
    this.live.delete(articleId);
    this.started.delete(articleId);
    const live = await p?.catch(() => undefined);
    if (!live) return;
    this.o.tools.revoke(live.secret);
    if (now) live.conn.kill();
    else live.conn.close();
  }

  /** Is an agent process running for this article? */
  hasAgent(articleId: string): boolean {
    const live = this.started.get(articleId);
    return !!live && !live.conn.exited;
  }

  /** On shutdown: the meta that was waiting is sent, and every agent let go. */
  async shutdown(): Promise<void> {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = undefined;
    for (const id of [...this.metaTimers.keys()]) this.pushMeta(id);
    await Promise.all([...this.live.keys()].map((id) => this.stopAgent(id)));
  }
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The letter line for a refused permission request: an edit is the write-refused line, anything else names it. */
function refusalLine(d: Decision, params: Json): string {
  const call = isObj(params.toolCall) ? params.toolCall : {};
  const edit =
    call.kind === "edit" ||
    call.kind === "delete" ||
    call.kind === "move" ||
    /^(Edit|MultiEdit|Write|NotebookEdit|write_draft)$/.test(d.tool) ||
    /article\.md/.test(d.title);
  return edit ? WRITE_REFUSED : `refused · ${d.title.slice(0, 80)} · logged`;
}
