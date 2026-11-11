// The coach: the AgentBackend behind every article's AHP session (design section 3).
//
// One session `ahp-session:/<articleId>` and one chat per article. The session's config is the host's own, three
// keys with no agent running: stage, pass and strictness. Its `_meta.sparring` is `metaFor(article)`, pushed with
// `session/metaChanged` whenever it changes (a stage at once, saves and commits debounced). A client turn first
// meets its slash command, if the host read one: `/stage` and the client-only commands are answered with a host
// line and start no agent. Anything else goes to the article's coach, an ACP agent started on the first prompt and
// spoken to through acp-connection and acp-mapper: the scripted coach for `demo`; `claude` comes in step 3.
import {
  type AgentInfo,
  AhpErrorCodes,
  JsonRpcErrorCodes,
  type SessionConfigState,
} from "@microsoft/agent-host-protocol";
import { STAGES, STRICTNESS, type Stage } from "@sparring/protocol/commands";
import { META_KEY } from "@sparring/protocol/meta";
import { AcpConnection, EXITED, TIMED_OUT } from "./ahp/acp-connection.ts";
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
import { ActionType, type Json } from "./ahp/wire.ts";
import { type ArticleRow, type Articles, HttpError, sessionUri } from "./articles.ts";

export type Provider = "claude" | "demo";
export const PROVIDERS: readonly Provider[] = ["demo", "claude"];

/** What a `claude` article answers until the real coach lands. */
export const CLAUDE_LATER = "claude arrives in step 3 · this article uses no coach yet";

/** The kinds of host line, in the SystemNotification part's `_meta`. */
export type LineKind = "stage" | "refused" | "mode" | "divider";
export const LINE_META = "sparring.line";

const SESSION_PREFIX = "ahp-session:/";
const TURN_LIMIT_MS = 10 * 60_000;
const HANDSHAKE_MS = 30_000;
const PASS_RE = /^[a-z0-9-]{0,40}$/;

export interface CoachOptions {
  articles: Articles;
  /** How each provider's agent starts. A provider without one starts nothing. */
  launches: Partial<Record<Provider, Launch>>;
  /** Saves and commits reach `_meta.sparring` at most this often (ms). */
  metaDebounceMs?: number;
  /** The `clientInfo.version` sent in `initialize`. */
  version?: string;
  log?: (m: string) => void;
}

/** An article's running agent. */
interface Live {
  conn: AcpConnection;
  sessionId: string;
  caps: Json;
  /** The turn being mapped now, if any. */
  mapper: TurnMapper | undefined;
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

export class Coach implements AgentBackend {
  private host: AhpHost | undefined;
  private readonly live = new Map<string, Promise<Live>>();
  private readonly metaTimers = new Map<string, ReturnType<typeof setTimeout>>();
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
  }

