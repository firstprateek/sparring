// The inbox on Articles: the ideas from `GET /api/inbox`, newest first, each with `→ article`, which asks for a
// slug in place and makes the article from the idea. Everything is set with textContent.
import type { Idea } from "./api.ts";

/** `11-06` from an ISO date or timestamp; anything else is shown as it came. */
export function ideaDate(date: string): string {
  const m = /^\d{4}-(\d{2})-(\d{2})/.exec(date ?? "");
  return m ? `${m[1]}-${m[2]}` : String(date ?? "");
}

/** Newest first. Ideas with the same date keep the file's order reversed (the last appended first). */
export function sortIdeas(items: readonly Idea[]): Idea[] {
  return [...items].reverse().sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

export interface InboxHooks {
  /** `→ article` was submitted with a slug. Resolves when the article exists; rejects with words to show. */
  article: (idea: Idea, slug: string) => Promise<void>;
  /** Checks a slug before it goes out; returns the problem in words, or null. */
  check: (slug: string) => string | null;
}

/** One `.inbox` row per idea: date, text and `→ article`. */
export function inboxRows(items: readonly Idea[], hooks: InboxHooks): HTMLDivElement[] {
  return sortIdeas(items).map((idea) => {
    const row = document.createElement("div");
    row.className = "inbox";
    row.dataset.id = idea.id;
    const go = document.createElement("button");
    go.type = "button";
    go.className = "t mono muted go";
    go.textContent = "→ article";
    go.addEventListener("click", () => {
      const form = buildForm(idea, hooks, () => {
        form.replaceWith(go);
        go.focus();
      });
      go.replaceWith(form);
      form.querySelector("input")?.focus();
    });
    row.append(span(ideaDate(idea.date), "mono muted date"), span(idea.text, "text"), go);
    return row;
  });
}

function buildForm(idea: Idea, hooks: InboxHooks, cancel: () => void): HTMLFormElement {
  const form = document.createElement("form");
  form.className = "slug mono";
  const input = document.createElement("input");
  input.name = "slug";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.setAttribute("autocapitalize", "off");
  input.placeholder = "slug";
  input.setAttribute("aria-label", `Slug for the article from: ${idea.text}`);
  const err = span("", "muted err");
  err.setAttribute("role", "status");
  form.append(input, err);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      cancel();
    }
  });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const slug = input.value.trim();
    const problem = hooks.check(slug);
    if (problem) {
      err.textContent = problem;
      return;
    }
    input.disabled = true;
    try {
      await hooks.article(idea, slug);
    } catch (x) {
      err.textContent = x instanceof Error ? x.message : String(x);
      input.disabled = false;
      input.focus();
    }
  });
  return form;
}

function span(text: string, cls: string): HTMLSpanElement {
  const s = document.createElement("span");
  s.className = cls;
  s.textContent = text;
  return s;
}
