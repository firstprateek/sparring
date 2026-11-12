import { describe, expect, it } from "vitest";
import { overlap, overlapIndex, overlapWords } from "../src/overlap.ts";

const COACH = [
  { source: "interview q1", text: "What is the one sentence you want a reader to walk away with?" },
  { source: "note c02", text: "Nothing here says how you know this. What did you see first-hand?" },
];

describe("overlap", () => {
  it("finds a pasted coach sentence inside the writer's own words", () => {
    const text = "My own start. What is the one sentence you want a reader to walk away with? My own end.";
    const spans = overlap(text, COACH);
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({
      text: "What is the one sentence you want a reader to walk away with",
      words: 13,
      source: "interview q1",
    });
    expect(text.slice(spans[0]?.start, spans[0]?.end)).toBe(spans[0]?.text);
    expect(overlapWords(spans)).toBe(13);
  });

  it("needs five words in a row", () => {
    expect(overlap("the one sentence you", COACH)).toEqual([]);
    expect(overlap("the one sentence you want", COACH)).toHaveLength(1);
    expect(overlap("the one big sentence you want a writer to keep", COACH)).toEqual([]);
  });

  it("ignores case, punctuation and line breaks, but not a blank line", () => {
    expect(overlap("NOTHING here, says: how you\nknow this!", COACH)[0]?.words).toBe(7);
    expect(overlap("Nothing here says\n\nhow you know this", COACH)).toEqual([]);
    expect(
      overlap("what did you see first’hand", [{ source: "x", text: "What did you see first'hand" }]),
    ).toHaveLength(1);
  });

  it("a rewrite that leaves under five words in a row is the writer's again", () => {
    const pasted = "Nothing here says how you know this.";
    expect(overlap(pasted, COACH)).toHaveLength(1);
    expect(overlap("Nothing here tells me how you came to know this.", COACH)).toEqual([]);
    // a partial rewrite keeps the part that is still the coach's
    const part = overlap("I think nothing here says how you know this at all, friend.", COACH);
    expect(part.map((s) => s.text)).toEqual(["nothing here says how you know this"]);
  });

  it("two separate runs are two spans, each with its source", () => {
    const spans = overlap("the one sentence you want, and then, what did you see first-hand", COACH);
    expect(spans.map((s) => s.source)).toEqual(["interview q1", "note c02"]);
  });

  it("words the writer said first are not the coach's", () => {
    const own = ["the laptop lid is a chaos monkey for every agent"];
    const corpus = [
      { source: "ideas", text: 'You said "the laptop lid is a chaos monkey". Which thread is it?' },
    ];
    const index = overlapIndex(corpus, own);
    expect(overlap("the laptop lid is a chaos monkey", index)).toEqual([]);
    expect(overlap("the laptop lid is a chaos monkey", corpus)).toHaveLength(1);
  });

  it("an empty corpus matches nothing", () => {
    expect(overlap("any five words in here at all", [])).toEqual([]);
  });
});
