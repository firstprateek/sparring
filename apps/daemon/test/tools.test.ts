// The MCP tools as the daemon serves them, and the socket the proxy reaches them through.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Articles, appendUnder, sha256 } from "../src/articles.ts";
import { type Db, openDb } from "../src/db.ts";
import { listenMcp, type McpSocket } from "../src/mcp-socket.ts";
import { migrate } from "../src/schema.ts";
import { BRIEF_MAX, Tools, WRITE_REFUSED } from "../src/tools.ts";

let dir: string;
let db: Db;
let articles: Articles;
let tools: Tools;
let secret: string;
let owner: string[];
let refused: string[];
let changed: number;
let id: string;
const DUMP = "I close the laptop at six.\n\nNobody noticed for a month.\n";

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "sparring-tools-"));
  db = await openDb(":memory:");
  migrate(db);
  articles = new Articles(db, dir, { gitName: "T", gitEmail: "t@l", defaultProvider: "demo" });
  await articles.init();
  const row = await articles.create("a", "demo", undefined, { dump: DUMP });
  id = row.id;
  tools = new Tools(articles);
  owner = [];
  refused = [];
  changed = 0;
  tools.hooks = {
    ownerMessages: () => owner,
    refused: (_id, text) => refused.push(text),
    changed: () => changed++,
  };
  secret = tools.issue(id);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const note = (args: Record<string, unknown>) => tools.call(secret, "note_brief", args);

describe("note_brief", () => {
  it("takes a quote from dump.md, appends it under ## Quotes and the question under ## Questions", async () => {
    const r = await note({
      topic: "thesis",
      quote: "I close the laptop at six.",
      question: "Six, or whenever?",
    });
    expect(r).toEqual({ ok: true, text: "noted thesis · interview 1/6 · 1 of 12 entries" });
    expect(readFileSync(join(dir, "a", "brief.md"), "utf8")).toBe(
      '## Quotes\n\n- thesis: "I close the laptop at six."\n\n## Questions\n\n- thesis: Six, or whenever?\n',
    );
    const row = articles.row("a");
    expect(JSON.parse(String(row.brief_notes_json))).toEqual([
      { topic: "thesis", quote: "I close the laptop at six.", question: "Six, or whenever?" },
    ]);
    expect(row.comments_rev).toBe(1);
    expect(articles.metaFor(row)).toMatchObject({ covered: ["thesis"], commentsRev: 1 });
    expect(changed).toBe(1);
  });

  it("takes a quote from one of the owner's messages", async () => {
    owner = ["The reader is a lead who answers Slack at ten."];
    expect((await note({ topic: "reader", quote: "a lead who answers Slack at ten" })).ok).toBe(true);
  });

  it("refuses a quote that is in neither dump.md nor an owner message", async () => {
    owner = ["something else"];
    const r = await note({ topic: "thesis", quote: "I close my laptop at six." });
    expect(r).toEqual({
      ok: false,
      error: "quote the writer exactly: the quote must be an exact substring of dump.md or a writer message",
    });
    expect(readFileSync(join(dir, "a", "brief.md"), "utf8")).toBe("");
    expect(articles.row("a").comments_rev).toBe(0);
  });

  it("refuses the 13th entry", async () => {
    for (let i = 0; i < BRIEF_MAX; i++)
      expect((await note({ topic: "evidence", quote: "Nobody noticed" })).ok).toBe(true);
    expect(await note({ topic: "scar", quote: "Nobody noticed" })).toEqual({
      ok: false,
      error: "the brief holds at most 12 entries",
    });
    expect(JSON.parse(String(articles.row("a").brief_notes_json))).toHaveLength(12);
  });

  it("refuses a question with a leading # or >, over 200 characters, or on two lines; and a bad topic", async () => {
    const q = (question: string) => note({ topic: "thesis", quote: "I close", question });
    expect(await q("## A heading")).toEqual({ ok: false, error: "question cannot start with # or >" });
    expect(await q("  # still a heading")).toEqual({ ok: false, error: "question cannot start with # or >" });
    expect(await q("> a quote")).toEqual({ ok: false, error: "question cannot start with # or >" });
    expect(await q("x".repeat(201))).toEqual({ ok: false, error: "question is at most 200 characters" });
    expect(await q("one\ntwo")).toEqual({ ok: false, error: "question is one line" });
    expect((await q("x".repeat(200))).ok).toBe(true);
    expect((await note({ topic: "arc", quote: "I close" })).ok).toBe(false);
    expect((await note({ topic: "thesis", quote: "" })).ok).toBe(false);
  });
});

