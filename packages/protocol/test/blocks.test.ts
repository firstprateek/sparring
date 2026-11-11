import { describe, expect, it } from "vitest";
import { joinBlocks, splitBlocks, wordCount } from "../src/blocks.ts";
import { slugProblem } from "../src/slug.ts";

describe("blocks", () => {
  it("splits on blank lines and joins back", () => {
    const text = "## Heading\n\nOne line.\nSame block.\n\n\n  \nLast.\n";
    const blocks = splitBlocks(text);
    expect(blocks).toEqual(["## Heading", "One line.\nSame block.", "Last."]);
    expect(joinBlocks(blocks)).toBe("## Heading\n\nOne line.\nSame block.\n\nLast.\n");
  });
  it("gives one empty block for an empty file and drops empty blocks on join", () => {
    expect(splitBlocks("")).toEqual([""]);
    expect(splitBlocks("\n\n")).toEqual([""]);
    expect(joinBlocks(["", "a", "  ", "b"])).toBe("a\n\nb\n");
    expect(joinBlocks([""])).toBe("");
  });
  it("counts words", () => {
    expect(wordCount("not crashed. confident. don't")).toBe(4);
    expect(wordCount("")).toBe(0);
  });
});

describe("slug", () => {
  it("follows the rule", () => {
    expect(slugProblem("closed-laptop")).toBeNull();
    expect(slugProblem("a1")).toBeNull();
    for (const bad of ["", "Closed", "a--b", "-a", "a-", "a_b", "index", "x".repeat(65), "../etc"]) {
      expect(slugProblem(bad)).not.toBeNull();
    }
  });
});
