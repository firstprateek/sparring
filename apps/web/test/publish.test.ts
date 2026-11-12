// @vitest-environment happy-dom
// The publish sheet in the browser: what is missing when publishing is not set up, in red, with the gates still
// shown; the button blocked with its reason until every gate is cleared; the ticks in coached and drafted mode;
// the job's log with a failure in red; the read-only post with its provenance bars; and `publish →` in the menu.
import { blockHash } from "@sparring/protocol/provenance";
import type { PostMeta, Preflight, PublishJob } from "@sparring/protocol/publish";
import { afterEach, describe, expect, it, vi } from "vitest";
import { logLineKind, PublishSheet, renderPost, type SheetHooks, shipState } from "../src/publish-view.ts";
import { StageMenu } from "../src/stage-menu.ts";

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

const META: PostMeta = {
  title: "The lid",
  description: "One sentence.",
  date: "2026-11-07",
  answers: ["a", "b", "c"],
};
const BODY = "## The lid\n\nI closed the laptop at six.\n\nThat is the test I want.";

function pf(over: Partial<Preflight> = {}): Preflight {
  return {
    slug: "closed-laptop",
    article_commit: "a".repeat(40),
    configured: true,
    setup: [],
    origin: { sha: "b".repeat(40), clean: true, text: "origin/main · clean" },
    kind: "first",
    branch: "post/closed-laptop",
    meta: META,
    counts: {
      questions: 11,
      comments: 19,
      done: 12,
      dismissed: 3,
      disagreed: 1,
      violations: 0,
      pastedWords: 0,
      spans: 0,
      words: 598,
    },
    authorship: "coached",
    yoursPct: 100,
    blockCounts: { coach: 0, edited: 0, yours: 0 },
    spans: [],
    blocks: [],
    checks: [
      { id: "site", ok: true, text: "site.config has no placeholders" },
      { id: "headings", ok: true, text: "headings start at ##" },
      { id: "images", ok: true, text: "no ![ in body" },
      { id: "slug", ok: true, text: "slug is new on origin/main" },
    ],
    post: `---\ntitle: "The lid"\ndate: 2026-11-07\ndescription: "One sentence."\ndraft: false\n---\n\n${BODY}\n`,
    path: "src/content/posts/closed-laptop.md",
    disclosure: "",
    pr: null,
    published_commit: null,
    publish: null,
    ...over,
  };
}

function sheet(p: Preflight, hooks: Partial<SheetHooks> = {}, ticked: string[] = []) {
  const root = document.createElement("aside");
  document.body.append(root);
  const h: SheetHooks = {
    saveMeta: vi.fn(async (_m: PostMeta) => p as Preflight | string),
    ship: vi.fn(async (_t: string[]) => null),
    today: () => "2026-11-11",
    ...hooks,
  };
  const s = new PublishSheet(root, h, ticked, 5);
  s.set(p);
  const q = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel);
  const all = <T extends HTMLElement>(sel: string) => [...root.querySelectorAll<T>(sel)];
  const btn = () => q<HTMLButtonElement>(".ship-btn") as HTMLButtonElement;
  const reason = () => (q(".reason")?.hidden ? "" : (q(".reason")?.textContent ?? ""));
  return { s, h, root, q, all, btn, reason };
}

const SPAN = {
  hash: "1".repeat(64),
  text: "treat the transcript as stale",
  block: 9,
  source: "from interview q6",
};
const PASTED = {
  hash: "2".repeat(64),
  text: "what is the one sentence you want",
  block: 3,
  source: "pasted from interview q1",
};