describe("the other tools", () => {
  it("read_article numbers the lines; read_source reads dump, brief, style and pass files only", async () => {
    writeFileSync(join(dir, "a", "article.md"), "one\ntwo\n");
    expect(await tools.call(secret, "read_article", {})).toEqual({ ok: true, text: "1  one\n2  two" });
    expect(await tools.call(secret, "read_source", { name: "dump" })).toEqual({ ok: true, text: DUMP });
    expect(await tools.call(secret, "read_source", { name: "brief" })).toEqual({
      ok: true,
      text: "(brief.md is empty)",
    });
    expect((await tools.call(secret, "read_source", { name: "style" })).ok).toBe(true);
    // a built-in pass is in ~/writing/passes from the start; any other name is no pass
    expect(await tools.call(secret, "read_source", { name: "pass:filler" })).toMatchObject({
      ok: true,
      text: expect.stringMatching(/^Pass: filler\./),
    });
    expect(await tools.call(secret, "read_source", { name: "pass:nope" })).toEqual({
      ok: false,
      error: "no pass nope",
    });
    expect((await tools.call(secret, "read_source", { name: "pass:../../etc/passwd" })).ok).toBe(false);
    expect((await tools.call(secret, "read_source", { name: "article" })).ok).toBe(false);
  });

  it("refuses write_draft without a grant, with the letter line", async () => {
    const r = await tools.call(secret, "write_draft", { blocks: ["A sentence."] });
    expect(r.ok).toBe(false);
    expect(refused).toEqual([WRITE_REFUSED]);
    expect(readFileSync(join(dir, "a", "article.md"), "utf8")).toBe("");
  });

  it("refuses a secret it did not give out, or took back", async () => {
    expect(await tools.call("nope", "read_article", {})).toEqual({
      ok: false,
      error: "unknown session secret",
    });
    tools.revoke(secret);
    expect((await tools.call(secret, "read_article", {})).ok).toBe(false);
  });
});

describe("appendUnder", () => {
  it("adds a section when it is missing, and appends inside one that exists", () => {
    expect(appendUnder("", "## Quotes", "- a")).toBe("## Quotes\n\n- a\n");
    expect(appendUnder("Thesis: mine.\n", "## Quotes", "- a")).toBe("Thesis: mine.\n\n## Quotes\n\n- a\n");
    const both = "## Quotes\n\n- a\n\n## Questions\n\n- q\n";
    expect(appendUnder(both, "## Quotes", "- b")).toBe("## Quotes\n\n- a\n- b\n\n## Questions\n\n- q\n");
    expect(appendUnder(both, "## Questions", "- r")).toBe("## Quotes\n\n- a\n\n## Questions\n\n- q\n- r\n");
    expect(appendUnder("## Quotes\n## Arc\n", "## Quotes", "- a")).toBe("## Quotes\n\n- a\n\n## Arc\n");
  });
});

