// Every place the web client meets the daemon's AHP surface, so it can be adjusted in one file:
// - the root session list (`listSessions`, then `root/sessionAdded`, `sessionRemoved`, `sessionSummaryChanged`),
//   where an article is a session whose summary `_meta.sparring` is a SparringMeta with its slug;
// - the article's chat: the summary's `defaultChat`, else its first chat;
// - the stage: `session/configChanged {stage}` on the session channel, read back from `config.values.stage`,
//   else from `_meta.sparring.stage`;
// - a composer line: `chat/turnStarted` on the chat when no turn runs, else a queued `chat/pendingMessageSet`;
// - the transcript: the chat's turns, with host lines as turns whose message origin is `systemNotification` and
//   as SystemNotification response parts.
import type {
  ChatState,
  ResponsePart,
  SessionState,
  SessionSummary,
  StateAction,
} from "@microsoft/agent-host-protocol";
import { STAGES, type Stage } from "@sparring/protocol/commands";
import { META_KEY, type SparringMeta } from "@sparring/protocol/meta";
import { pendingMessage, setConfig, turnStarted } from "./actions.ts";
import type { AhpConnection, RosterEvent } from "./ahp/connection.ts";
import { ActionType } from "./ahp/wire.ts";

type WithMeta = { _meta?: Record<string, unknown> | undefined };

/** `_meta.sparring` when the session is an article, else undefined. */
export function metaOf(x: WithMeta | undefined): SparringMeta | undefined {
  const m = x?._meta?.[META_KEY];
  return m && typeof m === "object" && typeof (m as { slug?: unknown }).slug === "string"
    ? (m as SparringMeta)
    : undefined;
}

/** The chat an article talks in. */
export function chatOf(s: Pick<SessionSummary, "defaultChat" | "chats"> | undefined): string | undefined {
  return s?.defaultChat ?? s?.chats?.[0]?.resource;
}

const isStage = (v: unknown): v is Stage =>
  typeof v === "string" && (STAGES as readonly string[]).includes(v);

/** The stage the article is in: the session's config value, else `_meta.sparring.stage`, else `fallback`. */
export function stageOf(
  session: SessionState | undefined,
  meta: SparringMeta | undefined,
  fallback: string,
): string {
  const v = session?.config?.values.stage;
  if (isStage(v)) return v;
  if (meta && isStage(meta.stage)) return meta.stage;
  return fallback;
}

/**
 * Asks the host to move the article to a stage. Returns an error in words, or null when it went out. A refusal
 * that comes back later (the host's own checks) reaches `onRefused` with the host's reason.
 */
export function setStage(
  conn: AhpConnection,
  session: string,
  stage: Stage,
  onRefused?: (reason: string) => void,
): string | null {
  const r = conn.dispatch(session, setConfig({ stage }));
  if (!r.ok) return r.error;
  if (onRefused) {
    const release = conn.onRejected((x) => {
      if (x.clientSeq !== r.clientSeq) return;
      release();
      onRefused(x.reason);
    });
    // The echo settles it either way; stop listening once accepted.
    const accepted = conn.onAccepted((seq) => {
      if (seq !== r.clientSeq) return;
      accepted();
      release();
    });
  }
  return null;
}

// ───────────────────────────── the article list ─────────────────────────────

/**
 * The articles as the root session list has them. Lists again every time the connection opens (root
 * notifications are not replayed) and follows the root notifications in between.
 */
export class ArticleList {
  private readonly rows = new Map<string, SessionSummary>();
  private readonly listeners = new Set<() => void>();
  private readonly releases: (() => void)[] = [];
  private wasOpen = false;
  /** True once a list has come back. */
  loaded = false;

  constructor(private readonly conn: AhpConnection) {
    this.releases.push(
      conn.onInfo((i) => {
        const open = i.status === "open";
        if (open && !this.wasOpen) void this.relist();
        this.wasOpen = open;
      }),
      conn.onRoster((events) => this.follow(events)),
    );
    if (conn.info.status === "open") {
      this.wasOpen = true;
      void this.relist();
    }
  }

