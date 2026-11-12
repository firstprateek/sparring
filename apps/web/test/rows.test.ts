import type { SparringMeta } from "@sparring/protocol/meta";
import { describe, expect, it } from "vitest";
import { ago, headLine, rowSub, rowTail, stageLabel, tok } from "../src/rows.ts";

const NOW = Date.parse("2026-11-10T12:00:00Z");

function meta(over: Partial<SparringMeta> = {}): SparringMeta {
  return {
    slug: "closed-laptop",
    stage: "draft",
    covered: [],
    authorship: "coached",
    drafting: false,
    coachQuiet: false,
    offline: false,
    wordCount: 612,
    savedAt: new Date(NOW - 2 * 3600_000).toISOString(),
    articleSha: null,
    commit: null,
    tells: { em: 0, oneSentence: 1, notXButY: 1 },
    pastedWords: 0,
    openComments: 6,
    unreadComments: 0,
    commentsRev: 0,
    run: null,
    queued: 0,
    letter: [],
    publish: null,
    tokens: 18_000,
    provider: "claude",
    ...over,
  };
}

const texts = (m: SparringMeta) => rowTail(m, NOW).map((p) => p.text);

describe("Articles row tail", () => {
  it("reads stage, words, open notes, save age and tokens", () => {
    expect(texts(meta())).toEqual(["draft", "612w", "·6", "2h", "18k tok"]);
    expect(rowTail(meta(), NOW).map((p) => p.cls)).toEqual([undefined, undefined, undefined, "save", "tok"]);
  });

  it("tags a drafted article before the stage", () => {
    const tail = rowTail(meta({ authorship: "drafted", yoursPct: 12 }), NOW);
    expect(tail.map((p) => p.text)).toEqual(["drafted", "draft", "612w", "·6", "2h", "18k tok"]);
    expect(tail[0]?.cls).toBe("tag");
    expect(texts(meta({ authorship: "drafted", prNumber: 5 }))).toEqual(["PR #5"]);
  });

  it("counts the interview from covered", () => {
    const m = meta({
      stage: "interview",
      covered: ["thesis", "reader", "evidence", "scar"],
      wordCount: 0,
      openComments: 1,
      savedAt: new Date(NOW - 3 * 86_400_000).toISOString(),
      tokens: 6_000,
    });
    expect(texts(m)).toEqual(["interview 4/6", "·1", "3d", "6k tok"]);
  });

  it("leaves out zero notes, zero tokens and a missing save", () => {
    expect(texts(meta({ openComments: 0, tokens: 0, savedAt: null }))).toEqual(["draft", "612w"]);
  });

  it("shows the PR alone once there is one", () => {
    expect(texts(meta({ prNumber: 4 }))).toEqual(["PR #4"]);
  });

  it("puts the open question under the title, else the last host line", () => {
    expect(rowSub(meta({ openQuestion: "Which number?", lastLine: "nothing in this pass · cut" }))).toBe(
      "Which number?",
    );
    expect(rowSub(meta({ lastLine: "nothing in this pass · cut" }))).toBe("nothing in this pass · cut");
    expect(rowSub(meta())).toBe("");
  });

  it("formats ages, tokens, stages and the head line", () => {
    expect([ago(12_000), ago(5 * 60_000), ago(26 * 3600_000)]).toEqual(["12s", "5m", "1d"]);
    expect([tok(640), tok(41_400)]).toEqual(["640 tok", "41k tok"]);
    expect(stageLabel("interview", ["thesis", "reader", "evidence", "counter", "uncertainty", "scar"])).toBe(
      "interview 6/6",
    );
    expect(stageLabel("polish", [])).toBe("polish");
    expect(headLine([meta({ tokens: 18_000 }), meta({ tokens: 23_000 })])).toBe("claude · 41k tok");
    expect(headLine([])).toBe("");
  });
});
