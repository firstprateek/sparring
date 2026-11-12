// @vitest-environment happy-dom
import type { Note } from "@sparring/protocol/notes";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bodyNodes, type NotesHooks, NotesView } from "../src/notes.ts";
import { Page } from "../src/page.ts";

const P1 = "Closing the laptop at six gave me my evenings back. I thought it would cost me at work.";
const P2 = "It did not, mostly. Nobody noticed for a month.";
const PAGE = `${P1}\n\n${P2}\n`;

const note = (p: Partial<Note>): Note => ({
  id: "c01",
  file: "article",
  kind: "unsupported",
  pass: "critique",
  brief_line: "evidence",
  span: "Closing the laptop at six gave me my evenings back.",
  block_orig: P1,
  body: 'Nothing says how you know. The dump says "it just worked".',
  body_v2: null,
  status: "open",
  muted: false,
  reply: null,
  seen_at: null,
  created_at: "",
  resolved_at: null,
  ...p,
});
const C2 = note({
  id: "c02",
  kind: "unclear",
  brief_line: null,
  span: "It did not, mostly.",
  block_orig: P2,
  body: "Unclear.",
});

function setup(over: Partial<NotesHooks> = {}) {
  document.body.innerHTML = `<section id="root" hidden><button id="toggle"></button><div id="filter"></div>
    <button id="close"></button><div id="body"><div id="err" hidden></div><div id="list"></div></div></section>`;
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const sent: string[] = [];
  const hooks: NotesHooks = {
    act: async (line) => {
      sent.push(line);
      return null;
    },
    jump: () => {},
    saveBlock: () => null,
    seen: () => {},
    ...over,
  };
  const view = new NotesView(
    {
      root: $("root"),
      toggle: $<HTMLButtonElement>("toggle"),
      close: $<HTMLButtonElement>("close"),
      filter: $("filter"),
      body: $("body"),
      err: $("err"),
      list: $("list"),
    },
    hooks,
  );
  const card = (id: string) => document.querySelector<HTMLElement>(`.note[data-id="${id}"]`) as HTMLElement;
  const act = (id: string, name: string) =>
    card(id).querySelector<HTMLButtonElement>(`[data-act="${name}"]`) as HTMLButtonElement;
  return { view, sent, $, card, act };
}

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe("the notes list", () => {
  it("is hidden with no notes, and lists them in page order under the filter row", () => {
    const t = setup();
    t.view.set([], PAGE);
    expect(t.$("root").hidden).toBe(true);
    t.view.set([C2, note({})], PAGE);
    expect(t.$("root").hidden).toBe(false);
    expect([...document.querySelectorAll(".note")].map((n) => (n as HTMLElement).dataset.id)).toEqual([
      "c01",
      "c02",
    ]);
    expect(t.card("c01").querySelector(".nhead")?.textContent).toBe("unsupported · c01 · brief: evidence");
    expect(t.card("c02").querySelector(".nhead")?.textContent).toBe("unclear · c02 · no brief line");
    expect(t.card("c01").querySelector(".span")?.textContent).toBe(
      '"Closing the laptop at six gave me my evenings back."',
    );
    expect([...t.$("filter").children].map((b) => b.textContent)).toEqual(["all 2", "open 2", "critique 2"]);
    expect(t.$("toggle").textContent).toBe("notes · 2 open ▾");
  });

  it("draws the writer's quoted words apart from the coach's", () => {
    const nodes = bodyNodes('The dump says "it just dropped". Which is it?');
    expect(nodes.map((n) => (typeof n === "string" ? n : `<${n.textContent}>`))).toEqual([
      "The dump says ",
      '<"it just dropped">',
      ". Which is it?",
    ]);
  });

  it("keeps Done disabled under `·edit the span first` until the note's block changes", () => {
    const t = setup();
    t.view.set([note({}), C2], PAGE);
    expect(t.act("c01", "done").disabled).toBe(true);
    expect(t.card("c01").querySelector(".nhint")?.textContent).toBe("·edit the span first");
    // the writer edits the first paragraph only
    t.view.set([note({}), C2], PAGE.replace("my evenings back", "three hours a night back"));
    expect(t.act("c01", "done").disabled).toBe(false);
    expect(t.card("c01").querySelector(".nhint")).toBeNull();
    expect(t.act("c02", "done").disabled).toBe(true);
    // its span is gone from the page: the note is on the shelf, and Done still works
    expect(document.querySelector(".shelf")?.textContent).toBe("shelf");
    expect(t.card("c01").classList.contains("stale")).toBe(true);
  });

  it("sends exactly the grammar lines, and waits for the snapshot to change", async () => {
    const t = setup();
    const edited = PAGE.replace("at six", "at 6pm");
    t.view.set([note({}), C2], edited);
    t.act("c01", "done").click();
    await Promise.resolve();
    expect(t.sent).toEqual(["done c01"]);
    expect(t.card("c01").querySelector(".wait")?.textContent).toBe("done c01 · sent, waiting");
    t.view.set([note({ status: "done" }), C2], edited);
    expect(t.card("c01").querySelector(".wait")).toBeNull();
    expect(t.card("c01").querySelector(".nhead")?.textContent).toContain("· done");
    t.act("c02", "dismiss").click();
    await Promise.resolve();
    t.view.set([note({ status: "done" }), { ...C2, status: "dismissed" }], edited);
    t.act("c02", "mute").click();
    await Promise.resolve();
    expect(t.sent).toEqual(["done c01", "dismiss c02", "dismiss c02 on purpose"]);
    t.view.set([note({ status: "done" }), { ...C2, status: "dismissed", muted: true }], edited);
    expect(t.card("c02").textContent).toContain('muted · STYLE.md ← do not flag: "It did not, mostly."');
  });

  it("disagree opens a `re c01:` line that sends the reply, then shows the sharpened v2", async () => {
    const t = setup();
    t.view.set([note({})], PAGE);
    t.act("c01", "disagree").click();
    const input = t.card("c01").querySelector<HTMLInputElement>(".reply-in") as HTMLInputElement;
    expect(t.card("c01").querySelector("label")?.textContent).toBe("re c01:");
    input.value = "I counted them.";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    t.act("c01", "send").click();
    await Promise.resolve();
    expect(t.sent).toEqual(["re c01: I counted them."]);
    t.view.set(
      [note({ status: "disagreed", reply: "I counted them.", body_v2: "Sharpened. Say so." })],
      PAGE,
    );
    expect(t.card("c01").querySelector(".nhead")?.textContent).toContain("disagreed · sharpened");
    expect(t.card("c01").querySelector(".v2")?.textContent).toBe("Sharpened. Say so.c01 v2");
    // one exchange: no second disagree
    expect(t.act("c01", "disagree")).toBeNull();
  });

  it("says in red when an action could not be sent, or is not answered", async () => {
    vi.useFakeTimers();
    const t = setup({ act: async () => "the socket is closed" });
    t.view.set([note({})], PAGE);
    t.act("c01", "dismiss").click();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.$("err").hidden).toBe(false);
    expect(t.$("err").textContent).toBe("not sent · the socket is closed");
    const u = setup();
    u.view.set([note({})], PAGE);
    u.act("c01", "dismiss").click();
    await vi.advanceTimersByTimeAsync(13_000);
    expect(u.$("err").textContent).toMatch(/^c01 has not changed · "dismiss c01" may be queued or refused/);
    expect(u.act("c01", "dismiss").disabled).toBe(false);
  });

  it("filters by status and pass, and reports the notes on screen as seen once drawn", () => {
    const seen: string[][] = [];
    const t = setup({ seen: (ids) => seen.push(ids) });
    t.view.set([note({}), { ...C2, status: "dismissed", pass: "filler" }], PAGE);
    expect(seen.at(-1)).toEqual(["c01", "c02"]);
    (t.$("filter").querySelector('[data-filter="open"]') as HTMLElement).click();
    expect(document.querySelectorAll(".note")).toHaveLength(1);
    (t.$("filter").querySelector('[data-filter="pass:filler"]') as HTMLElement).click();
    expect((document.querySelector(".note") as HTMLElement).dataset.id).toBe("c02");
  });

  it("the focused edit hands the paragraph back through saveBlock", () => {
    const saved: string[] = [];
    const t = setup({
      saveBlock: (_n, text) => {
        saved.push(text);
        return null;
      },
    });
    t.view.set([note({})], PAGE);
    t.act("c01", "edit").click();
    const ta = t.card("c01").querySelector<HTMLTextAreaElement>(".edit-in") as HTMLTextAreaElement;
    expect(ta.value).toBe(P1);
    ta.value = "A new first paragraph.";
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    t.act("c01", "save").click();
    expect(saved).toEqual(["A new first paragraph."]);
    expect(t.card("c01").querySelector(".edit-in")).toBeNull();
  });
});

describe("the gutter bar", () => {
  it("marks a block with a live note, opens the note on click, and goes when the span does", () => {
    const root = document.createElement("div");
    document.body.append(root);
    const opened: string[] = [];
    const page = new Page(root, () => {}, { gutter: true, onMark: (id) => opened.push(id) });
    page.show(PAGE, "article");
    page.setMarks((b) =>
      b.includes("It did not, mostly.") ? { kind: "note", id: "c02", label: "c02 unclear" } : null,
    );
    const bars = [...root.querySelectorAll<HTMLButtonElement>("button.mark")];
    expect(bars).toHaveLength(1);
    expect(bars[0]?.closest(".prow")?.querySelector("textarea")?.value).toBe(P2);
    bars[0]?.click();
    expect(opened).toEqual(["c02"]);
    expect(page.find("It did not, mostly.")).toBe(1);
    expect(page.setBlock(1, "It cost me nothing.")).toBe(true);
    expect(root.querySelector("button.mark")).toBeNull();
    expect(page.text()).toBe(`${P1}\n\nIt cost me nothing.\n`);
  });
});
