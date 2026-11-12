// The coach behind every article's session: the session and chat an article gets, `_meta.sparring`, the scripted
// coach answering through the real ACP path, and the commands the host answers itself.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ActionType, ResponsePartKind, ROOT, TurnState } from "../src/ahp/wire.ts";
import { Articles, sha256 } from "../src/articles.ts";
import { SESSION_META } from "../src/coach.ts";
import { openDb } from "../src/db.ts";
import { NO_MORE, QUESTIONS } from "../src/demo-agent.ts";
import { migrate } from "../src/schema.ts";
import { FakeLauncher } from "./ahp/fake-acp.ts";
import { type Any, TestClient, turnStarted } from "./ahp/support.ts";
import { dirs, meta, rig } from "./rig.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const plain = (x: unknown) => JSON.parse(JSON.stringify(x));

describe("an article's session", () => {
  it("is made with the article, and the root list shows it with _meta.sparring", async () => {
    const t = await rig();
    const root = new TestClient(t.host);
    await root.init([ROOT]);
    const a = await t.article("closed-laptop");
    expect(a.session).toBe(`ahp-session:/${a.id}`);
    expect(a.chat).toMatch(/^ahp-chat:\/[0-9a-f-]{36}$/);
    expect(t.articles.row("closed-laptop").chat).toBe(a.chat);
    const list = (await root.call("listSessions", { channel: ROOT })).items;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      resource: a.session,
      provider: "demo",
      title: "closed-laptop",
      defaultChat: a.chat,
      _meta: {
        sparring: {
          slug: "closed-laptop",
          provider: "demo",
          stage: "ideas",
          authorship: "coached",
          wordCount: 0,
          articleSha: sha256(""),
          commit: a.commit,
          openComments: 0,
          letter: [],
          publish: null,
          tokens: 0,
        },
      },
    });
    root.absorb();
    const added = root.notes.find((n) => n.method === "root/sessionAdded") as Any;
    expect(added.params.summary._meta.sparring.slug).toBe("closed-laptop");
    // the config is the host's own: three keys, no agent running
    const config = t.host.sessionState(a.session)?.config;
    expect(Object.keys(config?.schema.properties ?? {})).toEqual(["stage", "pass", "strictness"]);
    expect(config?.values).toEqual({ stage: "ideas", pass: "", strictness: "normal" });
    expect(t.launches()).toBe(0);
  });

  it("is made at start for an article that has none, and only once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sparring-coach-"));
    dirs.push(dir);
    const db = await openDb(join(dir, "sparring.db"));
    migrate(db);
    // an article from before step 2: a row and a folder, no session
    const before = new Articles(db, join(dir, "w"), {
      gitName: "T",
      gitEmail: "t@l",
      defaultProvider: "demo",
    });
    await before.init();
    await before.create("old-one");
    expect(before.row("old-one").chat).toBeNull();
    const t = await rig({ db, dir: join(dir, "w") });
    const row = t.articles.row("old-one");
    expect(row.chat).toMatch(/^ahp-chat:\//);
    expect(t.host.sessionState(`ahp-session:/${row.id}`)?.defaultChat).toBe(row.chat);
    expect(meta(t.host, `ahp-session:/${row.id}`).slug).toBe("old-one");
    await t.coach.start();
    expect(t.host.sessions()).toHaveLength(1);
    expect(t.articles.row("old-one").chat).toBe(row.chat);
  });

  it("can be made by an AHP client's createSession, with the slug in _meta", async () => {
    const t = await rig();
    const c = new TestClient(t.host);
    await c.init();
    const id = crypto.randomUUID();
    await c.call("createSession", {
      channel: `ahp-session:/${id}`,
      provider: "demo",
      _meta: { slug: "from-ahp" },
    });
    expect(t.articles.row("from-ahp").id).toBe(id);
    expect(t.host.sessionState(`ahp-session:/${id}`)?.title).toBe("from-ahp");
    const bad = await c.rpc("createSession", { channel: `ahp-session:/${crypto.randomUUID()}`, _meta: {} });
    expect(bad.error).toMatchObject({ code: -32602 });
    const slug = await c.rpc("createSession", {
      channel: `ahp-session:/${crypto.randomUUID()}`,
      _meta: { slug: "Not A Slug" },
    });
    expect(slug.error).toMatchObject({ code: -32602 });
    // an article's session stays
    expect((await c.rpc("disposeSession", { channel: `ahp-session:/${id}` })).error).toBeTruthy();
  });
});

