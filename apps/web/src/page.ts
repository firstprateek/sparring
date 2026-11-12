// The page: one textarea per block, blocks being the blank-line split of the file. Enter on an empty line
// starts a new block; Backspace at the start of a block joins it to the one above. With a gutter, each block is
// a `.prow` of a `.gut` and its textarea, and `setMarks` puts a mark in the gutter of the blocks it names: the
// mono `?` of a brief quote, or the solid bar of a live note, which is a button that opens the note. In a drafted
// article `setProv` adds the dotted provenance bar before it: accent for a block still the coach's, muted for one
// the writer edited, none once it is the writer's. `showReveal` lands a draft block by block.
import { joinBlocks, splitBlocks } from "@sparring/protocol/blocks";

export interface PageOptions {
  /** Each block gets a gutter column for marks. */
  gutter?: boolean;
  /** A note's bar was clicked. */
  onMark?: (noteId: string) => void;
}

/** What a block's gutter shows: `?` for a brief quote, or the bar of the note on it. */
export type Mark = { kind: "q" } | { kind: "note"; id: string; label: string };

/** A block's provenance bar: the coach's words, the coach's words edited, or none. */
export type Prov = "coach" | "edited" | null;

const PROV_SAYS = { coach: "written by the coach", edited: "written by the coach, edited by you" };

export class Page {
  private mark: ((block: string) => Mark | null) | null = null;
  private prov: ((block: string) => Prov) | null = null;
  private readOnly = false;
  /** The reveal in flight, if one is. */
  private landing: { timer: ReturnType<typeof setTimeout> | undefined } | null = null;
  private readonly gutter: boolean;
  /** The block the caret was last in. */
  private last: HTMLTextAreaElement | null = null;

  constructor(
    private readonly root: HTMLElement,
    private readonly onInput: (text: string) => void,
    opts: PageOptions = {},
  ) {
    this.gutter = opts.gutter === true;
    root.addEventListener("input", (e) => {
      if (e.target instanceof HTMLTextAreaElement && !this.landing) {
        autosize(e.target);
        this.markOne(e.target);
        this.onInput(this.text());
      }
    });
    root.addEventListener("keydown", (e) => this.key(e));
    root.addEventListener("focusin", (e) => {
      if (e.target instanceof HTMLTextAreaElement) this.last = e.target;
    });
    root.addEventListener("click", (e) => {
      const bar = (e.target as HTMLElement).closest<HTMLElement>("button.mark");
      if (bar?.dataset.note) opts.onMark?.(bar.dataset.note);
    });
  }

  /** Shows a file, one block per textarea. The placeholder shows in the first block while it is empty. */
  show(text: string, label: string, placeholder = ""): void {
    this.stopReveal();
    this.root.replaceChildren(
      ...splitBlocks(text).map((b, i) => this.row(this.block(b, `${label} block ${i + 1}`))),
    );
    const first = this.blocks()[0];
    if (first && placeholder) first.placeholder = placeholder;
    for (const ta of this.blocks()) autosize(ta);
    this.markAll();
  }

  /**
   * Lands a draft block by block, one every `stepMs` (all at once when it is 0, as under reduced motion). The
   * page is read-only until the last block is in, so nothing typed can be saved over half a draft.
   */
  showReveal(text: string, label: string, stepMs: number, done: () => void = () => {}): void {
    const blocks = splitBlocks(text);
    if (stepMs <= 0 || blocks.length <= 1) {
      this.show(text, label);
      done();
      return;
    }
    this.stopReveal();
    this.root.replaceChildren();
    const state: { timer: ReturnType<typeof setTimeout> | undefined } = { timer: undefined };
    this.landing = state;
    let i = 0;
    const next = () => {
      if (this.landing !== state) return;
      const ta = this.block(blocks[i] as string, `${label} block ${i + 1}`);
      ta.readOnly = true;
      const row = this.row(ta);
      row.classList.add("landing");
      this.root.append(row);
      autosize(ta);
      this.markOne(ta);
      row.scrollIntoView({ block: "nearest" });
      i++;
      if (i < blocks.length) {
        state.timer = setTimeout(next, stepMs);
        return;
      }
      this.landing = null;
      for (const b of this.blocks()) b.readOnly = this.readOnly;
      done();
    };
    next();
  }

