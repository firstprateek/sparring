// @vitest-environment happy-dom
// Drafted mode in the browser: the provenance bars in the gutter, the block reveal, the read-only wait, the quiet
// block, the stage menu's `send it` and `coached again`, `/sendit` in the composer, and the letter's strip.
import { baselineOf, provenance } from "@sparring/protocol/provenance";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Composer } from "../src/composer.ts";
import { provOf, QUIET_HEAD, QUIET_HINT, REVEAL_MS, renderQuietBlock, tagText } from "../src/drafted.ts";
import { letterRows, stripRow, tickerText } from "../src/letter.ts";
import { Page } from "../src/page.ts";
import { toolLine } from "../src/session.ts";
import { StageMenu } from "../src/stage-menu.ts";

const DRAFT =
  "## The lid\n\nI closed the laptop at six and the build died with it, quietly.\n\nThe daemon reconciles on wake and it costs about one second each time.\n";

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

function page() {
  const root = document.createElement("div");
  document.body.append(root);
  const typed: string[] = [];
  const p = new Page(root, (t) => typed.push(t), { gutter: true });
  const blocks = () => [...root.querySelectorAll<HTMLTextAreaElement>("textarea.para")];
  const bars = () =>
    blocks().map((ta) => {
      const gut = ta.previousElementSibling as HTMLElement;
      return [...gut.children].map((k) => k.className).join(" + ");
    });
  const type = (i: number, text: string) => {
    const ta = blocks()[i] as HTMLTextAreaElement;
    ta.value = text;
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  };
  return { root, p, typed, blocks, bars, type };
}

describe("provenance bars", () => {
  it("marks every block of a fresh draft as the coach's, and follows the typing", () => {
    const { p, bars, blocks, type } = page();
    p.setProv(provOf(baselineOf(DRAFT)));
    p.show(DRAFT, "article");
    expect(bars()).toEqual(["prov", "prov", "prov"]);
    expect(blocks()[1]?.getAttribute("aria-description")).toBe("written by the coach");
    // a small edit: the bar turns muted
    type(1, "I closed the laptop at six and the build died with it, quietly, again.");
    expect(bars()).toEqual(["prov", "prov mixed", "prov"]);
    expect(blocks()[1]?.getAttribute("aria-description")).toBe("written by the coach, edited by you");
    // rewritten until half the words are new: no bar
    type(2, "Every morning my own script compares the job list with the process table first.");
    expect(bars()).toEqual(["prov", "prov mixed", ""]);
    expect(blocks()[2]?.hasAttribute("aria-description")).toBe(false);
    // typed back to the coach's words: the coach's bar again
    type(1, "I closed the laptop at six and the build died with it, quietly.");
    expect(bars()[1]).toBe("prov");
  });

  it("gives a block the writer adds no bar, and puts a note's bar after the dotted one", () => {
    const { p, bars } = page();
    p.setProv(provOf(baselineOf(DRAFT)));
    p.setMarks((b) => (b.includes("daemon") ? { kind: "note", id: "c01", label: "c01 unclear" } : null));
    p.show(`${DRAFT}\nA paragraph that is only mine, about a standup.\n`, "article");
    expect(bars()).toEqual(["prov", "prov", "prov + mark", ""]);
    p.setProv(null);
    expect(bars()).toEqual(["", "", "mark", ""]);
  });
});

describe("the reveal and the wait", () => {
  it("lands a draft one block every 220 ms, read-only until the last one, and saves nothing typed meanwhile", () => {
    vi.useFakeTimers();
    const { p, blocks, typed, type } = page();
    let done = 0;
    p.showReveal(DRAFT, "article", REVEAL_MS, () => done++);
    expect(blocks()).toHaveLength(1);
    expect(p.revealing).toBe(true);
    expect(blocks()[0]?.readOnly).toBe(true);
    type(0, "typed over half a draft");
    expect(typed).toEqual([]);
    vi.advanceTimersByTime(REVEAL_MS);
    expect(blocks()).toHaveLength(2);
    expect(done).toBe(0);
    vi.advanceTimersByTime(REVEAL_MS);
    expect(blocks()).toHaveLength(3);
    expect(done).toBe(1);
    expect(p.revealing).toBe(false);
    expect(blocks().every((b) => !b.readOnly)).toBe(true);
    expect(blocks()[2]?.value).toBe("The daemon reconciles on wake and it costs about one second each time.");
  });

  it("lands all at once under reduced motion, and a new show ends a reveal", () => {
    vi.useFakeTimers();
    const { p, blocks } = page();
    let done = 0;
    p.showReveal(DRAFT, "article", 0, () => done++);
    expect(blocks()).toHaveLength(3);
    expect(done).toBe(1);
    p.showReveal(DRAFT, "article", REVEAL_MS);
    p.show("Only this.\n", "article");
    vi.advanceTimersByTime(REVEAL_MS * 5);
    expect(blocks().map((b) => b.value)).toEqual(["Only this."]);
    expect(p.revealing).toBe(false);
  });

  it("is read-only while the coach drafts, and Enter makes no block", () => {
    const { p, blocks, root } = page();
    p.show("One.\n\nTwo.\n", "article");
    p.setReadOnly(true);
    expect(blocks().every((b) => b.readOnly)).toBe(true);
    const ta = blocks()[0] as HTMLTextAreaElement;
    ta.value = "One.\n";
    ta.setSelectionRange(5, 5);
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(root.querySelectorAll("textarea")).toHaveLength(2);
    p.setReadOnly(false);
    expect(blocks().every((b) => !b.readOnly)).toBe(true);
  });
});

