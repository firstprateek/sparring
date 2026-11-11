// Step 3's done-when, daemon side, with no tokens: the scripted coach and a fake ACP child stand in for the real
// one. The guard (policy and tripwire), note_brief through the scripted coach, the continuation brief after a
// forced kill, /offline, a sign-in that is needed, the turn limit, the idle kill, the mode check, prompt assembly.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ResponsePartKind, ROOT, TurnState } from "../src/ahp/wire.ts";
import { sha256 } from "../src/articles.ts";
import {
  INTERRUPTED,
  MODE_REFUSED,
  OFFLINE_ON,
  OFFLINE_TURN,
  QUARANTINED,
  signInLine,
} from "../src/coach.ts";
import { DEMO_EDIT_TEXT, QUESTIONS } from "../src/demo-agent.ts";
import { WRITE_REFUSED } from "../src/tools.ts";
import { FakeLauncher } from "./ahp/fake-acp.ts";
import { type Any, TestClient } from "./ahp/support.ts";
import { meta, rig } from "./rig.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const b64 = (s: string) => Buffer.from(s).toString("base64");
const DUMP =
  "Closing the laptop at six gave me my evenings back. I thought it would cost me at work.\n\nIt did not, mostly.\n";

/** An article in the interview stage with a dump, and a client on its chat. */
async function interview(t: Awaited<ReturnType<typeof rig>>, slug = "closed-laptop", provider?: string) {
  const a = await t.article(slug, provider);
  const saved = await t.call("PUT", `/api/articles/${slug}/dump`, {
    text: DUMP,
    base_sha: sha256(""),
    commit: true,
  });
  expect(saved.status).toBe(200);
  const c = new TestClient(t.host);
  await c.init([ROOT, a.session, a.chat]);
  await t.say(c, a.chat, "/stage interview");
  return { a, c };
}

const parts = (t: Awaited<ReturnType<typeof rig>>, chat: string, i: number): Any[] =>
  (t.host.chatState(chat)?.turns[i]?.responseParts ?? []) as Any[];
const lines = (ps: Any[]) =>
  ps.filter((p) => p.kind === ResponsePartKind.SystemNotification).map((p) => p.content);
const turnRows = (t: Awaited<ReturnType<typeof rig>>) =>
  t.db.all<Any>("SELECT * FROM turns ORDER BY started_at, rowid");
const git = (dir: string, ...args: string[]) =>
  execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();

