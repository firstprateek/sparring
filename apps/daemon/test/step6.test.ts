// Step 6's done-when, daemon side, with no tokens: `write_draft` is accepted once under a grant and refused the
// second time; in coached mode it is refused with the `write refused` letter line; a failed draft leaves the page
// byte for byte; "coached again" restores the page byte for byte and the stage to `stage_before_draft`. (The
// provenance fixtures are in packages/protocol/test/provenance.test.ts.) Plus the route's refusals, the draft
// refs, the shelf, the quiet coach, the draft rules and the restart with an unspent grant.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ResponsePartKind, ROOT } from "../src/ahp/wire.ts";
import { sha256 } from "../src/articles.ts";
import { DRAFT_PASS, DRAFTED_NEXT_ASK } from "../src/coach.ts";
import { openDb } from "../src/db.ts";
import {
  DEMO_CLOSER,
  DRAFTED_NEXT_SAYS,
  DRAFTED_QUIET_SAYS,
  DRAFTED_SAYS,
  demoDraft,
  WRITE_REFUSED_SAYS,
} from "../src/demo-agent.ts";
import {
  DRAFT_EMPTY,
  DRAFT_FAILED,
  DRAFT_MAX_WORDS,
  draftProblem,
  draftText,
  MODE_COACHED,
  MODE_DRAFTED,
  SENDIT_LINE,
} from "../src/draft.ts";
import { DRAFTED_QUIET_LINE, DRAFTED_RULES, draftTurnPrompt } from "../src/prompt.ts";
import { WRITE_REFUSED } from "../src/tools.ts";
import { FakeLauncher } from "./ahp/fake-acp.ts";
import { type Any, TestClient } from "./ahp/support.ts";
import { dirs, meta, rig } from "./rig.ts";

type Rig = Awaited<ReturnType<typeof rig>>;

const SLUG = "closed-laptop";
const DUMP =
  "I closed the laptop at six and the build died with it.\n\nNobody told the runtime that a lid is a normal thing to close. I sat through a whole standup watching a spinner.\n";
const BRIEF =
  '## Quotes\n\n- thesis: "A lid is a normal thing to close."\n- reader: "People who run agents on a laptop."\n';
const PAGE = "## My outline\n\nThe lid, the spinner, the fix.\r\n\nA line with  two spaces, kept as typed.\n";
const AUTH = `/api/articles/${SLUG}/authorship`;

/** An article with a dump, a brief and a page of its own, in the outline stage, and a client on its chat. */
async function ready(t: Rig, o: { dump?: string; page?: string; stage?: string } = {}) {
  const a = await t.article(SLUG);
  const put = async (file: string, text: string) => {
    const r = await t.call("PUT", `/api/articles/${SLUG}/${file}`, {
      text,
      base_sha: sha256(""),
      commit: true,
    });
    expect(r.status).toBe(200);
  };
  if ((o.dump ?? DUMP) !== "") await put("dump", o.dump ?? DUMP);
  await put("brief", BRIEF);
  if ((o.page ?? PAGE) !== "") await put("article", o.page ?? PAGE);
  const c = new TestClient(t.host);
  await c.init([ROOT, a.session, a.chat]);
  await t.say(c, a.chat, `/stage ${o.stage ?? "outline"}`);
  return { a, c };
}

const disk = (t: Rig) => readFileSync(join(t.dir, SLUG, "article.md"), "utf8");
const row = (t: Rig) => t.articles.row(SLUG) as Any;
const turns = (t: Rig, chat: string) => (t.host.chatState(chat)?.turns ?? []) as Any[];
const allLines = (t: Rig, chat: string): string[] =>
  turns(t, chat).flatMap((x) =>
    (x.responseParts as Any[])
      .filter((p) => p.kind === ResponsePartKind.SystemNotification)
      .map((p) => p.content),
  );
const lineMeta = (t: Rig, chat: string, text: string): Any =>
  turns(t, chat)
    .flatMap((x) => x.responseParts as Any[])
    .find((p) => p.content === text)?._meta;
const said = (t: Rig, chat: string) =>
  ((turns(t, chat).at(-1)?.responseParts ?? []) as Any[])
    .filter((p) => p.kind === ResponsePartKind.Markdown)
    .map((p) => p.content)
    .join("");