describe("the quiet block and the tag", () => {
  it("shows the copy, the counts, the percent and the legend, in that order", () => {
    const el = document.createElement("section");
    const mine = "Every morning my own script compares the job list with the process table first.";
    const p = provenance(DRAFT, DRAFT.replace(/The daemon.*\n/, `${mine}\n`));
    renderQuietBlock(el, p);
    expect([...el.children].map((c) => c.textContent)).toEqual([
      "drafted · the coach wrote article.md · never-write is off for this article",
      QUIET_HEAD,
      QUIET_HINT,
      "3 ¶ · 2 coach · 0 edited · 1 yours",
      `${p.yoursPct}% of the words are yours`,
      "coacheditedno bar: yours",
      "close",
    ]);
    expect(el.querySelectorAll(".legend .prov")).toHaveLength(2);
    expect(el.querySelector(".legend .prov.mixed")).not.toBeNull();
    expect(tagText(p.yoursPct)).toBe(`drafted · ${p.yoursPct}% yours`);
    // unchanged numbers do not rebuild it
    const first = el.firstElementChild;
    renderQuietBlock(el, p);
    expect(el.firstElementChild).toBe(first);
  });
});

function menu(flip = vi.fn(async (_to: string) => null as string | null)) {
  document.body.innerHTML = `<button id="b"><span id="w"></span></button><div id="m" hidden></div>`;
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const pick = vi.fn((_s: string) => null as string | null);
  const m = new StageMenu($<HTMLButtonElement>("b"), $("w"), $("m"), pick, flip);
  const q = <T extends HTMLElement>(sel: string) => $("m").querySelector<T>(sel);
  const settle = async () => {
    for (let i = 0; i < 4; i++) await Promise.resolve();
  };
  return { m, $, q, pick, flip, settle };
}

describe("the stage menu", () => {
  it("offers send it under the stages, with its confirm line; yes makes the call and closes the menu", async () => {
    const { m, $, q, flip, settle } = menu();
    m.set("outline", [], false, false, "coached");
    $<HTMLButtonElement>("b").click();
    expect(q("[data-flip]")?.textContent).toBe("send it");
    expect(q(".pend")).toBeNull();
    q<HTMLButtonElement>("[data-flip]")?.click();
    expect(q(".pend")?.textContent).toBe(
      "the coach writes the draft from dump.md and brief.md·what is on the page moves to the shelf·yes·no",
    );
    expect(document.activeElement).toBe(q('[data-act="yes"]'));
    // the stage confirm and the send-it confirm never show together
    q<HTMLButtonElement>('[data-stage="critique"]')?.click();
    expect($("m").querySelectorAll(".pend")).toHaveLength(1);
    expect(q(".pend")?.textContent).toContain("advance to critique");
    q<HTMLButtonElement>("[data-flip]")?.click();
    expect($("m").querySelectorAll(".pend")).toHaveLength(1);
    // no backs out
    q<HTMLButtonElement>('[data-act="no"]')?.click();
    expect(q(".pend")).toBeNull();
    expect(flip).not.toHaveBeenCalled();
    q<HTMLButtonElement>("[data-flip]")?.click();
    q<HTMLButtonElement>('[data-act="yes"]')?.click();
    await settle();
    expect(flip).toHaveBeenCalledWith("drafted");
    expect($("m").hidden).toBe(true);
  });

  it("says in red why a send it did not start, and stays open", async () => {
    const { m, $, q, settle } = menu(vi.fn(async () => "nothing to draft from · dump.md is empty"));
    m.set("ideas", [], false, false, "coached");
    m.openSendit();
    expect($("m").hidden).toBe(false);
    expect(document.activeElement).toBe(q('[data-act="yes"]'));
    q<HTMLButtonElement>('[data-act="yes"]')?.click();
    await settle();
    expect(q(".pend .err")?.textContent).toBe("not started · nothing to draft from · dump.md is empty");
    expect(q(".pend .err")?.getAttribute("role")).toBe("alert");
    expect($("m").hidden).toBe(false);
  });

  it("reads coached again in a drafted article, with its own confirm; /sendit opens on it with no confirm", async () => {
    const { m, $, q, flip, settle } = menu();
    m.set("draft", [], false, false, "drafted");
    m.openSendit();
    expect(q("[data-flip]")?.textContent).toBe("coached again");
    expect(q(".pend")).toBeNull();
    expect(document.activeElement).toBe(q("[data-flip]"));
    q<HTMLButtonElement>("[data-flip]")?.click();
    expect(q(".pend")?.textContent).toBe(
      "discard the coach's draft·your page comes back from the shelf·yes·no",
    );
    q<HTMLButtonElement>('[data-act="yes"]')?.click();
    await settle();
    expect(flip).toHaveBeenCalledWith("coached");
    expect($("m").hidden).toBe(true);
  });

  it("reads drafting… while the draft turn runs, and offers no second send it", () => {
    const { m, $, q } = menu();
    m.set("interview", ["thesis"], true, false, "coached");
    expect($("w").textContent).toBe("drafting…");
    $<HTMLButtonElement>("b").click();
    expect(q<HTMLButtonElement>("[data-flip]")?.disabled).toBe(true);
    expect(q("[data-flip]")?.textContent).toBe("drafting…");
    m.set("draft", ["thesis"], false, false, "drafted");
    expect($("w").textContent).toBe("draft");
    expect(q("[data-flip]")?.textContent).toBe("coached again");
  });
});