describe("the scripted coach", () => {
  it("answers a client turn with the next interview question, streamed through ACP", async () => {
    const t = await rig();
    const a = await t.article("closed-laptop");
    const c = new TestClient(t.host);
    await c.init([ROOT, a.session, a.chat]);
    c.dispatch(a.chat, turnStarted("I want to write about closing the laptop at six", "t1"));
    await t.host.idle();
    const first = t.host.chatState(a.chat)?.turns[0];
    expect(first?.state).toBe(TurnState.Complete);
    expect(first?.responseParts).toEqual([
      { kind: ResponsePartKind.Markdown, id: expect.any(String), content: QUESTIONS[0] },
    ]);
    // it streamed: a part, then deltas
    expect(c.actions(a.chat).some((e) => e.action.type === ActionType.ChatDelta)).toBe(true);
    c.dispatch(a.chat, turnStarted("Close it and the evening is yours.", "t2"));
    await t.host.idle();
    expect(t.host.chatState(a.chat)?.turns[1]?.responseParts[0]).toMatchObject({ content: QUESTIONS[1] });
    expect(t.launches()).toBe(1); // one coach for the article, kept between turns
    expect(c.state(a.chat)).toEqual(plain(t.host.chatState(a.chat)));
  });

  it("says it has no more questions once the list is done", async () => {
    const t = await rig();
    const a = await t.article("a");
    const c = new TestClient(t.host);
    await c.init([ROOT, a.chat]);
    for (let i = 0; i <= QUESTIONS.length; i++) {
      c.dispatch(a.chat, turnStarted(`answer ${i}`));
      await t.host.idle();
    }
    expect(t.host.chatState(a.chat)?.turns.at(-1)?.responseParts[0]).toMatchObject({ content: NO_MORE });
  });

  it("answers a listed command this build cannot run, without waking the coach", async () => {
    const t = await rig();
    const a = await t.article("a");
    const c = new TestClient(t.host);
    await c.init([ROOT, a.chat]);
    // `/sendit` and `/publish` are the web client's; from another client they change nothing.
    for (const [i, cmd] of ["/sendit", "/publish"].entries()) {
      c.dispatch(a.chat, turnStarted(cmd, `t${i}`));
      await t.host.idle();
      expect(t.host.chatState(a.chat)?.turns[i]?.responseParts).toEqual([
        expect.objectContaining({
          content: expect.stringMatching(/opens in the web client · nothing changed/),
        }),
      ]);
    }
    expect(t.launches()).toBe(0);
  });

  it("runs any ACP agent the same way, and a cancel reaches it as session/cancel", async () => {
    const fake = new FakeLauncher();
    const t = await rig({ launch: fake.launch });
    const a = await t.article("a");
    const c = new TestClient(t.host);
    await c.init([ROOT, a.chat]);
    c.dispatch(a.chat, turnStarted("plain hello", "t1"));
    await t.host.idle();
    expect(t.host.chatState(a.chat)?.turns[0]?.responseParts[0]).toMatchObject({
      content: "You said: plain hello",
    });
    expect(fake.last.requests("initialize")[0]?.params).toMatchObject({
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "sparring" },
    });
    expect(fake.last.requests("session/new")[0]?.params).toEqual({
      cwd: join(t.dir, "a"),
      mcpServers: [
        {
          name: "sparring",
          command: process.execPath,
          args: [expect.stringMatching(/\/packages\/mcp\/src\/server\.ts$/)],
          env: [
            { name: "SPARRING_MCP_SOCK", value: "/tmp/sparring-test.sock" },
            { name: "SPARRING_MCP_SECRET", value: expect.stringMatching(/^[0-9a-f]{48}$/) },
          ],
        },
      ],
      _meta: SESSION_META,
    });
    c.dispatch(a.chat, turnStarted("slow down", "t2"));
    // The cancel is sent once the agent has the prompt, however busy the machine is.
    for (let i = 0; i < 400 && fake.last.prompts.length < 2; i++) await sleep(5);
    c.dispatch(a.chat, { type: ActionType.ChatTurnCancelled, turnId: "t2", duration: 0 });
    await t.host.idle();
    expect(t.host.chatState(a.chat)?.turns[1]?.state).toBe(TurnState.Cancelled);
    await sleep(20);
    expect(fake.last.cancels).toBe(1);
  });
});

