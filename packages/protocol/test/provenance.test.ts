// Step 6's provenance done-when: the fixtures give `coach`, `edited` and `yours` with a paragraph inserted in the
// middle. Plus the cases the one rule covers: added, deleted, reordered, split and merged blocks.
import { describe, expect, it } from "vitest";
import {
  blockHash,
  blockWords,
  countsLine,
  provenance,
  publishBlocks,
  untickedCoach,
} from "../src/provenance.ts";
import { sha256Hex } from "../src/sha256.ts";
import { BASELINE as BASE, CURRENT } from "./fixtures/provenance.ts";

const states = (cur: string, base = BASE) => provenance(base, cur).blocks.map((b) => b.state);

const A = "The quick brown fox jumps over the lazy dog near the river bank today.";
const B = "Seven silent engineers watched a pager glow red through the whole long night.";

describe("provenance", () => {
  it("gives coach, edited and yours on the fixtures, with a paragraph inserted in the middle", () => {
    const p = provenance(BASE, CURRENT);
    expect(p.blocks.map((b) => b.state)).toEqual([
      "coach", // the heading, untouched
      "coach", // the opening paragraph, untouched
      "yours", // the paragraph inserted in the middle
      "edited", // two words added to a coach paragraph
      "yours", // rewritten until most of its words are new
      "coach",
      "coach",
    ]);
    expect(p.counts).toEqual({ coach: 4, edited: 1, yours: 2 });
    expect(countsLine(p)).toBe("7 ¶ · 4 coach · 1 edited · 2 yours");
    // the inserted paragraph is all new; the edited one has two new words
    expect(p.blocks[2]).toMatchObject({ words: 20, fresh: 20 });
    expect(p.blocks[3]?.fresh).toBe(2);
    const total = p.blocks.reduce((n, b) => n + b.words, 0);
    const fresh = p.blocks.reduce((n, b) => n + b.fresh, 0);
    expect(p.yoursPct).toBe(Math.round((100 * fresh) / total));
    expect(p.yoursPct).toBeGreaterThan(20);
  });

  it("the untouched draft is all coach and 0% yours", () => {
    const p = provenance(BASE, BASE);
    expect(p.counts).toEqual({ coach: 6, edited: 0, yours: 0 });
    expect(p.yoursPct).toBe(0);
  });

  it("whitespace and line endings cannot change a coach block", () => {
    const messy = BASE.replace(/\n/g, "\r\n").replace("closed the laptop", "closed   the\tlaptop");
    expect(provenance(BASE, messy).counts).toEqual({ coach: 6, edited: 0, yours: 0 });
  });

  it("a reordered block matches by content, and a deleted one leaves the totals", () => {
    const base = `${A}\n\n${B}\n`;
    expect(states(`${B}\n\n${A}\n`, base)).toEqual(["coach", "coach"]);
    const p = provenance(base, `${B}\n`);
    expect(p.counts).toEqual({ coach: 1, edited: 0, yours: 0 });
    expect(p.blocks[0]?.words).toBe(blockWords(B).length);
  });

  it("a split block gives edited pieces with no new words", () => {
    const p = provenance(
      `${A}\n`,
      "The quick brown fox jumps over\n\nthe lazy dog near the river bank today.\n",
    );
    expect(p.blocks.map((b) => [b.state, b.fresh])).toEqual([
      ["edited", 0],
      ["edited", 0],
    ]);
    expect(p.yoursPct).toBe(0);
  });

  it("two coach blocks merged are one coach block with no new words", () => {
    const p = provenance(`${A}\n\n${B}\n`, `${A}\n${B}\n`);
    expect(p.blocks.map((b) => [b.state, b.fresh])).toEqual([["coach", 0]]);
  });

  it("a block is yours at half new words and edited just under it", () => {
    const base = "one two three four\n";
    expect(states("one two five six\n", base)).toEqual(["yours"]);
    expect(states("one two three five six\n", base)).toEqual(["edited"]);
    expect(states("alpha beta gamma delta\n", base)).toEqual(["yours"]);
  });

  it("strips a heading's ## and reads words as the mock does", () => {
    expect(blockWords("## Don't Stop, 2nd time")).toEqual(["don't", "stop", "2nd", "time"]);
    expect(blockHash("## The   LID")).toBe(blockHash("the lid"));
  });

  it("hashes like SHA-256", () => {
    const known: [string, string][] = [
      ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
      ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
      ["the lid is a chaos monkey", "a108240c52ae3492b49cdd7b3abcb1edf0ee2ad2062afd18355b0cf8a07277f0"],
      ["é’".repeat(40), "a2b10d3f762ae88ddc121ab85b8027925157d13333bff030709028454460ae4b"],
      ["x".repeat(119), "000b48d4edf0fa7bee3c6236ecd2785baa5db4eeb8bb54341b029e0d9fa5fb0c"],
    ];
    for (const [s, hex] of known) expect(sha256Hex(s)).toBe(hex);
  });

  it("lists the publish rows and the coach blocks with no tick", () => {
    const p = provenance(BASE, CURRENT);
    const rows = publishBlocks(p);
    expect(rows[0]).toEqual({
      n: 1,
      hash: blockHash("the lid is a chaos monkey"),
      state: "coach",
      first_words: "The lid is a chaos monkey",
    });
    expect(rows[1]?.first_words).toBe("I closed the laptop at six…");
    const coach = rows.filter((r) => r.state === "coach").map((r) => r.hash);
    expect(untickedCoach(p, [])).toEqual(coach);
    expect(untickedCoach(p, coach.slice(1))).toEqual([coach[0]]);
    expect(untickedCoach(p, coach)).toEqual([]);
  });
});
