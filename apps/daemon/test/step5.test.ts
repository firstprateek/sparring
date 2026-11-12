// Step 5's done-when, daemon side, with no tokens: the prompt for `/pass filler` contains `passes/filler.md` and
// the strictness line; three queued passes run with no client connected. Plus the three stage prompts, `/next`,
// `/ask`, `/strict`, `/quiet`, the pass letter lines and the resume letter.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PASSES } from "@sparring/protocol/commands";
import { describe, expect, it } from "vitest";
import { ResponsePartKind, ROOT } from "../src/ahp/wire.ts";
import { Articles, sha256 } from "../src/articles.ts";
import { askText, NEXT_ASK, passAsk, QUIET_OFF, QUIET_ON, SECTION_ASK } from "../src/coach.ts";
import {
  ASK_BODY,
  CUT_BODY,
  DRAFT_SAYS,
  fillerBody,
  NO_PARAGRAPH,
  NOTHING,
  POLISH_SAYS,
  QUIET_ANSWER,
  repeatBody,
  SECTION_BODY,
} from "../src/demo-agent.ts";
import { QUIET_LINE, strictnessLine } from "../src/prompt.ts";
import { FakeLauncher } from "./ahp/fake-acp.ts";
import { type Any, TestClient, turnStarted } from "./ahp/support.ts";
import { meta, rig } from "./rig.ts";

type Rig = Awaited<ReturnType<typeof rig>>;

const P1 =
  "Closing the laptop at six gave me my evenings back. It was really hard at first, and I actually missed the noise.";
const P2 = "The evenings were quiet. Quiet evenings are what the evenings were for, I thought.";
const P3 = "Nobody noticed for a month. The one person who did asked how to do it too.";
const PAGE = `## Six o'clock\n\n${P1}\n\n${P2}\n\n${P3}\n\n## What it cost\n`;
const SLUG = "closed-laptop";

/** An article with a page, and a client on its chat. */
async function written(t: Rig, page = PAGE) {
  const a = await t.article(SLUG);
  const put = await t.call("PUT", `/api/articles/${SLUG}/article`, {
    text: page,
    base_sha: sha256(""),
    commit: true,
  });
  expect(put.status).toBe(200);
  const c = new TestClient(t.host);
  await c.init([ROOT, a.session, a.chat]);
  return { a, c };
}

const turns = (t: Rig, chat: string) => (t.host.chatState(chat)?.turns ?? []) as Any[];
const lastParts = (t: Rig, chat: string): Any[] => (turns(t, chat).at(-1)?.responseParts ?? []) as Any[];
const hostLines = (ps: Any[]) =>
  ps.filter((p) => p.kind === ResponsePartKind.SystemNotification).map((p) => p.content);
const said = (ps: Any[]) =>
  ps
    .filter((p) => p.kind === ResponsePartKind.Markdown)
    .map((p) => p.content)
    .join("");
const snapshot = async (t: Rig) => (await t.call("GET", `/api/articles/${SLUG}`)).body;
const promptText = (fake: FakeLauncher) =>
  ((fake.last.prompts.at(-1)?.blocks ?? []) as Any[]).map((b) => b.text).join("\n");
const lastBlock = (fake: FakeLauncher) => ((fake.last.prompts.at(-1)?.blocks ?? []) as Any[]).at(-1)?.text;

describe("pass files", () => {
  it("are in ~/writing/passes from the start, committed, and an edited one is left alone", async () => {
    const t = await rig();
    for (const p of PASSES) expect(existsSync(join(t.dir, "passes", `${p}.md`))).toBe(true);
    expect((await t.articles.git.run(["status", "--porcelain"])).stdout.trim()).toBe("");
    expect(t.articles.passNames()).toEqual([...PASSES]);
    writeFileSync(join(t.dir, "passes", "filler.md"), "Pass: filler. My own rules.\n");
    writeFileSync(join(t.dir, "passes", "jargon.md"), "Pass: jargon. Words my reader does not know.\n");
    const again = new Articles(t.db, t.dir, {
      gitName: "T",
      gitEmail: "t@localhost",
      defaultProvider: "demo",
    });
    await again.init();
    expect(readFileSync(join(t.dir, "passes", "filler.md"), "utf8")).toBe("Pass: filler. My own rules.\n");
    expect(t.articles.passNames()).toEqual([...PASSES, "jargon"]);
  });
});

