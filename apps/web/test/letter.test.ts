// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api.ts";
import {
  type LetterLine,
  letterLines,
  letterParts,
  letterRows,
  resumeRows,
  tickerText,
} from "../src/letter.ts";

const line = (id: string, kind: LetterLine["kind"], text: string, at: string): LetterLine => ({
  id,
  kind,
  text,
  at,
});

const LETTER: LetterLine[] = [
  line("l1", "passEmpty", "nothing in this pass · cut", "2026-11-10T09:00:00Z"),
  line(
    "l2",
    "refused",
    "write refused · the coach tried to edit article.md · logged",
    "2026-11-10T09:05:00Z",
  ),
  line(
    "l3",
    "quarantine",
    "article.md changed outside a save · quarantined as article.agent.md · restore it",
    "2026-11-10T09:10:00Z",
  ),
  line("l4", "interrupted", "", "2026-11-10T09:15:00Z"),
];

describe("the letter", () => {
  it("shows the most recent first, at most three", () => {
    expect(letterLines(LETTER).map((l) => l.id)).toEqual(["l4", "l3", "l2"]);
    expect(letterLines(undefined)).toEqual([]);
  });

  it("uses the kind's copy when the line has no text", () => {
    expect(letterParts(LETTER[3] as LetterLine)).toEqual(["the coach was interrupted", "ask again"]);
  });

  it("ends a quarantine line in a `restore it` button and gives the other kinds none", () => {
    const restore = vi.fn(async () => {});
    const rows = letterRows(LETTER, restore);
    expect(rows.map((r) => r.textContent)).toEqual([
      "the coach was interrupted·ask again",
      "article.md changed outside a save·quarantined as article.agent.md·restore it",
      "write refused·the coach tried to edit article.md·logged",
    ]);
    expect(rows[0]?.querySelector("button")).toBeNull();
    expect(rows[2]?.querySelector("button")).toBeNull();
    const b = rows[1]?.querySelector("button");
    expect(b?.textContent).toBe("restore it");
    b?.click();
    expect(restore).toHaveBeenCalledWith("l3");
  });

  it("gives every kind but the quarantine line a dismiss, the write refused line included", async () => {
    const dismiss = vi.fn(async () => {});
    const rows = letterRows(LETTER, async () => {}, dismiss);
    expect(rows.map((r) => r.textContent)).toEqual([
      "the coach was interrupted·ask again·dismiss",
      "article.md changed outside a save·quarantined as article.agent.md·restore it",
      "write refused·the coach tried to edit article.md·logged·dismiss",
    ]);
    const refused = rows[2] as HTMLElement;
    expect(refused.classList.contains("err")).toBe(true);
    refused.querySelector("button")?.click();
    expect(dismiss).toHaveBeenCalledWith(refused.dataset.id);
  });

  it("adds `restore it` when the daemon's quarantine text leaves it out", () => {
    const rows = letterRows(
      [line("q", "quarantine", "article.md changed outside a save · quarantined as article.agent.md", "x")],
      async () => {},
    );
    expect(rows[0]?.textContent).toBe(
      "article.md changed outside a save·quarantined as article.agent.md·restore it",
    );
  });

  it("sets coach-supplied text as text", () => {
    const rows = letterRows(
      [line("x", "passDone", "<img src=x onerror=alert(1)> · 4 notes", "x")],
      async () => {},
    );
    expect(rows[0]?.querySelector("img")).toBeNull();
    expect(rows[0]?.textContent).toContain("<img src=x onerror=alert(1)>");
  });

  it("says when a restore fails and lets it be tried again", async () => {
    const rows = letterRows([LETTER[2] as LetterLine], async () => {
      throw new Error("the page has unsaved changes");
    });
    const b = rows[0]?.querySelector("button") as HTMLButtonElement;
    b.click();
    await vi.waitFor(() => expect(rows[0]?.querySelector(".err")?.textContent).toContain("not restored"));
    expect(b.disabled).toBe(false);
  });
});

