// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { InterviewScreen, interviewDone, renderStrip, stripTopics } from "../src/interview.ts";
import { renderTurns } from "../src/log.ts";
import type { Line } from "../src/session.ts";

const ALL = ["thesis", "reader", "evidence", "counter", "uncertainty", "scar"];

describe("the covered strip", () => {
  it("marks the topics in covered and leaves the rest muted, in the fixed order", () => {
    expect(stripTopics(["reader", "thesis"])).toEqual([
      { topic: "thesis", on: true },
      { topic: "reader", on: true },
      { topic: "evidence", on: false },
      { topic: "counter", on: false },
      { topic: "uncertainty", on: false },
      { topic: "scar", on: false },
    ]);
    expect(stripTopics(undefined).every((t) => !t.on)).toBe(true);
  });

  it("ignores names that are not topics", () => {
    expect(
      stripTopics(["thesis", "nonsense"])
        .filter((t) => t.on)
        .map((t) => t.topic),
    ).toEqual(["thesis"]);
  });

  it("draws `interview · ` and the six topics in text colour when covered", () => {
    const el = document.createElement("span");
    renderStrip(el, ["thesis", "evidence"]);
    expect(el.textContent).toBe("interview·thesisreaderevidencecounteruncertaintyscar");
    const cls = Object.fromEntries(
      [...el.querySelectorAll<HTMLElement>("[data-topic]")].map((s) => [s.dataset.topic, s.className]),
    );
    expect(cls).toEqual({
      thesis: "text",
      reader: "muted",
      evidence: "text",
      counter: "muted",
      uncertainty: "muted",
      scar: "muted",
    });
  });

  it("is done only when all six are covered", () => {
    expect(interviewDone(ALL.slice(0, 5))).toBe(false);
    expect(interviewDone(ALL)).toBe(true);
  });
});

describe("the interview turns", () => {
  const lines: Line[] = [
    { kind: "coach", text: "Say the claim in one sentence, your words.", at: undefined, streaming: false },
    { kind: "you", text: "closing the lid <b>breaks</b> nothing", at: undefined },
    { kind: "tool", text: "note_brief · thesis", at: undefined },
    { kind: "host", text: "stage interview", at: undefined },
  ];

  it("draws who and what, skips tool lines, host lines as dividers, text never as HTML", () => {
    const el = document.createElement("div");
    renderTurns(el, lines);
    const turns = [...el.querySelectorAll(".turn")];
    expect(turns).toHaveLength(2);
    expect(turns[0]?.querySelector(".who")?.textContent).toBe("coach");
    expect(turns[0]?.lastElementChild?.className).toContain("muted");
    expect(turns[1]?.lastElementChild?.className).toContain("text");
    expect(el.querySelector("b")).toBeNull();
    expect(el.querySelectorAll(".divider")).toHaveLength(1);
  });

  it("ends with `interview done · brief.md is yours` once done, once", () => {
    const el = document.createElement("div");
    renderTurns(el, lines, true);
    expect(el.lastElementChild?.textContent).toBe("interview done · brief.md is yours");
    renderTurns(
      el,
      [...lines, { kind: "host", text: "interview done · brief.md is yours", at: undefined }],
      true,
    );
    expect(
      [...el.querySelectorAll(".divider")].filter((d) => d.textContent?.startsWith("interview done")),
    ).toHaveLength(1);
  });
});

function screen() {
  document.body.innerHTML = `
    <div id="iv" hidden>
      <span id="title"></span><button id="btn"><span id="word"></span> ▾</button>
      <div id="menu" hidden><ul id="stages"></ul><button id="sendit">send it</button><div id="line" hidden></div><p id="err" hidden></p></div>
      <div id="sheet"><span id="topics"></span><button id="fold">▾</button><div id="body"><div id="thread"></div></div></div>
    </div>`;
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const pick = vi.fn((_s: string) => null as string | null);
  const sendIt = vi.fn(async () => null as string | null);
  const iv = new InterviewScreen(
    {
      root: $("iv"),
      title: $("title"),
      stageBtn: $<HTMLButtonElement>("btn"),
      stageWord: $("word"),
      menu: $("menu"),
      stages: $("stages"),
      sendit: $<HTMLButtonElement>("sendit"),
      senditLine: $("line"),
      menuError: $("err"),
      topics: $("topics"),
      sheet: $("sheet"),
      sheetBtn: $<HTMLButtonElement>("fold"),
      sheetBody: $("body"),
      thread: $("thread"),
    },
    pick,
    sendIt,
  );
  return { iv, pick, $, sendIt };
}