describe("the scripted coach in the interview", () => {
  it("asks to edit article.md and is rejected: the file is unchanged and the refusal is a letter line", async () => {
    const t = await rig();
    const { a, c } = await interview(t);
    const page = "My own first paragraph.\n";
    const put = await t.call("PUT", "/api/articles/closed-laptop/article", {
      text: page,
      base_sha: sha256(""),
    });
    expect(put.status).toBe(200);
    await t.say(c, a.chat, "Let's start.");
    const turn = t.host.chatState(a.chat)?.turns.at(-1);
    expect(turn?.state).toBe(TurnState.Complete);
    // the Edit was a tool call that failed, and the page is byte for byte what the owner saved
    const edit = turn?.responseParts.find(
      (p: Any) => p.kind === "toolCall" && /^Edit /.test(p.toolCall.displayName),
    );
    expect(edit).toBeTruthy();
    expect(readFileSync(join(t.dir, "closed-laptop", "article.md"), "utf8")).toBe(page);
    expect(readFileSync(join(t.dir, "closed-laptop", "article.md"), "utf8")).not.toContain(DEMO_EDIT_TEXT);
    expect(lines(parts(t, a.chat, (t.host.chatState(a.chat)?.turns.length ?? 0) - 1))).toContain(
      WRITE_REFUSED,
    );
    const m = meta(t.host, a.session);
    expect(m.letter.map((l: Any) => [l.kind, l.text])).toContainEqual(["refused", WRITE_REFUSED]);
    // the turn is recorded, with its violation; the question came back
    const row = turnRows(t).at(-1);
    expect(row).toMatchObject({ status: "done", stage: "interview", violation: 1, is_question: 1 });
    expect(turn?.responseParts.at(-1)).toMatchObject({
      kind: ResponsePartKind.Markdown,
      content: QUESTIONS[0],
    });
    expect(m.openQuestion).toBe(QUESTIONS[0]);
  });

  it("one note_brief moves covered to one topic, writes brief.md under ## Quotes and bumps commentsRev", async () => {
    const t = await rig();
    const { a, c } = await interview(t);
    expect(meta(t.host, a.session).covered).toEqual([]);
    await t.say(c, a.chat, "Ask away.");
    await sleep(40);
    const m = meta(t.host, a.session);
    expect(m.covered).toEqual(["thesis"]);
    expect(m.commentsRev).toBe(1);
    const brief = readFileSync(join(t.dir, "closed-laptop", "brief.md"), "utf8");
    expect(brief).toBe('## Quotes\n\n- thesis: "Closing the laptop at six gave me my evenings back."\n');
    // committed through the queue
    expect(git(t.dir, "log", "-1", "--format=%s")).toBe("brief note closed-laptop");
    const snap = await t.call("GET", "/api/articles/closed-laptop");
    expect(snap.body.briefNotes).toEqual([
      { topic: "thesis", quote: "Closing the laptop at six gave me my evenings back." },
    ]);
    // the tool call shows by its own name, with the daemon's answer as its result
    const note = parts(t, a.chat, (t.host.chatState(a.chat)?.turns.length ?? 0) - 1).find(
      (p) => p.kind === "toolCall" && p.toolCall.displayName === "note_brief",
    );
    expect(note?.toolCall.content[0].text).toBe("noted thesis · interview 1/6 · 1 of 12 entries");
    // the next turn notes the next sentence under the next topic
    await t.say(c, a.chat, "Go on.");
    await sleep(40);
    expect(meta(t.host, a.session).covered).toEqual(["thesis", "reader"]);
  });

  it("starts no process while /offline is on, and starts one again when it is off", async () => {
    const t = await rig();
    const a = await t.article("a");
    const c = new TestClient(t.host);
    await c.init([ROOT, a.session, a.chat]);
    await t.say(c, a.chat, "/offline");
    expect(t.articles.row("a").offline).toBe(1);
    expect(meta(t.host, a.session).offline).toBe(true);
    expect(lines(parts(t, a.chat, 0))).toEqual([OFFLINE_ON]);
    await t.say(c, a.chat, "hello coach");
    expect(lines(parts(t, a.chat, 1))).toEqual([OFFLINE_TURN]);
    expect(t.launches()).toBe(0);
    expect(turnRows(t)).toHaveLength(0);
    await t.say(c, a.chat, "/offline");
    expect(meta(t.host, a.session).offline).toBe(false);
    await t.say(c, a.chat, "hello coach");
    expect(t.launches()).toBe(1);
  });

  it("kills a live coach when /offline goes on", async () => {
    const fake = new FakeLauncher();
    const t = await rig({ launch: fake.launch });
    const a = await t.article("a");
    const c = new TestClient(t.host);
    await c.init([ROOT, a.chat]);
    await t.say(c, a.chat, "plain hi");
    expect(fake.live).toHaveLength(1);
    await t.say(c, a.chat, "/offline");
    await sleep(20);
    expect(fake.live).toHaveLength(0);
    expect(t.coach.hasAgent(a.id)).toBe(false);
  });
});

describe("the tripwire", () => {
  it("quarantines a change made behind the daemon's back and restores the page; restore it puts it back", async () => {
    const fake = new FakeLauncher();
    const t = await rig({ launch: fake.launch });
    const a = await t.article("a");
    const c = new TestClient(t.host);
    await c.init([ROOT, a.session, a.chat]);
    const page = "The owner's page.\n";
    await t.call("PUT", "/api/articles/a/article", { text: page, base_sha: sha256("") });
    const path = join(t.dir, "a", "article.md");
    const sneaky = "The agent's page.\n";
    await t.say(c, a.chat, `@@write ${b64(path)} ${b64(sneaky)} plain done`);
    // restored from the turn-start commit, byte for byte
    expect(readFileSync(path, "utf8")).toBe(page);
    const commitBefore = turnRows(t)[0].commit_before;
    expect(git(t.dir, "show", `${commitBefore}:a/article.md`)).toBe(page.trimEnd());
    // the changed text is kept at the quarantine ref; no file is written for it
    expect(git(t.dir, "show", "refs/sparring/quarantine/a:a/article.md")).toBe(sneaky.trimEnd());
    expect(git(t.dir, "ls-files", "a")).not.toContain("article.agent.md");
    expect(lines(parts(t, a.chat, 0))).toContain(QUARANTINED);
    await sleep(40);
    const m = meta(t.host, a.session);
    const line = m.letter.find((l: Any) => l.kind === "quarantine");
    expect(line.text).toBe(QUARANTINED);
    expect(m.articleSha).toBe(sha256(page));
    expect(turnRows(t)[0]).toMatchObject({ violation: 1 });
    // restore it: the page is committed, then the quarantined text comes back
    const res = await t.call("POST", `/api/articles/a/letter/${line.id}`, { action: "restore" });
    expect(res.status).toBe(200);
    expect(readFileSync(path, "utf8")).toBe(sneaky);
    expect(res.body.sha).toBe(sha256(sneaky));
    expect(git(t.dir, "log", "-2", "--format=%s")).toBe("restore quarantined a\nturn a");
    await sleep(40);
    expect(meta(t.host, a.session).letter.find((l: Any) => l.id === line.id)).toBeUndefined();
  });

  it("does not fire for a save made during the turn", async () => {
    const fake = new FakeLauncher();
    const t = await rig({ launch: fake.launch });
    const a = await t.article("a");
    const c = new TestClient(t.host);
    await c.init([ROOT, a.chat]);
    c.dispatch(a.chat, {
      type: "chat/turnStarted",
      turnId: "g",
      startedAt: new Date().toISOString(),
      message: { text: "gate", origin: { kind: "user" } },
    } as Any);
    await sleep(30);
    const saved = await t.call("PUT", "/api/articles/a/article", {
      text: "Saved mid-turn.\n",
      base_sha: sha256(""),
    });
    expect(saved.status).toBe(200);
    fake.last.gateOpen = true;
    await t.host.idle();
    expect(readFileSync(join(t.dir, "a", "article.md"), "utf8")).toBe("Saved mid-turn.\n");
    expect(turnRows(t)[0]).toMatchObject({ status: "done", violation: 0 });
  });
});