describe("the button", () => {
  it("says why it is disabled, most pressing first, and what it does when it is not", () => {
    expect(shipState(pf(), null, [])).toEqual({ label: "build and open PR", disabled: false, reason: "" });
    expect(shipState(pf({ spans: [SPAN] }), null, [])).toEqual({
      label: "build and open PR",
      disabled: true,
      reason: "disabled: 1 span unticked",
    });
    expect(shipState(pf({ spans: [SPAN, PASTED] }), null, [SPAN.hash]).reason).toBe(
      "disabled: 1 span unticked",
    );
    expect(shipState(pf({ spans: [SPAN, PASTED] }), null, []).reason).toBe("disabled: 2 spans unticked");
    const drafted = pf({
      authorship: "drafted",
      blocks: [
        { n: 1, hash: "c1", state: "coach", first_words: "a" },
        { n: 2, hash: "c2", state: "coach", first_words: "b" },
        { n: 3, hash: "e1", state: "edited", first_words: "c" },
      ],
    });
    expect(shipState(drafted, null, []).reason).toBe("disabled: 2 blocks unticked");
    expect(shipState(drafted, null, ["c1"]).reason).toBe("disabled: 1 block unticked");
    expect(shipState(drafted, null, ["c1", "c2"]).disabled).toBe(false);
    const failing = pf({
      checks: [
        { id: "title", ok: false, text: "title is empty" },
        { id: "deep", ok: false, warn: true, text: "heading below ###" },
      ],
      spans: [SPAN],
    });
    expect(shipState(failing, null, []).reason).toBe("disabled: title is empty · and 1 more");
    expect(shipState(pf({ configured: false, setup: ["site_repo is not set"] }), null, []).reason).toBe(
      "disabled: publishing is not set up",
    );
    expect(shipState(pf(), null, [], "saving")).toMatchObject({
      disabled: true,
      reason: "saving the fields…",
    });
  });

  it("reads building… while a job runs and PR #5 is open once it is", () => {
    const running: PublishJob = { id: 1, step: "build", lines: [] };
    expect(shipState(pf(), running, [])).toEqual({ label: "building…", disabled: true, reason: "" });
    const open = pf({
      pr: { number: 5, url: "https://x/pull/5", state: "open" },
      published_commit: "a".repeat(40),
    });
    expect(shipState(open, { id: 1, step: "done", lines: [] }, [])).toEqual({
      label: "PR #5 is open",
      disabled: true,
      reason: "",
    });
    // the page moved on since: the open PR can be updated
    const edited = pf({
      pr: { number: 5, url: "https://x/pull/5", state: "open" },
      published_commit: "c".repeat(40),
      kind: "update_open",
    });
    expect(shipState(edited, { id: 1, step: "done", lines: [] }, [])).toMatchObject({
      label: "build and update PR #5",
      disabled: false,
    });
    // a failed job can be tried again
    expect(shipState(pf(), { id: 1, step: "failed", lines: [], error: "failed at pr" }, []).disabled).toBe(
      false,
    );
  });
});