describe("the interview screen", () => {
  it("reads `<slug> · dump` and `interview N/6`, N being covered.length, and moves with covered", () => {
    const { iv, $ } = screen();
    iv.set({ slug: "closed-laptop", stage: "interview", covered: ["thesis"], offline: false, lines: [] });
    iv.show(true);
    expect($("title").textContent).toBe("closed-laptop · dump");
    expect($("word").textContent).toBe("interview 1/6");
    iv.set({
      slug: "closed-laptop",
      stage: "interview",
      covered: ["thesis", "reader"],
      offline: false,
      lines: [],
    });
    expect($("word").textContent).toBe("interview 2/6");
    expect($("topics").querySelector('[data-topic="reader"]')?.className).toBe("text");
  });

  it("dispatches a stage pick at once, with no advance line", () => {
    const { iv, pick, $ } = screen();
    iv.set({ slug: "a", stage: "interview", covered: [], offline: false, lines: [] });
    iv.show(true);
    $<HTMLButtonElement>("btn").click();
    expect($("menu").hidden).toBe(false);
    const items = [...$("stages").querySelectorAll<HTMLButtonElement>("button")];
    expect(items.map((b) => b.textContent)).toEqual([
      "ideas",
      "interview 0/6",
      "outline",
      "draft",
      "critique",
      "polish",
    ]);
    items[2]?.click();
    expect(pick).toHaveBeenCalledWith("outline");
    expect($("menu").hidden).toBe(true);
    expect(document.body.textContent).not.toContain("advance to");
  });

  it("shows the confirm line under `send it`; no backs out, yes makes the call and closes the menu", async () => {
    const { iv, $, sendIt } = screen();
    iv.set({ slug: "a", stage: "interview", covered: [], offline: false, lines: [] });
    iv.show(true);
    $<HTMLButtonElement>("btn").click();
    $<HTMLButtonElement>("sendit").click();
    expect($("line").hidden).toBe(false);
    expect($("line").textContent).toBe(
      "the coach writes the draft from dump.md and brief.md·what is on the page moves to the shelf·yes·no",
    );
    $("line").querySelector<HTMLButtonElement>('[data-act="no"]')?.click();
    expect($("line").hidden).toBe(true);
    expect(sendIt).not.toHaveBeenCalled();
    $<HTMLButtonElement>("sendit").click();
    $("line").querySelector<HTMLButtonElement>('[data-act="yes"]')?.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(sendIt).toHaveBeenCalledTimes(1);
    expect($("menu").hidden).toBe(true);
  });

  it("says in the menu why a send it did not start, and stays open", async () => {
    const { iv, $, sendIt } = screen();
    sendIt.mockResolvedValueOnce("nothing to draft from · dump.md is empty");
    iv.set({ slug: "a", stage: "interview", covered: [], offline: false, lines: [] });
    iv.show(true);
    $<HTMLButtonElement>("btn").click();
    $<HTMLButtonElement>("sendit").click();
    $("line").querySelector<HTMLButtonElement>('[data-act="yes"]')?.click();
    await Promise.resolve();
    await Promise.resolve();
    expect($("err").hidden).toBe(false);
    expect($("err").textContent).toBe("not started · nothing to draft from · dump.md is empty");
    expect($("menu").hidden).toBe(false);
  });

  it("reads `offline` while the article is offline", () => {
    const { iv, $ } = screen();
    iv.set({ slug: "a", stage: "interview", covered: ["thesis"], offline: true, lines: [] });
    iv.show(true);
    expect($("word").textContent).toBe("offline");
    expect($("btn").classList.contains("muted")).toBe(true);
  });
});
