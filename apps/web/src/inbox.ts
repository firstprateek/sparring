// The inbox on Articles: the ideas from `GET /api/inbox`, newest first, each with `→ article`, which asks for a
// slug in place and makes the article from the idea. Everything is set with textContent.
import { suggestSlug } from "@sparring/protocol/slug";
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
  /** The slug form opened (the guide points at its button). */
  opened?: () => void;
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
      hooks.opened?.();
    });
    row.append(span(ideaDate(idea.date), "mono muted date"), span(idea.text, "text"), go);
    return row;
  });
}

/**
 * Keeps a slug field tidy as it is typed: lower case, spaces and underscores become hyphens. The rule's
 * problem, if any, shows in `err` at once, so a bad slug never fails silently.
 */
export function wireSlugField(
  input: HTMLInputElement,
  err: HTMLElement,
  check: (slug: string) => string | null,
): void {
  input.addEventListener("input", () => {
    const at = input.selectionStart ?? input.value.length;
    const tidy = input.value.toLowerCase().replace(/[\s_]+/g, "-");
    if (tidy !== input.value) {
      input.value = tidy;
      input.setSelectionRange(at, at);
    }
    const slug = input.value.trim();
    err.textContent = slug === "" ? "" : (check(slug) ?? "");
  });
}

function buildForm(idea: Idea, hooks: InboxHooks, cancel: () => void): HTMLFormElement {
  const form = document.createElement("form");
  form.className = "slug";
  const id = `slug-${idea.id}`;
  const label = document.createElement("label");
  label.className = "help";
  label.htmlFor = id;
  label.textContent = "name the article · lowercase words and hyphens · it becomes the folder and the URL";
  const input = document.createElement("input");
  input.id = id;
  input.className = "mono";
  input.name = "slug";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.setAttribute("autocapitalize", "off");
  input.placeholder = "like agents-forget-sockets";
  input.value = suggestSlug(idea.text);
  const create = document.createElement("button");
  create.type = "submit";
  create.className = "btn primary";
  create.textContent = "create article";
  const back = document.createElement("button");
  back.type = "button";
  back.className = "btn";
  back.textContent = "cancel";
  back.addEventListener("click", cancel);
  const line = document.createElement("div");
  line.className = "slug-row";
  line.append(input, create, back);
  const err = span("", "mono err");
  err.setAttribute("role", "alert");
  form.append(label, line, err);
  wireSlugField(input, err, hooks.check);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      cancel();
    }
  });
  queueMicrotask(() => input.select());
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const slug = input.value.trim();
    const problem = hooks.check(slug);
    if (problem) {
      err.textContent = problem;
      input.focus();
      return;
    }
    input.disabled = true;
    create.disabled = true;
    create.textContent = "creating…";
    err.textContent = "";
    try {
      await hooks.article(idea, slug);
    } catch (x) {
      err.textContent = `not created · ${x instanceof Error ? x.message : String(x)}`;
      input.disabled = false;
      create.disabled = false;
      create.textContent = "create article";
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