describe("what the host answers itself", () => {
  it("sets the stage on /stage <name>, with one host line and no agent", async () => {
    const t = await rig();
    const a = await t.article("a");
    const c = new TestClient(t.host);
    await c.init([ROOT, a.session, a.chat]);
    c.dispatch(a.chat, turnStarted("/stage critique", "t1"));
    await t.host.idle();
    expect(t.launches()).toBe(0);
    expect(t.articles.row("a").stage).toBe("critique");
    expect(t.host.sessionState(a.session)?.config?.values.stage).toBe("critique");
    expect(meta(t.host, a.session)).toMatchObject({ stage: "critique", lastLine: "stage critique" });
    const turn = t.host.chatState(a.chat)?.turns[0];
    expect(turn?.state).toBe(TurnState.Complete);
    expect(turn?.responseParts).toEqual([
      {
        kind: ResponsePartKind.SystemNotification,
        content: "stage critique",
        _meta: { "sparring.line": "stage" },
      },
    ]);
    expect(c.state(a.session).config.values.stage).toBe("critique");
    // a stage that does not exist changes nothing
    c.dispatch(a.chat, turnStarted("/stage done", "t2"));
    await t.host.idle();
    expect(t.articles.row("a").stage).toBe("critique");
    expect(t.host.chatState(a.chat)?.turns[1]?.responseParts).toEqual([
      expect.objectContaining({
        content: expect.stringMatching(/^no stage "done"/),
        _meta: { "sparring.line": "refused" },
      }),
    ]);
    expect(t.launches()).toBe(0);
  });

  it("answers /sendit, /publish and /log from a client with one line, and changes nothing", async () => {
    const t = await rig();
    const a = await t.article("a");
    const c = new TestClient(t.host);
    await c.init([ROOT, a.chat]);
    for (const cmd of ["/sendit", "/publish", "/log"]) {
      c.dispatch(a.chat, turnStarted(cmd));
      await t.host.idle();
    }
    const parts = t.host.chatState(a.chat)?.turns.map((x) => x.responseParts) ?? [];
    expect(parts.map((p) => p.length)).toEqual([1, 1, 1]);
    expect(parts[0]?.[0]).toMatchObject({ content: "/sendit opens in the web client · nothing changed" });
    expect(t.launches()).toBe(0);
    expect(t.articles.row("a")).toMatchObject({ stage: "ideas", authorship: "coached" });
  });

  it("changes the stage on session/configChanged, with a host line of its own, and puts back a bad pass", async () => {
    const t = await rig();
    const a = await t.article("a");
    const c = new TestClient(t.host);
    await c.init([ROOT, a.session, a.chat]);
    c.dispatch(a.session, { type: ActionType.SessionConfigChanged, config: { stage: "draft" } });
    await sleep(10);
    expect(t.articles.row("a").stage).toBe("draft");
    const turn = t.host.chatState(a.chat)?.turns[0];
    expect(turn?.message.origin).toEqual({ kind: "systemNotification" });
    expect(turn?.responseParts[0]).toMatchObject({
      content: "stage draft",
      _meta: { "sparring.line": "stage" },
    });
    expect(meta(t.host, a.session).stage).toBe("draft");
    c.dispatch(a.session, { type: ActionType.SessionConfigChanged, config: { strictness: "every nit" } });
    c.dispatch(a.session, { type: ActionType.SessionConfigChanged, config: { pass: "../etc" } });
    c.dispatch(a.session, { type: ActionType.SessionConfigChanged, config: { stage: "publish" } });
    await sleep(10);
    expect(t.articles.row("a").strictness).toBe("every nit");
    expect(t.host.sessionState(a.session)?.config?.values).toEqual({
      stage: "draft",
      pass: "",
      strictness: "every nit",
    });
    expect(c.rejections().map((r) => r.rejectionReason)).toEqual(["publish is not a valid stage"]);
    expect(t.launches()).toBe(0);
  });

  it("answers a turn of a provider with no launch with a host line, and starts nothing", async () => {
    const t = await rig();
    const a = await t.article("a", "claude");
    const c = new TestClient(t.host);
    await c.init([ROOT, a.chat]);
    c.dispatch(a.chat, turnStarted("hello"));
    await t.host.idle();
    expect(t.host.chatState(a.chat)?.turns[0]?.responseParts).toEqual([
      {
        kind: ResponsePartKind.SystemNotification,
        content: "no coach for claude",
        _meta: { "sparring.line": "refused" },
      },
    ]);
    expect(meta(t.host, a.session).provider).toBe("claude");
    expect(t.launches()).toBe(0);
  });
});

describe("_meta.sparring", () => {
  it("follows a save, so the Articles row shows the new word count and save age", async () => {
    const t = await rig();
    const a = await t.article("a");
    const root = new TestClient(t.host);
    await root.init([ROOT]);
    const text = "One two three.\n\nFour five.\n";
    const saved = await t.call("PUT", "/api/articles/a/article", { text, base_sha: sha256("") });
    expect(saved.status).toBe(200);
    await sleep(60);
    expect(meta(t.host, a.session)).toMatchObject({ wordCount: 5, articleSha: sha256(text) });
    expect(Date.parse(meta(t.host, a.session).savedAt)).toBeGreaterThan(0);
    root.absorb();
    const changed = root.notes.filter((n) => n.method === "root/sessionSummaryChanged") as Any[];
    expect(changed.at(-1)?.params).toMatchObject({
      session: a.session,
      changes: { _meta: { sparring: { wordCount: 5 } } },
    });
    // Cmd+S makes a commit, and the commit is in the meta
    const cmd = await t.call("PUT", "/api/articles/a/article", {
      text: `${text}Six.\n`,
      base_sha: sha256(text),
      commit: true,
    });
    await sleep(60);
    expect(meta(t.host, a.session)).toMatchObject({ wordCount: 6, commit: cmd.body.commit });
    // a save that changes nothing the meta shows sends nothing
    const n = t.host.serverSeq;
    t.coach.pushMeta(a.id);
    expect(t.host.serverSeq).toBe(n);
  });
});