  /** At daemon start: every article gets its session and chat if it lacks them, and fresh meta. */
  async start(): Promise<void> {
    for (const row of this.articles.all()) {
      try {
        await this.open(row);
        this.pushMeta(row.id);
      } catch (e) {
        this.log(`coach: no session for ${row.slug}: ${e instanceof Error ? e.message : e}`);
      }
    }
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
        description: "claude-agent-acp, from step 3",
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
    if (run.command && this.hostCommand(row, run.chat, run.command)) return { kind: "complete" };
    const launch = this.o.launches[row.provider as Provider];
    if (!launch) {
      this.line(row, run.chat, row.provider === "claude" ? CLAUDE_LATER : `no coach for ${row.provider}`);
      return { kind: "complete" };
    }
    return this.prompt(row, run, launch);
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
  private hostCommand(row: ArticleRow, chat: string, { command, rest }: ParsedCommand): boolean {
    if (command.name === "stage") {
      const stage = STAGES.find((s) => s === rest);
      if (stage) this.stage(row, stage, true, chat);
      else this.line(row, chat, `no stage "${rest.slice(0, 40)}" · ${STAGES.join(" ")}`);
      return true;
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

  // ───────────────────────────── the agent ─────────────────────────────

  private async prompt(row: ArticleRow, run: TurnRun, launch: Launch): Promise<TurnOutcome> {
    let live: Live;
    try {
      live = await this.agent(row, launch);
    } catch (e) {
      return {
        kind: "error",
        errorType: "agent_start",
        message: `the coach did not start: ${e instanceof Error ? e.message : e}`,
      };
    }
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
      const reply = await live.conn.request(
        "session/prompt",
        { sessionId: live.sessionId, prompt: promptBlocks(run.message, live.caps) },
        TURN_LIMIT_MS,
      );
      mapper.finish();
      if (run.signal.aborted) return { kind: "cancelled" };
      if (reply.error) {
        if (reply.error.code === TIMED_OUT) {
          cancel();
          await this.stopAgent(row.id);
        }
        return {
          kind: "error",
          errorType: reply.error.code === EXITED ? "agent_exited" : "agent_error",
          message: reply.error.message ?? "the coach failed",
        };
      }
      return reply.result?.stopReason === "cancelled" ? { kind: "cancelled" } : { kind: "complete" };
    } finally {
      live.mapper = undefined;
      run.signal.removeEventListener("abort", cancel);
    }
  }

  /** The article's agent, started (and its ACP session made) on first use. */
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

  private async startAgent(row: ArticleRow, launch: Launch): Promise<Live> {
    const cwd = this.articles.folder(row.slug);
    const proc = await launch({ articleId: row.id, cwd, env: {} });
    const conn = new AcpConnection(proc, this.log);
    const live: Live = { conn, sessionId: "", caps: {}, mapper: undefined };
    conn.onNotification = (method, params) => {
      if (method === "session/update" && params.sessionId === live.sessionId && isObj(params.update))
        live.mapper?.update(params.update);
    };
    conn.onRequest = (method, params) => this.onAgentRequest(row, method, params);
    const init = await conn.request(
      "initialize",
      {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "sparring", version: this.o.version ?? "0.0.0" },
      },
      HANDSHAKE_MS,
    );
    if (init.error) {
      conn.kill();
      throw new Error(init.error.message ?? "initialize failed");
    }
    live.caps = isObj(init.result?.agentCapabilities) ? init.result.agentCapabilities : {};
    const made = await conn.request("session/new", { cwd, mcpServers: [] }, HANDSHAKE_MS);
    const sessionId = made.result?.sessionId;
    if (made.error || typeof sessionId !== "string") {
      conn.kill();
      throw new Error(made.error?.message ?? "session/new gave no session id");
    }
    live.sessionId = sessionId;
    return live;
  }

  /**
   * Every request the agent makes of the daemon comes here (permission prompts, elicitation). The coach offers
   * none of them yet, so each is answered with -32601 by the connection.
   */
  private async onAgentRequest(row: ArticleRow, method: string, _params: Json): Promise<unknown> {
    throw new Error(`not offered to ${row.slug}: ${method}`);
  }

  /** ACP updates that are not chat actions (modes, config, commands, usage). The host owns all three keys. */
  private side(row: ArticleRow, kind: string, _update: Json): void {
    if (kind.startsWith("unknown:") || kind.startsWith("dropped:")) this.log(`coach ${row.slug}: ${kind}`);
  }

  private async stopAgent(articleId: string): Promise<void> {
    const p = this.live.get(articleId);
    this.live.delete(articleId);
    const live = await p?.catch(() => undefined);
    live?.conn.close();
  }

  /** On shutdown: the meta that was waiting is sent, and every agent let go. */
  async shutdown(): Promise<void> {
    for (const id of [...this.metaTimers.keys()]) this.pushMeta(id);
    await Promise.all([...this.live.keys()].map((id) => this.stopAgent(id)));
  }
}