describe("/pass", () => {
  it("sends a prompt that contains passes/filler.md and the strictness line", async () => {
    const fake = new FakeLauncher();
    const t = await rig({ launch: fake.launch });
    const { a, c } = await written(t);
    await t.say(c, a.chat, "/pass filler");
    const text = promptText(fake);
    expect(text).toContain("passes/filler.md");
    expect(text).toContain(readFileSync(join(t.dir, "passes", "filler.md"), "utf8").trim());
    expect(text).toContain(strictnessLine("normal"));
    expect(text).toContain("Strictness: normal");
    expect(text).toMatch(/<sparring stage="ideas" pass="filler" strictness="normal" /);
    // a pass runs under the polish stage prompt whatever the stage, and the stage does not move
    expect(text).toContain("Stage: polish. Named passes, one per turn");
    expect(t.articles.row(SLUG).stage).toBe("ideas");
    expect(lastBlock(fake)).toBe(passAsk("filler"));
    expect(turns(t, a.chat).at(-1)?.message.text).toBe("/pass filler");

    // /strict changes the line in the next pass header, and the session's config
    await t.say(c, a.chat, "/strict every nit");
    expect(hostLines(lastParts(t, a.chat))).toEqual(["strictness every nit · every pass from now on"]);
    expect(t.host.sessionState(a.session)?.config?.values.strictness).toBe("every nit");
    await t.say(c, a.chat, "/pass filler");
    expect(promptText(fake)).toContain(strictnessLine("every nit"));
    expect(promptText(fake)).toMatch(/pass="filler" strictness="every nit"/);
  });

  it("sends the pass file as the writer edited it", async () => {
    const fake = new FakeLauncher();
    const t = await rig({ launch: fake.launch });
    const { a, c } = await written(t);
    writeFileSync(join(t.dir, "passes", "filler.md"), "Pass: filler. Only the word very.\n");
    await t.say(c, a.chat, "/pass filler");
    expect(promptText(fake)).toContain("Pass: filler · from passes/filler.md");
    expect(promptText(fake)).toContain("Pass: filler. Only the word very.");
  });

  it("refuses a pass that has no file, in a host line, with no coach", async () => {
    const t = await rig();
    const { a, c } = await written(t);
    await t.say(c, a.chat, "/pass nope");
    expect(hostLines(lastParts(t, a.chat))[0]).toMatch(/^no pass "nope" · filler · buried-verbs/);
    await t.say(c, a.chat, "/pass");
    expect(hostLines(lastParts(t, a.chat))[0]).toMatch(/^no pass named · \/pass filler/);
    await t.say(c, a.chat, "/strict loud");
    expect(hostLines(lastParts(t, a.chat))[0]).toMatch(/^no strictness "loud"/);
    expect(t.launches()).toBe(0);
  });

  it("has the scripted coach leave notes by strictness, with the letter line and the host line", async () => {
    const t = await rig();
    const { a, c } = await written(t);
    await t.say(c, a.chat, "/pass filler");
    let notes = (await snapshot(t)).comments as Any[];
    expect(notes).toMatchObject([
      { id: "c01", pass: "filler", kind: "filler", span: "really hard", body: fillerBody("really") },
      { id: "c02", pass: "filler", kind: "filler", span: "actually missed", body: fillerBody("actually") },
    ]);
    expect(said(lastParts(t, a.chat))).toBe("2 notes in the filler pass, at normal.");
    expect(hostLines(lastParts(t, a.chat))).toEqual(["filler · 2 notes"]);
    expect(meta(t.host, a.session).letter).toMatchObject([{ kind: "passDone", text: "filler · 2 notes" }]);
    expect(t.articles.row(SLUG).last_line).toBe("filler · 2 notes");

    // a pass that finds nothing says so, in the chat, the letter and the Articles row
    await t.say(c, a.chat, "/pass voice");
    expect(said(lastParts(t, a.chat))).toBe(NOTHING);
    expect(hostLines(lastParts(t, a.chat))).toEqual(["nothing in this pass · voice"]);
    expect(meta(t.host, a.session).letter.at(-1)).toMatchObject({
      kind: "passEmpty",
      text: "nothing in this pass · voice",
    });

    // howlers only: one note where normal left two
    await t.say(c, a.chat, "/strict howlers");
    expect(t.articles.row(SLUG).strictness).toBe("howlers only");
    await t.say(c, a.chat, "/pass repeats");
    notes = ((await snapshot(t)).comments as Any[]).filter((n) => n.pass === "repeats");
    expect(notes).toMatchObject([{ span: "evenings are what", body: repeatBody("evenings") }]);
    expect(said(lastParts(t, a.chat))).toBe("One note in the repeats pass, at howlers only.");
  });
});

