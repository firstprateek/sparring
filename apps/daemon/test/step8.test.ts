// Step 8's done-when, with no network and no tokens: against a fixture copy of the site with a local bare repo as
// origin and a `gh` stub on PATH, the diff touches one path, the right one; a job killed before `push` is marked
// `failed` at its step and the next publish starts clean; a job killed after `push` gets its PR on the next
// publish; a second publish gives `post/<slug>-2`; and each refusal fires, including an unticked coach block and
// a sha that is not the reviewed one.
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { overlap, overlapIndex } from "@sparring/protocol/overlap";
import { blockers, type Preflight, realDate, QUESTIONS as SHEET_QUESTIONS } from "@sparring/protocol/publish";
import { describe, expect, it } from "vitest";
import { ROOT } from "../src/ahp/wire.ts";
import { sha256 } from "../src/articles.ts";
import { QUESTIONS } from "../src/demo-agent.ts";
import {
  buildPost,
  checkBody,
  cleanBody,
  disclosureLine,
  type Exec,
  Publisher,
  type PublishSettings,
  postPath,
} from "../src/publish.ts";
import { type Any, TestClient } from "./ahp/support.ts";
import { dirs, meta, rig } from "./rig.ts";
import { FIXTURE_REPO, FIXTURE_URL, siteFixture } from "./site-fixture.ts";

const SLUG = "closed-laptop";
const PUBLISH = `/api/articles/${SLUG}/publish`;
const DUMP =
  "I closed the laptop at six and the build died with it.\n\nNobody told the runtime that a lid is a normal thing to close.\n";
const PAGE =
  "## The lid\n\nI closed the laptop at six and nothing warned me. <!-- check the time -->\n\nThat is the test I want for every agent runtime now.\n";
const META = {
  title: 'The laptop lid is a "chaos monkey"',
  description: "Closing a laptop does not crash a coding agent: it leaves one confident.",
  date: "2026-11-07",
  answers: ["that the bug was my trust", "yes, I said it to Dev", "people building agent runtimes"],
};
const SETTINGS: PublishSettings = {
  siteRepo: FIXTURE_REPO,
  gitName: "Post Author",
  gitEmail: "author@fixture.test",
};

