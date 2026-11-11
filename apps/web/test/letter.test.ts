// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api.ts";
import { type LetterLine, letterLines, letterParts, letterRows } from "../src/letter.ts";

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
