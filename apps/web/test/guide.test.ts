// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { advance, Guide, loadState, STEPS } from "../src/guide.ts";

const at = (title: string) => STEPS.findIndex((s) => s.title === title);

afterEach(() => {
  localStorage.clear();
  document.body.replaceChildren();
});

describe("guide steps", () => {
  it("moves on from a step once its check passes, and not before", () => {
    expect(advance(0, { where: "articles", ideas: 0 }).step).toBe(0);
    expect(advance(0, { where: "articles", ideas: 1 })).toEqual({ step: 1, passed: "Catch an idea" });
  });

  it("passes several finished steps at once and stops at one with no check", () => {
    // Arriving in a Room finishes "Turn it into an article", seen from the Room it opens.
    expect(advance(1, { where: "room" })).toEqual({
      step: at("Three pages, one coach"),
      passed: "Turn it into an article",
    });
    // In a Room there is no inbox count, so the first step waits.
    expect(advance(0, { where: "room" }).step).toBe(0);
  });

  it("counts the interview as started once any topic is covered", () => {
    const step = at("Start the interview");
    expect(advance(step, { where: "room", stage: "ideas", covered: 0 }).step).toBe(step);
    expect(advance(step, { where: "room", stage: "ideas", covered: 2 }).step).toBe(step + 1);
  });

  it("never runs past the last step", () => {
    expect(advance(STEPS.length - 1, { where: "room" }).step).toBe(STEPS.length - 1);
  });
});

describe("the guide card", () => {
  it("opens by itself the first time only, and remembers where it is", () => {
    const btn = document.createElement("button");
    const g = new Guide("articles", btn);
    expect(document.querySelector(".guide")?.hasAttribute("hidden")).toBe(false);
    g.update({ where: "articles", ideas: 1 });
    expect(loadState()).toMatchObject({ open: true, seen: true, step: 1 });
    expect(document.querySelector(".g-passed")?.textContent).toBe("✓ Catch an idea");
    (document.querySelector(".g-head button:last-child") as HTMLButtonElement).click();
    expect(loadState().open).toBe(false);
    document.body.replaceChildren();
    new Guide("articles", btn);
    expect(document.querySelector(".guide")?.hasAttribute("hidden")).toBe(true);
  });

  it("points at the step's control and says when the step is on another screen", () => {
    const idea = document.createElement("input");
    idea.id = "idea";
    document.body.append(idea);
    new Guide("articles", null);
    expect(idea.classList.contains("guide-target")).toBe(true);
    document.body.replaceChildren();
    new Guide("room", null);
    expect(document.querySelector(".g-where")?.textContent).toContain("Articles screen");
  });
});

describe("the critique step", () => {
  const step = at("Get critiqued");

  it("is built: it waits for the coach's notes and moves on once there is one", () => {
    expect(STEPS[step]?.later).toBeUndefined();
    expect(advance(step, { where: "room", stage: "critique", notes: 0 }).step).toBe(step);
    expect(advance(step, { where: "room", stage: "critique", notes: 2 })).toEqual({
      step: step + 1,
      passed: "Get critiqued",
    });
  });

  it("points at the composer and at the notes", () => {
    localStorage.setItem("sparring-guide", JSON.stringify({ open: true, step, seen: true, small: false }));
    const composer = document.createElement("textarea");
    composer.id = "composer";
    const notes = document.createElement("section");
    notes.id = "notes";
    document.body.append(composer, notes);
    const g = new Guide("room", null);
    expect(composer.classList.contains("guide-target")).toBe(true);
    expect(notes.classList.contains("guide-target")).toBe(true);
    expect(document.querySelector(".g-tag")).toBeNull();
    expect(document.querySelector(".g-wait")?.textContent).toBe("moves on when you have done it");
    g.update({ where: "room", notes: 1 });
    expect(loadState().step).toBe(step + 1);
  });
});
