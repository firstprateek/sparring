// The Sparring MCP proxy (design section 3, "MCP surface").
//
// A thin stdio MCP server. It exposes six tools and forwards each call as one JSON line
// `{secret, tool, args}` over the Unix socket named by SPARRING_MCP_SOCK, then returns the daemon's
// one-line reply: `{ok: true, text}` becomes text content, `{ok: false, error}` an isError result.
// The daemon maps the secret to the article and does all validation and every write. This file has
// no database and checks nothing beyond the schemas below.
//
// On start it also sends one `{secret, hello: true}` line, so the host can see the proxy connect
// before any tool is called (probe row A3). The reply to it is ignored.
//
// It runs under bun (the daemon spawns process.execPath) and under node 22.6+ (type stripping).
import { connect } from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

type Json = Record<string, unknown>;

const SOCK = process.env.SPARRING_MCP_SOCK ?? "";
const SECRET = process.env.SPARRING_MCP_SECRET ?? "";
const CALL_TIMEOUT_MS = 60_000;

const str = (description: string, extra: Json = {}): Json => ({ type: "string", description, ...extra });
const object = (properties: Json, required: string[]): Json => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

const TOOLS = [
  {
    name: "read_article",
    description: "Read article.md, with line numbers.",
    inputSchema: object({}, []),
  },
  {
    name: "read_source",
    description: "Read a source file: dump (dump.md), brief (brief.md), style (STYLE.md) or pass:<id>.",
    inputSchema: object(
      { name: str("dump, brief, style or pass:<id>", { pattern: "^(dump|brief|style|pass:.+)$" }) },
      ["name"],
    ),
  },
  {
    name: "comment",
    description:
      "Leave a note on the article. anchor must be an exact substring of the current article. " +
      "Every double-quoted span in body must be an exact substring of the article, dump, brief or an owner message.",
    inputSchema: object(
      {
        anchor: str("exact text from the article the note is about"),
        kind: {
          type: "string",
          enum: ["unclear", "unsupported", "counter", "detail", "filler", "voice", "typo", "tell"],
        },
        body: str("the note, at most 280 characters", { maxLength: 280 }),
        pass: str("the pass this note belongs to, or an empty string"),
        brief_line: str("the brief line a critique item serves"),
        file: str("the file the anchor is in; the article when left out"),
      },
      ["anchor", "kind", "body", "pass"],
    ),
  },
  {
    name: "resolve_comment",
    description: "Withdraw a note, or sharpen it with a new body.",
    inputSchema: object(
      {
        id: str("the note id, such as c12"),
        action: { type: "string", enum: ["withdraw", "sharpen"] },
        body: str("the sharpened note, at most 280 characters", { maxLength: 280 }),
      },
      ["id", "action"],
    ),
  },
  {
    name: "note_brief",
    description: "Add a quote, and optionally a question, to the brief.",
    inputSchema: object(
      {
        topic: { type: "string", enum: ["thesis", "reader", "evidence", "counter", "uncertainty", "scar"] },
        quote: str("an exact substring of dump.md or an owner chat message"),
        question: str("one line, at most 200 characters", { maxLength: 200 }),
      },
      ["topic", "quote"],
    ),
  },
  {
    name: "write_draft",
    description: "Write the draft. Refused unless the host has granted a draft turn.",
    inputSchema: object({ blocks: { type: "array", items: { type: "string" } } }, ["blocks"]),
  },
];

/** Sends one line and resolves with the first line that comes back. */
function exchange(line: Json, timeoutMs: number): Promise<Json> {
  return new Promise((resolve, reject) => {
    const socket = connect(SOCK);
    let buffer = "";
    const done = (error: Error | null, reply?: Json) => {
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(reply ?? {});
    };
    const timer = setTimeout(() => done(new Error("the daemon did not answer in time")), timeoutMs);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify(line)}\n`));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      try {
        done(null, JSON.parse(buffer.slice(0, end)) as Json);
      } catch {
        done(new Error("the daemon sent a reply that is not JSON"));
      }
    });
    socket.on("error", (error) => done(error));
    socket.on("close", () => done(new Error("the daemon closed the connection without a reply")));
  });
}

const server = new Server({ name: "sparring", version: "0.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const tool = request.params.name;
  const args = request.params.arguments ?? {};
  try {
    const reply = await exchange({ secret: SECRET, tool, args }, CALL_TIMEOUT_MS);
    if (reply.ok === true) return { content: [{ type: "text", text: String(reply.text ?? "") }] };
    return { content: [{ type: "text", text: String(reply.error ?? "the daemon refused") }], isError: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { content: [{ type: "text", text: `sparring is not reachable: ${message}` }], isError: true };
  }
});

await server.connect(new StdioServerTransport());
exchange({ secret: SECRET, hello: true }, 5_000).catch(() => {});
