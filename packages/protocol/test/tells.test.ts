// Step 7's done-when: `tells()` on `test/fixtures/tells.md` returns the seven numbers in the fixture header.
// The header was counted by hand: eight sentences of 6, 9, 11, 9, 13, 4, 6 and 6 words (mean 8, σ √8), three of
// them in the first person.
import { describe, expect, it } from "vitest";
import { splitBlocks } from "../src/blocks.ts";
import { sentences, tells, tellsLine, tellsSummary } from "../src/tells.ts";
import FIXTURE from "./fixtures/tells.md?raw";

const HEADER = /^<!-- tells: (.*) -->$/m.exec(FIXTURE)?.[1] ?? "";

describe("tells", () => {
  it("returns the seven numbers in the fixture header", () => {
    const n = (name: string) => Number(new RegExp(`${name} ([\\d.]+)`).exec(HEADER)?.[1]);
    const header = {
      em: n("em-dash"),
      oneSentence: n("single-sentence ¶"),
      notXButY: n("not-X-but-Y"),
      genuinely: n("genuinely"),
      ruleOfThree: n("rule-of-three"),
      sentenceSigma: n("sentence-length σ"),
      firstPerson: n("first-person"),
    };
    expect(Object.values(header).every((v) => Number.isFinite(v))).toBe(true);
    const t = tells(FIXTURE);
    expect({
      em: t.em,
      oneSentence: t.oneSentence,
      notXButY: t.notXButY,
      genuinely: t.genuinely,
      ruleOfThree: t.ruleOfThree,
      sentenceSigma: t.sentenceSigma,
      firstPerson: t.firstPerson,
    }).toEqual(header);
    expect(header).toEqual({
      em: 3,
      oneSentence: 2,
      notXButY: 2,
      genuinely: 1,
      ruleOfThree: 2,
      sentenceSigma: 2.8,
      firstPerson: 38,
    });
    expect(tellsSummary(t)).toBe(HEADER);
    expect(tellsLine(t)).toBe("em 3 · ¶1 2 · not-x-but-y 2");
  });

  it("says where each tell is, as a span of its block", () => {
    const t = tells(FIXTURE);
    const blocks = splitBlocks(FIXTURE);
    for (const list of Object.values(t.hits))
      for (const h of list) expect(blocks[h.block]?.slice(h.start, h.end)).toBe(h.text);
    expect(t.hits.notXButY.map((h) => h.text)).toEqual([
      "not broken, it was very confident",
      "Not just late but also wrong",
    ]);
    expect(t.hits.ruleOfThree.map((h) => h.text)).toEqual([
      "It retried, logged and slept",
      "Fast, cheap or good",
    ]);
    expect(t.hits.oneSentence.map((h) => h.text)).toEqual([
      "That is the test I want for every agent runtime now.",
      "Fast, cheap or good: pick two.",
    ]);
    expect(t.hits.genuinely).toHaveLength(1);
  });

  it("gives the dump's σ and first-person beside the article's", () => {
    const dump = "I saw it fail. I was there for the whole long ugly night of it.\n";
    const t = tells("One short line. Then a much longer line that keeps going for a while.\n", dump);
    expect(t.dump.firstPerson).toBe(100);
    expect(t.firstPerson).toBe(0);
    // 4 and 11 words: mean 7.5, σ 3.5
    expect(t.dump.sentenceSigma).toBe(3.5);
    expect(tells("").dump).toEqual({ sentenceSigma: 0, firstPerson: 0 });
  });

  it("counts the constructions and nothing near them", () => {
    expect(tells("It's not a bug, it's a feature.").notXButY).toBe(1);
    expect(tells("This is not a tool but a partner.").notXButY).toBe(1);
    expect(tells("It isn't speed. It's trust.").notXButY).toBe(1);
    expect(tells("This is not a tool, but a partner in the work.").notXButY).toBe(1);
    expect(tells("I did not know the answer yet.").notXButY).toBe(0);
    expect(tells("Run tailscale serve --bg and wait.").em).toBe(0);
    expect(tells("A pause--then nothing.").em).toBe(1);
    expect(tells("Genuinely new. And genuinely old.").genuinely).toBe(2);
    expect(tells("We tried red, green, blue and grey.").ruleOfThree).toBe(0);
    expect(tells("One. Two.\n\nOnly one here.\n\n## A heading\n").oneSentence).toBe(1);
  });

  it("does not end a sentence at an abbreviation or an initial", () => {
    expect(sentences("We met Dr. Chen, e.g. on Tuesday. She left.")).toHaveLength(2);
    expect(sentences("J. Smith wrote it. Nobody read it!  Why?")).toHaveLength(3);
  });

  it("an empty page has no tells", () => {
    const t = tells("");
    expect([
      t.em,
      t.oneSentence,
      t.notXButY,
      t.genuinely,
      t.ruleOfThree,
      t.sentenceSigma,
      t.firstPerson,
    ]).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });
});