describe("a new child", () => {
  it("after a forced kill, opens its first prompt with the continuation brief: the first answer word for word", async () => {
    const fake = new FakeLauncher();
    const t = await rig({ launch: fake.launch });
    const { a, c } = await interview(t);
    const answer = "plain My claim: closing the laptop at six made me better at the job, not worse.";
    await t.say(c, a.chat, answer);
    await t.say(c, a.chat, "plain The reader is a lead who answers Slack at ten.");
    expect(fake.agents).toHaveLength(1);
    fake.last.kill();
    await sleep(20);
    await t.say(c, a.chat, "plain Next question?");
    expect(fake.agents).toHaveLength(2);
    const first = fake.last.prompts[0]?.blocks.map((b: Any) => b.text).join("\n") ?? "";
    expect(first).toContain("<continuation>");
    expect(first).toContain(answer);
    expect(first).toContain("Stage: interview");
    // the old child's prompts never carried one, and the new child's second prompt does not either
    expect(
      fake.agents[0]?.prompts.some((p) => p.blocks.some((b: Any) => /<continuation>/.test(b.text))),
    ).toBe(false);
    await t.say(c, a.chat, "plain again");
    expect(fake.last.prompts[1]?.blocks.some((b: Any) => /<continuation>/.test(b.text))).toBe(false);
    expect(turnRows(t).map((r) => r.status)).toEqual(["done", "done", "done", "done"]);
  });

  it("gets the rules first when the agent offers no systemPrompt, and through systemPrompt when it does", async () => {
    const fake = new FakeLauncher();
    const t = await rig({ launch: fake.launch });
    const a = await t.article("a");
    const c = new TestClient(t.host);
    await c.init([ROOT, a.chat]);
    await t.say(c, a.chat, "plain one");
    const blocks = fake.last.prompts[0]?.blocks as Any[];
    expect(blocks[0].text).toMatch(/^# Sparring: the coach's operating rules/);
    expect(blocks[0].text).toContain("STYLE.md, as it stands now:");
    expect(fake.last.requests("session/new")[0]?.params.systemPrompt).toBeUndefined();
    // the order: header, (stage prompt), article, message
    expect(blocks[1].text).toMatch(
      /^<sparring stage="ideas" pass="" strictness="normal" words="0" commit="[0-9a-f]{7}" open_comments="">$/,
    );
    expect(blocks[2].text).toMatch(/^Stage: ideas\./);
    expect(blocks[3].text).toBe("article.md is empty.");
    expect(blocks.at(-1)?.text).toBe("plain one");
    // the second prompt has no rules, and says the page has not changed
    await t.say(c, a.chat, "plain two");
    const second = fake.last.prompts[1]?.blocks as Any[];
    expect(second[0].text).toMatch(/^<sparring /);
    expect(second.map((b) => b.text)).toContain("article.md has not changed since you last saw it.");

    const fake2 = new FakeLauncher();
    fake2.options = { systemPrompt: true };
    const t2 = await rig({ launch: fake2.launch });
    const b = await t2.article("b");
    const c2 = new TestClient(t2.host);
    await c2.init([ROOT, b.chat]);
    await t2.say(c2, b.chat, "plain one");
    const sp = fake2.last.requests("session/new")[0]?.params.systemPrompt;
    expect(sp.mode).toBe("append");
    expect(sp.content[0].text).toMatch(/^# Sparring: the coach's operating rules/);
    expect((fake2.last.prompts[0]?.blocks ?? [])[0]?.text).toMatch(/^<sparring /);
  });

  it("is shown the page whole the first time, then a diff of what changed", async () => {
    const fake = new FakeLauncher();
    const t = await rig({ launch: fake.launch });
    const a = await t.article("a");
    const c = new TestClient(t.host);
    await c.init([ROOT, a.chat]);
    await t.call("PUT", "/api/articles/a/article", { text: "First line.\n", base_sha: sha256("") });
    await t.say(c, a.chat, "plain one");
    const texts = (i: number) => (fake.last.prompts[i]?.blocks ?? []).map((b: Any) => b.text).join("\n");
    expect(texts(0)).toContain("article.md as it stands (2 words):\n<article>\nFirst line.\n</article>");
    await t.call("PUT", "/api/articles/a/article", {
      text: "First line.\nSecond line.\n",
      base_sha: sha256("First line.\n"),
    });
    await t.say(c, a.chat, "plain two");
    expect(texts(1)).toContain("article.md changed since you last saw it:\n<diff>");
    expect(texts(1)).toContain("+Second line.");
  });
});

describe("the coach process", () => {
  it("shows sign-in needed on -32000, kills the child and starts none until /offline is toggled", async () => {
    const fake = new FakeLauncher();
    fake.options = { promptAuthRequired: true };
    const t = await rig({ claude: fake.launch });
    const a = await t.article("a", "claude");
    const c = new TestClient(t.host);
    await c.init([ROOT, a.session, a.chat]);
    await t.say(c, a.chat, "hello");
    expect(lines(parts(t, a.chat, 0))).toEqual([signInLine("claude")]);
    await sleep(20);
    expect(fake.live).toHaveLength(0);
    expect(meta(t.host, a.session)).toMatchObject({
      signInNeeded: true,
      offline: true,
      lastLine: "sign-in needed · claude",
    });
    await t.say(c, a.chat, "hello again");
    expect(lines(parts(t, a.chat, 1))).toEqual([signInLine("claude")]);
    expect(fake.agents).toHaveLength(1);
    expect(turnRows(t).map((r) => r.status)).toEqual(["failed"]);
    // /offline twice tries again
    await t.say(c, a.chat, "/offline");
    await t.say(c, a.chat, "/offline");
    fake.options = {};
    await t.say(c, a.chat, "plain back");
    expect(fake.agents).toHaveLength(2);
    expect(meta(t.host, a.session).signInNeeded).toBeUndefined();
  });

  it("cancels a turn at the limit and kills the child", async () => {
    const fake = new FakeLauncher();
    const t = await rig({ launch: fake.launch, turnLimitMs: 60 });
    const a = await t.article("a");
    const c = new TestClient(t.host);
    await c.init([ROOT, a.chat]);
    await t.say(c, a.chat, "hang on");
    const turn = t.host.chatState(a.chat)?.turns[0] as Any;
    expect(turn.state).toBe(TurnState.Error);
    expect(turn.responseParts.at(-1).error).toMatchObject({ errorType: "agent_timeout" });
    await sleep(20);
    expect(fake.last.cancels).toBe(1);
    expect(fake.live).toHaveLength(0);
    expect(turnRows(t)[0].status).toBe("failed");
  });

  it("lets an idle child go, but never one with a turn running", async () => {
    const fake = new FakeLauncher();
    const t = await rig({ launch: fake.launch, idleMs: 0 });
    const a = await t.article("a");
    const c = new TestClient(t.host);
    await c.init([ROOT, a.chat]);
    c.dispatch(a.chat, {
      type: "chat/turnStarted",
      turnId: "g",
      startedAt: new Date().toISOString(),
      message: { text: "gate", origin: { kind: "user" } },
    } as Any);
    await sleep(30);
    t.coach.sweep(Date.now() + 60 * 60_000);
    expect(fake.live).toHaveLength(1);
    fake.last.gateOpen = true;
    await t.host.idle();
    t.coach.sweep(Date.now() + 60 * 60_000);
    await sleep(20);
    expect(fake.live).toHaveLength(0);
    // the next message starts a new one
    await t.say(c, a.chat, "plain hi");
    expect(fake.agents).toHaveLength(2);
  });

  it("sets a session that starts in another mode back to default, and refuses to prompt when it cannot", async () => {
    const fake = new FakeLauncher();
    fake.options = { startMode: "acceptEdits" };
    const t = await rig({ launch: fake.launch });
    const a = await t.article("a");
    const c = new TestClient(t.host);
    await c.init([ROOT, a.chat]);
    await t.say(c, a.chat, "plain hi");
    expect(fake.last.requests("session/set_mode")[0]?.params).toMatchObject({ modeId: "default" });
    expect(fake.last.mode).toBe("default");
    expect(fake.last.prompts).toHaveLength(1);

    const stuck = new FakeLauncher();
    stuck.options = { startMode: "acceptEdits", refuseMode: true };
    const t2 = await rig({ launch: stuck.launch });
    const b = await t2.article("b");
    const c2 = new TestClient(t2.host);
    await c2.init([ROOT, b.chat]);
    await t2.say(c2, b.chat, "plain hi");
    expect(lines(parts(t2, b.chat, 0))).toEqual([MODE_REFUSED]);
    expect(stuck.last.prompts).toHaveLength(0);
  });

  it("ends a turn whose agent leaves default mode, sets it back and records the violation", async () => {
    const fake = new FakeLauncher();
    const t = await rig({ launch: fake.launch });
    const a = await t.article("a");
    const c = new TestClient(t.host);
    await c.init([ROOT, a.chat]);
    await t.say(c, a.chat, "modeswitch now");
    expect(lines(parts(t, a.chat, 0))).toEqual([
      "mode acceptEdits refused · set back to default · turn ended",
    ]);
    await sleep(20);
    expect(fake.last.mode).toBe("default");
    expect(fake.last.cancels).toBe(1);
    expect(turnRows(t)[0]).toMatchObject({ status: "failed", violation: 1 });
  });

  it("answers every permission request with policy: the fake's Edit is rejected with reject_once", async () => {
    const fake = new FakeLauncher();
    const t = await rig({ launch: fake.launch });
    const a = await t.article("a");
    const c = new TestClient(t.host);
    await c.init([ROOT, a.session, a.chat]);
    await t.say(c, a.chat, "edit the app");
    expect(fake.last.permissionAnswers).toEqual([{ outcome: "selected", optionId: "reject-once" }]);
    expect(
      t.host
        .chatState(a.chat)
        ?.turns[0]?.responseParts.some((p: Any) => p.content === "Understood, I left the file alone."),
    ).toBe(true);
    // tokens from the prompt's usage reach the article
    await sleep(40);
    expect(meta(t.host, a.session).tokens).toBe(1234);
    expect(t.articles.row("a")).toMatchObject({ tokens_in: 1200, tokens_out: 34 });
  });

  it("marks running turns interrupted at start, with the host line and a letter line", async () => {
    const t = await rig();
    const a = await t.article("a");
    t.db.run(
      "INSERT INTO turns (turn_id, article_id, origin, status, stage, started_at) VALUES ('x', ?, 'writer', 'running', 'ideas', ?)",
      a.id,
      new Date().toISOString(),
    );
    await t.coach.start();
    expect(turnRows(t)[0].status).toBe("interrupted");
    const last = t.host.chatState(a.chat)?.turns.at(-1) as Any;
    expect(last.responseParts[0]).toMatchObject({
      content: INTERRUPTED,
      _meta: { "sparring.line": "divider" },
    });
    expect(meta(t.host, a.session).letter.map((l: Any) => l.kind)).toEqual(["interrupted"]);
  });

  it("appends /idea to inbox.md with no agent", async () => {
    const t = await rig();
    const a = await t.article("a");
    const c = new TestClient(t.host);
    await c.init([ROOT, a.chat]);
    await t.say(c, a.chat, "/idea write about   the six o'clock rule");
    expect(lines(parts(t, a.chat, 0))).toEqual(["idea added to inbox.md"]);
    const inbox = readFileSync(join(t.dir, "inbox.md"), "utf8");
    expect(inbox).toMatch(/^- \d{4}-\d\d-\d\dT[\d:.]+Z write about the six o'clock rule\n$/);
    expect((await t.call("GET", "/api/inbox")).body).toEqual([
      { id: expect.any(String), date: expect.any(String), text: "write about the six o'clock rule" },
    ]);
    expect(t.launches()).toBe(0);
  });
});
