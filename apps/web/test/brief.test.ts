// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { adoptBrief, briefNotesOf, quoteMarks, renderQuotes } from "../src/brief.ts";
import { Leaf } from "../src/leaf.ts";
import { Page } from "../src/page.ts";

const NOTES = [
  { topic: "thesis", quote: "not crashed. confident." },
  { topic: "evidence", quote: "the transcript is just a cache", question: "Name the incident." },
];

describe("the ? mark rule", () => {
  it("marks a block when a brief quote is a substring of it, and only then", () => {
    const blocks = [
      "ok so the thing that keeps biting me. not crashed. confident. the socket is dead.",
      "agents keep a transcript and the transcript is just a cache.",
      "this is the same bug as the framework.",
      "not crashed, confident.",
    ];
    expect(quoteMarks(blocks, NOTES)).toEqual([true, true, false, false]);
  });

  it("is exact: case and a quote split across blocks do not match", () => {
    expect(quoteMarks(["Not crashed. Confident."], NOTES)).toEqual([false]);
    expect(quoteMarks(["not crashed.", "confident."], NOTES)).toEqual([false, false]);
  });

  it("marks nothing for empty quotes or no notes", () => {
    expect(quoteMarks(["anything"], [{ topic: "scar", quote: "  " }])).toEqual([false]);
    expect(quoteMarks(["anything"], [])).toEqual([false]);
  });

  it("puts the mono ? in the gutter of the quoted blocks and follows edits", () => {
    const root = document.createElement("div");
    const page = new Page(root, () => {}, { gutter: true });
    page.show("not crashed. confident. yes\n\nnothing here\n", "dump");
    page.setMarks((b) => (quoteMarks([b], NOTES)[0] === true ? { kind: "q" } : null));
    const gutters = () => [...root.querySelectorAll(".prow .gut")].map((g) => g.textContent);
    expect(gutters()).toEqual(["?", ""]);
    const second = root.querySelectorAll("textarea")[1] as HTMLTextAreaElement;
    second.value = "the transcript is just a cache";
    second.dispatchEvent(new Event("input", { bubbles: true }));
    expect(gutters()).toEqual(["?", "?"]);
    page.setMarks(null);
    expect(gutters()).toEqual(["", ""]);
    expect(page.text()).toBe("not crashed. confident. yes\n\nthe transcript is just a cache\n");
  });
});

describe("the brief leaf's margin", () => {
  it("lists `quoted from dump.md` then each quote, as text", () => {
    const el = document.createElement("div");
    renderQuotes(el, [...NOTES, { topic: "scar", quote: "<img src=x onerror=alert(1)>" }]);
    expect(el.firstElementChild?.textContent).toBe("quoted from dump.md");
    expect([...el.querySelectorAll(".quotes span")].map((s) => s.textContent)).toEqual([
      '"not crashed. confident."',
      '"the transcript is just a cache"',
      '"<img src=x onerror=alert(1)>"',
    ]);
    expect(el.querySelector("img")).toBeNull();
  });

  it("keeps only well-formed notes", () => {
    expect(briefNotesOf([NOTES[0], { topic: 1 }, null, "x"])).toEqual([NOTES[0]]);
    expect(briefNotesOf(undefined)).toEqual([]);
  });
});

describe("the brief refetch rule", () => {
  afterEach(() => localStorage.clear());

  it("takes the new brief.md text and sha when the leaf is clean", () => {
    let changed = 0;
    const leaf = new Leaf("a", "brief", "old\n", "sha-old", () => changed++);
    expect(adoptBrief(leaf, { text: "thesis: x\n", sha: "sha-new" })).toBe(true);
    expect(leaf.text).toBe("thesis: x\n");
    expect(leaf.baseSha).toBe("sha-new");
    expect(changed).toBe(1);
  });

  it("keeps a dirty leaf as it is", () => {
    const leaf = new Leaf("a", "brief", "old\n", "sha-old", () => {});
    leaf.edit("my own brief, not saved yet\n");
    expect(adoptBrief(leaf, { text: "thesis: x\n", sha: "sha-new" })).toBe(false);
    expect(leaf.text).toBe("my own brief, not saved yet\n");
    expect(leaf.baseSha).toBe("sha-old");
    expect(leaf.dirty).toBe(true);
  });

  it("keeps a leaf with an open conflict", () => {
    const leaf = new Leaf("a", "brief", "old\n", "sha-old", () => {});
    leaf.state = { kind: "conflict", diskSha: "d", diskText: "disk\n" };
    expect(adoptBrief(leaf, { text: "thesis: x\n", sha: "sha-new" })).toBe(false);
    expect(leaf.text).toBe("old\n");
  });
});
