// The coach: the AgentBackend behind every article's AHP session (design section 3).
//
// One session `ahp-session:/<articleId>` and one chat per article. The session's config is the host's own, three
// keys with no agent running: stage, pass and strictness. Its `_meta.sparring` is `metaFor(article)`, pushed with
// `session/metaChanged` whenever it changes (a stage at once, saves and commits debounced).
//
// A client turn first meets its slash command, if the host read one, or its note action (`done c08`): `/stage`,
// `/offline`, `/idea`, `/mute`, `done`, `dismiss` and the client-only commands are answered with a host line and
// start no agent; so are `/strict`, `/quiet` and `/queue`, which adds one queued `/pass <name>` message per pass
// for the host to run as separate turns, with or without a client. `/critique`, `/reader`, `/pass`, `/next`,
// `/ask` and `re c09: …` are rewritten into prompt text. Anything else goes to
// the article's coach as it is, an ACP agent started on the first prompt (the pinned claude adapter, or the scripted coach for `demo`)
// and spoken to through acp-connection and acp-mapper. Every permission request it makes is answered by
// policy.ts. Each turn has a `turns` row, a turn-start commit, a 10-minute limit and the tripwire; a child idle
// for 15 minutes is let go, and a new child's first prompt opens with the continuation brief.
//
// Drafted mode (design section 4): `flip` is the one way authorship changes, called by the authorship route. To
// `drafted` it makes the single-use grant and starts the draft turn itself, with no client message; the turn's
// one accepted `write_draft` does the rest (`acceptDraft`), and a draft turn that ends without one clears the
// grant and says the draft failed. To `coached` it restores the page from the shelf.
import {
  type AgentInfo,
  AhpErrorCodes,
  JsonRpcErrorCodes,
  type SessionConfigState,
} from "@microsoft/agent-host-protocol";
import { splitBlocks, wordCount } from "@sparring/protocol/blocks";
import {
  BUILT_COMMANDS,
  STAGES,
  STRICTNESS,
  type Stage,
  strictnessOf,
  TOPICS,
} from "@sparring/protocol/commands";
import { META_KEY } from "@sparring/protocol/meta";
import { blockEdited, isLive, type NoteAction, parseNoteAction } from "@sparring/protocol/notes";
import type { CorpusEntry } from "@sparring/protocol/overlap";
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
import { ActionType, type Json, PendingMessageKind, ResponsePartKind, USER_ORIGIN } from "./ahp/wire.ts";
import { type ArticleRow, type Articles, HttpError, sessionUri, type TurnStatus } from "./articles.ts";
import { DISALLOWED_TOOLS, killRecordedGroups } from "./claude.ts";
import {
  DRAFT_EMPTY,
  DRAFT_FAILED,
  draftText,
  draftWritten,
  MODE_COACHED,
  MODE_DRAFTED,
  SENDIT_LINE,
  stageMoved,
} from "./draft.ts";
import { type Decision, decide, SPARRING_PREFIX } from "./policy.ts";
import {
  articleBlock,
  continuationBrief,
  DRAFTED_QUIET_LINE,
  DRAFTED_RULES,
  draftAsk,
  header,
  type PastTurn,
  PROMPTS_DIR,
  passBlock,
  QUIET_LINE,
  rulesText,
  stagePrompt,
  tellsBlock,
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
export const QUIET_ON = "quiet · the coach holds its notes · /quiet again to hear them";
export const QUIET_OFF = "the coach speaks again · notes are back";
/** The letter and host line of a pass that left nothing. */
export const passEmptyLine = (pass: string) => `nothing in this pass · ${pass}`;
/** The letter and host line of a pass that left notes. */
export const passDoneLine = (pass: string, n: number) => `${pass} · ${n} ${n === 1 ? "note" : "notes"}`;
/** At most this many passes in one `/queue`. */
export const QUEUE_MAX = 12;

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
  /** The pass it runs: the session's, or the one its command names (`critique`, `reader`). */
  pass: string;
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

/** A writer line the host rewrote into prompt text: `/critique`, `/reader`, `re c09: …`. */
interface Rewrite {
  /** The pass the header names for this turn. */
  pass: string;
  /** What the coach is sent in place of the writer's line. */
  text: string;
  /** Done once the turn is sure to reach the coach: a stage change, a note marked disagreed. */
  apply?: () => void;
  /** The host started this turn (the draft turn): its row says so, and it carries no stage or pass prompt. */
  host?: true;
}

/** The pass the header names in the draft turn. */
export const DRAFT_PASS = "sendit";

const oneLine = (s: string, max = 200) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

export const CRITIQUE_ASK =
  "Run the critique pass over the whole draft now, as the stage instructions say. Leave each item with the comment tool.";
export const READER_ASK =
  "Role-play the reader named in brief.md. Read the brief with read_source (brief) and the draft with " +
  "read_article. Answer as that reader, in the first person: where you stopped reading, what you did not " +
  "believe, what you still do not know, and what you lose if you stop. Point at a place by quoting the writer " +
  "exactly. Leave no notes and suggest no wording. If the brief names no reader, say so and ask who reads this.";

export const passAsk = (pass: string) =>
  `Run the ${pass} pass over the whole draft now, as the pass instructions say. Leave each item with the ` +
  `comment tool, pass "${pass}". If the pass finds nothing, say "nothing in this pass" and stop.`;
export const NEXT_ASK =
  "The writer asks what to write next. Read the page with read_article. Find the first ## section with no " +
  "prose under it and tell the writer to write that one section, naming it by its own heading. Say that ugly " +
  "is fine, and to say done when it is in the file. Leave no notes and write none of it. If the page has no " +
  "## headings, say so and ask which point the reader needs first.";
export const SECTION_ASK =
  "The writer says the section is in the file. The change to article.md above is what they wrote; read the " +
  "page with read_article if you need the rest. Leave at most five notes on that section with the comment " +
  'tool, pass "section": an unclear referent, an unsupported claim, hand-waving, a missing lived detail, the ' +
  "place where the reader named in the brief stops. Then say in one line how many you left and stop. If the " +
  'section needs none, say "nothing in this pass".';
const DRAFTED_ALONE = "This article is drafted and the review is the writer's alone.";
/** `/next` in a drafted article: a short chat reply and no notes. */
export const DRAFTED_NEXT_ASK = `The writer asks what to work on next. ${DRAFTED_ALONE} Answer in chat in one or two sentences, with no wording for the piece, and leave no notes.`;
const CHAT_ONLY =
  "Answer in chat in one or two sentences, with no wording for the piece, and leave no notes.";
/** `/ask` as the coach gets it: the question, and the paragraph it was parked at when there is one. */
export function askText(question: string, block: string | null, why = ""): string {
  if (block === null) return [`The writer asks: ${question}`, why, CHAT_ONLY].filter(Boolean).join("\n");
  return [
    "The writer parked a question at this paragraph of article.md:",
    "<paragraph>",
    block,
    "</paragraph>",
    `The question: ${question}`,
    'Answer with one comment anchored inside that paragraph: the anchor copied exactly from it, pass "ask", ' +
      "the kind that fits. The body is the answer, in one or two sentences, with no wording for the piece. " +
      "Then say one line in chat and stop.",
  ].join("\n");
}

/** The paragraph a `/ask` message carries: the lines after the first, each quoted with `> `. */
export function askedBlock(message: string): string {
  return message
    .split("\n")
    .slice(1)
    .filter((l) => l.startsWith(">"))
    .map((l) => l.replace(/^> ?/, ""))
    .join("\n")
    .trim();
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
  /** Passes `/queue` added that have not started yet, per article: their turns are of origin `queue`. */
  private readonly queuedPasses = new Map<string, number>();
  /** Providers whose engine answered -32000: their articles behave as if offline until /offline is toggled. */
  private readonly signedOut = new Set<string>();
  /** Draft turns the host started that have not run yet, by turn id. */
  private readonly draftTurns = new Set<string>();
  /** Articles whose running draft turn has had its `write_draft` accepted. */
  private readonly drafted = new Set<string>();
  private readonly metaTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** article.md as a turn-start commit holds it, by `<slug>@<commit>`: read once for the overlap corpus. */
  private readonly pages = new Map<string, string>();
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
    this.articles.onChangedNow = (row) => this.pushMeta(row.id);
    this.articles.metaExtra = (row) => ({
      run: this.runs.get(row.id) ?? null,
      queued: (row.chat ? this.host?.chatState(row.chat)?.queuedMessages?.length : 0) ?? 0,
      ...(this.signedOut.has(row.provider) ? { offline: true, signInNeeded: true } : {}),
    });
    this.o.tools.hooks = {
      ownerMessages: (id) => this.ownerMessages(id),
      refused: (id, text) => this.refused(id, text),
      changed: (id) => this.pushMeta(id),
      grantLive: (id) => this.grantLive(id),
      draft: (id, blocks) => this.acceptDraft(id, blocks),
      turn: (id) => {
        const t = this.started.get(id)?.turn;
        return t ? { turnId: t.turnId, pass: t.pass } : undefined;
      },
    };
  }

  /**
   * At daemon start: the groups a dead daemon left are killed, every article gets its session and chat if it
   * lacks them, a turn that was running is marked interrupted with its host line, and the meta is fresh.
   */
  async start(): Promise<void> {
    if (this.o.runDir) killRecordedGroups(this.o.runDir, this.log);
    const interrupted = new Set(this.articles.interruptRunning());
    // A grant the last daemon left unspent: its draft turn died with it.
    const ungranted = new Set(this.articles.clearGrants());
    for (const row of this.articles.all()) {
      try {
        await this.open(row);
        const chat = this.articles.byId(row.id)?.chat;
        if (interrupted.has(row.id) && chat) {
          this.articles.addLetter(row.id, "interrupted", INTERRUPTED);
          this.line(row, chat, INTERRUPTED, "divider");
        }
        if (ungranted.has(row.id)) {
          this.articles.addLetter(row.id, "draftFailed", DRAFT_FAILED);
          if (chat) this.line(row, chat, DRAFT_FAILED, "refused");
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
    if (this.draftTurns.delete(run.turnId)) return this.draftTurn(row, run);
    let rewrite: Rewrite | undefined;
    const action = run.command ? null : parseNoteAction(run.message.text);
    const handled = action
      ? await this.noteAction(row, run.chat, action)
      : run.command
        ? await this.hostCommand(row, run.chat, run.command, run.message.text)
        : this.sectionDone(row, run);
    if (handled === true) return { kind: "complete" };
    if (handled !== false) rewrite = handled;
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
    rewrite?.apply?.();
    return this.coachTurn(this.articles.byId(row.id) ?? row, run, launch, rewrite);
  }

  /** A draft turn cancelled before it ever ran: the grant goes with it. */
  cancelTurn(run: TurnRun): void {
    if (!this.draftTurns.delete(run.turnId)) return;
    const row = this.articleOfSession(run.session);
    if (row) this.draftFailed(row, run.chat);
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
  // Commands the daemon can act on in this build. Any other listed command gets a host line saying it is not
  // built yet, rather than reaching the coach as plain text and seeming to do nothing.

  /**
   * A command the host answers itself, with one host line and no agent (true), or rewrites into prompt text for
   * the coach. False: it goes to the coach as text.
   */
  private async hostCommand(
    row: ArticleRow,
    chat: string,
    { command, rest }: ParsedCommand,
    message = "",
  ): Promise<boolean | Rewrite> {
    const quiet = Number(row.coach_quiet ?? 0) === 1;
    const unquiet = () => {
      if (quiet) this.articles.setQuiet(row.id, false);
    };
    switch (command.name) {
      case "pass": {
        // One named pass, locked to its lens. It works from any stage and ends a quiet.
        const name = rest.split(/\s+/)[0] ?? "";
        const names = this.articles.passNames();
        if (!name) {
          this.line(row, chat, `no pass named · /pass ${names.join(" · ")}`);
          return true;
        }
        if ((await this.articles.pass(name)) === undefined) {
          this.line(row, chat, `no pass "${name.slice(0, 40)}" · ${names.join(" · ")}`);
          return true;
        }
        const more = rest.slice(name.length).trim();
        return {
          pass: name,
          text: more ? `${passAsk(name)}\n\nThe writer adds: ${more}` : passAsk(name),
          apply: unquiet,
        };
      }
      case "queue": {
        const names = rest.split(/[\s,]+/).filter(Boolean);
        if (names.length === 0) {
          this.line(row, chat, "nothing queued · /queue filler repeats cut");
          return true;
        }
        if (names.length > QUEUE_MAX) {
          this.line(row, chat, `nothing queued · at most ${QUEUE_MAX} passes at once`);
          return true;
        }
        for (const n of names) {
          if ((await this.articles.pass(n)) !== undefined) continue;
          this.line(
            row,
            chat,
            `nothing queued · no pass "${n.slice(0, 40)}" · ${this.articles.passNames().join(" · ")}`,
          );
          return true;
        }
        // Each pass is its own queued message, so each runs as a separate turn once this one is over, with or
        // without a client connected. The queue lives in the chat's state; there is no queue table.
        for (const n of names)
          this.h.apply(chat, {
            type: ActionType.ChatPendingMessageSet,
            kind: PendingMessageKind.Queued,
            id: crypto.randomUUID(),
            message: { text: `/pass ${n}`, origin: USER_ORIGIN },
          });
        this.queuedPasses.set(row.id, (this.queuedPasses.get(row.id) ?? 0) + names.length);
        this.line(row, chat, `queued · ${names.join(" · ")}`, "divider");
        this.h.resumeChat(chat);
        return true;
      }
      case "strict": {
        const to = strictnessOf(rest);
        if (!to) {
          this.line(
            row,
            chat,
            rest
              ? `no strictness "${rest.slice(0, 40)}" · /strict ${STRICTNESS.join(" · ")}`
              : `strictness is ${row.strictness} · /strict ${STRICTNESS.join(" · ")}`,
            rest ? "refused" : "mode",
          );
          return true;
        }
        this.articles.setStrictness(row.id, to);
        this.h.apply(sessionUri(row.id), {
          type: ActionType.SessionConfigChanged,
          config: { strictness: to },
        });
        this.line(row, chat, `strictness ${to} · every pass from now on`, "mode");
        return true;
      }
      case "quiet":
        this.articles.setQuiet(row.id, !quiet);
        this.line(row, chat, quiet ? QUIET_OFF : QUIET_ON, "mode");
        return true;
      case "next": {
        // In a drafted article the review is the writer's alone: a short chat reply and no notes.
        const ask = row.authorship === "drafted" ? DRAFTED_NEXT_ASK : NEXT_ASK;
        return { pass: "next", text: rest ? `${ask}\n\nThe writer adds: ${rest}` : ask };
      }
      case "ask": {
        if (!rest) {
          this.line(row, chat, "nothing asked · /ask <question>");
          return true;
        }
        // The paragraph at the caret travels in the message, quoted. It counts only if it is on the page.
        const asked = askedBlock(message);
        const block = splitBlocks(await this.articles.read(row.slug, "article")).find(
          (b) => b.trim() === asked,
        );
        const noNote = quiet
          ? "The writer asked for quiet."
          : row.authorship === "drafted"
            ? DRAFTED_ALONE
            : block === undefined
              ? "No paragraph of article.md came with the question."
              : "";
        return {
          pass: "ask",
          text: askText(rest, noNote || block === undefined ? null : block, noNote),
        };
      }
      case "critique":
        // `/critique` is the critique stage's pass: the article moves there if it is somewhere else, and a quiet
        // coach speaks again.
        return {
          pass: "critique",
          text: rest ? `${CRITIQUE_ASK}\n\nThe writer adds: ${rest}` : CRITIQUE_ASK,
          apply: () => {
            unquiet();
            if (row.stage !== "critique") this.stage(row, "critique", true, chat);
          },
        };
      case "reader":
        return { pass: "reader", text: rest ? `${READER_ASK}\n\nThe writer adds: ${rest}` : READER_ASK };
      case "mute": {
        const id = /^c\d+$/i.test(rest) ? rest.toLowerCase() : "";
        if (!id) {
          this.line(row, chat, "nothing muted · /mute c11");
          return true;
        }
        return this.noteAction(row, chat, { action: "mute", id });
      }
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
    if (!BUILT_COMMANDS.has(command.name)) {
      this.line(row, chat, `/${command.name} is not a command here · nothing was sent to the coach`);
      return true;
    }
    return false;
  }

  /**
   * `done`, typed alone, right after a `/next` turn: the writer says the section is in the file. The coach gets
   * the diff, as every turn does, and is asked for at most five notes on it. Anything else is plain text.
   */
  private sectionDone(row: ArticleRow, run: TurnRun): false | Rewrite {
    if (!/^done[.!]?$/i.test(run.message.text.trim())) return false;
    // In a drafted article `/next` left nothing to hand over.
    if (row.authorship === "drafted") return false;
    if (this.articles.lastCoachPass(row.id, run.turnId) !== "next") return false;
    return { pass: "section", text: SECTION_ASK };
  }

  /**
   * A note action the writer typed or a note button sent. `done`, `dismiss` and `mute` are the host's alone: one
   * host line, no agent. `re c09: …` marks the note disagreed and goes to the coach as prompt text.
   */
  private async noteAction(row: ArticleRow, chat: string, a: NoteAction): Promise<true | Rewrite> {
    const note = this.articles.comment(row.id, a.id);
    if (!note) {
      this.line(row, chat, `no note ${a.id} · nothing changed`);
      return true;
    }
    const closed = `${note.id} is already ${note.status} · nothing changed`;
    switch (a.action) {
      case "done": {
        if (!isLive(note)) {
          this.line(row, chat, closed);
          return true;
        }
        // The same rule the Done button follows: the block the note was left on must have changed on disk.
        const blocks = splitBlocks(await this.articles.read(row.slug, "article"));
        if (!blockEdited(note.block_orig, blocks)) {
          this.line(row, chat, `${note.id} not done · edit the span first`);
          return true;
        }
        this.articles.setComment(row.id, note.id, { status: "done" });
        this.line(row, chat, `${note.id} done`, "divider");
        return true;
      }
      case "dismiss": {
        if (!isLive(note)) {
          this.line(row, chat, closed);
          return true;
        }
        this.articles.setComment(row.id, note.id, { status: "dismissed" });
        this.line(row, chat, `${note.id} dismissed`, "divider");
        return true;
      }
      case "mute": {
        if (note.muted) {
          this.line(row, chat, `${note.id} is already muted · nothing changed`);
          return true;
        }
        if (note.status === "done" || note.status === "withdrawn") {
          this.line(row, chat, closed);
          return true;
        }
        const entry = `${note.kind}: "${oneLine(note.span, 300)}"`;
        try {
          await this.articles.doNotFlag(`- ${entry}`);
        } catch (e) {
          this.line(row, chat, `${note.id} not muted · STYLE.md was not written · ${errText(e)}`);
          return true;
        }
        this.articles.setComment(row.id, note.id, { status: "dismissed", muted: true });
        this.line(row, chat, `${note.id} muted · STYLE.md ← do not flag: ${entry}`, "divider");
        return true;
      }
      case "reply": {
        if (!isLive(note)) {
          this.line(row, chat, closed);
          return true;
        }
        return {
          pass: note.pass,
          text: [
            `The writer disagrees with your note ${note.id} (${note.kind}) on "${note.span}".`,
            `Your note: ${note.body_v2 ?? note.body}`,
            `The writer's reply: ${a.text}`,
            `Answer once. Either withdraw it with resolve_comment({id: "${note.id}", action: "withdraw", body}), ` +
              `one line, or sharpen it with resolve_comment({id: "${note.id}", action: "sharpen", body}) and a ` +
              "reason the writer can verify. Do not argue past this exchange.",
          ].join("\n"),
          apply: () => this.articles.setComment(row.id, note.id, { status: "disagreed", reply: a.text }),
        };
      }
    }
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

  /** `PUT meta` set a title: it is the session's title too, which the Articles row shows. */
  titled(slug: string, title: string): void {
    const row = this.articles.row(slug);
    const t = title.trim().slice(0, 200) || row.slug;
    if (this.host?.sessionState(sessionUri(row.id)))
      this.h.apply(sessionUri(row.id), { type: ActionType.SessionTitleChanged, title: t });
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

  /**
   * The overlap corpus of an article: everything the coach said. Its chat replies (the Markdown parts of each
   * turn, named by stage: `interview q2`, `critique reply`), its notes and its brief questions. Tool calls are
   * not read, so the `write_draft` input is never in it; otherwise a drafted page would match whole. `own` is
   * the writer's side, the dump and the writer's messages: a run of words found there is not the coach's. Each
   * reply also carries the page as it was when its turn began (`before`), so a reply that quotes the article
   * back is not the coach's words either.
   */
  async corpus(slug: string): Promise<{ entries: CorpusEntry[]; own: string[] }> {
    const row = this.articles.row(slug);
    const entries: CorpusEntry[] = [];
    const st = row.chat ? this.host?.chatState(row.chat) : undefined;
    const rows = new Map(this.articles.turnRows(row.id).map((r) => [r.turn_id, r]));
    const asked = new Map<string, number>();
    // What the page held when a turn began: a reply that quotes it does not make those words the coach's.
    const pageAt = async (commit: string | null | undefined): Promise<string> => {
      if (!commit) return "";
      const key = `${slug}@${commit}`;
      let text = this.pages.get(key);
      if (text === undefined) {
        text = (await this.articles.showAt(commit, `${slug}/article.md`)) ?? "";
        if (this.pages.size > 500) this.pages.clear();
        this.pages.set(key, text);
      }
      return text;
    };
    for (const t of st ? [...st.turns, ...(st.activeTurn ? [st.activeTurn] : [])] : []) {
      const text = t.responseParts
        .map((p) => (p.kind === ResponsePartKind.Markdown ? p.content : ""))
        .join("")
        .trim();
      if (!text) continue;
      const r = rows.get(t.id);
      const stage = r?.stage || "chat";
      let source = `${stage} reply`;
      if (r && Number(r.is_question) === 1) {
        asked.set(stage, (asked.get(stage) ?? 0) + 1);
        source = `${stage} q${asked.get(stage)}`;
      }
      const before = await pageAt(r?.commit_before);
      entries.push({ source, text, ...(before ? { before } : {}) });
    }
    entries.push(...this.articles.coachWritten(row));
    return { entries, own: [await this.articles.read(slug, "dump"), ...this.ownerMessages(row.id)] };
  }

  // ───────────────────────────── drafted mode ─────────────────────────────

  private grantLive(articleId: string): boolean {
    const g = this.articles.byId(articleId)?.draft_grant;
    return typeof g === "string" && g !== "";
  }

  /**
   * `POST /api/articles/:slug/authorship {to, confirm: true}`: the only way authorship changes. Agent text, a
   * tool result or a config key can never reach it.
   *
   * To `drafted`, from any stage: 409 while the article is drafted already, offline, or busy with a turn, with
   * no host line. An empty dump is refused with a host line and a letter line. Otherwise the grant is made,
   * `drafting` goes out, and the host starts the draft turn. Authorship still reads `coached` and the page is
   * untouched until the draft is accepted.
   *
   * To `coached`: the page comes back from the shelf and the stage returns to where it was.
   */
  async flip(slug: string, to: "coached" | "drafted"): Promise<Record<string, unknown>> {
    const row = this.articles.row(slug);
    const chat = row.chat;
    const busy = () =>
      this.runs.has(row.id) || (chat ? this.h.hasActiveTurn(chat) : false) || this.grantLive(row.id);
    if (to === "coached") {
      if (row.authorship !== "drafted")
        throw new HttpError(409, { error: "this article is coached already" });
      if (busy())
        throw new HttpError(409, { error: "the coach is in the middle of a turn · try again after it" });
      const { from, stage } = await this.articles.backToCoached(slug);
      this.h.apply(sessionUri(row.id), { type: ActionType.SessionConfigChanged, config: { stage } });
      const fresh = this.articles.byId(row.id) ?? row;
      if (chat) {
        this.line(fresh, chat, MODE_COACHED, "mode");
        if (from !== stage) this.line(fresh, chat, stageMoved(from, stage), "stage");
      }
      this.pushMeta(row.id);
      return { authorship: "coached", stage, sha: fresh.article_sha };
    }
    if (row.authorship === "drafted") throw new HttpError(409, { error: "this article is drafted already" });
    if (Number(row.offline ?? 0) === 1 || this.signedOut.has(row.provider))
      throw new HttpError(409, { error: "the article is offline · /offline brings the coach back" });
    if (!chat || !this.o.launches[row.provider as Provider])
      throw new HttpError(409, { error: "this article has no coach to write the draft" });
    if (busy())
      throw new HttpError(409, { error: "the coach is in the middle of a turn · try again after it" });
    if ((await this.articles.read(slug, "dump")).trim() === "") {
      this.articles.addLetter(row.id, "draftEmpty", DRAFT_EMPTY);
      this.line(row, chat, DRAFT_EMPTY, "refused");
      throw new HttpError(409, { error: DRAFT_EMPTY });
    }
    this.articles.setDraftGrant(row.id, crypto.randomUUID());
    const turnId = this.h.startHostTurn(chat, SENDIT_LINE);
    if (!turnId) {
      this.articles.setDraftGrant(row.id, null);
      throw new HttpError(409, { error: "the coach is in the middle of a turn · try again after it" });
    }
    this.draftTurns.add(turnId);
    this.pushMeta(row.id);
    return { authorship: "coached", drafting: true };
  }

  /**
   * The draft turn, in the article's own coach session. Its prompt asks for one `write_draft` call. If the turn
   * ends with none accepted (it failed, was cancelled, hit the limit, or the agent exited), the grant is cleared
   * and the host says the draft failed; the page was never touched.
   */
  private async draftTurn(row: ArticleRow, run: TurnRun): Promise<TurnOutcome> {
    this.drafted.delete(row.id);
    const launch = this.o.launches[row.provider as Provider];
    try {
      if (!launch || !this.grantLive(row.id)) return { kind: "complete" };
      const notes = JSON.parse(String(row.brief_notes_json ?? "[]")) as { topic?: unknown }[];
      const covered = new Set(notes.map((n) => n.topic));
      const uncovered = TOPICS.filter((t) => !covered.has(t));
      const text = draftAsk(
        {
          answers: this.earlyAnswers(row),
          uncovered: row.stage === "interview" || covered.size > 0 ? uncovered : [],
        },
        this.o.promptsDir ?? PROMPTS_DIR,
      );
      return await this.coachTurn(row, run, launch, { pass: DRAFT_PASS, text, host: true });
    } finally {
      if (!this.drafted.delete(row.id)) this.draftFailed(row, run.chat);
    }
  }

  /** No draft was accepted: the grant is cleared and the host says so. Nothing was written. */
  private draftFailed(row: ArticleRow, chat: string): void {
    this.articles.setDraftGrant(row.id, null);
    this.articles.addLetter(row.id, "draftFailed", DRAFT_FAILED);
    this.line(this.articles.byId(row.id) ?? row, chat, DRAFT_FAILED, "refused");
  }

  /** The writer's own messages from the ideas and interview stages, oldest first, commands left out. */
  private earlyAnswers(row: ArticleRow): string[] {
    const chat = row.chat ? this.h.chatState(row.chat) : undefined;
    const byId = new Map((chat?.turns ?? []).map((t) => [t.id, t]));
    const out: string[] = [];
    for (const r of this.articles.coachTurns(row.id)) {
      if (r.stage !== "ideas" && r.stage !== "interview") continue;
      const m = byId.get(r.turn_id)?.message;
      const text = m?.origin?.kind === "user" ? m.text.trim() : "";
      if (text && !text.startsWith("/")) out.push(text);
    }
    return out;
  }

  /**
   * An accepted `write_draft`: the page moves to the shelf, the draft is written and committed, authorship is
   * `drafted`, the stage `draft`, the coach quiet and the grant spent (all in `Articles.writeDraft`). Then the
   * session's stage and the host's two lines. Answers the tool's result.
   */
  private async acceptDraft(articleId: string, blocks: string[]): Promise<string> {
    const row = this.articles.byId(articleId);
    if (!row) throw new Error("the article is gone");
    const text = draftText(blocks);
    let done: { n: number; commit: string; stageBefore: string };
    try {
      done = await this.articles.writeDraft(row.slug, text);
    } catch (e) {
      // The transaction rolled back and the page is as it was. The draft turn ends as a failed draft.
      this.articles.setDraftGrant(row.id, null);
      this.log(`draft ${row.slug}: ${errText(e)}`);
      throw new Error(`the draft was not written: ${errText(e)}`);
    }
    this.drafted.add(row.id);
    const fresh = this.articles.byId(row.id) ?? row;
    this.log(`draft ${row.slug}: draft ${done.n} at ${done.commit.slice(0, 7)} · never-write is off`);
    if (done.stageBefore !== "draft")
      this.h.apply(sessionUri(row.id), { type: ActionType.SessionConfigChanged, config: { stage: "draft" } });
    if (fresh.chat) {
      this.line(fresh, fresh.chat, MODE_DRAFTED, "mode");
      if (done.stageBefore !== "draft")
        this.line(fresh, fresh.chat, stageMoved(done.stageBefore, "draft"), "stage");
    }
    this.pushMeta(row.id);
    return draftWritten(splitBlocks(text).length);
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
  private async coachTurn(
    row: ArticleRow,
    run: TurnRun,
    launch: Launch,
    rewrite?: Rewrite,
  ): Promise<TurnOutcome> {
    let commitBefore: string;
    let before: string;
    try {
      commitBefore = await this.articles.turnCommit(row.slug);
      before = await this.articles.diskSha(row.slug);
    } catch (e) {
      return { kind: "error", errorType: "git", message: `the turn-start commit failed: ${errText(e)}` };
    }
    const pass = rewrite?.pass ?? this.passOf(row);
    // A pass with a file, or the critique: its result is a letter line and a host line.
    const reports = pass === "critique" || (pass !== "" && (await this.articles.pass(pass)) !== undefined);
    const waiting = this.queuedPasses.get(row.id) ?? 0;
    const fromQueue = waiting > 0 && run.command?.command.name === "pass";
    if (fromQueue) this.queuedPasses.set(row.id, waiting - 1);
    this.articles.turnStarted({
      turnId: run.turnId,
      articleId: row.id,
      origin: rewrite?.host ? "host" : fromQueue ? "queue" : "writer",
      stage: row.stage,
      pass,
      commitBefore,
    });
    this.runs.set(row.id, { pass, startedAt: new Date().toISOString() });
    this.pushMeta(row.id);
    const turn: Turn = { turnId: run.turnId, pass, text: "", violation: false };
    let status: TurnStatus = "failed";
    let live: Live | undefined;
    try {
      try {
        live = await this.agent(row, launch);
      } catch (e) {
        return this.startFailed(row, run.chat, e);
      }
      live.turn = turn;
      const blocks = await this.promptFor(row, live, run, commitBefore, pass, rewrite?.text, rewrite?.host);
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
      if (status === "done" && reports) this.passResult(row, run.chat, run.turnId, pass);
      if (status === "done") this.articles.setOpenQuestion(row.id, said.endsWith("?") ? said : null);
      this.articles.turnEnded(run.turnId, status, said.endsWith("?"), turn.violation);
      this.runs.delete(row.id);
      this.pushMeta(row.id);
    }
  }

  /** A pass ended: `filler · 2 notes` or `nothing in this pass · filler`, in the letter and in the chat. */
  private passResult(row: ArticleRow, chat: string, turnId: string, pass: string): void {
    const n = this.articles.commentsInTurn(row.id, turnId);
    const text = n > 0 ? passDoneLine(pass, n) : passEmptyLine(pass);
    this.articles.addLetter(row.id, n > 0 ? "passDone" : "passEmpty", text);
    this.line(row, chat, text, "divider");
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
  private async promptFor(
    row: ArticleRow,
    live: Live,
    run: TurnRun,
    commitBefore: string,
    pass: string,
    rewritten?: string,
    /** The draft turn: its own message is the whole instruction, so no stage or pass prompt goes with it. */
    bare = false,
  ): Promise<Json[]> {
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
    // A named pass runs the same from any stage: its stage prompt is polish's, which says how every pass runs.
    const passText = pass && pass !== fresh.stage && !bare ? await this.articles.pass(pass) : undefined;
    const stage = bare
      ? undefined
      : stagePrompt(passText ? "polish" : fresh.stage, this.o.promptsDir ?? PROMPTS_DIR);
    if (stage) text(stage);
    if (pass && passText) text(passBlock({ pass, strictness: fresh.strictness, text: passText }));
    // The tells pass leans on the tells module: the coach is handed the counts and judges content only.
    if (pass === "tells" && passText) text(tellsBlock(article, await this.articles.read(row.slug, "dump")));
    const isDrafted = fresh.authorship === "drafted";
    // A critique or a pass over a drafted article: the draft is the writer's page now.
    if (isDrafted && !bare && (pass === "critique" || passText)) text(DRAFTED_RULES);
    if (Number(fresh.coach_quiet ?? 0) === 1 && !bare) text(isDrafted ? DRAFTED_QUIET_LINE : QUIET_LINE);
    const seen = typeof fresh.agent_seen_commit === "string" ? fresh.agent_seen_commit : null;
    const diff =
      seen && seen !== commitBefore ? await this.articles.articleDiff(row.slug, seen, commitBefore) : "";
    text(articleBlock({ seen, commit: commitBefore, text: article, words, diff }));
    this.articles.setAgentSeen(row.id, commitBefore);
    blocks.push(
      ...promptBlocks(rewritten === undefined ? run.message : { ...run.message, text: rewritten }, live.caps),
    );
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
      // Cancelled while the prompt was being put together: nothing is sent.
      if (run.signal.aborted) return { outcome: { kind: "cancelled" }, status: "interrupted" };
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
    const d = decide(params, { grantLive: this.grantLive(articleId) });
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
