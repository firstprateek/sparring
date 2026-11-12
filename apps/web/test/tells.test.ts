// @vitest-environment happy-dom
// Tells and pasted words in the browser: the Tells table's rows and hits, the underline a pasted coach sentence
// carries in the page's mirror and loses when it is rewritten, the caret a hit or `pasted N` moves, and a paste
// of several paragraphs becoming blocks.
import { overlap, overlapIndex } from "@sparring/protocol/overlap";
import { TELLS_CAVEAT, tells } from "@sparring/protocol/tells";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Page } from "../src/page.ts";
import { hitSummary, TellsView, tellRows } from "../src/tells-view.ts";

const ARTICLE =
  "## The lid\n\nI closed the laptop at six. The agent kept talking — or so the transcript said.\n\nThat is the test I want for every agent runtime now.\n\nThe daemon was not broken, it was very confident. It retried, logged and slept for an hour.\n";
const DUMP = "I saw it fail. I was there for the whole long ugly night of it.\n";
const COACH = "What is the one sentence you want a reader to walk away with?";

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("the Tells table", () => {
  it("has seven rows, the last two beside the dump's", () => {
    const rows = tellRows(tells(ARTICLE, DUMP));
    expect(rows.map((r) => [r.label, r.n])).toEqual([
      ["em-dash", "1"],
      ["single-sentence ¶", "1"],
      ["not-X-but-Y", "1"],
      ["genuinely", "0"],
      ["rule-of-three", "1"],
      ["sentence-length σ", rows[5]?.n],
      ["first-person", "40%"],
    ]);
    expect(rows[2]?.beside).toBe('¶4 "not broken, it was very confident"');
    expect(rows[3]?.beside).toBe("");
    expect(rows[5]?.beside).toBe("dump 3.5");
    expect(rows[6]?.beside).toBe("dump 100%");
  });

  it("says the paragraphs when a row has several hits", () => {
    const t = tells("One — two.\n\nThree — four — five.\n");
    expect(hitSummary(t.hits.em)).toBe("¶1, ¶2");
  });

  it("opens a row to its hits, and a hit jumps to its span", () => {
    const root = document.createElement("div");
    document.body.append(root);
    const jump = vi.fn();
    const close = vi.fn();
    const view = new TellsView(root, { jump, close });
    const t = tells(ARTICLE, DUMP);
    view.set(t);
    expect(root.querySelector(".tells-caveat")?.textContent).toBe(TELLS_CAVEAT);
    // a row with no hits is plain text; a row with hits is a button
    const buttons = [...root.querySelectorAll<HTMLButtonElement>("button.tells-row")];
    expect(buttons.map((b) => b.textContent)).toEqual([
      "em-dash",
      "single-sentence ¶",
      "not-X-but-Y",
      "rule-of-three",
    ]);
    expect(root.querySelector(".tells-hit")).toBeNull();
    buttons[2]?.click();
    const hits = [...root.querySelectorAll<HTMLButtonElement>("button.tells-hit")];
    expect(hits.map((b) => b.textContent)).toEqual(['¶4 "not broken, it was very confident"']);
    hits[0]?.click();
    expect(jump).toHaveBeenCalledWith(t.hits.notXButY[0]);
    // the count that was clicked in the foot opens its row
    view.expand("em");
    expect(root.querySelector(".tells-hit")?.textContent).toBe('¶2 "—"');
    // fixing the page takes the row's hits with it
    view.set(tells(ARTICLE.replace(" — or so", ", or so"), DUMP));
    expect(root.querySelector(".tells-hit")).toBeNull();
    root.querySelector<HTMLButtonElement>(".tells-close")?.click();
    expect(close).toHaveBeenCalled();
  });
});

function page(onPaste?: (text: string) => void) {
  const root = document.createElement("div");
  document.body.append(root);
  const typed: string[] = [];
  const p = new Page(root, (t) => typed.push(t), { gutter: true, ...(onPaste ? { onPaste } : {}) });
  const blocks = () => [...root.querySelectorAll<HTMLTextAreaElement>("textarea.para")];
  const underlined = () => [...root.querySelectorAll(".mirror .pasted")].map((u) => u.textContent);
  const type = (ta: HTMLTextAreaElement, text: string) => {
    ta.value = text;
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  };
  return { root, p, typed, blocks, underlined, type };
}