describe("/sendit in the composer", () => {
  it("opens the confirm line and sends no turn", () => {
    document.body.innerHTML = `<textarea id="c"></textarea><div id="s" hidden></div><div id="n" hidden></div><div id="q" hidden></div>`;
    const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
    const line = vi.fn();
    const sendit = vi.fn();
    const c = new Composer($<HTMLTextAreaElement>("c"), $("s"), $("n"), $("q"), {
      line,
      log: () => {},
      sendit,
      escape: () => {},
    });
    $<HTMLTextAreaElement>("c").value = "/sendit";
    c.submit();
    expect(sendit).toHaveBeenCalledTimes(1);
    expect(line).not.toHaveBeenCalled();
    expect($("n").hidden).toBe(true);
    expect($<HTMLTextAreaElement>("c").value).toBe("");
    // /publish is the one command still to come
    $<HTMLTextAreaElement>("c").value = "/publish";
    c.submit();
    expect($("n").textContent).toContain("/publish is not built yet");
  });
});

describe("the letter in drafted mode", () => {
  it("has the status strip, draws a refused write and a failed draft in red, and counts the draft turn", () => {
    expect(stripRow().textContent).toBe(
      "drafted·the coach wrote article.md·never-write is off for this article",
    );
    const at = new Date().toISOString();
    const rows = letterRows(
      [
        {
          id: "l1",
          kind: "refused",
          text: "write refused · the coach tried to edit article.md · logged",
          at,
        },
        {
          id: "l2",
          kind: "draftFailed",
          text: "draft failed · nothing was written · your page is unchanged",
          at,
        },
        { id: "l3", kind: "passDone", text: "filler · 2 notes", at },
      ],
      async () => {},
      async () => {},
    );
    const byId = (id: string) => rows.find((r) => r.dataset.id === id) as HTMLElement;
    expect(byId("l1").classList.contains("err")).toBe(true);
    expect(byId("l2").classList.contains("err")).toBe(true);
    expect(byId("l3").classList.contains("err")).toBe(false);
    // a failed draft can be put away, and so can a refused write
    expect(byId("l2").querySelector("button")?.textContent).toBe("dismiss");
    expect(byId("l1").querySelector("button")?.textContent).toBe("dismiss");
    const now = Date.parse("2026-11-11T10:00:12Z");
    expect(tickerText({ pass: "sendit", startedAt: "2026-11-11T10:00:00Z" }, 0, now)).toBe(
      "the coach is writing the draft… 12s",
    );
  });

  it("words the draft's tool call as the design does", () => {
    expect(
      toolLine({
        toolName: "other",
        displayName: "write_draft",
        pastTenseMessage: "write_draft",
        content: [{ type: "text", text: "article.md · 12 ¶ from dump.md and brief.md" }],
      }),
    ).toBe("write_draft article.md · 12 ¶ from dump.md and brief.md");
  });
});
