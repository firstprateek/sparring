// The page: one textarea per block, blocks being the blank-line split of the file. Enter on an empty line
// starts a new block; Backspace at the start of a block joins it to the one above.
import { joinBlocks, splitBlocks } from "@sparring/protocol/blocks";

export class Page {
  constructor(
    private readonly root: HTMLElement,
    private readonly onInput: (text: string) => void,
  ) {
    root.addEventListener("input", (e) => {
      if (e.target instanceof HTMLTextAreaElement) {
        autosize(e.target);
        this.onInput(this.text());
      }
    });
    root.addEventListener("keydown", (e) => this.key(e));
  }

  /** Shows a file, one block per textarea. */
  show(text: string, label: string): void {
    this.root.replaceChildren(...splitBlocks(text).map((b, i) => this.block(b, `${label} block ${i + 1}`)));
    for (const ta of this.blocks()) autosize(ta);
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

  private key(e: KeyboardEvent): void {
    const ta = e.target;
    if (!(ta instanceof HTMLTextAreaElement) || e.isComposing) return;
    const pos = ta.selectionStart;
    if (pos !== ta.selectionEnd) return;
    if (e.key === "Enter" && !e.shiftKey && pos > 0 && ta.value[pos - 1] === "\n") {
      e.preventDefault();
      const next = this.block(ta.value.slice(pos), ta.getAttribute("aria-label") ?? "block");
      ta.value = ta.value.slice(0, pos - 1);
      ta.after(next);
      autosize(ta);
      autosize(next);
      next.focus();
      next.setSelectionRange(0, 0);
      this.onInput(this.text());
    } else if (e.key === "Backspace" && pos === 0) {
      const prev = ta.previousElementSibling;
      if (!(prev instanceof HTMLTextAreaElement)) return;
      e.preventDefault();
      const at = prev.value.length;
      prev.value = prev.value === "" || ta.value === "" ? prev.value + ta.value : `${prev.value}\n${ta.value}`;
      ta.remove();
      autosize(prev);
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