  /** Articles, most recently changed first. */
  list(): SessionSummary[] {
    return [...this.rows.values()].sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  }

  /** Why the last listing failed, or "" after one worked. */
  error = "";

  bySlug(slug: string): SessionSummary | undefined {
    return this.list().find((s) => metaOf(s)?.slug === slug);
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  dispose(): void {
    for (const r of this.releases) r();
    this.listeners.clear();
  }

  async relist(): Promise<void> {
    try {
      const items = await this.conn.listSessions();
      this.rows.clear();
      for (const s of items) if (metaOf(s)) this.rows.set(s.resource, s);
      this.loaded = true;
      this.error = "";
      this.changed();
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      console.info(`ahp: listSessions failed: ${this.error}`);
      this.changed();
    }
  }

  private follow(events: RosterEvent[]): void {
    let any = false;
    for (const ev of events) {
      if (ev.type === "sessionAdded") {
        if (metaOf(ev.params.summary)) {
          this.rows.set(ev.params.summary.resource, ev.params.summary);
          any = true;
        }
      } else if (ev.type === "sessionRemoved") {
        any = this.rows.delete(ev.params.session) || any;
      } else {
        const old = this.rows.get(ev.params.session);
        const changes = ev.params.changes;
        if (old) {
          const { resource: _r, provider: _p, createdAt: _c, ...rest } = changes;
          this.rows.set(old.resource, { ...old, ...rest } as SessionSummary);
          any = true;
        } else if (metaOf(changes)) {
          // A session that became an article after the list was taken: list again to learn the rest of it.
          void this.relist();
        }
      }
    }
    if (any) this.changed();
  }

  private changed(): void {
    for (const fn of [...this.listeners]) fn();
  }
}

// ───────────────────────────── composer lines ─────────────────────────────

/**
 * Sends composer lines to one chat: a turn when none is running, a queued message otherwise. `send` has the
 * outbox's shape: it returns false when the line cannot go now. A line the host refuses comes back through
 * `onRefused` with the host's reason.
 */
export class ChatLines {
  private started: string | undefined;
  private readonly sent = new Map<number, string>();
  private readonly release: () => void;

  constructor(
    private readonly conn: AhpConnection,
    private readonly chat: () => string | undefined,
    onRefused: (text: string, reason: string) => void,
  ) {
    this.release = conn.onRejected((r) => {
      const text = this.sent.get(r.clientSeq);
      if (text === undefined) return;
      this.sent.delete(r.clientSeq);
      if ((r.action as { type?: string }).type === ActionType.ChatTurnStarted) this.started = undefined;
      onRefused(text, r.reason);
    });
  }

  dispose(): void {
    this.release();
  }

  /** True while a turn is running, or one this client started has not come back yet. */
  busy(state: ChatState): boolean {
    if (state.activeTurn) return true;
    const s = this.started;
    return s !== undefined && !state.turns.some((t) => t.id === s);
  }

