// The page: one textarea per block, blocks being the blank-line split of the file. Enter on an empty line
// starts a new block; Backspace at the start of a block joins it to the one above. With a gutter, each block is
// a `.prow` of a `.gut` and its textarea, and `setMarks` puts the mono `?` in the gutter of the blocks it names.
import { joinBlocks, splitBlocks } from "@sparring/protocol/blocks";

export interface PageOptions {
  /** Each block gets a gutter column for marks. */
  gutter?: boolean;
}

export class Page {
  private mark: ((block: string) => boolean) | null = null;
  private readonly gutter: boolean;

  constructor(
    private readonly root: HTMLElement,
    private readonly onInput: (text: string) => void,
    opts: PageOptions = {},
  ) {
    this.gutter = opts.gutter === true;
    root.addEventListener("input", (e) => {
      if (e.target instanceof HTMLTextAreaElement) {
        autosize(e.target);
        this.markOne(e.target);
        this.onInput(this.text());
      }
    });
    root.addEventListener("keydown", (e) => this.key(e));
  }

  /** Shows a file, one block per textarea. The placeholder shows in the first block while it is empty. */
  show(text: string, label: string, placeholder = ""): void {
    this.root.replaceChildren(
      ...splitBlocks(text).map((b, i) => this.row(this.block(b, `${label} block ${i + 1}`))),
    );
    const first = this.blocks()[0];
    if (first && placeholder) first.placeholder = placeholder;
    for (const ta of this.blocks()) autosize(ta);
    this.markAll();
  }

  /** Which blocks carry the `?` mark; null clears every mark. Applied now and after every edit. */
  setMarks(mark: ((block: string) => boolean) | null): void {
    this.mark = mark;
    this.markAll();
  }

  text(): string {
    return joinBlocks(this.blocks().map((ta) => ta.value));
  }

  focusEnd(): void {
    const last = this.blocks().at(-1);
    if (!last) return;
    last.focus();
    last.setSelectionRange(last.value.length, last.value.length);
  }

  /** Grows every block to its text again (after the page was hidden and its width changed). */
  resize(): void {
    for (const ta of this.blocks()) autosize(ta);
  }

  private blocks(): HTMLTextAreaElement[] {
    return [...this.root.querySelectorAll<HTMLTextAreaElement>("textarea.para")];
  }

  private block(text: string, label: string): HTMLTextAreaElement {
    const ta = document.createElement("textarea");
    ta.className = "para";
    ta.rows = 1;
    ta.spellcheck = true;
    ta.value = text;
    ta.setAttribute("aria-label", label);
    return ta;
  }

  /** The element that holds a block in the page: its `.prow` with a gutter, else the textarea itself. */
  private row(ta: HTMLTextAreaElement): HTMLElement {
    if (!this.gutter) return ta;
    const row = document.createElement("div");
    row.className = "prow";
    const gut = document.createElement("div");
    gut.className = "gut";
    row.append(gut, ta);
    return row;
  }

  private holder(ta: HTMLTextAreaElement): HTMLElement {
    return this.gutter && ta.parentElement?.classList.contains("prow") ? ta.parentElement : ta;
  }

  private markAll(): void {
    for (const ta of this.blocks()) this.markOne(ta);
  }

  private markOne(ta: HTMLTextAreaElement): void {
    if (!this.gutter) return;
    const gut = ta.previousElementSibling;
    if (!(gut instanceof HTMLElement) || !gut.classList.contains("gut")) return;
    const on = this.mark?.(ta.value) === true;
    const has = gut.querySelector(".qmark") !== null;
    if (on === has) return;
    if (on) {
      const q = document.createElement("span");
      q.className = "qmark";
      q.setAttribute("aria-hidden", "true");
      q.textContent = "?";
      gut.replaceChildren(q);
    } else gut.replaceChildren();
  }

  private key(e: KeyboardEvent): void {
    const ta = e.target;
    if (!(ta instanceof HTMLTextAreaElement) || e.isComposing) return;
    const pos = ta.selectionStart;
    if (pos !== ta.selectionEnd) return;
    if (e.key === "Enter" && !e.shiftKey && pos > 0 && ta.value[pos - 1] === "\n") {
      e.preventDefault();
      const next = this.block(ta.value.slice(pos), ta.getAttribute("aria-label") ?? "block");
      ta.value = ta.value.slice(0, pos - 1);
      this.holder(ta).after(this.row(next));
      autosize(ta);
      autosize(next);
      this.markOne(ta);
      this.markOne(next);
      next.focus();
      next.setSelectionRange(0, 0);
      this.onInput(this.text());
    } else if (e.key === "Backspace" && pos === 0) {
      const all = this.blocks();
      const prev = all[all.indexOf(ta) - 1];
      if (!prev) return;
      e.preventDefault();
      const at = prev.value.length;
      prev.value =
        prev.value === "" || ta.value === "" ? prev.value + ta.value : `${prev.value}\n${ta.value}`;
      this.holder(ta).remove();
      autosize(prev);
      this.markOne(prev);
      prev.focus();
      prev.setSelectionRange(at, at);
      this.onInput(this.text());
    }
  }
}

/** Safari has no field-sizing: grow the textarea to its content. */
export function autosize(ta: HTMLTextAreaElement): void {
  ta.style.height = "auto";
  ta.style.height = `${ta.scrollHeight}px`;
}