describe("/queue", () => {
  it("runs three queued passes to completion with no client connected", async () => {
    const t = await rig();
    const { a, c } = await written(t);
    c.dispatch(a.chat, turnStarted("/queue filler repeats cut", "q1"));
    // Every client is gone before the first pass has run.
    c.disconnect();
    expect((t.host.chatState(a.chat)?.turns ?? []).length).toBeLessThan(2);
    expect(t.db.all("SELECT 1 FROM comments").length).toBe(0);
    await t.host.idle();

    const ts = turns(t, a.chat);
    expect(ts.map((x) => x.message.text)).toEqual([
      "/queue filler repeats cut",
      "/pass filler",
      "/pass repeats",
      "/pass cut",
    ]);
    expect(hostLines(ts[0].responseParts)).toEqual(["queued · filler · repeats · cut"]);
    expect(t.host.chatState(a.chat)?.queuedMessages ?? []).toEqual([]);
    expect(t.host.chatState(a.chat)?.activeTurn).toBeUndefined();
    // three separate turns, each from the queue, each done
    expect(t.db.all("SELECT origin, status, pass FROM turns ORDER BY started_at, rowid")).toEqual([
      { origin: "queue", status: "done", pass: "filler" },
      { origin: "queue", status: "done", pass: "repeats" },
      { origin: "queue", status: "done", pass: "cut" },
    ]);
    const notes = (await snapshot(t)).comments as Any[];
    expect(notes.map((n) => `${n.id} ${n.pass} ${n.span}`)).toEqual([
      "c01 filler really hard",
      "c02 filler actually missed",
      "c03 repeats evenings are what",
      "c04 repeats evenings were for",
      "c05 cut Nobody noticed for a month.",
    ]);
    expect(notes[4].body).toBe(CUT_BODY);
    const m = meta(t.host, a.session);
    expect(m.letter.map((l: Any) => `${l.kind} ${l.text}`)).toEqual([
      "passDone filler · 2 notes",
      "passDone repeats · 2 notes",
      "passDone cut · 1 note",
    ]);
    expect(m).toMatchObject({ queued: 0, run: null, openComments: 5, unreadComments: 5 });
    expect(hostLines(ts[3].responseParts)).toEqual(["cut · 1 note"]);
  });

  it("queues nothing when a name is no pass, and says which", async () => {
    const t = await rig();
    const { a, c } = await written(t);
    await t.say(c, a.chat, "/queue filler nope cut");
    expect(hostLines(lastParts(t, a.chat))[0]).toMatch(/^nothing queued · no pass "nope"/);
    await t.say(c, a.chat, "/queue");
    expect(hostLines(lastParts(t, a.chat))).toEqual(["nothing queued · /queue filler repeats cut"]);
    expect(turns(t, a.chat).length).toBe(2);
    expect(t.launches()).toBe(0);
  });
});