describe("the sheet", () => {
  it("shows the fields, the three questions, the numbers and the four checks", () => {
    const { q, all, btn, reason, s } = sheet(pf());
    expect(q(".top")?.textContent).toBe("publishorigin/main · clean");
    expect(q<HTMLInputElement>("#f-title")?.value).toBe("The lid");
    expect(q<HTMLTextAreaElement>("#f-desc")?.value).toBe("One sentence.");
    expect(q<HTMLInputElement>("#f-date")?.value).toBe("2026-11-07");
    expect(all(".kv .ro-v").map((e) => e.textContent)).toEqual(["closed-laptop", "false"]);
    expect(all(".q-text").map((e) => e.textContent)).toEqual([
      "what did you learn writing this?",
      "would you say this to a friend?",
      "who is this for and what do they lose?",
    ]);
    expect(all<HTMLInputElement>(".ans").map((e) => e.value)).toEqual(["a", "b", "c"]);
    const prov = all(".grp")[2]?.textContent ?? "";
    expect(prov).toContain("questions asked 11 · comments 19 · done 12 · dismissed 3");
    expect(prov).toContain("disagreed 1 · violations 0 · pasted words 0");
    expect(prov).toContain("agent-word spans in the text 0");
    expect(prov).toContain("disclosure line: none. Type one into the body if you want one");
    expect(all(".grp")[3]?.textContent).toBe(
      "checks✓ site.config has no placeholders✓ headings start at ##✓ no ![ in body✓ slug is new on origin/main",
    );
    expect(q(".setup")?.hidden).toBe(true);
    expect(btn().textContent).toBe("build and open PR");
    expect(btn().disabled).toBe(false);
    expect(reason()).toBe("");
    expect(q(".log")?.hidden).toBe(true);
    expect(s.chrome()).toEqual({
      tag: "",
      stage: "publish",
      left: "598 words · read-only while publishing",
      right: "the host runs this sheet, not the coach",
    });
  });

  it("says in red that publishing is not set up, names the keys, and still shows the gates", () => {
    const { q, all, btn, reason } = sheet(
      pf({
        configured: false,
        setup: [
          "site_repo is not set · the site's owner/name on GitHub, in ~/.sparring/config.json",
          "publish.git_name and publish.git_email are not set · the author of the post's commit, in ~/.sparring/config.json",
          "no clone of the site at ~/.sparring/site · git clone git@github.com:<owner>/<name>.git ~/.sparring/site",
        ],
        origin: { sha: "", clean: false, bad: true, text: "origin/main · not set up" },
        checks: [
          { id: "site", ok: false, warn: true, text: "site.config not checked yet" },
          { id: "headings", ok: true, text: "headings start at ##" },
          { id: "images", ok: true, text: "no ![ in body" },
          { id: "slug", ok: false, warn: true, text: "slug not checked on origin/main yet" },
        ],
        spans: [SPAN],
      }),
    );
    const setup = q(".setup") as HTMLElement;
    expect(setup.hidden).toBe(false);
    expect(setup.classList.contains("err")).toBe(true);
    expect(setup.getAttribute("role")).toBe("alert");
    expect(setup.textContent).toContain("publishing is not set up on this machine");
    expect(setup.textContent).toContain("site_repo is not set");
    expect(setup.textContent).toContain("publish.git_name and publish.git_email are not set");
    expect(setup.textContent).toContain("no clone of the site at ~/.sparring/site");
    expect(setup.textContent).toContain("README.md, section Publishing");
    expect(q(".top .err")?.textContent).toBe("origin/main · not set up");
    // the gates are all still there: fields, questions, the span to tick, the checks
    expect(q("#f-title")).not.toBeNull();
    expect(all(".tick")).toHaveLength(1);
    expect(all(".grp")[3]?.querySelectorAll(".warn")).toHaveLength(2);
    expect(btn().disabled).toBe(true);
    expect(reason()).toBe("disabled: publishing is not set up · and 1 more");
  });

  it("is blocked by an unticked span and unblocks when it is ticked; a failing check shows in red", () => {
    const ticks: string[][] = [];
    const { all, btn, reason, s } = sheet(pf({ spans: [SPAN, PASTED] }), {
      ticksChanged: (t) => ticks.push(t),
    });
    const rows = all<HTMLLabelElement>(".tick");
    expect(rows.map((r) => r.textContent)).toEqual([
      '"treat the transcript as stale" (¶9, from interview q6)I chose these words',
      '"what is the one sentence you want" (¶3, pasted from interview q1)I chose these words',
    ]);
    expect(btn().disabled).toBe(true);
    expect(reason()).toBe("disabled: 2 spans unticked");
    const boxes = all<HTMLInputElement>(".tick input");
    (boxes[0] as HTMLInputElement).checked = true;
    boxes[0]?.dispatchEvent(new Event("change", { bubbles: true }));
    expect(reason()).toBe("disabled: 1 span unticked");
    (boxes[1] as HTMLInputElement).checked = true;
    boxes[1]?.dispatchEvent(new Event("change", { bubbles: true }));
    expect(btn().disabled).toBe(false);
    expect(reason()).toBe("");
    expect(ticks.at(-1)).toEqual([SPAN.hash, PASTED.hash]);
    // unticking blocks it again
    (boxes[0] as HTMLInputElement).checked = false;
    boxes[0]?.dispatchEvent(new Event("change", { bubbles: true }));
    expect(reason()).toBe("disabled: 1 span unticked");
    // a new preflight with a failing check: red, and the first reason
    s.set(
      pf({
        spans: [SPAN, PASTED],
        checks: [{ id: "images", ok: false, text: "![ in body · images are not published yet" }],
      }),
    );
    expect(all(".grp")[3]?.querySelector(".err")?.textContent).toBe(
      "✗ ![ in body · images are not published yet",
    );
    expect(reason()).toBe("disabled: ![ in body · images are not published yet · and 1 more");
    // the tick made before the new preflight is kept
    expect(all<HTMLInputElement>(".tick input").map((b) => b.checked)).toEqual([false, true]);
  });

  it("lists the coach blocks of a drafted article with a tick each and tick all", () => {
    const drafted = pf({
      authorship: "drafted",
      yoursPct: 31,
      blockCounts: { coach: 2, edited: 1, yours: 1 },
      spans: [SPAN],
      blocks: [
        { n: 1, hash: "c1", state: "coach", first_words: "The lid" },
        { n: 2, hash: "y1", state: "yours", first_words: "Every word of this opening paragraph…" },
        { n: 3, hash: "e1", state: "edited", first_words: "I closed the laptop at six…" },
        { n: 4, hash: "c2", state: "coach", first_words: "That is the test I want…" },
      ],
    });
    const { all, btn, reason, q, s } = sheet(drafted);
    const prov = all(".grp")[2]?.textContent ?? "";
    expect(prov).toContain("drafted by the coach · never-write was off for this article");
    expect(prov).toContain("4 ¶ · 2 coach · 1 edited · 1 yours");
    expect(prov).toContain("31% of the words are yours");
    expect(prov).toContain("blocks still entirely the coach's words 2");
    // the chat-overlap list and the coached counts are not shown
    expect(prov).not.toContain("agent-word spans");
    expect(prov).not.toContain("questions asked");
    expect(all(".tick").map((r) => r.textContent)).toEqual([
      '¶1 "The lid"I chose these words',
      '¶4 "That is the test I want…"I chose these words',
    ]);
    expect(reason()).toBe("disabled: 2 blocks unticked");
    q<HTMLButtonElement>("[data-tick-all]")?.click();
    expect(all<HTMLInputElement>(".tick input").every((b) => b.checked)).toBe(true);
    expect(btn().disabled).toBe(false);
    expect(s.chrome().tag).toBe("drafted · 31% yours");
    // with no coach block left there is nothing to tick
    s.set({
      ...drafted,
      blocks: drafted.blocks.filter((b) => b.state !== "coach"),
      blockCounts: { coach: 0, edited: 1, yours: 1 },
    });
    expect(all(".tick")).toHaveLength(0);
    expect(all(".grp")[2]?.textContent).toContain("every block has your words in it");
    expect(q("[data-tick-all]")).toBeNull();
  });

  it("stores a field a moment after typing, then follows the new preflight", async () => {
    vi.useFakeTimers();
    const empty = pf({
      meta: { ...META, title: "" },
      checks: [{ id: "title", ok: false, text: "title is empty" }],
    });
    const saveMeta = vi.fn(async (m: PostMeta) => pf({ meta: m }) as Preflight | string);
    const { q, btn, reason } = sheet(empty, { saveMeta });
    expect(reason()).toBe("disabled: title is empty");
    const title = q<HTMLInputElement>("#f-title") as HTMLInputElement;
    title.value = "A title";
    title.dispatchEvent(new Event("input"));
    expect(saveMeta).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(20);
    expect(saveMeta).toHaveBeenCalledWith({ ...META, title: "A title" });
    expect(btn().disabled).toBe(false);
    expect(reason()).toBe("");
    // a save that fails says so in red and keeps the button shut
    saveMeta.mockResolvedValueOnce("could not reach the daemon");
    title.value = "Another";
    title.dispatchEvent(new Event("input"));
    await vi.advanceTimersByTimeAsync(20);
    expect(q(".field-err")?.textContent).toBe("not saved · could not reach the daemon");
    expect(btn().disabled).toBe(true);
  });

  it("fills an empty date from the browser's local date and stores it", async () => {
    vi.useFakeTimers();
    const saveMeta = vi.fn(async (m: PostMeta) => pf({ meta: m }) as Preflight | string);
    const { q } = sheet(pf({ meta: { ...META, date: "" } }), { saveMeta });
    expect(q<HTMLInputElement>("#f-date")?.value).toBe("2026-11-11");
    await vi.advanceTimersByTimeAsync(20);
    expect(saveMeta).toHaveBeenCalledWith({ ...META, date: "2026-11-11" });
  });

  it("sends the ticks, shows a refusal in red with the fresh preflight, then the job step by step", async () => {
    const fresh = pf({ article_commit: "d".repeat(40), spans: [SPAN] });
    const ship = vi
      .fn<SheetHooks["ship"]>()
      .mockResolvedValueOnce({
        error: "the page changed since you reviewed it · look again, then publish",
        preflight: fresh,
      })
      .mockResolvedValue(null);
    const { q, all, btn, s } = sheet(pf({ spans: [SPAN] }), { ship }, [SPAN.hash]);
    expect(btn().disabled).toBe(false);
    btn().click();
    await vi.waitFor(() => expect(q(".ship-err")?.textContent).toContain("not started · the page changed"));
    expect(ship).toHaveBeenCalledWith([SPAN.hash]);
    expect(btn().textContent).toBe("build and open PR");

    btn().click();
    await vi.waitFor(() => expect(btn().textContent).toBe("building…"));
    expect(btn().disabled).toBe(true);
    expect(q(".ship-err")?.textContent).toBe("");
    expect(s.setJob({ id: 1, step: "build", lines: ["✓ checks passed", "$ npm ci"] })).toBe(false);
    expect(all(".log > *").map((e) => e.textContent)).toEqual([
      "publish 1 · build…",
      "✓ checks passed",
      "$ npm ci",
    ]);
    expect(btn().textContent).toBe("building…");
    // the job ends: the page is told to fetch the preflight that has the PR
    const url = "https://github.com/o/n/pull/5";
    expect(s.setJob({ id: 1, step: "done", lines: ["$ gh pr create --fill", url] })).toBe(true);
    const link = q<HTMLAnchorElement>(".log a") as HTMLAnchorElement;
    expect(link.href).toBe(url);
    expect(link.target).toBe("_blank");
    expect(link.rel).toBe("noopener noreferrer");
    // until that preflight is in, the button stays shut: there is no window to start a second job in
    expect(btn().textContent).toBe("built");
    expect(btn().disabled).toBe(true);
    s.set(
      pf({
        pr: { number: 5, url, state: "open" },
        published_commit: "a".repeat(40),
        publish: { id: 1, step: "done", lines: [url] },
      }),
    );
    expect(btn().textContent).toBe("PR #5 is open");
    expect(btn().disabled).toBe(true);
    expect(s.chrome()).toMatchObject({ stage: "published", right: "PR #5 · merging is your click" });
  });

  it("shows a failed job in red with its step, and the button is live again", () => {
    const { all, btn, s, q } = sheet(pf());
    s.setJob({ id: 2, step: "pr", lines: ["$ gh pr create --fill"] });
    expect(btn().textContent).toBe("building…");
    const ended = s.setJob({
      id: 2,
      step: "failed",
      error: "failed at pr · gh pr create --fill exited 1",
      lines: [
        "$ gh pr create --fill",
        "  the stub was told to fail",
        "✗ failed at pr · gh pr create --fill exited 1",
      ],
    });
    expect(ended).toBe(true);
    const lines = all(".log > *");
    expect(lines[0]?.textContent).toBe("publish 2 · failed");
    expect(lines[0]?.classList.contains("err")).toBe(true);
    expect(lines[3]?.textContent).toBe("✗ failed at pr · gh pr create --fill exited 1");
    expect(lines[3]?.classList.contains("err")).toBe(true);
    expect(lines[2]?.classList.contains("out")).toBe(true);
    expect(q(".log")?.querySelectorAll(".err")).toHaveLength(2);
    expect(btn().textContent).toBe("build failed");
    expect(btn().disabled).toBe(true);
    // the preflight after it: the failure is said beside the button in red, and the button is live again
    s.set(
      pf({
        publish: { id: 2, step: "failed", error: "failed at pr · gh pr create --fill exited 1", lines: [] },
      }),
    );
    expect(q(".ship-err")?.textContent).toBe("publish 2 failed at pr · gh pr create --fill exited 1");
    expect(q(".ship-err")?.classList.contains("err")).toBe(true);
    expect(btn().textContent).toBe("build and open PR");
    expect(btn().disabled).toBe(false);
    // an older job's news never replaces a newer job's
    expect(s.setJob({ id: 1, step: "done", lines: [] })).toBe(false);
    expect(q(".log > span")?.textContent).toBe("publish 2 · failed");
    expect(logLineKind("$ npm ci")).toBe("cmd");
  });

  it("opens the diff of an edit to a merged post", () => {
    const { q, all } = sheet(
      pf({
        kind: "edit_merged",
        branch: "post/closed-laptop-2",
        diff: "@@ -1 +1 @@\n-old\n+new",
        checks: [{ id: "slug", ok: true, text: "exists · branch post/closed-laptop-2 · diff" }],
      }),
    );
    expect(all(".grp")[3]?.textContent).toBe("checks✓ exists · branch post/closed-laptop-2 · diff");
    expect(q(".diff")).toBeNull();
    q<HTMLButtonElement>("[data-diff]")?.click();
    expect(q("pre.diff")?.textContent).toBe("@@ -1 +1 @@\n-old\n+new");
    expect(q("[data-diff]")?.getAttribute("aria-expanded")).toBe("true");
  });

  it("says in red that the sheet did not load", () => {
    const root = document.createElement("aside");
    document.body.append(root);
    const s = new PublishSheet(root, { saveMeta: async () => "x", ship: async () => null, today: () => "" });
    s.fail("the sheet did not load · could not reach the daemon · reload to try again");
    expect(root.querySelector(".err")?.textContent).toContain("the sheet did not load");
    expect(root.querySelector(".err")?.getAttribute("role")).toBe("alert");
  });
});