const toolCalls = (t: Rig, chat: string): Any[] =>
  turns(t, chat)
    .flatMap((x) => x.responseParts as Any[])
    .filter((p) => p.kind === ResponsePartKind.ToolCall)
    .map((p) => p.toolCall);
const letter = (t: Rig, session: string): Any[] => meta(t.host, session).letter;
const git = async (t: Rig, ...args: string[]) =>
  (await t.articles.git.run(args, { ok: [0, 1, 128] })).stdout.trim();
const promptText = (fake: FakeLauncher) =>
  ((fake.last.prompts.at(-1)?.blocks ?? []) as Any[]).map((b) => b.text).join("\n");

async function until(ok: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !ok(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(ok()).toBe(true);
}

/** Send it, and wait for the draft turn to end. */
async function sendIt(t: Rig) {
  const res = await t.call("POST", AUTH, { to: "drafted", confirm: true });
  await t.host.idle();
  return res;
}

describe("send it", () => {
  it("accepts write_draft once under the grant, and refuses the second with the write refused letter line", async () => {
    const t = await rig();
    const { a, c } = await ready(t);
    const res = await t.call("POST", AUTH, { to: "drafted", confirm: true });
    expect(res).toEqual({ status: 200, body: { authorship: "coached", drafting: true } });
    // the grant is live and the flag is out; authorship still reads coached and the page is untouched
    expect(row(t).draft_grant).toEqual(expect.any(String));
    expect(meta(t.host, a.session)).toMatchObject({ drafting: true, authorship: "coached" });
    expect(disk(t)).toBe(PAGE);
    await t.host.idle();

    const want = draftText(demoDraft(DUMP, BRIEF));
    expect(disk(t)).toBe(want);
    expect(want).toContain("I closed the laptop at six and the build died with it.");
    expect(want).toContain(DEMO_CLOSER);
    const r = row(t);
    expect(r).toMatchObject({
      authorship: "drafted",
      stage: "draft",
      coach_quiet: 1,
      draft_grant: null,
      draft_n: 1,
      stage_before_draft: "outline",
      article_sha: sha256(want),
    });
    expect(r.agent_seen_commit).toBe(r.draft_commit);
    expect(t.host.sessionState(a.session)?.config?.values.stage).toBe("draft");
    // the draft is the coach's first, at its ref, and its parent is the page before it
    expect(await git(t, "rev-parse", `refs/sparring/drafts/${SLUG}/1`)).toBe(r.draft_commit);
    expect(await git(t, "rev-parse", `${r.draft_commit}^`)).toBe(r.page_before_commit);
    expect(await git(t, "show", `${r.page_before_commit}:${SLUG}/article.md`)).toBe(PAGE.trim());
    expect((await t.articles.git.run(["show", `${r.page_before_commit}:${SLUG}/article.md`])).stdout).toBe(
      PAGE,
    );
    // the host's lines, the tool's line and the coach's one sentence
    const n = demoDraft(DUMP, BRIEF).length;
    expect(allLines(t, a.chat)).toEqual(expect.arrayContaining([MODE_DRAFTED, "stage outline → draft"]));
    expect(lineMeta(t, a.chat, MODE_DRAFTED)).toEqual({ "sparring.line": "mode" });
    const draftTurn = turns(t, a.chat).at(-1);
    expect(draftTurn.message).toMatchObject({ text: SENDIT_LINE, origin: { kind: "systemNotification" } });
    const call = toolCalls(t, a.chat).find((x) => x.displayName === "write_draft");
    expect(call.content[0].text).toBe(`article.md · ${n} ¶ from dump.md and brief.md`);
    expect(said(t, a.chat)).toBe(DRAFTED_SAYS);
    expect(meta(t.host, a.session)).toMatchObject({
      authorship: "drafted",
      drafting: false,
      coachQuiet: true,
      stage: "draft",
      yoursPct: 0,
      blocks: { coach: n, edited: 0, yours: 0 },
    });
    expect(letter(t, a.session).map((l) => l.kind)).toEqual([]);
    // the draft turn is the host's, and no violation
    expect(
      t.db.all<Any>("SELECT origin, pass, status, violation FROM turns ORDER BY rowid DESC LIMIT 1"),
    ).toEqual([{ origin: "host", pass: DRAFT_PASS, status: "done", violation: 0 }]);
    // the tripwire did not take the daemon's own write for someone else's
    expect(await git(t, "rev-parse", "--verify", "-q", `refs/sparring/quarantine/${SLUG}`)).toBe("");

    // the grant is spent: the second write_draft is refused, logged in the letter, and the page stays
    await t.say(c, a.chat, "please write it again for me");
    expect(said(t, a.chat)).toBe(WRITE_REFUSED_SAYS);
    expect(disk(t)).toBe(want);
    expect(letter(t, a.session)).toEqual([expect.objectContaining({ kind: "refused", text: WRITE_REFUSED })]);
    expect(lineMeta(t, a.chat, WRITE_REFUSED)).toEqual({ "sparring.line": "refused" });
    expect(row(t)).toMatchObject({ authorship: "drafted", draft_n: 1 });
    // and at the socket too, where the guard does not depend on the adapter asking
    const secret = t.tools.issue(a.id);
    expect((await t.tools.call(secret, "write_draft", { blocks: ["Again."] })).ok).toBe(false);
    expect(disk(t)).toBe(want);
    // the route answers 409 to a second send it
    expect((await t.call("POST", AUTH, { to: "drafted", confirm: true })).status).toBe(409);
  });

  it("refuses write_draft in coached mode with the write refused letter line", async () => {
    const t = await rig();
    const { a, c } = await ready(t);
    await t.say(c, a.chat, "just write it for me");
    expect(said(t, a.chat)).toBe(WRITE_REFUSED_SAYS);
    expect(disk(t)).toBe(PAGE);
    expect(letter(t, a.session)).toEqual([expect.objectContaining({ kind: "refused", text: WRITE_REFUSED })]);
    expect(allLines(t, a.chat)).toContain(WRITE_REFUSED);
    expect(row(t)).toMatchObject({ authorship: "coached", draft_n: 0, draft_commit: null });
    expect(t.db.all<Any>("SELECT violation FROM turns ORDER BY rowid DESC LIMIT 1")).toEqual([
      { violation: 1 },
    ]);
    // straight at the socket, with no permission asked first
    const secret = t.tools.issue(a.id);
    const r = await t.tools.call(secret, "write_draft", { blocks: ["A sentence."] });
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/^write refused/) });
    expect(disk(t)).toBe(PAGE);
    expect(letter(t, a.session).filter((l) => l.kind === "refused")).toHaveLength(2);
  });

  it("a failed draft leaves the page byte for byte", async () => {
    // an agent that never calls write_draft
    const fake = new FakeLauncher();
    const t = await rig({ launch: fake.launch });
    const { a } = await ready(t);
    const before = disk(t);
    expect((await sendIt(t)).status).toBe(200);
    expect(Buffer.from(disk(t)).equals(Buffer.from(before))).toBe(true);
    expect(disk(t)).toBe(PAGE);
    expect(row(t)).toMatchObject({ authorship: "coached", stage: "outline", draft_grant: null, draft_n: 0 });
    expect(allLines(t, a.chat).at(-1)).toBe(DRAFT_FAILED);
    expect(lineMeta(t, a.chat, DRAFT_FAILED)).toEqual({ "sparring.line": "refused" });
    expect(letter(t, a.session).at(-1)).toMatchObject({ kind: "draftFailed", text: DRAFT_FAILED });
    expect(meta(t.host, a.session)).toMatchObject({ drafting: false, authorship: "coached" });
    expect(await git(t, "for-each-ref", "refs/sparring/drafts")).toBe("");
    // the grant went with the turn: a write now is refused
    const secret = t.tools.issue(a.id);
    expect((await t.tools.call(secret, "write_draft", { blocks: ["Late."] })).ok).toBe(false);
    expect(disk(t)).toBe(PAGE);
  });

  it("a draft turn that is cancelled, or whose agent dies, fails the same way", async () => {
    const fake = new FakeLauncher();
    const t = await rig({ launch: fake.launch });
    const { a, c } = await ready(t);
    // the agent exits mid-turn
    const first = t.call("POST", AUTH, { to: "drafted", confirm: true });
    expect((await first).status).toBe(200);
    await until(() => fake.agents.length > 0 && fake.last.prompts.length > 0);
    fake.last.kill();
    await t.host.idle();
    expect(disk(t)).toBe(PAGE);
    expect(row(t)).toMatchObject({ authorship: "coached", draft_grant: null });
    expect(allLines(t, a.chat).filter((l) => l === DRAFT_FAILED)).toHaveLength(1);
    // cancelled by the writer
    expect((await t.call("POST", AUTH, { to: "drafted", confirm: true })).status).toBe(200);
    const active = t.host.chatState(a.chat)?.activeTurn as Any;
    c.dispatch(a.chat, { type: "chat/turnCancelled", turnId: active.id, duration: 0 });
    await t.host.idle();
    await new Promise((r) => setTimeout(r, 30));
    expect(disk(t)).toBe(PAGE);
    expect(row(t)).toMatchObject({ authorship: "coached", draft_grant: null });
    expect(allLines(t, a.chat).filter((l) => l === DRAFT_FAILED)).toHaveLength(2);
  });

  it("rolls back a draft whose transaction fails partway, and says the draft failed", async () => {
    const t = await rig();
    const { a } = await ready(t);
    // a ref in the way: refs/sparring/drafts/<slug>/1 cannot be made, after the draft was written and committed
    const head = await git(t, "rev-parse", "HEAD");
    await t.articles.git.run(["update-ref", `refs/sparring/drafts/${SLUG}`, head]);
    await sendIt(t);
    expect(disk(t)).toBe(PAGE);
    expect(row(t)).toMatchObject({
      authorship: "coached",
      stage: "outline",
      draft_grant: null,
      draft_n: 0,
      article_sha: sha256(PAGE),
    });
    expect(allLines(t, a.chat).at(-1)).toBe(DRAFT_FAILED);
    expect((await t.articles.git.run(["show", `HEAD:${SLUG}/article.md`])).stdout).toBe(PAGE);
  });

  it("answers 409 with no host line while offline, while a turn runs, and for a bad body", async () => {
    const fake = new FakeLauncher();
    const t = await rig({ launch: fake.launch });
    const { a, c } = await ready(t);
    const lines = () => allLines(t, a.chat).length;
    const n = lines();
    expect((await t.call("POST", AUTH, { to: "drafted" })).status).toBe(400);
    expect((await t.call("POST", AUTH, { to: "published", confirm: true })).status).toBe(400);
    expect(
      (await t.call("POST", "/api/articles/nope/authorship", { to: "drafted", confirm: true })).status,
    ).toBe(404);
    expect((await t.call("POST", AUTH, { to: "coached", confirm: true })).status).toBe(409);
    // a turn is running
    c.dispatch(a.chat, {
      type: "chat/turnStarted",
      turnId: "slow-1",
      startedAt: new Date().toISOString(),
      message: { text: "slow please", origin: { kind: "user" } },
    });
    await until(() => t.host.hasActiveTurn(a.chat));
    expect((await t.call("POST", AUTH, { to: "drafted", confirm: true })).status).toBe(409);
    c.dispatch(a.chat, { type: "chat/turnCancelled", turnId: "slow-1", duration: 0 });
    await t.host.idle();
    // offline
    await t.say(c, a.chat, "/offline");
    const m = lines();
    expect((await t.call("POST", AUTH, { to: "drafted", confirm: true })).status).toBe(409);
    expect(lines()).toBe(m);
    expect(n).toBeLessThan(m);
    expect(row(t)).toMatchObject({ authorship: "coached", draft_grant: null });
    expect(disk(t)).toBe(PAGE);
  });

  it("refuses an empty dump with a host line and a draftEmpty letter line", async () => {
    const t = await rig();
    const { a } = await ready(t, { dump: "" });
    const res = await sendIt(t);
    expect(res).toEqual({ status: 409, body: { error: DRAFT_EMPTY } });
    expect(allLines(t, a.chat).at(-1)).toBe(DRAFT_EMPTY);
    expect(letter(t, a.session).at(-1)).toMatchObject({ kind: "draftEmpty", text: DRAFT_EMPTY });
    expect(row(t)).toMatchObject({ authorship: "coached", draft_grant: null });
    expect(t.launches()).toBe(0);
  });

  it("clears a grant the last daemon left unspent, and says the draft failed", async () => {
    const dir = (await import("node:fs")).mkdtempSync(
      join((await import("node:os")).tmpdir(), "sparring-coach-"),
    );
    dirs.push(dir);
    const db = await openDb(":memory:");
    const t = await rig({ db, dir });
    const { a } = await ready(t);
    t.articles.setDraftGrant(a.id, "left-over");
    const again = await rig({ db, dir });
    expect(again.articles.row(SLUG).draft_grant).toBeNull();
    expect(allLines(again, a.chat).at(-1)).toBe(DRAFT_FAILED);
    expect(letter(again, a.session).at(-1)).toMatchObject({ kind: "draftFailed" });
    expect(meta(again.host, a.session).drafting).toBe(false);
    expect(readFileSync(join(dir, SLUG, "article.md"), "utf8")).toBe(PAGE);
  });

  it("sends the draft turn the instruction, the interview answers word for word and the topics not covered", async () => {
    const fake = new FakeLauncher();
    const t = await rig({ launch: fake.launch });
    const { a, c } = await ready(t, { stage: "interview" });
    await t.say(c, a.chat, "plain The lid closed and the socket was mine, not the provider's.");
    await sendIt(t);
    const text = promptText(fake);
    expect(text).toContain(draftTurnPrompt());
    expect(text).toMatch(/<sparring stage="interview" pass="sendit" /);
    expect(text).toContain("- plain The lid closed and the socket was mine, not the provider's.");
    expect(text).toContain("Interview topics not covered yet, so leave them out: thesis, reader, evidence");
    // the draft turn carries no stage prompt: the interview's would ask for a question
    expect(text).not.toContain("Stage: interview");
    expect(disk(t)).toBe(PAGE);
    expect(a.chat).toBeTruthy();
  });
});

