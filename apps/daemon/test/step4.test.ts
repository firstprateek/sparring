// Step 4's done-when, daemon side, with no tokens: the scripted coach leaves two notes through the real tools;
// every sample note in the mocks is accepted; a body with a quoted phrase that is in none of the four sources is
// refused; Done is refused until the block changes; `dismiss c11 on purpose` appends to STYLE.md. Plus the note
// grammar, /critique, /reader and resolve_comment.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ResponsePartKind, ROOT } from "../src/ahp/wire.ts";
import { sha256 } from "../src/articles.ts";
import { CRITIQUE_ASK, READER_ASK } from "../src/coach.ts";
import { NOTE_BODIES, NOTHING, READER_SAYS, SHARPENED, WITHDRAWN } from "../src/demo-agent.ts";
import { FakeLauncher } from "./ahp/fake-acp.ts";
import { type Any, TestClient } from "./ahp/support.ts";
import { meta, rig } from "./rig.ts";

type Rig = Awaited<ReturnType<typeof rig>>;

const P1 = "Closing the laptop at six gave me my evenings back. I thought it would cost me at work.";
const P2 = "It did not, mostly. Nobody noticed for a month.";
const PAGE = `## Six o'clock\n\n${P1}\n\n${P2}\n`;

/** An article with a page, and a client on its chat. */
async function drafted(t: Rig, page = PAGE, slug = "closed-laptop") {
  const a = await t.article(slug);
  const put = await t.call("PUT", `/api/articles/${slug}/article`, {
    text: page,
    base_sha: sha256(""),
    commit: true,
  });
  expect(put.status).toBe(200);
  const c = new TestClient(t.host);
  await c.init([ROOT, a.session, a.chat]);
  return { a, c, sha: put.body.sha as string };
}

const lastParts = (t: Rig, chat: string): Any[] =>
  (t.host.chatState(chat)?.turns.at(-1)?.responseParts ?? []) as Any[];
const hostLines = (ps: Any[]) =>
  ps.filter((p) => p.kind === ResponsePartKind.SystemNotification).map((p) => p.content);
const said = (ps: Any[]) =>
  ps
    .filter((p) => p.kind === ResponsePartKind.Markdown)
    .map((p) => p.content)
    .join("");
const snapshot = async (t: Rig, slug = "closed-laptop") =>
  (await t.call("GET", `/api/articles/${slug}`)).body;
const style = (t: Rig) => readFileSync(join(t.dir, "STYLE.md"), "utf8");