  /** True while a draft is landing. */
  get revealing(): boolean {
    return this.landing !== null;
  }

  private stopReveal(): void {
    if (this.landing) clearTimeout(this.landing.timer);
    this.landing = null;
  }

  /** While the coach drafts, the page can be read and not typed in. */
  setReadOnly(on: boolean): void {
    this.readOnly = on;
    if (!this.landing) for (const ta of this.blocks()) ta.readOnly = on;
  }

  /** The provenance bar of each block, in a drafted article; null clears every bar. */
  setProv(prov: ((block: string) => Prov) | null): void {
    this.prov = prov;
    this.markAll();
  }

  /** Which blocks carry a mark, and which; null clears every mark. Applied now and after every edit. */
  setMarks(mark: ((block: string) => Mark | null) | null): void {
    this.mark = mark;
    this.markAll();
  }

  /** The index of the first block that holds a span, or -1. */
  find(span: string): number {
    return this.blocks().findIndex((ta) => ta.value.includes(span));
  }

  /** Scrolls a block into view and lights it for a moment. */
  reveal(index: number): void {
    const ta = this.blocks()[index];
    if (!ta) return;
    const el = this.holder(ta);
    el.scrollIntoView({ block: "center", behavior: "auto" });
    el.classList.add("hit");
    setTimeout(() => el.classList.remove("hit"), 1600);
  }

  /** Replaces one block's text (the phone's focused edit), as if the writer had typed it. */
  setBlock(index: number, text: string): boolean {
    const ta = this.blocks()[index];
    if (!ta) return false;
    ta.value = text;
    autosize(ta);
    this.markOne(ta);
    this.onInput(this.text());
    return true;
  }

  text(): string {
    return joinBlocks(this.blocks().map((ta) => ta.value));
  }

  /** The text of the block the caret is in, or was in last; null when no block of this page has had it. */
  caretBlock(): string | null {
    const ta = this.last;
    if (!ta?.isConnected || !this.root.contains(ta)) return null;
    return ta.value.trim() === "" ? null : ta.value;
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
    ta.readOnly = this.readOnly;
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
    const m = this.mark?.(ta.value) ?? null;
    const p = this.prov?.(ta.value) ?? null;
    const key = `${p ?? ""}|${m === null ? "" : m.kind === "q" ? "q" : `note:${m.id}:${m.label}`}`;
    if ((gut.dataset.mark ?? "|") === key) return;
    gut.dataset.mark = key;
    if (p) ta.setAttribute("aria-description", PROV_SAYS[p]);
    else ta.removeAttribute("aria-description");
    // The dotted provenance bar comes first, then the note's solid one.
    const kids: HTMLElement[] = [];
    if (p) {
      const bar = document.createElement("span");
      bar.className = p === "edited" ? "prov mixed" : "prov";
      bar.setAttribute("aria-hidden", "true");
      kids.push(bar);
    }
    if (m === null) gut.replaceChildren(...kids);
    else if (m.kind === "q") {
      const q = document.createElement("span");
      q.className = "qmark";
      q.setAttribute("aria-hidden", "true");
      q.textContent = "?";
      gut.replaceChildren(...kids, q);
    } else {
      const bar = document.createElement("button");
      bar.type = "button";
      bar.className = "mark";
      bar.dataset.note = m.id;
      bar.title = m.label;
      bar.setAttribute("aria-label", `Open the note on this paragraph · ${m.label}`);
      gut.replaceChildren(...kids, bar);
    }
  }

  private key(e: KeyboardEvent): void {
    const ta = e.target;
    if (!(ta instanceof HTMLTextAreaElement) || e.isComposing || ta.readOnly) return;
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