describe("the MCP socket", () => {
  let sockDir: string;
  let sock: McpSocket;
  beforeEach(async () => {
    // macOS caps a socket path at 104 bytes: a short folder
    sockDir = mkdtempSync(join(tmpdir(), "sp-"));
    sock = await listenMcp(join(sockDir, "run", "daemon.sock"), tools);
  });
  afterEach(async () => {
    await sock.close();
    rmSync(sockDir, { recursive: true, force: true });
  });

  /** Sends lines and collects the reply lines until the daemon closes or `n` replies came. */
  const exchange = (lines: unknown[], n: number) =>
    new Promise<{ replies: Record<string, unknown>[]; closed: boolean }>((resolve) => {
      const s = connect(sock.path);
      const replies: Record<string, unknown>[] = [];
      let closed = false;
      const done = () => resolve({ replies, closed });
      createInterface({ input: s }).on("line", (l) => {
        replies.push(JSON.parse(l));
        if (replies.length === n) {
          s.end();
          setTimeout(done, 20);
        }
      });
      s.on("close", () => {
        closed = true;
        done();
      });
      s.on("connect", () => s.write(lines.map((l) => `${JSON.stringify(l)}\n`).join("")));
    });

  it("is 0600 in a 0700 folder", () => {
    expect(statSync(sock.path).mode & 0o777).toBe(0o600);
    expect(statSync(join(sockDir, "run")).mode & 0o777).toBe(0o700);
  });

  it("takes the hello and serves tool calls for the right secret, in order", async () => {
    const { replies } = await exchange(
      [
        { secret, hello: true },
        { secret, tool: "read_source", args: { name: "dump" } },
        { secret, tool: "note_brief", args: { topic: "scar", quote: "Nobody noticed for a month." } },
      ],
      3,
    );
    expect(replies).toEqual([
      { ok: true },
      { ok: true, text: DUMP },
      { ok: true, text: "noted scar · interview 1/6 · 1 of 12 entries" },
    ]);
    expect(tools.greeted(secret)).toBe(true);
  });

  it("refuses a wrong secret once and closes the connection", async () => {
    const { replies, closed } = await exchange(
      [
        { secret: "f".repeat(48), hello: true },
        { secret, tool: "read_article", args: {} },
      ],
      2,
    );
    expect(replies).toEqual([{ ok: false, error: "unknown session secret" }]);
    expect(closed).toBe(true);
  });

  it("carries a call from the real proxy, packages/mcp/src/server.ts, hello first", async () => {
    const server = new URL("../../../packages/mcp/src/server.ts", import.meta.url).pathname;
    const child = spawn(process.execPath, [server], {
      env: { PATH: process.env.PATH ?? "", SPARRING_MCP_SOCK: sock.path, SPARRING_MCP_SECRET: secret },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const out = createInterface({ input: child.stdout });
    const replies = new Map<number, Record<string, unknown>>();
    out.on("line", (l) => {
      const m = JSON.parse(l);
      if (typeof m.id === "number") replies.set(m.id, m);
    });
    const send = (m: Record<string, unknown>) =>
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`);
    const reply = async (id: number) => {
      for (let i = 0; i < 400 && !replies.has(id); i++) await new Promise((r) => setTimeout(r, 25));
      return replies.get(id) as Record<string, unknown> & { result: { content: { text: string }[] } };
    };
    try {
      send({
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
      });
      await reply(1);
      send({ method: "notifications/initialized" });
      for (let i = 0; i < 200 && !tools.greeted(secret); i++) await new Promise((r) => setTimeout(r, 25));
      expect(tools.greeted(secret)).toBe(true);
      send({ id: 2, method: "tools/call", params: { name: "read_source", arguments: { name: "dump" } } });
      expect((await reply(2)).result.content[0]?.text).toBe(DUMP);
    } finally {
      child.kill();
    }
  });
});

// The sample article, dump, brief and notes of the approved mocks, read from the mock pages themselves.
const MOCKS = join(import.meta.dirname, "../../../mocks");
function mockArray(html: string, name: string): string[] {
  const m = new RegExp(`const ${name} = \\[([\\s\\S]*?)\\n\\];`).exec(html);
  if (!m) throw new Error(`no ${name} in the mock`);
  return new Function(`return [${m[1]}];`)() as string[];
}
interface MockNote {
  id: string;
  kind: string;
  brief: string;
  span: string;
  body: string;
  v2?: string;
}
function mockNotes(html: string): MockNote[] {
  return [...html.matchAll(/^\s*(\{ id: 'c\d+', kind: .*\}),?\s*$/gm)].map(
    (m) => new Function(`return ${m[1]};`)() as MockNote,
  );
}

describe("comment", () => {
  const room = readFileSync(join(MOCKS, "room.html"), "utf8");
  const phone = readFileSync(join(MOCKS, "phone.html"), "utf8");
  const ARTICLE = `${mockArray(room, "ARTICLE").join("\n\n")}\n`;
  const SAMPLE_DUMP = `${mockArray(room, "DUMP").join("\n\n")}\n`;
  const BRIEF = `${mockArray(room, "BRIEF").join("\n\n")}\n`;
  const comment = (args: Record<string, unknown>) => tools.call(secret, "comment", args);
  const resolve = (args: Record<string, unknown>) => tools.call(secret, "resolve_comment", args);

  beforeEach(async () => {
    const put = async (file: "article" | "dump" | "brief", text: string) => {
      const disk = readFileSync(join(dir, "a", `${file}.md`), "utf8");
      await articles.save("a", file, text, sha256(disk), true);
    };
    await put("article", ARTICLE);
    await put("dump", SAMPLE_DUMP);
    await put("brief", BRIEF);
    changed = 0;
  });

  it("accepts every sample note in the mocks, and the sharpened one", async () => {
    const samples = [...mockNotes(room), ...mockNotes(phone)];
    const byId = new Map(samples.map((n) => [n.id, n]));
    expect([...byId.keys()].sort()).toEqual(["c07", "c08", "c09", "c10", "c11", "c12"]);
    // the room and the phone show the same notes
    for (const n of samples) expect(byId.get(n.id)).toMatchObject({ span: n.span, body: n.body });
    const made = new Map<string, string>();
    for (const n of byId.values()) {
      const r = await comment({
        anchor: n.span,
        kind: n.kind,
        body: n.body,
        pass: n.kind === "filler" || n.kind === "voice" ? n.kind : "critique",
        brief_line: n.brief,
      });
      expect(r, `${n.id}: ${n.body}`).toMatchObject({ ok: true });
      made.set(n.id, (r as { text: string }).text.slice(0, 3));
    }
    const notes = articles.comments(id);
    expect(notes).toHaveLength(6);
    expect(notes.map((n) => n.brief_line)).toEqual(["arc", "evidence", null, "counter", "scar", "thesis"]);
    expect(notes[0]).toMatchObject({
      id: "c01",
      kind: "unclear",
      pass: "critique",
      span: "about six things nobody wrote down",
      status: "open",
    });
    expect(notes[0]?.block_orig).toMatch(/^The setup is ordinary\./);
    expect(articles.row("a").comments_rev).toBe(6);
    expect(changed).toBe(6);
    // c09's v2, as the mock has it, passes the same rule
    const v2 = byId.get("c09")?.v2 ?? "";
    expect(v2).toContain('"on wake, the daemon reconciles"');
    const sharp = await resolve({ id: made.get("c09"), action: "sharpen", body: v2 });
    expect(sharp).toMatchObject({ ok: true });
    expect(articles.comment(id, made.get("c09") ?? "")).toMatchObject({ status: "disagreed", body_v2: v2 });
  });

  it("answers with the note as text: id, kind and paragraph, span, body", async () => {
    const r = await comment({
      anchor: "It is important to note that",
      kind: "filler",
      body: "Six words before the sentence starts.",
      pass: "filler",
    });
    expect(r).toEqual({
      ok: true,
      text: 'c01 · filler · ¶6\n"It is important to note that"\nSix words before the sentence starts.',
    });
  });

  it("refuses a body with a quoted phrase that is in none of the four sources", async () => {
    owner = ["I measured it once, on the office wifi."];
    const anchor = "the server dropped it after thirty seconds of silence";
    const r = await comment({
      anchor,
      kind: "unsupported",
      body: 'Which server? Say "the gateway closed idle sockets after half a minute" or cut the number.',
      pass: "critique",
    });
    expect(r).toEqual({
      ok: false,
      error:
        '"the gateway closed idle sockets after half a minute" is not the writer\'s text: every double-quoted span must be an exact substring of article.md, dump.md, brief.md or a writer message',
    });
    expect(articles.comments(id)).toEqual([]);
    expect(changed).toBe(0);
    // each of the four sources is enough: the article, the dump, the brief, an owner message
    for (const quote of [
      "Every component is healthy.",
      "it just dropped",
      "They lose the week I lost.",
      "I measured it once",
    ]) {
      const body = `You say "${quote}" and the page does not carry it.`;
      expect(
        await comment({
          anchor: `${anchor.slice(0, 20 + articles.comments(id).length)}`,
          kind: "unclear",
          body,
          pass: "",
        }),
        quote,
      ).toMatchObject({ ok: true });
    }
  });

  it("refuses fix text, even made of the writer's words", async () => {
    const r = await comment({
      anchor: "It is important to note that",
      kind: "filler",
      body: 'Filler. Consider: "none of this is a crash"',
      pass: "filler",
    });
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/^no fix text/) });
  });

  it("refuses an anchor that is not in the article word for word, or that runs across paragraphs", async () => {
    const body = "Unclear.";
    expect(
      await comment({ anchor: "about six things nobody wrote up", kind: "unclear", body, pass: "" }),
    ).toEqual({
      ok: false,
      error: "quote the text exactly: the anchor must be an exact substring of article.md as it is now",
    });
    const across = "nobody wrote down.\n\n## What actually dies";
    expect(ARTICLE).toContain(across);
    expect(await comment({ anchor: across, kind: "unclear", body, pass: "" })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/inside one paragraph/),
    });
  });

  it("refuses a bad kind, a long body, another file, a second note on a flagged span and an eleventh in a turn", async () => {
    const anchor = "Every component is healthy.";
    const ok = { anchor, kind: "unclear", body: "Unclear.", pass: "" };
    expect(await comment({ ...ok, kind: "praise" })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/^kind is one of/),
    });
    expect(await comment({ ...ok, body: "x".repeat(281) })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/at most 280/),
    });
    expect(await comment({ ...ok, file: "dump" })).toMatchObject({ ok: false });
    expect(await comment({ ...ok, pass: "Not A Pass" })).toMatchObject({ ok: false });
    expect(await comment(ok)).toMatchObject({ ok: true });
    expect(await comment(ok)).toEqual({ ok: false, error: "c01 already flags this span" });
    // a note left outside a named pass is filed under the stage
    expect(articles.comments(id)[0]?.pass).toBe("ideas");
    tools.hooks.turn = () => ({ turnId: "t1", pass: "critique" });
    const words = ARTICLE.match(/[A-Za-z]{6,}/g) ?? [];
    let made = 0;
    for (const w of new Set(words)) {
      const r = await comment({ ...ok, anchor: w });
      if (!r.ok) {
        expect(r.error).toBe("at most 10 notes in one turn: stop here");
        break;
      }
      made++;
    }
    expect(made).toBe(10);
  });

  it("refuses a note while the coach is quiet", async () => {
    articles.setQuiet(id, true);
    expect(
      await comment({ anchor: "Every component is healthy.", kind: "unclear", body: "Unclear.", pass: "" }),
    ).toMatchObject({
      ok: false,
      error: expect.stringMatching(/^the coach is quiet/),
    });
  });

  it("resolve_comment withdraws or sharpens a live note, and nothing else", async () => {
    await comment({ anchor: "Every component is healthy.", kind: "unclear", body: "Unclear.", pass: "" });
    expect(await resolve({ id: "c09", action: "withdraw" })).toEqual({ ok: false, error: "no note c09" });
    expect(await resolve({ id: "c01", action: "delete" })).toMatchObject({ ok: false });
    expect(await resolve({ id: "c01", action: "sharpen" })).toEqual({
      ok: false,
      error: "a sharpened note needs a body",
    });
    expect(await resolve({ id: "c01", action: "sharpen", body: 'Try: "All of it is fine."' })).toMatchObject({
      ok: false,
    });
    expect(await resolve({ id: "c01", action: "withdraw", body: "Fair. The next line covers it." })).toEqual({
      ok: true,
      text: "c01 withdrawn",
    });
    expect(articles.comment(id, "c01")).toMatchObject({
      status: "withdrawn",
      body_v2: "Fair. The next line covers it.",
    });
    expect(await resolve({ id: "c01", action: "sharpen", body: "Again." })).toEqual({
      ok: false,
      error: "c01 is withdrawn: nothing to resolve",
    });
  });
});