  readonly send = (text: string): boolean => {
    const uri = this.chat();
    const state = uri ? this.conn.chat(uri) : undefined;
    if (!uri || !state) return false;
    const busy = this.busy(state);
    const action: StateAction = busy ? pendingMessage("queued", text) : turnStarted(text);
    const r = this.conn.dispatch(uri, action);
    if (!r.ok) return false;
    if (!busy) this.started = (action as unknown as { turnId: string }).turnId;
    this.sent.set(r.clientSeq, text);
    if (this.sent.size > 200) this.sent.delete(this.sent.keys().next().value as number);
    return true;
  };
}

// ───────────────────────────── the transcript ─────────────────────────────

export type Line =
  | { kind: "you"; text: string; at: string | undefined }
  | { kind: "coach"; text: string; at: string | undefined; streaming: boolean }
  | { kind: "tool"; text: string; at: string | undefined }
  | { kind: "host"; text: string; at: string | undefined };

const SPARRING_TOOL = "mcp__sparring__";

const plain = (v: unknown): string =>
  typeof v === "string" ? v : v && typeof v === "object" && "markdown" in v ? String(v.markdown) : "";

const oneLine = (s: string, max = 140): string => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** A tool call as one mono line: its name without the Sparring prefix, then what it did. */
export function toolLine(tc: {
  toolName: string;
  displayName: string;
  pastTenseMessage?: unknown;
  invocationMessage?: unknown;
}): string {
  const name = tc.toolName.startsWith(SPARRING_TOOL)
    ? tc.toolName.slice(SPARRING_TOOL.length)
    : tc.displayName || tc.toolName;
  const said = oneLine(plain(tc.pastTenseMessage) || plain(tc.invocationMessage));
  return said && said !== name && said !== tc.displayName ? `${name} · ${said}` : name;
}

interface TurnError {
  errorType?: string;
  message?: string;
  _meta?: Record<string, unknown>;
}

const SIGN_IN =
  /sign[\s-]?in|auth(?:entication|_required|Required)?\b|not logged in|log ?in required|-32000/i;

/**
 * A failed turn as a host line. A failure for sign-in (the adapter's -32000, an auth error type, or the
 * daemon's own `sign-in needed` words) reads `sign-in needed · claude`; anything else reads `error · <message>`.
 */
export function errorLine(error: TurnError | undefined): string {
  const message = String(error?.message ?? "").trim();
  if (/^sign-in needed\b/.test(message)) return message;
  if (SIGN_IN.test(String(error?.errorType ?? "")) || SIGN_IN.test(message)) {
    const provider = error?._meta?.provider;
    return `sign-in needed · ${typeof provider === "string" && provider ? provider : "claude"}`;
  }
  return `error · ${message || "the turn failed"}`;
}

function partsToLines(
  parts: ResponsePart[],
  at: string | undefined,
  streaming: boolean,
  host: boolean,
): Line[] {
  const out: Line[] = [];
  let text = "";
  const flush = (open: boolean) => {
    if (text.trim())
      out.push(host ? { kind: "host", text, at } : { kind: "coach", text, at, streaming: open });
    text = "";
  };
  for (const p of parts) {
    switch (p.kind as string) {
      case "markdown":
        text += (p as { content: string }).content;
        break;
      case "toolCall":
        flush(false);
        out.push({
          kind: "tool",
          text: toolLine((p as { toolCall: Parameters<typeof toolLine>[0] }).toolCall),
          at,
        });
        break;
      case "systemNotification":
        flush(false);
        out.push({ kind: "host", text: plain((p as { content: unknown }).content), at });
        break;
      case "error":
        flush(false);
        out.push({ kind: "host", text: errorLine((p as { error: TurnError }).error), at });
        break;
      default:
        break;
    }
  }
  flush(streaming);
  return out;
}

/** The chat as transcript lines, oldest first, the running turn last. */
export function transcript(chat: ChatState | undefined): Line[] {
  if (!chat) return [];
  const out: Line[] = [];
  const turns = [...chat.turns, ...(chat.activeTurn ? [chat.activeTurn] : [])];
  turns.forEach((t, n) => {
    const at = t.startedAt;
    const host = (t.message.origin as { kind?: string } | undefined)?.kind === "systemNotification";
    if (t.message.text.trim()) out.push({ kind: host ? "host" : "you", text: t.message.text, at });
    const streaming = n === turns.length - 1 && chat.activeTurn !== undefined;
    out.push(...partsToLines(t.responseParts, at, streaming, host));
  });
  return out;
}

/** Messages the host holds for after the running turn. */
export function hostQueued(chat: ChatState | undefined): string[] {
  return (chat?.queuedMessages ?? []).map((m) => m.message.text);
}