describe("/quiet", () => {
  it("toggles, holds the coach's notes, and ends with /pass", async () => {
    const fake = new FakeLauncher();
    const t = await rig({ launch: fake.launch });
    const { a, c } = await written(t);
    await t.say(c, a.chat, "/quiet");
    expect(hostLines(lastParts(t, a.chat))).toEqual([QUIET_ON]);
    expect(meta(t.host, a.session).coachQuiet).toBe(true);
    expect(fake.launches.length).toBe(0);
    // the coach still answers when spoken to, and is told to leave no notes
    await t.say(c, a.chat, "are you there?");
    expect(promptText(fake)).toContain(QUIET_LINE);
    // /ask is answered in chat while quiet
    await t.say(c, a.chat, `/ask is this true?\n> ${P2}`);
    expect(lastBlock(fake)).toBe(askText("is this true?", null, "The writer asked for quiet."));
    await t.say(c, a.chat, "/pass filler");
    expect(meta(t.host, a.session).coachQuiet).toBe(false);
    expect(promptText(fake)).not.toContain(QUIET_LINE);
    await t.say(c, a.chat, "/quiet");
    await t.say(c, a.chat, "/quiet");
    expect(hostLines(lastParts(t, a.chat))).toEqual([QUIET_OFF]);
    expect(meta(t.host, a.session).coachQuiet).toBe(false);
  });
});

describe("/quiet with the scripted coach", () => {
  it("answers /ask in chat and leaves no note, then notes again after /quiet", async () => {
    const t = await rig();
    const { a, c } = await written(t);
    await t.say(c, a.chat, "/quiet");
    await t.say(c, a.chat, `/ask does this follow?\n> ${P2}`);
    expect(said(lastParts(t, a.chat))).toBe(QUIET_ANSWER);
    expect((await snapshot(t)).comments).toEqual([]);
    await t.say(c, a.chat, "/quiet");
    await t.say(c, a.chat, `/ask does this follow?\n> ${P2}`);
    expect((await snapshot(t)).comments).toMatchObject([{ id: "c01", pass: "ask" }]);
  });
});

describe("the outline, draft and polish stages", () => {
  it("each send their own stage prompt", async () => {
    const fake = new FakeLauncher();
    const t = await rig({ launch: fake.launch });
    const { a, c } = await written(t);
    for (const [stage, opens] of [
      ["outline", "Stage: outline. The writer types `##` headings"],
      ["draft", "Stage: draft. The writer is writing the piece."],
      ["polish", "Stage: polish. Named passes, one per turn"],
    ] as const) {
      await t.say(c, a.chat, `/stage ${stage}`);
      await t.say(c, a.chat, "hello");
      expect(promptText(fake)).toMatch(new RegExp(`<sparring stage="${stage}" pass="" `));
      expect(promptText(fake)).toContain(opens);
    }
  });

  it("have the scripted coach act differently in each", async () => {
    const t = await rig();
    const { a, c } = await written(t);
    await t.say(c, a.chat, "/stage outline");
    await t.say(c, a.chat, "here is my outline");
    expect(said(lastParts(t, a.chat))).toBe(
      'I count 2 sections. What does the reader know after "## Six o\'clock" that they did not know before it?',
    );
    await t.say(c, a.chat, "/stage draft");
    await t.say(c, a.chat, "writing now");
    expect(said(lastParts(t, a.chat))).toBe(DRAFT_SAYS);
    await t.say(c, a.chat, "/stage polish");
    await t.say(c, a.chat, "what now");
    expect(said(lastParts(t, a.chat))).toBe(POLISH_SAYS);
    // none of them left a note or a brief entry
    const snap = await snapshot(t);
    expect(snap.comments).toEqual([]);
    expect(snap.briefNotes).toEqual([]);
  });
});