describe("pass results", () => {
  const PASSES_DONE: LetterLine[] = [
    line("p1", "passDone", "filler · 2 notes", "2026-11-10T02:00:00Z"),
    line("p2", "passEmpty", "nothing in this pass · cut", "2026-11-10T02:01:00Z"),
  ];

  it("show as the daemon worded them, each with a dismiss", async () => {
    const dismiss = vi.fn(async () => {});
    const rows = letterRows(PASSES_DONE, async () => {}, dismiss);
    expect(rows.map((r) => r.textContent)).toEqual([
      "nothing in this pass·cut·dismiss",
      "filler·2 notes·dismiss",
    ]);
    rows[1]?.querySelector("button")?.click();
    expect(dismiss).toHaveBeenCalledWith("p1");
  });

  it("say in red when a dismiss fails", async () => {
    const rows = letterRows(
      PASSES_DONE,
      async () => {},
      async () => {
        throw new Error("no such letter line");
      },
    );
    const b = rows[0]?.querySelector("button") as HTMLButtonElement;
    b.click();
    await vi.waitFor(() => expect(rows[0]?.querySelector(".err")?.textContent).toContain("not dismissed"));
    expect(b.disabled).toBe(false);
  });
});

describe("the ticker", () => {
  const now = Date.parse("2026-11-10T02:00:12Z");
  const run = (pass: string) => ({ pass, startedAt: "2026-11-10T02:00:00Z" });

  it("counts the seconds of a running pass and what waits behind it", () => {
    expect(tickerText(run("critique"), 0, now)).toBe("running critique… 12s");
    expect(tickerText(run("filler"), 2, now)).toBe("running filler… 12s · 2 queued");
    expect(tickerText(run(""), 0, now)).toBe("the coach is answering… 12s");
  });

  it("is empty when nothing runs, and says so between two queued passes", () => {
    expect(tickerText(null, 0, now)).toBe("");
    expect(tickerText(undefined, undefined, now)).toBe("");
    expect(tickerText(null, 1, now)).toBe("1 queued · starting…");
  });
});

describe("the resume letter", () => {
  const ago = (ms: number) => `${Math.round(ms / 3600_000)}h`;
  const now = Date.parse("2026-11-11T08:00:00Z");
  const resume = {
    stage: "polish",
    savedAt: "2026-11-10T22:00:00Z",
    awaySince: "2026-11-10T23:00:00Z",
    openQuestion: "Which lens first?",
    unread: Array.from({ length: 8 }, (_, i) => ({
      id: `c0${i + 1}`,
      kind: "filler",
      pass: i < 4 ? "filler" : "cut",
      span: "really hard at first and for a long while after that as well",
    })),
  };

  it("says where the article stands, the open question and the unread notes", () => {
    const rows = resumeRows(resume, { ago, open: () => {}, dismiss: () => {}, now });
    const text = rows.map((r) => r.textContent);
    expect(text[0]).toBe("welcome back · last here 9h ago · stage polish · saved 10h ago·dismiss");
    expect(text[1]).toBe("the coach asked: Which lens first?");
    expect(text[2]).toBe("8 unread notes");
    expect(text[3]).toBe("c01 · filler · “really hard at first and for a long whi…”");
    expect(text.at(-1)).toBe("and 2 more in the notes");
    expect(rows.length).toBe(3 + 6 + 1);
  });

  it("opens a note from its line, and goes away on dismiss", () => {
    const open = vi.fn();
    const dismiss = vi.fn();
    const rows = resumeRows({ ...resume, unread: resume.unread.slice(0, 1) }, { ago, open, dismiss, now });
    expect(rows.map((r) => r.textContent)[2]).toBe("1 unread note");
    rows[3]?.querySelector("button")?.click();
    expect(open).toHaveBeenCalledWith("c01");
    rows[0]?.querySelector("button")?.click();
    expect(dismiss).toHaveBeenCalled();
  });

  it("says so when nothing is unread and no question is open", () => {
    const rows = resumeRows(
      { stage: "draft", savedAt: null, awaySince: resume.awaySince, unread: [] },
      { ago, open: () => {}, dismiss: () => {}, now },
    );
    expect(rows.map((r) => r.textContent)).toEqual([
      "welcome back · last here 9h ago · stage draft·dismiss",
      "no unread notes",
    ]);
  });
});

describe("the restore call", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("posts {action: 'restore'} to the line's route", async () => {
    const fetch = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    await api.letter("closed-laptop", "l3", "restore");
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/api\/articles\/closed-laptop\/letter\/l3$/);
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ action: "restore" });
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
  });
});
