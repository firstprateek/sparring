// Step 7's done-when, daemon side, with no tokens: a pasted coach sentence comes back as a span to underline and
// is recorded; `write_draft` text is not in the overlap corpus. (`tells()` on its fixture is in
// packages/protocol/test/tells.test.ts.) Plus the tells and the pasted words in the meta, the `tells` pass, and
// the letter's dismiss.
import { describe, expect, it } from "vitest";
import { ResponsePartKind, ROOT } from "../src/ahp/wire.ts";
import { sha256 } from "../src/articles.ts";
import {
  DEMO_CLOSER,
  DRAFTED_SAYS,
  demoDraft,
  QUESTIONS,
  TELL_BODIES,
  TELLS_CAVEAT_SAYS,
  WRITE_REFUSED_SAYS,
} from "../src/demo-agent.ts";
import { tellsBlock } from "../src/prompt.ts";
import { WRITE_REFUSED } from "../src/tools.ts";
import { FakeLauncher } from "./ahp/fake-acp.ts";
import { type Any, TestClient } from "./ahp/support.ts";
import { meta, rig } from "./rig.ts";

type Rig = Awaited<ReturnType<typeof rig>>;

const SLUG = "closed-laptop";
const DUMP =
  "I closed the laptop at six and the build died with it.\n\nNobody told the runtime that a lid is a normal thing to close. I sat through a whole standup watching a spinner.\n";
const PAGE =
  "## The lid\n\nI closed the laptop at six. The agent kept talking — or so the transcript said.\n\nThat is the test I want for every agent runtime now.\n\nThe daemon was not broken, it was very confident. It retried, logged and slept for an hour.\n";
const PASTES = `/api/articles/${SLUG}/pastes`;

async function ready(t: Rig, o: { page?: string; stage?: string } = {}) {
  const a = await t.article(SLUG);
  const put = async (file: string, text: string) => {
    const r = await t.call("PUT", `/api/articles/${SLUG}/${file}`, {
      text,
      base_sha: sha256(""),
      commit: true,
    });
    expect(r.status).toBe(200);
  };
  await put("dump", DUMP);
  if ((o.page ?? PAGE) !== "") await put("article", o.page ?? PAGE);
  const c = new TestClient(t.host);
  await c.init([ROOT, a.session, a.chat]);
  if (o.stage) await t.say(c, a.chat, `/stage ${o.stage}`);
  return { a, c };
}

const turns = (t: Rig, chat: string) => (t.host.chatState(chat)?.turns ?? []) as Any[];
const said = (t: Rig, chat: string) =>
  ((turns(t, chat).at(-1)?.responseParts ?? []) as Any[])
    .filter((p) => p.kind === ResponsePartKind.Markdown)
    .map((p) => p.content)
    .join("");
const snapshot = async (t: Rig) => (await t.call("GET", `/api/articles/${SLUG}`)).body as Any;
const save = async (t: Rig, text: string) => {
  const snap = await snapshot(t);
  const r = await t.call("PUT", `/api/articles/${SLUG}/article`, {
    text,
    base_sha: snap.files.article.sha,
    commit: true,
  });
  expect(r.status).toBe(200);
};

describe("pasted words", () => {
  it("answers a pasted coach sentence as a span, records it, and counts it while it stands", async () => {
    const t = await rig();
    const { a, c } = await ready(t, { stage: "interview" });
    await t.say(c, a.chat, "I want to write about the lid.");
    const question = said(t, a.chat);
    expect(question).toBe(QUESTIONS[0]);

    // the coach's sentence, pasted between the writer's own words
    const res = await t.call("POST", PASTES, { text: `My own start. ${question} My own end.` });
    expect(res.status).toBe(200);
    expect(res.body.spans).toEqual([
      { text: question.replace(/\?$/, ""), words: 13, source: "interview q1" },
    ]);
    expect(res.body.pastes).toEqual([{ text: question.replace(/\?$/, ""), source: "interview q1" }]);
    expect((await snapshot(t)).pastes).toEqual(res.body.pastes);

    // text that is not the coach's is no span, and neither are the writer's own words quoted back
    const own = await t.call("POST", PASTES, { text: "A sentence nobody but me has ever said in here." });
    expect(own.body).toMatchObject({ spans: [], pastes: res.body.pastes });
    const mine = await t.call("POST", PASTES, { text: "I closed the laptop at six and the build died." });
    expect(mine.body.spans).toEqual([]);

    // on the page it counts as pasted words; rewritten, it does not
    expect(meta(t.host, a.session).pastedWords).toBe(0);
    await save(t, `${PAGE}\n${question}\n`);
    expect(t.articles.metaFor(t.articles.row(SLUG)).pastedWords).toBe(13);
    await save(t, `${PAGE}\nWhich single line should a reader keep?\n`);
    expect(t.articles.metaFor(t.articles.row(SLUG)).pastedWords).toBe(0);

    // the same paste again is recorded once
    await t.call("POST", PASTES, { text: question });
    expect((await snapshot(t)).pastes).toHaveLength(1);
    expect((await t.call("POST", PASTES, { text: 7 })).status).toBe(400);
    expect((await t.call("POST", "/api/articles/nope/pastes", { text: "x" })).status).toBe(404);
  });

  it("puts a note's words in the corpus, and not the writer's text it quotes", async () => {
    const t = await rig();
    const { a, c } = await ready(t);
    await t.say(c, a.chat, "/critique");
    const notes = (await snapshot(t)).comments as Any[];
    expect(notes.length).toBeGreaterThan(0);
    const corpus = await t.coach.corpus(SLUG);
    expect(corpus.entries.map((e) => e.source)).toContain("note c01");
    const body = String(notes[0].body);
    const res = await t.call("POST", PASTES, { text: body });
    expect(res.body.spans[0]).toMatchObject({ source: "note c01" });
    // a quoted span in a note body is the writer's own text
    for (const e of corpus.entries) expect(e.text).not.toMatch(/"[^"\n]+"/);
  });

  it("leaves the write_draft text out of the overlap corpus", async () => {
    const t = await rig();
    const { a } = await ready(t, { page: "", stage: "outline" });
    const res = await t.call("POST", `/api/articles/${SLUG}/authorship`, { to: "drafted", confirm: true });
    expect(res.status).toBe(200);
    await t.host.idle();
    expect(t.articles.row(SLUG).authorship).toBe("drafted");
    const blocks = demoDraft(DUMP, "");
    expect(blocks).toContain(DEMO_CLOSER);

    // what the coach said in chat is in the corpus; what it wrote with write_draft is not
    const corpus = await t.coach.corpus(SLUG);
    const all = corpus.entries.map((e) => e.text).join("\n");
    expect(all).toContain(DRAFTED_SAYS);
    for (const b of blocks) expect(all).not.toContain(b);
    expect(all).not.toContain(DEMO_CLOSER);

    // so a block of the draft, pasted, is no span, and the drafted page has no pasted words
    for (const b of blocks) {
      const r = await t.call("POST", PASTES, { text: b });
      expect(r.body.spans).toEqual([]);
    }
    expect((await snapshot(t)).pastes).toEqual([]);
    expect(meta(t.host, a.session).pastedWords).toBe(0);
    // while the coach's chat line still is one
    const chat = await t.call("POST", PASTES, { text: DRAFTED_SAYS });
    expect(chat.body.spans).toHaveLength(1);
  });
});