describe("the read-only post", () => {
  it("shows the front matter and the body, with a bar on each block the coach wrote", () => {
    const front = document.createElement("pre");
    const body = document.createElement("div");
    const blocks = BODY.split("\n\n");
    renderPost(
      front,
      body,
      pf({
        authorship: "drafted",
        blocks: [
          { n: 1, hash: blockHash(blocks[0] as string), state: "coach", first_words: "" },
          { n: 2, hash: blockHash(blocks[1] as string), state: "edited", first_words: "" },
          { n: 3, hash: blockHash(blocks[2] as string), state: "yours", first_words: "" },
        ],
      }),
    );
    expect(front.textContent).toBe(
      '---\ntitle: "The lid"\ndate: 2026-11-07\ndescription: "One sentence."\ndraft: false\n---',
    );
    const kids = [...body.children];
    expect(kids.map((k) => k.tagName)).toEqual(["H2", "P", "P"]);
    expect(kids.map((k) => k.querySelector(".prov")?.className ?? "")).toEqual(["prov", "prov mixed", ""]);
    expect(kids[0]?.getAttribute("aria-description")).toBe("written by the coach");
    expect(kids[1]?.textContent).toBe("I closed the laptop at six.");
    // a coached article has no bars
    renderPost(front, body, pf());
    expect(body.querySelector(".prov")).toBeNull();
  });
});

describe("publish → in the stage menu", () => {
  function menu(publish: () => Promise<string | null>) {
    document.body.innerHTML = `<button id="b"><span id="w"></span></button><div id="m" hidden></div>`;
    const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
    const m = new StageMenu(
      $<HTMLButtonElement>("b"),
      $("w"),
      $("m"),
      () => null,
      async () => null,
      publish,
    );
    m.set("polish", [], false, false, "coached");
    $<HTMLButtonElement>("b").click();
    return { m, item: () => $("m").querySelector<HTMLButtonElement>("[data-publish]"), menu: $("m") };
  }

  it("is the last item, and opens the sheet", async () => {
    const publish = vi.fn(async () => null as string | null);
    const { item, menu: el } = menu(publish);
    expect(item()?.textContent).toBe("publish →");
    expect(el.lastElementChild).toBe(item());
    item()?.click();
    await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
    expect(el.querySelector(".err")).toBeNull();
  });

  it("says in red why the sheet did not open", async () => {
    const { item, menu: el } = menu(async () => "article.md is not saved yet");
    item()?.click();
    await vi.waitFor(() =>
      expect(el.querySelector(".err")?.textContent).toBe("not opened · article.md is not saved yet"),
    );
  });
});