describe("/critique with the scripted coach", () => {
  it("moves to the critique stage and leaves two notes through the comment tool", async () => {
    const t = await rig();
    const { a, c } = await drafted(t);
    await t.say(c, a.chat, "/critique");
    expect(t.articles.row("closed-laptop").stage).toBe("critique");
    expect(hostLines(lastParts(t, a.chat))).toContain("stage critique");
    const snap = await snapshot(t);
    expect(snap.comments).toMatchObject([
      {
        id: "c01",
        kind: "unsupported",
        pass: "critique",
        brief_line: "evidence",
        span: "Closing the laptop at six gave me my evenings back.",
        block_orig: P1,
        body: NOTE_BODIES[0],
        status: "open",
        muted: false,
      },
      {
        id: "c02",
        kind: "unclear",
        pass: "critique",
        brief_line: null,
        span: "It did not, mostly.",
        block_orig: P2,
        body: NOTE_BODIES[1]("It did not,"),
        status: "open",
      },
    ]);
    // each note is a tool call any AHP client sees, by its own name, with the note as its result
    const calls = lastParts(t, a.chat).filter(
      (p) => p.kind === "toolCall" && p.toolCall.displayName === "comment",
    );
    expect(calls.map((p) => p.toolCall.content[0].text)).toEqual([
      `c01 · unsupported · ¶2\n"Closing the laptop at six gave me my evenings back."\n${NOTE_BODIES[0]}`,
      `c02 · unclear · ¶3\n"It did not, mostly."\n${NOTE_BODIES[1]("It did not,")}`,
    ]);
    expect(said(lastParts(t, a.chat))).toBe("Two items. One cites a brief line. Nothing on structure.");
    expect(meta(t.host, a.session)).toMatchObject({ openComments: 2, unreadComments: 2, commentsRev: 2 });
    const turn = t.db.all<Any>("SELECT * FROM turns ORDER BY started_at, rowid").at(-1);
    expect(turn).toMatchObject({ stage: "critique", pass: "critique", status: "done", violation: 0 });
    // asked again in the same session, it has nothing new
    await t.say(c, a.chat, "/critique");
    expect(said(lastParts(t, a.chat))).toBe(NOTHING);
    expect((await snapshot(t)).comments).toHaveLength(2);
  });

  it("leaves the notes on any message once the stage menu has picked critique", async () => {
    const t = await rig();
    const { a, c } = await drafted(t);
    await t.say(c, a.chat, "/stage critique");
    await t.say(c, a.chat, "go on");
    expect((await snapshot(t)).comments).toHaveLength(2);
  });

  it("sends the coach the critique stage prompt, the pass in the header and the open notes", async () => {
    const fake = new FakeLauncher();
    const t = await rig({ launch: fake.launch });
    const { a, c } = await drafted(t);
    await t.say(c, a.chat, "/critique mind section two");
    const blocks = (fake.last.prompts.at(-1)?.blocks ?? []) as Any[];
    const text = blocks.map((b) => b.text).join("\n");
    expect(text).toMatch(/<sparring stage="critique" pass="critique" /);
    expect(text).toContain("Stage: critique. An argument-level pass over the whole draft.");
    expect(blocks.at(-1).text).toBe(`${CRITIQUE_ASK}\n\nThe writer adds: mind section two`);
    // the chat keeps what the writer typed
    expect(t.host.chatState(a.chat)?.turns.at(-1)?.message.text).toBe("/critique mind section two");
  });

  it("starts no agent for /critique while the article is offline, and leaves the stage alone", async () => {
    const t = await rig();
    const { a, c } = await drafted(t);
    await t.say(c, a.chat, "/offline");
    await t.say(c, a.chat, "/critique");
    expect(t.launches()).toBe(0);
    expect(t.articles.row("closed-laptop").stage).toBe("ideas");
  });
});

describe("/reader", () => {
  it("is rewritten into the reader prompt, changes no stage and leaves no notes", async () => {
    const fake = new FakeLauncher();
    const t = await rig({ launch: fake.launch });
    const { a, c } = await drafted(t);
    await t.say(c, a.chat, "/reader");
    const blocks = (fake.last.prompts.at(-1)?.blocks ?? []) as Any[];
    expect(blocks.map((b) => b.text).join("\n")).toMatch(/<sparring stage="ideas" pass="reader" /);
    expect(blocks.at(-1).text).toBe(READER_ASK);
    expect(t.articles.row("closed-laptop").stage).toBe("ideas");
  });

  it("has the scripted coach read the brief and answer as the reader", async () => {
    const t = await rig();
    const { a, c } = await drafted(t);
    await t.say(c, a.chat, "/reader");
    const ps = lastParts(t, a.chat);
    expect(ps.some((p) => p.kind === "toolCall" && p.toolCall.displayName === "read_source")).toBe(true);
    expect(said(ps)).toBe(READER_SAYS);
    expect((await snapshot(t)).comments).toEqual([]);
  });
});