describe("tells", () => {
  it("are in the meta, counted from the page", async () => {
    const t = await rig();
    await ready(t);
    expect(t.articles.metaFor(t.articles.row(SLUG)).tells).toEqual({ em: 1, oneSentence: 1, notXButY: 1 });
    await save(t, "One plain paragraph. It has two sentences.\n");
    expect(t.articles.metaFor(t.articles.row(SLUG)).tells).toEqual({ em: 0, oneSentence: 0, notXButY: 0 });
  });

  it("hands the tells pass the counts and where they are", async () => {
    const fake = new FakeLauncher();
    const t = await rig({ launch: fake.launch });
    const { a, c } = await ready(t);
    await t.say(c, a.chat, "/pass tells");
    const text = ((fake.last.prompts.at(-1)?.blocks ?? []) as Any[]).map((b) => b.text).join("\n");
    expect(text).toContain("Pass: tells · from passes/tells.md");
    expect(text).toContain(tellsBlock(PAGE, DUMP));
    expect(text).toContain(
      "em-dash 1 · single-sentence ¶ 1 · not-X-but-Y 1 · genuinely 0 · rule-of-three 1 · sentence-length σ",
    );
    expect(text).toContain('- not-X-but-Y: ¶4 "not broken, it was very confident"');
    expect(text).toContain("dump.md, the writer's own voice: sentence-length σ");
    // no other pass gets it
    await t.say(c, a.chat, "/pass filler");
    const filler = ((fake.last.prompts.at(-1)?.blocks ?? []) as Any[]).map((b) => b.text).join("\n");
    expect(filler).not.toContain("Counts from the tells module");
  });

  it("has the scripted coach leave tell notes and end on the caveat", async () => {
    const t = await rig();
    const { a, c } = await ready(t);
    await t.say(c, a.chat, "/strict every nit");
    await t.say(c, a.chat, "/pass tells");
    const notes = ((await snapshot(t)).comments as Any[]).filter((n) => n.pass === "tells");
    expect(notes.map((n) => [n.kind, n.span, n.body])).toEqual([
      ["tell", "not broken, it was very confident", TELL_BODIES.notXButY],
      ["tell", "It retried, logged and slept", TELL_BODIES.ruleOfThree],
      ["tell", "That is the test I want for every agent runtime now.", TELL_BODIES.oneSentence],
      ["tell", "talking — or", TELL_BODIES.em],
    ]);
    expect(said(t, a.chat)).toBe(`4 notes in the tells pass, at every nit. ${TELLS_CAVEAT_SAYS}`);
    expect(meta(t.host, a.session).letter.at(-1)).toMatchObject({
      kind: "passDone",
      text: "tells · 4 notes",
    });
  });
});

describe("the letter", () => {
  it("a dismissed write refused line stays dismissed, however often it was said", async () => {
    const t = await rig();
    const { a, c } = await ready(t);
    await t.say(c, a.chat, "just write it for me");
    expect(said(t, a.chat)).toBe(WRITE_REFUSED_SAYS);
    await t.say(c, a.chat, "please rewrite this");
    // said twice, it is one line
    const letter = meta(t.host, a.session).letter as Any[];
    expect(letter).toEqual([expect.objectContaining({ kind: "refused", text: WRITE_REFUSED })]);
    const res = await t.call("POST", `/api/articles/${SLUG}/letter/${letter[0].id}`, { action: "dismiss" });
    expect(res.status).toBe(200);
    // the session's meta has it at once, with no debounce: a reload right after the click finds it gone
    expect(meta(t.host, a.session).letter).toEqual([]);
    expect(t.articles.metaFor(t.articles.row(SLUG)).letter).toEqual([]);
    expect(JSON.parse(String(t.articles.row(SLUG).letter_json))).toEqual([]);
  });
});