const realExec: Exec = (cmd, args, o) =>
  new Promise((resolve) => {
    execFile(cmd, args, { cwd: o.cwd, env: o.env, timeout: o.timeoutMs }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
/** A command that never answers: what a job looks like from outside when its daemon has died. */
const never = new Promise<never>(() => {});

type Rig = Awaited<ReturnType<typeof rig>>;

async function setup(o: { settings?: PublishSettings; placeholder?: boolean; exec?: Exec } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sparring-site-"));
  dirs.push(dir);
  const fx = siteFixture(dir, o.placeholder ? { placeholder: true } : {});
  const said: { text: string; bad: boolean }[] = [];
  const make = (t: Pick<Rig, "articles" | "db" | "coach">, exec?: Exec) =>
    new Publisher({
      articles: t.articles,
      db: t.db,
      home: fx.home,
      settings: () => o.settings ?? SETTINGS,
      path: fx.path,
      corpus: (slug) => t.coach.corpus(slug),
      say: (row, text, bad) => {
        said.push({ text, bad });
        if (row.chat) t.coach.line(row, row.chat, text, bad ? "refused" : "divider");
      },
      changed: (id) => t.coach.pushMeta(id),
      fetchEveryMs: 0,
      prPollMs: 0,
      ...(exec ? { exec } : {}),
    });
  const t = await rig({ publisher: (parts) => make(parts, o.exec) });
  const pub = t.publisher as Publisher;
  return { t, fx, pub, said, make };
}

async function article(t: Rig, o: { page?: string; meta?: Record<string, unknown> | null } = {}) {
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
  await put("article", o.page ?? PAGE);
  if (o.meta !== null) {
    const r = await t.call("PUT", `/api/articles/${SLUG}/meta`, o.meta ?? META);
    expect(r.status).toBe(200);
  }
  const c = new TestClient(t.host);
  await c.init([ROOT, a.session, a.chat]);
  return { a, c };
}

const preflight = async (t: Rig) => {
  const r = await t.call("GET", PUBLISH);
  expect(r.status).toBe(200);
  return r.body as Preflight;
};
const save = async (t: Rig, text: string) => {
  const snap = (await t.call("GET", `/api/articles/${SLUG}`)).body as Any;
  const r = await t.call("PUT", `/api/articles/${SLUG}/article`, {
    text,
    base_sha: snap.files.article.sha,
    commit: true,
  });
  expect(r.status).toBe(200);
};
/** Publishes what the preflight shows, with every tick it asks for, and waits for the job. */
async function publish(t: Rig, pub: Publisher, ticked?: string[]) {
  const pf = await preflight(t);
  const res = await t.call("POST", PUBLISH, {
    article_commit: pf.article_commit,
    origin_sha: pf.origin.sha,
    ticked: ticked ?? [...pf.spans.map((s) => s.hash), ...pf.blocks.map((b) => b.hash)],
  });
  await pub.idle();
  return { pf, res };
}
const job = (t: Rig) => t.db.all<Any>("SELECT * FROM publishes ORDER BY id").at(-1) as Any;
const reasons = (pf: Preflight, ticked: string[] = []) => blockers(pf, ticked);

describe("the post", () => {
  it("writes four front matter keys in order, quoted through JSON, over the cleaned body", () => {
    const post = buildPost(META, PAGE);
    expect(post).toBe(
      [
        "---",
        'title: "The laptop lid is a \\"chaos monkey\\""',
        "date: 2026-11-07",
        'description: "Closing a laptop does not crash a coding agent: it leaves one confident."',
        "draft: false",
        "---",
        "",
        "## The lid",
        "",
        "I closed the laptop at six and nothing warned me. ",
        "",
        "That is the test I want for every agent runtime now.",
        "",
      ].join("\n"),
    );
    // a title on two lines is one line; nothing is concatenated raw
    expect(buildPost({ ...META, title: " a\n  b: c " }, "x")).toContain('title: "a b: c"\n');
  });

  it("removes comments outside code and keeps them inside it", () => {
    const text =
      "one <!-- gone -->two\n\n`<!-- kept -->` and\n\n```html\n<!-- kept too -->\n<div>\n```\n\n<!--\nmany\nlines\n-->\nend\n";
    const { body, prose } = cleanBody(text);
    expect(body).toBe("one two\n\n`<!-- kept -->` and\n\n```html\n<!-- kept too -->\n<div>\n```\n\n\nend");
    expect(prose).not.toContain("kept");
    expect(checkBody(body, prose)).toMatchObject({ html: null, h1: null, image: false, frontmatter: false });
  });

  it("finds each thing the body may not hold, and lets code and autolinks pass", () => {
    const check = (text: string) => {
      const { body, prose } = cleanBody(text);
      return checkBody(body, prose);
    };
    expect(check("---\ntitle: x\n---\n\ntext").frontmatter).toBe(true);
    expect(check("text\n\n# A title\n").h1).toBe("# A title");
    expect(check("## Fine\n\n```\n# a comment in code\n```\n").h1).toBeNull();
    expect(check("see ![alt](a.png)").image).toBe(true);
    expect(check("a <div class='x'>b</div>").html).toBe("<div class='x'>");
    expect(check("a <script>alert(1)</script>").html).toBe("<script>");
    expect(check("inline `<b>` and\n\n```\n<script>\n```\n").html).toBeNull();
    expect(check("see <https://example.org/a> or <me@example.org>, 1 < 2 > 0").html).toBeNull();
    expect(check("[x](javascript:alert(1))").scheme).toBe("javascript:");
    expect(check("[x]: data:text/html,hi").scheme).toBe("data:");
    expect(check("<ftp://host/file>").scheme).toBe("ftp:");
    expect(
      check("[a](https://a.b) [b](mailto:c@d.e) [c](/writing/x/) [d](#top) [e](../y)").scheme,
    ).toBeNull();
    expect(check("zero​width").invisible).toBe("U+200B in ¶1");
    expect(check("ok\n\nright‮left").invisible).toBe("U+202E in ¶2");
    expect(check("## a\n\n#### too deep\n").deep).toBe("#### too deep");
    expect(check("  \n").empty).toBe(true);
    expect(realDate("2026-02-28")).toBe(true);
    expect(realDate("2026-02-30")).toBe(false);
    expect(realDate("2026-2-3")).toBe(false);
    expect(disclosureLine("a\n\n*Disclosure: a coach read this.*\n")).toBe(
      "*Disclosure: a coach read this.*",
    );
    expect(disclosureLine("a\n\nb\n")).toBe("");
  });

  it("does not count a reply that quotes the page as the coach's words", () => {
    const said =
      "You wrote that the lid is a normal thing to close, and I would open with the standup story instead.";
    const page = "Nobody told the runtime that the lid is a normal thing to close.";
    const later = `${page} I would open with the standup story instead.`;
    // the coach said it after the sentence was on the page: only its own words are its own
    const index = overlapIndex([{ source: "critique reply", text: said, before: page }]);
    expect(overlap(later, index).map((s) => s.text)).toEqual(["I would open with the standup story instead"]);
    // a run the coach said first stays the coach's, however often it quotes the page afterwards
    const twice = overlapIndex([
      { source: "interview q1", text: said, before: "" },
      { source: "critique reply", text: said, before: later },
    ]);
    expect(overlap(later, twice)).toHaveLength(1);
    expect(overlap(later, twice)[0]?.source).toBe("interview q1");
  });
});

describe("the preflight", () => {
  it("says publishing is not set up, names the keys, and still shows the gates", async () => {
    const { t, fx } = await setup({ settings: {} });
    await article(t, { meta: null });
    const pf = await preflight(t);
    expect(pf.configured).toBe(false);
    expect(pf.setup.join("\n")).toMatch(/site_repo is not set/);
    expect(pf.setup.join("\n")).toMatch(/publish\.git_name and publish\.git_email are not set/);
    expect(pf.origin).toMatchObject({ clean: false, bad: true, text: "origin/main · not set up" });
    // the gates are all there to read
    expect(pf.checks.map((c) => c.id)).toEqual(
      expect.arrayContaining([
        "site",
        "headings",
        "images",
        "slug",
        "title",
        "description",
        "date",
        "answers",
      ]),
    );
    expect(pf.post).toContain("draft: false");
    expect(reasons(pf)[0]).toBe("publishing is not set up");
    const res = await t.call("POST", PUBLISH, { article_commit: pf.article_commit, ticked: [] });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("publishing is not set up");
    expect(fx.ghCalls()).toEqual([]);
    expect(fx.branches()).toEqual(["main"]);
  });

  it("says there is no clone when only the clone is missing", async () => {
    const { t, make } = await setup();
    await article(t);
    const dir = mkdtempSync(join(tmpdir(), "sparring-noclone-"));
    dirs.push(dir);
    const bare = new Publisher({ articles: t.articles, db: t.db, home: dir, settings: () => SETTINGS });
    const pf = await bare.preflight(SLUG);
    expect(pf.configured).toBe(false);
    expect(pf.setup).toHaveLength(1);
    expect(pf.setup[0]).toMatch(
      /no clone of the site at .*site · git clone git@github\.com:fixture-owner\/fixture-site\.git/,
    );
    make(t); // the rig's publisher owns the meta hook again
  });

  it("shows the four checks, the fields, the numbers and the exact file", async () => {
    const { t, fx } = await setup();
    await article(t);
    const pf = await preflight(t);
    expect(pf).toMatchObject({
      slug: SLUG,
      configured: true,
      setup: [],
      kind: "first",
      branch: `post/${SLUG}`,
      authorship: "coached",
      path: `src/content/posts/${SLUG}.md`,
      meta: META,
      spans: [],
      blocks: [],
      pr: null,
      publish: null,
    });
    expect(pf.origin).toEqual({
      sha: fx.origin("rev-parse", "main"),
      clean: true,
      text: "origin/main · clean",
    });
    expect(pf.checks).toEqual([
      { id: "site", ok: true, text: "site.config has no placeholders" },
      { id: "headings", ok: true, text: "headings start at ##" },
      { id: "images", ok: true, text: "no ![ in body" },
      { id: "slug", ok: true, text: "slug is new on origin/main" },
    ]);
    expect(pf.post).toBe(buildPost(META, PAGE));
    expect(pf.counts).toMatchObject({
      questions: 0,
      comments: 0,
      violations: 0,
      pastedWords: 0,
      spans: 0,
      words: 23,
    });
    expect(reasons(pf)).toEqual([]);
    expect(SHEET_QUESTIONS).toHaveLength(3);
    // the machine was asked once who it is and what it may do
    expect(fx.ghCalls()).toEqual([
      "auth status --hostname github.com",
      `repo view ${FIXTURE_REPO} --json viewerPermission`,
    ]);
  });

  it("stores the fields with PUT meta, one key at a time, and titles the session", async () => {
    const { t } = await setup();
    const { a } = await article(t, { meta: null });
    expect((await preflight(t)).meta).toEqual({
      title: "",
      description: "",
      date: "",
      answers: ["", "", ""],
    });
    const one = await t.call("PUT", `/api/articles/${SLUG}/meta`, { title: "  The lid  " });
    expect(one.body.meta).toMatchObject({ title: "The lid", description: "" });
    expect(t.host.sessionState(a.session)?.title).toBe("The lid");
    await t.call("PUT", `/api/articles/${SLUG}/meta`, { answers: ["a", "b", "c"], date: "2026-11-07" });
    expect(JSON.parse(readFileSync(join(t.dir, SLUG, "meta.json"), "utf8"))).toEqual({
      title: "The lid",
      description: "",
      date: "2026-11-07",
      answers: ["a", "b", "c"],
    });
    expect((await t.call("PUT", `/api/articles/${SLUG}/meta`, { answers: ["a"] })).status).toBe(400);
    expect((await t.call("PUT", `/api/articles/${SLUG}/meta`, { title: 3 })).status).toBe(400);
    expect((await t.call("PUT", "/api/articles/nope/meta", { title: "x" })).status).toBe(404);
  });
});

describe("a publish", () => {
  it("opens a PR whose diff touches one path, the right one, with the right front matter", async () => {
    const { t, fx, pub, said } = await setup();
    const { a } = await article(t);
    const { pf, res } = await publish(t, pub);
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ publish_id: 1 });

    // origin: one new branch, one commit on it, one changed path
    expect(fx.branches()).toEqual(["main", `post/${SLUG}`]);
    expect(fx.origin("diff", "--name-status", "main", `post/${SLUG}`)).toBe(`A\t${postPath(SLUG)}`);
    expect(fx.origin("rev-list", "--count", `main..post/${SLUG}`)).toBe("1");
    expect(fx.origin("log", "-1", "--format=%s|%an|%ae", `post/${SLUG}`)).toBe(
      'Add post: The laptop lid is a "chaos monkey"|Post Author|author@fixture.test',
    );
    expect(fx.origin("show", `post/${SLUG}:${postPath(SLUG)}`)).toBe(buildPost(META, PAGE).trimEnd());
    expect(fx.origin("rev-parse", "main")).toBe(pf.origin.sha);

    // gh: one PR, made from an argv, with the body file
    const create = fx.ghCalls().filter((l) => l.startsWith("pr create"));
    expect(create).toHaveLength(1);
    expect(create[0]).toMatch(
      new RegExp(
        `^pr create --fill --body-file \\S+publish-1\\.pr\\.md --head post/${SLUG} --repo ${FIXTURE_REPO}$`,
      ),
    );
    const body = fx.prBody(1);
    expect(body).toContain(`Post \`/writing/${SLUG}/\` from \`src/content/posts/${SLUG}.md\`.`);
    expect(body).toContain("- date: 2026-11-07");
    expect(body).toContain("- words: 23");
    expect(body).toContain(`- build: dist/writing/${SLUG}/index.html · rss ok`);
    expect(body).toContain(`- Sparring article commit: ${pf.article_commit}`);
    expect(body).toContain("Provenance (recorded by Sparring; not part of the post)");
    expect(body).toContain("- mode: coached");
    expect(body).toContain("- questions asked 0 · comments 0 · done 0 · dismissed 0");
    expect(body).toContain("- disagreed 0 · violations 0 · pasted words 0");
    expect(body).toContain("- disclosure line: none");

    // the row, the article, the meta and the chat
    const url = "https://github.com/fixture-owner/fixture-site/pull/1";
    expect(job(t)).toMatchObject({
      n: 1,
      kind: "first",
      step: "done",
      error: null,
      branch: `post/${SLUG}`,
      article_commit: pf.article_commit,
      origin_sha: pf.origin.sha,
      pr_number: 1,
      pr_url: url,
      pr_state: "open",
      authorship: "coached",
      acks_json: "[]",
    });
    expect(t.articles.row(SLUG)).toMatchObject({ pr_number: 1, pr_url: url });
    const m = meta(t.host, a.session);
    expect(m).toMatchObject({ prNumber: 1, prUrl: url, lastLine: `build finished · PR #1 is open · ${url}` });
    expect(m.publish).toMatchObject({ id: 1, step: "done" });
    expect(m.publish.error).toBeUndefined();
    expect(m.publish.lines).toEqual([
      expect.stringMatching(/^✓ checks passed · article [0-9a-f]{7} · first · post\/closed-laptop$/),
      expect.stringMatching(
        /^\$ git worktree add -B post\/closed-laptop \S+worktrees\/closed-laptop origin\/main$/,
      ),
      `wrote src/content/posts/${SLUG}.md`,
      "$ npm ci",
      "$ npm run build",
      `✓ built · dist/writing/${SLUG}/index.html · rss ok`,
      '$ git commit -m "Add post: The laptop lid is a \\"chaos monkey\\""',
      `$ git push -u origin post/${SLUG}`,
      "$ gh pr create --fill",
      url,
    ]);
    expect(said.at(-1)).toEqual({ text: `build finished · PR #1 is open · ${url}`, bad: false });
    // the worktree is gone, the log file is there
    expect(existsSync(join(fx.home, "worktrees", SLUG))).toBe(false);
    expect(readFileSync(join(fx.home, "logs", "publish-1.log"), "utf8")).toContain("$ npm run build");
    // nothing new to publish: the same commit is the published one
    expect((await preflight(t)).published_commit).toBe(pf.article_commit);
  });

  it("updates the open PR on the same branch", async () => {
    const { t, fx, pub } = await setup();
    await article(t);
    await publish(t, pub);
    await save(t, `${PAGE}\nOne more paragraph, written after the PR was opened.\n`);
    const pf = await preflight(t);
    expect(pf).toMatchObject({
      kind: "update_open",
      branch: `post/${SLUG}`,
      pr: { number: 1, state: "open" },
    });
    expect(pf.checks.find((c) => c.id === "slug")).toMatchObject({
      ok: true,
      text: `PR #1 is open · branch post/${SLUG}`,
    });
    const { res } = await publish(t, pub);
    expect(res.status).toBe(202);
    expect(job(t)).toMatchObject({ n: 2, kind: "update_open", step: "done", pr_number: 1 });
    expect(fx.branches()).toEqual(["main", `post/${SLUG}`]);
    expect(fx.origin("rev-list", "--count", `main..post/${SLUG}`)).toBe("2");
    expect(fx.origin("diff", "--name-only", "main", `post/${SLUG}`)).toBe(postPath(SLUG));
    expect(fx.origin("log", "-1", "--format=%s", `post/${SLUG}`)).toMatch(/^Update post: /);
    expect(fx.ghCalls().filter((l) => l.startsWith("pr create"))).toHaveLength(1);
    expect(fx.ghCalls().filter((l) => l.startsWith("pr edit 1 --repo"))).toHaveLength(1);
  });

  it("gives post/<slug>-2 after the first PR was merged, with the diff against the merged file", async () => {
    const { t, fx, pub } = await setup();
    const { a } = await article(t);
    await publish(t, pub);
    fx.merge(1, `post/${SLUG}`);
    await save(t, PAGE.replace("nothing warned me", "nobody warned me"));
    const pf = await preflight(t);
    expect(pf).toMatchObject({ kind: "edit_merged", branch: `post/${SLUG}-2` });
    expect(pf.checks.find((c) => c.id === "slug")).toEqual({
      id: "slug",
      ok: true,
      text: `exists · branch post/${SLUG}-2 · diff`,
    });
    expect(pf.diff).toContain("-I closed the laptop at six and nothing warned me. ");
    expect(pf.diff).toContain("+I closed the laptop at six and nobody warned me. ");
    expect(pf.meta.date).toBe("2026-11-07"); // the original date is kept
    expect(t.db.all<Any>("SELECT pr_state FROM publishes")[0]?.pr_state).toBe("merged");
    expect(t.articles.row(SLUG).published_at).toBe("2026-11-11T10:00:00Z");
    expect(meta(t.host, a.session).lastLine).toBe("PR #1 was merged · published");

    const { res } = await publish(t, pub);
    expect(res.status).toBe(202);
    expect(job(t)).toMatchObject({
      n: 2,
      kind: "edit_merged",
      step: "done",
      branch: `post/${SLUG}-2`,
      pr_number: 2,
    });
    expect(fx.branches()).toEqual(["main", `post/${SLUG}-2`]);
    expect(fx.origin("diff", "--name-status", "main", `post/${SLUG}-2`)).toBe(`M\t${postPath(SLUG)}`);
    expect(fx.origin("log", "-1", "--format=%s", `post/${SLUG}-2`)).toMatch(/^Update post: /);
    expect(fx.ghCalls().at(-1)).toMatch(new RegExp(`--head post/${SLUG}-2 --repo`));
    // and after that one is closed unmerged, the third try is -3
    fx.origin("update-ref", "-d", `refs/heads/post/${SLUG}-2`);
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(fx.bin, "closed-2"), "");
    expect(await preflight(t)).toMatchObject({ kind: "edit_merged", branch: `post/${SLUG}-3` });
  });

  it("marks a job killed before push failed at its step, and the next publish starts clean", async () => {
    // the daemon dies while `npm run build` runs
    const dying: Exec = (cmd, args, o) =>
      cmd === "npm" && args[0] === "run" ? never : realExec(cmd, args, o);
    const { t, fx, said, make } = await setup({ exec: dying });
    const { a } = await article(t);
    const pf = await preflight(t);
    const res = await t.call("POST", PUBLISH, { article_commit: pf.article_commit, ticked: [] });
    expect(res.status).toBe(202);
    await expect.poll(() => job(t).step, { timeout: 20_000 }).toBe("build");
    // a second request while it runs is refused
    const again = await t.call("POST", PUBLISH, { article_commit: pf.article_commit, ticked: [] });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe("a publish is already running for this article");
    expect(existsSync(join(fx.home, "worktrees", SLUG))).toBe(true);

    // the daemon starts again
    const next = make(t);
    await next.recover();
    expect(job(t)).toMatchObject({ id: 1, step: "failed", error: "stopped at build · the daemon restarted" });
    expect(job(t).finished_at).toBeTruthy();
    expect(said.at(-1)).toEqual({
      text: "publish stopped at build when the daemon restarted · nothing left this machine · publish again",
      bad: true,
    });
    expect(meta(t.host, a.session).publish).toMatchObject({
      step: "failed",
      error: "stopped at build · the daemon restarted",
    });
    // nothing left the machine, and the worktree is pruned
    expect(fx.branches()).toEqual(["main"]);
    expect(existsSync(join(fx.home, "worktrees", SLUG))).toBe(false);
    expect(fx.ghCalls().some((l) => l.startsWith("pr "))).toBe(false);

    // the next publish starts clean
    const fresh = await next.preflight(SLUG);
    expect(fresh).toMatchObject({ kind: "first", branch: `post/${SLUG}`, pr: null });
    expect(fresh.origin.text).toBe("origin/main · clean");
    await next.publish(SLUG, { article_commit: fresh.article_commit, ticked: [] });
    await next.idle();
    expect(job(t)).toMatchObject({ id: 2, n: 2, kind: "first", step: "done", pr_number: 1 });
    expect(fx.origin("diff", "--name-status", "main", `post/${SLUG}`)).toBe(`A\t${postPath(SLUG)}`);
    expect(fx.origin("rev-list", "--count", `main..post/${SLUG}`)).toBe("1");
  });

  it("gives a job killed after push its PR on the next publish", async () => {
    // the daemon dies while `gh pr create` runs: the branch is on origin, the PR is not
    const dying: Exec = (cmd, args, o) =>
      cmd === "gh" && args[1] === "create" ? never : realExec(cmd, args, o);
    const { t, fx, said, make } = await setup({ exec: dying });
    await article(t);
    const pf = await preflight(t);
    await t.call("POST", PUBLISH, { article_commit: pf.article_commit, ticked: [] });
    await expect.poll(() => job(t).step, { timeout: 20_000 }).toBe("pr");
    expect(fx.branches()).toEqual(["main", `post/${SLUG}`]);

    const next = make(t);
    await next.recover();
    expect(job(t)).toMatchObject({
      id: 1,
      step: "failed",
      error: "stopped at pr · the daemon restarted",
      pr_number: null,
    });
    expect(said.at(-1)?.text).toBe(
      "publish stopped at pr when the daemon restarted · the branch is on the site repo · publish again to open its PR",
    );
    const fresh = await next.preflight(SLUG);
    expect(fresh).toMatchObject({ kind: "update_open", branch: `post/${SLUG}`, pr: null });
    expect(fresh.checks.find((c) => c.id === "slug")?.text).toBe(
      `branch post/${SLUG} is on origin · no PR yet`,
    );
    await next.publish(SLUG, { article_commit: fresh.article_commit, ticked: [] });
    await next.idle();
    expect(job(t)).toMatchObject({
      id: 2,
      kind: "update_open",
      step: "done",
      pr_number: 1,
      branch: `post/${SLUG}`,
    });
    // the PR is made this time, on the commit the dead job pushed: still one commit, one path
    expect(fx.ghCalls().filter((l) => l.startsWith("pr create"))).toHaveLength(1);
    expect(fx.origin("rev-list", "--count", `main..post/${SLUG}`)).toBe("1");
    expect(fx.origin("diff", "--name-status", "main", `post/${SLUG}`)).toBe(`A\t${postPath(SLUG)}`);
    expect(t.db.all<Any>("SELECT log_json FROM publishes WHERE id = 2")[0]?.log_json).toContain(
      "the same as the branch has",
    );
  });

  it("shows a failed job with its step, and a retry goes through", async () => {
    const { t, fx, pub, said } = await setup();
    const { a } = await article(t);
    fx.failPr(true);
    const { res } = await publish(t, pub);
    expect(res.status).toBe(202);
    expect(job(t)).toMatchObject({
      step: "failed",
      error: "failed at pr · gh pr create --fill exited 1",
      pr_number: null,
    });
    const m = meta(t.host, a.session).publish;
    expect(m).toMatchObject({ step: "failed", error: "failed at pr · gh pr create --fill exited 1" });
    expect(m.lines.slice(-3)).toEqual([
      "$ gh pr create --fill",
      "  pull request create failed: the stub was told to fail",
      "✗ failed at pr · gh pr create --fill exited 1",
    ]);
    expect(said.at(-1)).toEqual({ text: "publish failed at pr · gh pr create --fill exited 1", bad: true });
    expect(meta(t.host, a.session).prNumber).toBeUndefined();
    // the worktree stays until the next attempt, and the sheet says so
    expect((await preflight(t)).origin).toMatchObject({
      clean: false,
      text: "origin/main · a failed build's worktree is left · the next build clears it",
    });

    fx.failPr(false);
    const retry = await publish(t, pub);
    expect(retry.res.status).toBe(202);
    expect(job(t)).toMatchObject({ n: 2, step: "done", pr_number: 1 });
    expect(fx.origin("rev-list", "--count", `main..post/${SLUG}`)).toBe("1");
    expect((await preflight(t)).origin.text).toBe("origin/main · clean");
  });

  it("fails at build when the site refuses the post, and nothing is pushed", async () => {
    const { t, fx, pub } = await setup();
    await article(t);
    // the site on main grows a fixture post that the build would publish: the build gate catches the folder
    fx.commitToMain(
      "build.mjs",
      `${fx.origin("show", "main:build.mjs")}\nmkdirSync("dist/writing/_fixture-x", { recursive: true });\n`,
    );
    const { res } = await publish(t, pub);
    expect(res.status).toBe(202);
    expect(job(t)).toMatchObject({ step: "failed" });
    expect(job(t).error).toBe("failed at build · the build has a fixture post · dist/writing/_fixture-x");
    expect(fx.branches()).toEqual(["main"]);
  });
});