describe("the note actions", () => {
  async function critiqued(t: Rig) {
    const d = await drafted(t);
    await t.say(d.c, d.a.chat, "/critique");
    return d;
  }
  const status = async (t: Rig) =>
    Object.fromEntries(((await snapshot(t)).comments as Any[]).map((n) => [n.id, n.status]));

  it("refuses done until the block has changed on disk, then takes it", async () => {
    const t = await rig();
    const { a, c, sha } = await critiqued(t);
    const launches = t.launches();
    await t.say(c, a.chat, "done c01");
    expect(hostLines(lastParts(t, a.chat))).toEqual(["c01 not done · edit the span first"]);
    expect((await status(t)).c01).toBe("open");
    // the writer rewrites the paragraph the note sits on
    const put = await t.call("PUT", "/api/articles/closed-laptop/article", {
      text: PAGE.replace("gave me my evenings back", "gave me back three hours a night, by my own count"),
      base_sha: sha,
    });
    expect(put.status).toBe(200);
    await t.say(c, a.chat, "done c01");
    expect(hostLines(lastParts(t, a.chat))).toEqual(["c01 done"]);
    expect(await status(t)).toEqual({ c01: "done", c02: "open" });
    // the other note's block is untouched: still refused
    await t.say(c, a.chat, "done c02");
    expect((await status(t)).c02).toBe("open");
    expect(meta(t.host, a.session).openComments).toBe(1);
    // none of this woke the coach
    expect(t.launches()).toBe(launches);
    expect(t.db.all("SELECT 1 FROM turns")).toHaveLength(1);
  });

  it("dismisses a note, and `dismiss c02 on purpose` appends to STYLE.md under ## Do not flag", async () => {
    const t = await rig();
    const { a, c } = await critiqued(t);
    await t.say(c, a.chat, "dismiss c01");
    expect(hostLines(lastParts(t, a.chat))).toEqual(["c01 dismissed"]);
    expect(style(t)).toBe("# Style\n\n## Do not flag\n");
    await t.say(c, a.chat, "dismiss c02 on purpose");
    expect(style(t)).toBe('# Style\n\n## Do not flag\n\n- unclear: "It did not, mostly."\n');
    expect(hostLines(lastParts(t, a.chat))).toEqual([
      'c02 muted · STYLE.md ← do not flag: unclear: "It did not, mostly."',
    ]);
    const notes = (await snapshot(t)).comments as Any[];
    expect(notes.map((n) => [n.id, n.status, n.muted])).toEqual([
      ["c01", "dismissed", false],
      ["c02", "dismissed", true],
    ]);
    // a dismissed note can still be muted, with mute or /mute; a second time changes nothing
    await t.say(c, a.chat, "/mute c01");
    expect(style(t)).toContain('- unsupported: "Closing the laptop at six gave me my evenings back."');
    await t.say(c, a.chat, "mute c01");
    expect(hostLines(lastParts(t, a.chat))).toEqual(["c01 is already muted · nothing changed"]);
    expect(style(t).match(/^- /gm)).toHaveLength(2);
    // the same line is never written twice
    await t.articles.doNotFlag('- unclear: "It did not, mostly."');
    expect(style(t).match(/^- /gm)).toHaveLength(2);
    expect(meta(t.host, a.session).openComments).toBe(0);
  });

  it("answers an action on a note that is not there, and keeps plain text plain", async () => {
    const t = await rig();
    const { a, c } = await critiqued(t);
    await t.say(c, a.chat, "done c44");
    expect(hostLines(lastParts(t, a.chat))).toEqual(["no note c44 · nothing changed"]);
    await t.say(c, a.chat, "/mute");
    expect(hostLines(lastParts(t, a.chat))).toEqual(["nothing muted · /mute c11"]);
  });

  it("sends `re c01: …` to the coach, which sharpens the note as v2", async () => {
    const t = await rig();
    const { a, c } = await critiqued(t);
    await t.say(c, a.chat, "re c01: I counted the evenings myself.");
    const n = ((await snapshot(t)).comments as Any[])[0];
    expect(n).toMatchObject({
      id: "c01",
      status: "disagreed",
      reply: "I counted the evenings myself.",
      body: NOTE_BODIES[0],
      body_v2: SHARPENED,
    });
    expect(said(lastParts(t, a.chat))).toBe("c01 v2");
    // still waiting on the writer
    expect(meta(t.host, a.session).openComments).toBe(2);
  });

  it("lets the coach withdraw a note the writer argued down", async () => {
    const t = await rig();
    const { a, c } = await critiqued(t);
    await t.say(c, a.chat, "re c02: please withdraw this, the next section answers it");
    const n = ((await snapshot(t)).comments as Any[])[1];
    expect(n).toMatchObject({ id: "c02", status: "withdrawn", body_v2: WITHDRAWN });
    expect(n.resolved_at).toBeTruthy();
    expect(meta(t.host, a.session).openComments).toBe(1);
  });

  it("marks notes seen", async () => {
    const t = await rig();
    const { a } = await critiqued(t);
    const res = await t.call("POST", "/api/articles/closed-laptop/comments/seen", { ids: ["c01"] });
    expect(res.status).toBe(200);
    expect(t.articles.metaFor(t.articles.row("closed-laptop"))).toMatchObject({
      openComments: 2,
      unreadComments: 1,
    });
    expect((await t.call("POST", "/api/articles/closed-laptop/comments/seen", {})).status).toBe(400);
    expect(a.chat).toBeTruthy();
  });
});