describe("the draft rules", () => {
  it("names the rule a draft breaks", () => {
    expect(draftProblem(["## A heading", "A paragraph."])).toBeNull();
    expect(draftProblem(["### Deeper", "A paragraph\nof two lines."])).toBeNull();
    expect(draftProblem([])).toMatch(/non-empty list/);
    expect(draftProblem("text")).toMatch(/non-empty list/);
    expect(draftProblem(["ok", 3])).toMatch(/string/);
    expect(draftProblem(["ok", "  \n"])).toBe("no block may be blank");
    expect(draftProblem(["# Title", "ok"])).toMatch(/^headings start at ##/);
    expect(draftProblem(["one\n\ntwo"])).toMatch(/^one paragraph or ## heading per block/);
    expect(
      draftProblem([
        Array(DRAFT_MAX_WORDS + 1)
          .fill("word")
          .join(" "),
      ]),
    ).toMatch(/at most 6000 words/);
    expect(draftProblem([Array(DRAFT_MAX_WORDS).fill("word").join(" ")])).toBeNull();
    expect(draftText(["## A", " B \r\n"])).toBe("## A\n\nB\n");
  });

  it("a failed check answers the rule, keeps the grant, and the coach may try again", async () => {
    const t = await rig();
    const { a } = await ready(t);
    t.articles.setDraftGrant(a.id, "g");
    const secret = t.tools.issue(a.id);
    const bad = await t.tools.call(secret, "write_draft", { blocks: ["# A title", "Text."] });
    expect(bad).toMatchObject({ ok: false, error: expect.stringMatching(/^headings start at ##/) });
    expect(disk(t)).toBe(PAGE);
    expect(row(t).draft_grant).toBe("g");
    expect(letter(t, a.session)).toEqual([]);
    const good = await t.tools.call(secret, "write_draft", { blocks: ["## A title", "Text."] });
    expect(good).toEqual({ ok: true, text: "article.md · 2 ¶ from dump.md and brief.md" });
    expect(disk(t)).toBe("## A title\n\nText.\n");
    expect(row(t)).toMatchObject({ authorship: "drafted", draft_grant: null });
  });
});

describe("a drafted article", () => {
  it("has the shelf, the baseline in the snapshot, and provenance in its meta as the writer edits", async () => {
    const t = await rig();
    const { a } = await ready(t);
    expect((await t.call("GET", `/api/articles/${SLUG}/shelf`)).status).toBe(404);
    expect((await t.call("GET", `/api/articles/${SLUG}`)).body.draft).toBeNull();
    await sendIt(t);
    const shelf = await t.call("GET", `/api/articles/${SLUG}/shelf`);
    expect(shelf).toEqual({ status: 200, body: { text: PAGE, commit: row(t).page_before_commit } });
    const snap = (await t.call("GET", `/api/articles/${SLUG}`)).body;
    const draft = draftText(demoDraft(DUMP, BRIEF));
    expect(snap).toMatchObject({
      authorship: "drafted",
      draft: { n: 1, commit: row(t).draft_commit, text: draft },
    });

    // a stale tab that replays an old save gets 409 and the disk text
    const stale = await t.call("PUT", `/api/articles/${SLUG}/article`, {
      text: `${PAGE}more\n`,
      base_sha: sha256(PAGE),
    });
    expect(stale).toEqual({ status: 409, body: { disk_sha: sha256(draft), disk_text: draft } });

    // the writer rewrites the closing block and adds a paragraph of their own
    const mine =
      "I keep the lid shut now, and the daemon reconciles when it wakes, which costs me one second.";
    const edited = `${draft.replace(DEMO_CLOSER, mine)}\nA last paragraph that is only mine, about standups.\n`;
    const save = await t.call("PUT", `/api/articles/${SLUG}/article`, {
      text: edited,
      base_sha: sha256(draft),
    });
    expect(save.status).toBe(200);
    t.coach.pushMeta(a.id);
    const m = meta(t.host, a.session);
    const n = demoDraft(DUMP, BRIEF).length;
    expect(m.blocks).toEqual({ coach: n - 1, edited: 0, yours: 2 });
    expect(m.yoursPct).toBeGreaterThan(20);
    // the baseline survives a restart: it is read from git at draft_commit
    expect((await t.articles.draftBaseline(SLUG))?.text).toBe(draft);
  });

  it("keeps the coach quiet until /critique, which adds the three drafted rules", async () => {
    const fake = new FakeLauncher();
    const t = await rig({ launch: fake.launch });
    const { a, c } = await ready(t);
    // drafted by hand, as the accepted call leaves it
    t.articles.setDraftGrant(a.id, "g");
    const secret = t.tools.issue(a.id);
    expect(
      (await t.tools.call(secret, "write_draft", { blocks: ["## One", "A paragraph of the coach's."] })).ok,
    ).toBe(true);
    // quiet: comment is refused, and a plain question carries the three-sentence line
    const note = await t.tools.call(secret, "comment", {
      anchor: "A paragraph",
      kind: "unclear",
      body: "Why?",
      pass: "",
    });
    expect(note).toMatchObject({ ok: false, error: expect.stringMatching(/quiet/) });
    await t.say(c, a.chat, "plain is the opening any good?");
    expect(promptText(fake)).toContain(DRAFTED_QUIET_LINE);
    expect(promptText(fake)).not.toContain(DRAFTED_RULES);
    // /next: a short chat reply and no notes
    await t.say(c, a.chat, "/next");
    expect(((fake.last.prompts.at(-1)?.blocks ?? []) as Any[]).at(-1)?.text).toBe(DRAFTED_NEXT_ASK);
    await t.say(c, a.chat, "done");
    expect(((fake.last.prompts.at(-1)?.blocks ?? []) as Any[]).at(-1)?.text).toBe("done");
    // /critique ends the quiet and carries the rules; so does a pass
    await t.say(c, a.chat, "/critique");
    expect(row(t)).toMatchObject({ coach_quiet: 0, stage: "critique", authorship: "drafted" });
    expect(promptText(fake)).toContain(DRAFTED_RULES);
    expect(promptText(fake)).not.toContain(DRAFTED_QUIET_LINE);
    await t.say(c, a.chat, "/pass filler");
    expect(promptText(fake)).toContain(DRAFTED_RULES);
  });

  it("the scripted coach answers /next and a plain question in chat, with no notes", async () => {
    const t = await rig();
    const { a, c } = await ready(t);
    await sendIt(t);
    await t.say(c, a.chat, "/next");
    expect(said(t, a.chat)).toBe(DRAFTED_NEXT_SAYS);
    await t.say(c, a.chat, "is the opening any good?");
    expect(said(t, a.chat)).toBe(DRAFTED_QUIET_SAYS);
    expect(t.articles.comments(a.id)).toEqual([]);
    // /critique brings the notes back, beside the provenance
    await t.say(c, a.chat, "/critique");
    expect(t.articles.comments(a.id).length).toBeGreaterThan(0);
    expect(meta(t.host, a.session)).toMatchObject({ coachQuiet: false, authorship: "drafted", yoursPct: 0 });
  });
});

describe("coached again", () => {
  it("restores the page byte for byte and the stage to stage_before_draft", async () => {
    const t = await rig();
    const { a } = await ready(t);
    await sendIt(t);
    const draft = disk(t);
    const r = row(t);
    // the writer worked on the draft first; that work is committed before the page is put back
    const worked = `${draft}\nA paragraph I added to the coach's draft.\n`;
    await t.call("PUT", `/api/articles/${SLUG}/article`, { text: worked, base_sha: sha256(draft) });

    const res = await t.call("POST", AUTH, { to: "coached", confirm: true });
    expect(res).toEqual({
      status: 200,
      body: { authorship: "coached", stage: "outline", sha: sha256(PAGE) },
    });
    expect(Buffer.from(disk(t)).equals(Buffer.from(PAGE))).toBe(true);
    expect(row(t)).toMatchObject({
      authorship: "coached",
      stage: "outline",
      coach_quiet: 0,
      page_before_commit: null,
      stage_before_draft: null,
      draft_n: 1,
      article_sha: sha256(PAGE),
    });
    expect(t.host.sessionState(a.session)?.config?.values.stage).toBe("outline");
    expect(allLines(t, a.chat).slice(-2)).toEqual([MODE_COACHED, "stage draft → outline"]);
    const m = meta(t.host, a.session);
    expect(m).toMatchObject({ authorship: "coached", coachQuiet: false, stage: "outline" });
    expect(m.yoursPct).toBeUndefined();
    expect(m.blocks).toBeUndefined();
    // the coach's draft stays as its ref, the writer's work on it is in the log, and the shelf is empty again
    expect(await git(t, "rev-parse", `refs/sparring/drafts/${SLUG}/1`)).toBe(r.draft_commit);
    expect(await git(t, "log", "--format=%s", "-3", "--", SLUG)).toBe(
      [`coached again ${SLUG}`, `before coached again ${SLUG}`, `draft 1 ${SLUG}`].join("\n"),
    );
    expect((await t.call("GET", `/api/articles/${SLUG}/shelf`)).status).toBe(404);
    expect((await t.call("GET", `/api/articles/${SLUG}`)).body.draft).toBeNull();
    expect((await t.call("POST", AUTH, { to: "coached", confirm: true })).status).toBe(409);

    // a later send it writes draft 2
    await sendIt(t);
    expect(row(t)).toMatchObject({ authorship: "drafted", draft_n: 2, stage_before_draft: "outline" });
    expect(await git(t, "rev-parse", `refs/sparring/drafts/${SLUG}/2`)).toBe(row(t).draft_commit);
    expect((await t.call("GET", `/api/articles/${SLUG}/shelf`)).body.text).toBe(PAGE);
  });

  it("works from an empty page, and a draft that equals the page is still a draft of its own", async () => {
    const t = await rig();
    await ready(t, { page: "" });
    await sendIt(t);
    expect(row(t).authorship).toBe("drafted");
    expect((await t.call("GET", `/api/articles/${SLUG}/shelf`)).body.text).toBe("");
    await t.call("POST", AUTH, { to: "coached", confirm: true });
    expect(disk(t)).toBe("");
    // the page already holds exactly what the coach would write
    const draft = draftText(demoDraft(DUMP, BRIEF));
    await t.call("PUT", `/api/articles/${SLUG}/article`, { text: draft, base_sha: sha256(""), commit: true });
    await sendIt(t);
    const r = row(t);
    expect(r).toMatchObject({ authorship: "drafted", draft_n: 2 });
    expect(r.draft_commit).not.toBe(r.page_before_commit);
    expect(await git(t, "rev-parse", `${r.draft_commit}^`)).toBe(r.page_before_commit);
    expect((await t.call("GET", `/api/articles/${SLUG}`)).body.draft.text).toBe(draft);
  });
});