describe("refusals", () => {
  const refused = async (t: Rig, pf: Preflight, ticked: string[] = []) => {
    const res = await t.call("POST", PUBLISH, { article_commit: pf.article_commit, ticked });
    expect(res.status).toBe(409);
    expect(res.body.preflight.article_commit).toBe(pf.article_commit);
    expect(t.db.all("SELECT 1 FROM publishes")).toHaveLength(0);
    return String(res.body.error);
  };

  it("refuses a site config that still has a placeholder", async () => {
    const { t, fx } = await setup({ placeholder: true });
    await article(t);
    const pf = await preflight(t);
    expect(pf.checks[0]).toEqual({
      id: "site",
      ok: false,
      text: "site.config still has a placeholder · fix it on main first",
    });
    expect(await refused(t, pf)).toBe("site.config still has a placeholder · fix it on main first");
    expect(fx.branches()).toEqual(["main"]);
  });

  it("refuses empty fields, a date that is no date, and unanswered questions", async () => {
    const { t } = await setup();
    await article(t, { meta: { title: " ", description: "", date: "2026-02-30", answers: ["a", "", ""] } });
    const pf = await preflight(t);
    expect(reasons(pf)).toEqual([
      "title is empty",
      "description is empty",
      "date is not a real date · 2026-02-30",
      "2 questions unanswered",
    ]);
    expect(await refused(t, pf)).toBe("title is empty");
    await t.call("PUT", `/api/articles/${SLUG}/meta`, { ...META, date: "" });
    expect(reasons(await preflight(t))).toEqual(["date is empty"]);
  });

  it("refuses a slug whose file on origin/main is another post's", async () => {
    const { t, fx } = await setup();
    await article(t);
    fx.commitToMain(
      postPath(SLUG),
      '---\ntitle: "Someone else"\ndate: 2026-01-06\ndescription: "x"\ndraft: false\n---\n\nTaken.\n',
    );
    const pf = await preflight(t);
    const text = `src/content/posts/${SLUG}.md is on origin/main and is not this article's · pick another slug`;
    expect(pf.checks.find((c) => c.id === "slug")).toEqual({ id: "slug", ok: false, text });
    expect(await refused(t, pf)).toBe(text);
  });

  it("refuses each thing the body may not hold", async () => {
    const { t } = await setup();
    await article(t);
    const cases: [string, string][] = [
      [
        "---\nlayout: x\n---\n\nText.\n",
        "the body opens with a --- block · the host writes the front matter",
      ],
      ["# My title\n\nText.\n", "a # heading in the body · the title is the page's h1 · # My title"],
      ["Text ![a](b.png) here.\n", "![ in body · images are not published yet"],
      ["Text <span>raw</span> here.\n", "raw HTML in body · <span>"],
      [
        "Text [x](javascript:void) here.\n",
        "link scheme not allowed · javascript: · http, https, mailto or relative",
      ],
      ["Text​ here.\n", "invisible character in body · U+200B in ¶1"],
      ["<!-- only a comment -->\n", "article.md is empty"],
    ];
    for (const [page, reason] of cases) {
      await save(t, page);
      const pf = await preflight(t);
      expect(reasons(pf)).toEqual([reason]);
      expect(await refused(t, pf)).toBe(reason);
    }
    // a heading below ### is a warning: shown, and no refusal
    await save(t, "## Fine\n\n#### Deep\n\nText.\n");
    const pf = await preflight(t);
    expect(pf.checks.at(-1)).toEqual({
      id: "deep",
      ok: false,
      warn: true,
      text: "heading below ### · #### Deep",
    });
    expect(reasons(pf)).toEqual([]);
  });

  it("refuses a sha that is not the reviewed one, and a site that moved", async () => {
    const { t, fx } = await setup();
    await article(t);
    const reviewed = await preflight(t);
    await save(t, `${PAGE}\nA line typed after the sheet was read.\n`);
    const res = await t.call("POST", PUBLISH, { article_commit: reviewed.article_commit, ticked: [] });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("the page changed since you reviewed it · look again, then publish");
    expect(res.body.preflight.article_commit).not.toBe(reviewed.article_commit);
    expect(res.body.preflight.post).toContain("A line typed after the sheet was read.");
    expect((await t.call("POST", PUBLISH, { article_commit: "0000000", ticked: [] })).status).toBe(409);

    const now = await preflight(t);
    fx.commitToMain("README.md", "the site moved\n");
    const moved = await t.call("POST", PUBLISH, {
      article_commit: now.article_commit,
      origin_sha: now.origin.sha,
      ticked: [],
    });
    expect(moved.status).toBe(409);
    expect(moved.body.error).toBe("the site's main moved since you reviewed it · look again, then publish");
    expect(moved.body.preflight.origin.sha).toBe(fx.origin("rev-parse", "main"));
    expect(t.db.all("SELECT 1 FROM publishes")).toHaveLength(0);
    expect(fx.branches()).toEqual(["main"]);
    expect((await t.call("POST", PUBLISH, { article_commit: now.article_commit })).status).toBe(400);
  });

  it("refuses an unticked agent-word span in a coached article, pasted or retyped", async () => {
    const { t, fx, pub } = await setup();
    const { a, c } = await article(t);
    await t.say(c, a.chat, "/stage interview");
    await t.say(c, a.chat, "I want to write about the lid.");
    const question = QUESTIONS[0] as string;
    // retyped from the chat into the page, and a second coach sentence pasted
    await save(t, `${PAGE}\n${question}\n`);
    await t.say(c, a.chat, "A reader should keep the lid line.");
    const second = QUESTIONS[1] as string;
    const paste = await t.call("POST", `/api/articles/${SLUG}/pastes`, { text: second });
    expect(paste.body.spans).toHaveLength(1);
    await save(t, `${PAGE}\n${question}\n\n${second}\n`);

    const pf = await preflight(t);
    expect(pf.spans).toEqual([
      {
        hash: expect.stringMatching(/^[0-9a-f]{64}$/),
        text: question.replace(/\?$/, ""),
        block: 4,
        source: "from interview q1",
      },
      {
        hash: expect.stringMatching(/^[0-9a-f]{64}$/),
        text: second.replace(/\?$/, ""),
        block: 5,
        source: "pasted from interview q2",
      },
    ]);
    expect(pf.counts).toMatchObject({ questions: 2, spans: 2, pastedWords: 13 });
    expect(reasons(pf)).toEqual(["2 spans unticked"]);
    const one = [pf.spans[0]?.hash as string];
    expect(reasons(pf, one)).toEqual(["1 span unticked"]);
    const res = await t.call("POST", PUBLISH, { article_commit: pf.article_commit, ticked: one });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("1 span unticked");
    expect(fx.branches()).toEqual(["main"]);

    // ticked, it goes out, and the ticks are kept on the row and named in the PR
    const ticked = pf.spans.map((s) => s.hash);
    const ok = await publish(t, pub, ticked);
    expect(ok.res.status).toBe(202);
    expect(JSON.parse(job(t).acks_json)).toEqual(ticked);
    const body = fx.prBody(1);
    expect(body).toContain('- agent-word spans kept and ticked "I chose these words": 2 of 2');
    expect(body).toContain(`  - "${question.replace(/\?$/, "")}" (¶4, from interview q1)`);
    expect(body).toContain("- questions asked 2 · comments 0");
    expect(body).toContain("pasted words 13");
  });

  it("refuses an unticked coach block in a drafted article, and takes the ticks", async () => {
    const { t, fx, pub } = await setup();
    const { a } = await article(t);
    const flip = await t.call("POST", `/api/articles/${SLUG}/authorship`, { to: "drafted", confirm: true });
    expect(flip.status).toBe(200);
    await t.host.idle();
    expect(meta(t.host, a.session).authorship).toBe("drafted");
    // the writer rewrites the first paragraph and leaves the rest
    const snap = (await t.call("GET", `/api/articles/${SLUG}`)).body as Any;
    const blocks = String(snap.files.article.text).trim().split("\n\n");
    expect(blocks.length).toBeGreaterThan(2);
    blocks[0] = "Every word of this opening paragraph is mine and nobody else wrote any of it.";
    await save(t, `${blocks.join("\n\n")}\n`);

    const pf = await preflight(t);
    const coach = pf.blocks.filter((b) => b.state === "coach");
    expect(pf.authorship).toBe("drafted");
    expect(pf.blocks[0]).toMatchObject({
      n: 1,
      state: "yours",
      first_words: "Every word of this opening paragraph…",
    });
    expect(coach).toHaveLength(blocks.length - 1);
    expect(pf.blockCounts).toEqual({ coach: blocks.length - 1, edited: 0, yours: 1 });
    expect(pf.yoursPct).toBeGreaterThan(0);
    expect(reasons(pf)).toEqual([`${coach.length} blocks unticked`]);

    const most = coach.slice(1).map((b) => b.hash);
    const res = await t.call("POST", PUBLISH, { article_commit: pf.article_commit, ticked: most });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("1 block unticked");
    // a tick for a block that is not on the page counts for nothing
    const wrong = await t.call("POST", PUBLISH, {
      article_commit: pf.article_commit,
      ticked: [...most, "f".repeat(64)],
    });
    expect(wrong.status).toBe(409);
    expect(fx.branches()).toEqual(["main"]);

    const all = coach.map((b) => b.hash);
    const ok = await publish(t, pub, all);
    expect(ok.res.status).toBe(202);
    expect(job(t)).toMatchObject({ step: "done", authorship: "drafted", yours_pct: pf.yoursPct });
    expect(JSON.parse(job(t).acks_json)).toEqual(all);
    const body = fx.prBody(1);
    expect(body).toContain("- mode: drafted");
    expect(body).toContain(`- blocks: ${blocks.length} ¶ · ${blocks.length - 1} coach · 0 edited · 1 yours`);
    expect(body).toContain(`- ${pf.yoursPct}% of the words are the writer's`);
    expect(body).toContain(`- coach blocks ticked "I chose these words": ${coach.length} of ${coach.length}`);
    expect(fx.origin("diff", "--name-only", "main", `post/${SLUG}`)).toBe(postPath(SLUG));
    expect(FIXTURE_URL).toMatch(/^https:/);
  });
});
