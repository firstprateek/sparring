// Lifted from firstprateek/i-inc at 274b42b.
// Trimmed for Sparring.
// What the host keeps from an agent: every string and every action capped, and credentials taken out of tool
// calls. Message and reply text is never redacted, so a 40-character commit id reaches the chat unchanged. Tool
// input, tool output and tool-call paths go through `redactTokens`, which knows only the unmistakable forms.
import type { Json } from "./wire.ts";

/** Keys whose string values are free text in a tool call. */
const TOOL_TEXT_KEYS = new Set([
  "content",
  "text",
  "toolInput",
  "partialInput",
  "invocationMessage",
  "pastTenseMessage",
  "confirmationTitle",
  "message",
  "displayName",
  "path",
]);

export interface Caps {
  /** The longest string kept, in UTF-16 units. */
  maxString: number;
  /** The most an action may take once serialised (bytes, roughly). */
  maxAction: number;
  /** The most text a streamed part of a reply may grow to. */
  maxPart: number;
}

export const defaultCaps: Caps = { maxString: 64 * 1024, maxAction: 1024 * 1024, maxPart: 2 * 1024 * 1024 };

const marker = (n: number) => `\n[…${n} more characters not kept]`;

/** A private key block goes whole, through its end marker or, with none, through the end of the text. */
const PEM =
  /-----BEGIN [A-Z ]{0,30}PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z ]{0,30}PRIVATE KEY(?: BLOCK)?-----|$)/g;
// Everything between `://` and the last `@` before the path: a password may hold an `@`.
const USERINFO = /([a-z][a-z0-9+.-]{0,30}:\/\/)[^/\s?#]{1,400}@/gi;
const SECRET_QUERY =
  /([?&;](?:access_token|refresh_token|id_token|token|key|api_key|apikey|sig|signature|secret|client_secret|password|passwd|pwd|pass|passphrase|code|auth|x-amz-[a-z0-9-]{1,40}|x-goog-[a-z0-9-]{1,40})=)[^&\s"'#<>]{1,2000}/gi;

/**
 * Only the patterns that are unmistakably credentials, so source code and prose come through: private key
 * blocks, URL userinfo, secret-looking query parameters, bearer headers and tokens of the known kinds (GitHub,
 * OpenAI and Anthropic, Google, Slack, AWS, JWTs, Stripe, npm). It leaves `token: string` in source code alone.
 */
export function redactTokens(text: string): string {
  let t = text.length > 1_000_000 ? text.slice(0, 1_000_000) : text;
  if (t.includes("PRIVATE KEY")) t = t.replace(PEM, "[private key]");
  t = t.replace(USERINFO, "$1[redacted]@").replace(SECRET_QUERY, "$1[redacted]");
  t = t.replace(/(bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi, "$1[redacted]");
  t = t.replace(/\b(?:ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{20,}\b/g, "[redacted]");
  t = t.replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[redacted]");
  t = t.replace(/\bAIza[0-9A-Za-z_-]{30,}\b/g, "[redacted]");
  t = t.replace(/\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g, "[redacted]");
  t = t.replace(/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\b/g, "[redacted]");
  t = t.replace(/\bAKIA[0-9A-Z]{16}\b/g, "[redacted]");
  t = t.replace(/\b(?:[sr]k_live|whsec)_[A-Za-z0-9]{8,}\b/g, "[redacted]");
  t = t.replace(/\bnpm_[A-Za-z0-9]{20,}\b/g, "[redacted]");
  return t.replace(
    /((?:aws[_-]?)?secret[_-]?(?:access[_-]?)?key["']?\s{0,5}[=:]\s{0,5}["']?)[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])/gi,
    "$1[redacted]",
  );
}

/**
 * A string kept to `max` characters. When it is redacted, that happens before it is cut, on the text with a
 * margin past the cut, and the cut backs up to a blank so it never falls inside a token.
 */
function keep(v: string, max: number, redact: boolean): string {
  if (v.length <= max) return redact ? redactTokens(v) : v;
  const head = v.slice(0, max + 1024);
  let r = redact ? redactTokens(head) : head;
  if (r.length > max) r = r.slice(0, max);
  if (redact) {
    const back = Math.min(512, Math.floor(r.length / 4));
    const blank = Math.max(r.lastIndexOf(" "), r.lastIndexOf("\n"));
    r = blank >= r.length - back && blank > 0 ? r.slice(0, blank) : r.slice(0, r.length - back);
  }
  return r + marker(v.length - r.length);
}

function walk(v: unknown, key: string | undefined, max: number, redact: boolean): unknown {
  if (typeof v === "string") {
    // `data` is base64 of an attached file: capped by the attachment checks, never cut here.
    if (key === "data") return v;
    return keep(v, max, redact && key !== undefined && TOOL_TEXT_KEYS.has(key));
  }
  if (Array.isArray(v)) return v.map((x) => walk(x, key, max, redact));
  if (v && typeof v === "object") {
    const out: Json = {};
    for (const [k, x] of Object.entries(v)) out[k] = walk(x, k, max, redact);
    return out;
  }
  return v;
}

const isToolCall = (a: unknown): boolean =>
  !!a && typeof a === "object" && String((a as Json).type ?? "").startsWith("chat/toolCall");

/**
 * An action from the backend, made safe to keep: a tool call's text fields redacted, strings capped, and the
 * whole action shrunk (shorter strings) if it is still over the cap.
 */
export function sanitizeAction<T>(action: T, caps: Pick<Caps, "maxString" | "maxAction"> = defaultCaps): T {
  let max = caps.maxString;
  let out = walk(action, undefined, max, isToolCall(action));
  // Strings are cut hard until the action fits: a tool that returns hundreds of big parts.
  while (JSON.stringify(out).length > caps.maxAction && max > 256) {
    max = Math.floor(max / 4);
    out = walk(out, undefined, max, false);
  }
  return out as T;
}