describe("the paste underline", () => {
  const index = overlapIndex([{ source: "interview q1", text: COACH.replace(/\?$/, "") }]);
  const under = (b: string) => overlap(b, index);

  it("underlines a pasted coach sentence, and nothing of the writer's own", () => {
    const { p, blocks, underlined } = page();
    p.show(
      `My own opening paragraph, typed by hand.\n\nSo I asked myself: ${COACH} Then I wrote.\n`,
      "article",
    );
    p.setUnder(under);
    expect(underlined()).toEqual(["What is the one sentence you want a reader to walk away with"]);
    // the mirror holds the block's whole text, so the underline sits under the same words
    const ta = blocks()[1] as HTMLTextAreaElement;
    expect((ta.nextElementSibling as HTMLElement).textContent).toBe(ta.value);
    expect(blocks()[0]?.nextElementSibling?.textContent).toBe("");
    expect(ta.title).toBe("these are the coach's words");
  });

  it("goes when the sentence is rewritten, and stays on what is left of a partial rewrite", () => {
    const { p, blocks, underlined, type } = page();
    p.show(`${COACH}\n`, "article");
    p.setUnder(under);
    const ta = blocks()[0] as HTMLTextAreaElement;
    expect(underlined()).toHaveLength(1);
    type(ta, "What is the single line you want a reader to walk away with?");
    expect(underlined()).toEqual(["you want a reader to walk away with"]);
    type(ta, "Which line should stay with whoever reads this?");
    expect(underlined()).toEqual([]);
    expect(ta.hasAttribute("title")).toBe(false);
    // no rule, no underline
    type(ta, COACH);
    expect(underlined()).toHaveLength(1);
    p.setUnder(null);
    expect(underlined()).toEqual([]);
  });

  it("steps the caret through the underlined spans, round and round", () => {
    const { p, blocks } = page();
    p.show(`${COACH}\n\nMine.\n\nAgain: ${COACH}\n`, "article");
    expect(p.nextUnder()).toBe(false);
    p.setUnder(under);
    expect(p.nextUnder()).toBe(true);
    const [first, , third] = blocks() as [HTMLTextAreaElement, HTMLTextAreaElement, HTMLTextAreaElement];
    expect([first.selectionStart, first.selectionEnd]).toEqual([0, COACH.length - 1]);
    expect(first.parentElement?.classList.contains("ticked")).toBe(true);
    p.nextUnder();
    expect([third.selectionStart, third.selectionEnd]).toEqual([7, 7 + COACH.length - 1]);
    expect(first.parentElement?.classList.contains("ticked")).toBe(false);
    expect(third.parentElement?.classList.contains("ticked")).toBe(true);
    p.nextUnder();
    expect(first.parentElement?.classList.contains("ticked")).toBe(true);
    p.clearTick();
    expect(document.querySelector(".ticked")).toBeNull();
  });

  it("selects a tell's span in its block", () => {
    const { p, blocks } = page();
    p.show(ARTICLE, "article");
    const hit = tells(ARTICLE).hits.notXButY[0];
    expect(hit).toBeDefined();
    if (!hit) return;
    expect(
      p.select(
        "The daemon was not broken, it was very confident. It retried, logged and slept for an hour.",
        hit.start,
        hit.end,
      ),
    ).toBe(true);
    const ta = blocks()[3] as HTMLTextAreaElement;
    expect(ta.value.slice(ta.selectionStart, ta.selectionEnd)).toBe("not broken, it was very confident");
    expect(ta.parentElement?.classList.contains("ticked")).toBe(true);
    expect(p.select("a block that is gone", 0, 3)).toBe(false);
  });

  it("reports a paste, and turns pasted paragraphs into blocks", () => {
    vi.useFakeTimers();
    const pasted: string[] = [];
    const { p, blocks, typed } = page((t) => pasted.push(t));
    p.show("Mine.\n", "article");
    const ta = blocks()[0] as HTMLTextAreaElement;
    const text = `${COACH}\n\nA second pasted paragraph.`;
    // the browser puts the text in, then the page hears of it
    ta.value = `Mine. ${text}`;
    const e = new Event("paste", { bubbles: true }) as Event & { clipboardData: unknown };
    e.clipboardData = { getData: () => text };
    ta.dispatchEvent(e);
    vi.runAllTimers();
    expect(pasted).toEqual([text]);
    expect(blocks().map((b) => b.value)).toEqual([`Mine. ${COACH}`, "A second pasted paragraph."]);
    expect(typed.at(-1)).toBe(`Mine. ${COACH}\n\nA second pasted paragraph.\n`);
    expect(p.text()).toBe(typed.at(-1));
  });
});
