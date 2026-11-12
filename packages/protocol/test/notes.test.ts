import { describe, expect, it } from "vitest";
import {
  arrange,
  blockEdited,
  bodyProblem,
  briefLabel,
  briefLineOf,
  filterItems,
  filterNotes,
  type Note,
  parseNoteAction,
  quotedSpans,
  quoteFound,
} from "../src/notes.ts";

const note = (p: Partial<Note>): Note => ({
  id: "c01",
  file: "article",
  kind: "unclear",
  pass: "critique",
  brief_line: null,
  span: "one",
  block_orig: "Block one.",
  body: "b",
  body_v2: null,
  status: "open",
  muted: false,
  reply: null,
  seen_at: null,
  created_at: "",
  resolved_at: null,
  ...p,
});

describe("the note grammar", () => {
  it("reads the five typed actions", () => {
    expect(parseNoteAction("done c08")).toEqual({ action: "done", id: "c08" });
    expect(parseNoteAction("dismiss c11")).toEqual({ action: "dismiss", id: "c11" });
    expect(parseNoteAction("dismiss c11 on purpose")).toEqual({ action: "mute", id: "c11" });
    expect(parseNoteAction("mute c11")).toEqual({ action: "mute", id: "c11" });
    expect(parseNoteAction("re c09: the retry path is fine\nwhen the child survived")).toEqual({
      action: "reply",
      id: "c09",
      text: "the retry path is fine\nwhen the child survived",
    });
  });

  it("leaves anything else as plain text", () => {
    for (const t of ["done", "done c08 now", "done with c08", "re c09:", "done c08 on purpose", "dismiss x1"])
      expect(parseNoteAction(t)).toBeNull();
  });
});

describe("the body rule", () => {
  const sources = [
    "The server dropped it after thirty seconds.",
    "it just dropped, and I sat there watching it spin.",
  ];

  it("accepts unquoted explanation and quotes of the writer's text", () => {
    expect(bodyProblem("Which server? Nothing says.", sources)).toBeNull();
    expect(bodyProblem('The dump says "it just dropped". Which is it?', sources)).toBeNull();
    expect(quotedSpans('a "b c" d “e”')).toEqual(["b c", "e"]);
  });

  it("takes a quote that closes a sentence or opens one with a capital", () => {
    expect(quoteFound("I sat there watching it.", sources)).toBe(true);
    expect(quoteFound("I sat there watching the screen.", sources)).toBe(false);
    expect(quoteFound("the server dropped it", sources)).toBe(true);
    expect(quoteFound("it just dropped.", sources)).toBe(true);
  });

  it("refuses a quoted phrase that is in none of the sources", () => {
    expect(bodyProblem('Say "the socket timed out after a minute" instead.', sources)).toMatch(
      /is not the writer's text/,
    );
  });

  it("refuses fix text after consider:, try:, rewrite: or e.g., even in the writer's words", () => {
    for (const lead of ["Consider:", "try:", "Rewrite:", "e.g.", "e.g.,"])
      expect(bodyProblem(`Too long. ${lead} "it just dropped"`, sources)).toMatch(/no fix text/);
  });

  it("refuses an empty body and one over 280 characters", () => {
    expect(bodyProblem("  ", sources)).toMatch(/required/);
    expect(bodyProblem("x".repeat(281), sources)).toMatch(/at most 280/);
    expect(bodyProblem("x".repeat(280), sources)).toBeNull();
  });
});

describe("brief lines", () => {
  it("stores the bare name and words it for the note head", () => {
    expect(briefLineOf("brief: evidence")).toBe("evidence");
    expect(briefLineOf("(no brief line)")).toBeNull();
    expect(briefLineOf(undefined)).toBeNull();
    expect(briefLabel("evidence")).toBe("brief: evidence");
    expect(briefLabel(null)).toBe("no brief line");
  });
});

describe("what is computed from the file", () => {
  const text = "Block one.\n\nBlock two has the phrase.\n";

  it("Done is live once the anchored block differs from block_orig", () => {
    expect(blockEdited("Block one.", ["Block one.", "Block two."])).toBe(false);
    expect(blockEdited("Block one.", ["Block one, changed.", "Block two."])).toBe(true);
  });

  it("orders live notes by page position, closed ones after, and shelves a note whose span left the file", () => {
    const notes = [
      note({ id: "c01", span: "the phrase", block_orig: "Block two has the phrase." }),
      note({ id: "c02", span: "Block one", block_orig: "Block one." }),
      note({ id: "c03", span: "gone from the page", block_orig: "An old block." }),
      note({ id: "c04", span: "Block one", status: "done" }),
      note({ id: "c05", span: "Block one", status: "dismissed" }),
    ];
    const { list, shelf } = arrange(notes, text);
    expect(list.map((v) => v.note.id)).toEqual(["c02", "c01", "c05", "c04"]);
    expect(shelf.map((v) => [v.note.id, v.stale, v.edited])).toEqual([["c03", true, true]]);
    expect(list[0]).toMatchObject({ block: 0, stale: false, edited: false });
  });

  it("counts the filter row by status and by pass", () => {
    const notes = [
      note({ id: "c01" }),
      note({ id: "c02", status: "disagreed" }),
      note({ id: "c03", pass: "filler", status: "dismissed" }),
    ];
    expect(filterItems(notes).map((i) => `${i.label} ${i.count}`)).toEqual([
      "all 3",
      "open 2",
      "critique 2",
      "filler 1",
    ]);
    expect(filterNotes(notes, "open").map((n) => n.id)).toEqual(["c01", "c02"]);
    expect(filterNotes(notes, "pass:filler").map((n) => n.id)).toEqual(["c03"]);
  });
});