describe("/next and /ask", () => {
  it("/next is rewritten, and done after it hands the section over", async () => {
    const fake = new FakeLauncher();
    const t = await rig({ launch: fake.launch });
    const { a, c } = await written(t);
    // done with no /next before it is plain text
    await t.say(c, a.chat, "done");
    expect(lastBlock(fake)).toBe("done");
    await t.say(c, a.chat, "/next");
    expect(lastBlock(fake)).toBe(NEXT_ASK);
    expect(promptText(fake)).toMatch(/pass="next"/);
    await t.say(c, a.chat, "Done.");
    expect(lastBlock(fake)).toBe(SECTION_ASK);
    expect(promptText(fake)).toMatch(/pass="section"/);
    // only once: the next done is plain text again
    await t.say(c, a.chat, "done");
    expect(lastBlock(fake)).toBe("done");
  });

  it("has the scripted coach name the empty section, then leave a note on what was written", async () => {
    const t = await rig();
    const { a, c } = await written(t);
    await t.say(c, a.chat, "/next");
    expect(said(lastParts(t, a.chat))).toBe(
      'Write the section under "## What it cost". Ugly is fine. Say done when it is in the file.',
    );
    const snap = await snapshot(t);
    const cost = "It cost me one promotion cycle, I think.";
    const put = await t.call("PUT", `/api/articles/${SLUG}/article`, {
      text: `${PAGE}\n${cost}\n`,
      base_sha: snap.files.article.sha,
      commit: true,
    });
    expect(put.status).toBe(200);
    await t.say(c, a.chat, "done");
    expect((await snapshot(t)).comments).toMatchObject([
      { id: "c01", pass: "section", kind: "detail", span: cost, block_orig: cost, body: SECTION_BODY },
    ]);
    expect(said(lastParts(t, a.chat))).toBe("One note on that section.");
  });

  it("/ask carries the paragraph at the caret, and the answer is a note on it", async () => {
    const fake = new FakeLauncher();
    const t = await rig({ launch: fake.launch });
    const { a, c } = await written(t);
    await t.say(c, a.chat, `/ask does this follow?\n> ${P2}`);
    expect(lastBlock(fake)).toBe(askText("does this follow?", P2));
    expect(lastBlock(fake)).toContain(`<paragraph>\n${P2}\n</paragraph>`);
    expect(promptText(fake)).toMatch(/pass="ask"/);
    // a paragraph that is not on the page does not count
    await t.say(c, a.chat, "/ask and this?\n> A paragraph that is not in the file.");
    expect(lastBlock(fake)).toBe(
      askText("and this?", null, "No paragraph of article.md came with the question."),
    );
    await t.say(c, a.chat, "/ask");
    expect(hostLines(lastParts(t, a.chat))).toEqual(["nothing asked · /ask <question>"]);
  });

  it("has the scripted coach answer /ask with a note in that paragraph", async () => {
    const t = await rig();
    const { a, c } = await written(t);
    await t.say(c, a.chat, `/ask does this follow?\n> ${P2}`);
    expect((await snapshot(t)).comments).toMatchObject([
      {
        id: "c01",
        pass: "ask",
        kind: "unclear",
        span: "The evenings were quiet.",
        block_orig: P2,
        body: ASK_BODY,
      },
    ]);
    expect(said(lastParts(t, a.chat))).toBe("Answered in a note on that paragraph.");
    await t.say(c, a.chat, "/ask and in general?");
    expect(said(lastParts(t, a.chat))).toBe(NO_PARAGRAPH);
  });
});

describe("the resume letter", () => {
  it("lists the notes left since the article was last opened, and nothing on the first opening", async () => {
    const t = await rig();
    const { a, c } = await written(t);
    expect((await snapshot(t)).resume).toBeNull();
    await new Promise((r) => setTimeout(r, 5));
    await t.say(c, a.chat, "/pass filler");
    const snap = await snapshot(t);
    expect(snap.resume).toMatchObject({
      stage: "ideas",
      unread: [
        { id: "c01", kind: "filler", pass: "filler", span: "really hard" },
        { id: "c02", kind: "filler", pass: "filler", span: "actually missed" },
      ],
    });
    expect(typeof snap.resume.awaySince).toBe("string");
    // opened a moment ago, nothing new: no letter
    expect((await snapshot(t)).resume).toBeNull();
    // read notes are not listed, and a day away brings the letter back with what is still unread
    await t.call("POST", `/api/articles/${SLUG}/comments/seen`, { ids: ["c01"] });
    t.db.run(
      "UPDATE articles SET last_opened_at = ? WHERE slug = ?",
      new Date(Date.now() - 25 * 3600_000).toISOString(),
      SLUG,
    );
    const later = (await snapshot(t)).resume;
    expect(later.unread.map((n: Any) => n.id)).toEqual(["c02"]);
    expect(later.stage).toBe("ideas");
  });
});
