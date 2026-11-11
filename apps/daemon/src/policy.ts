// policy.ts: the host's answer to every `session/request_permission`, for every engine (design section 3, the
// guard, layer 3). Nothing is ever left to a client.
//
// A request is a Sparring call when `toolCall._meta.claudeCode.mcpServer.name` is `sparring`; the `mcp__sparring__`
// name prefix is the fallback. A Sparring call gets the offered option of kind `allow_once` (`write_draft` only
// while the article's draft grant is live). Everything else is rejected with the first offered option of kind
// `reject_once`, else `reject_always`, else `{outcome: "cancelled"}`. The host never answers `allow_always`, and
// never sends an `optionId` that is not in `params.options`, because the adapter throws on one.

type Json = Record<string, unknown>;

export const SPARRING_PREFIX = "mcp__sparring__";

export type PermissionOutcome = { outcome: "selected"; optionId: string } | { outcome: "cancelled" };

export interface Decision {
  /** The JSON-RPC result for the agent. */
  result: { outcome: PermissionOutcome };
  allowed: boolean;
  /** Was it a Sparring tool call? */
  sparring: boolean;
  /** The Sparring tool's bare name (`note_brief`), or the call's own name for anything else. */
  tool: string;
  /** The call's title, for the log and the letter line. */
  title: string;
  /** The option kind that was picked, or `cancelled`. */
  picked: string;
}

export interface PolicyContext {
  /** Is a single-use draft grant live for this article? Only then may `write_draft` be allowed. */
  grantLive?: boolean;
}

const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

function claudeMeta(toolCall: Json): Json {
  const meta = isObj(toolCall._meta) ? toolCall._meta : {};
  return isObj(meta.claudeCode) ? meta.claudeCode : {};
}

/** The tool's name as the agent reports it: `_meta.claudeCode.toolName`, else the title. */
export function toolNameOf(toolCall: Json): string {
  const name = claudeMeta(toolCall).toolName;
  if (typeof name === "string" && name) return name;
  return typeof toolCall.title === "string" ? toolCall.title : "";
}

/** Is this a call to a Sparring tool: by the MCP server name, else by the `mcp__sparring__` prefix. */
export function isSparringCall(toolCall: Json): boolean {
  const server = claudeMeta(toolCall).mcpServer;
  if (isObj(server) && server.name === "sparring") return true;
  const named = claudeMeta(toolCall).toolName;
  return [named, toolCall.title].some((n) => typeof n === "string" && n.startsWith(SPARRING_PREFIX));
}

/** The bare Sparring tool name (`note_brief`) of a Sparring call. */
function sparringTool(toolCall: Json): string {
  const name = toolNameOf(toolCall);
  return name.startsWith(SPARRING_PREFIX) ? name.slice(SPARRING_PREFIX.length) : name;
}

/** Answers one `session/request_permission`. Pure: the caller logs and records what it decided. */
export function decide(params: Json, ctx: PolicyContext = {}): Decision {
  const toolCall = isObj(params.toolCall) ? params.toolCall : {};
  const options = (Array.isArray(params.options) ? params.options : []).filter(
    (o): o is Json => isObj(o) && typeof o.optionId === "string" && o.optionId !== "",
  );
  const sparring = isSparringCall(toolCall);
  const tool = sparring ? sparringTool(toolCall) : toolNameOf(toolCall);
  const title = typeof toolCall.title === "string" ? toolCall.title : tool;
  const allow = sparring && (tool !== "write_draft" || ctx.grantLive === true);
  const pick = allow
    ? options.find((o) => o.kind === "allow_once")
    : (options.find((o) => o.kind === "reject_once") ?? options.find((o) => o.kind === "reject_always"));
  // A Sparring call with no allow_once on offer is not allowed some other way: it falls to the reject path.
  const fallback =
    allow && !pick
      ? (options.find((o) => o.kind === "reject_once") ?? options.find((o) => o.kind === "reject_always"))
      : undefined;
  const chosen = pick ?? fallback;
  return {
    result: {
      outcome: chosen ? { outcome: "selected", optionId: String(chosen.optionId) } : { outcome: "cancelled" },
    },
    allowed: allow && pick !== undefined,
    sparring,
    tool,
    title,
    picked: chosen ? String(chosen.kind) : "cancelled",
  };
}
