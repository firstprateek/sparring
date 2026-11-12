// The notes: the coach's remarks on article.md, listed in the coach panel under the filter row. On a wide screen
// the list sits above the turns and folds away; on a narrow one it is a sheet that rises from the foot. A note
// shows its kind, id and brief line, the quoted span and the body, then `done`, `disagree`, `dismiss`. `done` is
// inert under `·edit the span first` until the block the note was left on has changed. A button only sends a
// grammar line as a chat turn (`done c08`, `dismiss c11`, `dismiss c11 on purpose`, `re c09: …`); the daemon
// decides. Live notes whose span has left the file stack under the `shelf` rule.
import { splitBlocks } from "@sparring/protocol/blocks";
import {
  arrange,
  briefLabel,
  filterItems,
  filterNotes,
  isLive,
  type Note,
  type NoteView,
} from "@sparring/protocol/notes";

export interface NotesEls {
  root: HTMLElement;
  /** Folds the list on a wide screen. */
  toggle: HTMLButtonElement;
  /** Closes the sheet on a narrow screen. */
  close: HTMLButtonElement;
  filter: HTMLElement;
  body: HTMLElement;
  err: HTMLElement;
  list: HTMLElement;
}

export interface NotesHooks {
  /** Sends a grammar line. Resolves with why it could not go, in words, or null when it went or was queued. */
  act(line: string, note: Note): Promise<string | null>;
  /** Shows the note's paragraph in the page. */
  jump(note: Note): void;
  /** Replaces the note's paragraph with new text (the focused edit). An error in words, or null. */
  saveBlock(note: Note, text: string): string | null;
  /** These notes are on screen now. */
  seen(ids: string[]): void;
}

/** How long a sent action may go unanswered before the note says so. */
const PENDING_MS = 12_000;

const QUOTE_RE = /"[^"]+"|“[^”]+”/g;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls = "",
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** A note body: the coach's words muted, the writer's quoted words in the text colour. */
export function bodyNodes(body: string): (HTMLSpanElement | string)[] {
  const out: (HTMLSpanElement | string)[] = [];
  let at = 0;
  for (const m of body.matchAll(QUOTE_RE)) {
    if (m.index > at) out.push(body.slice(at, m.index));
    out.push(el("span", "q", m[0]));
    at = m.index + m[0].length;
  }
  if (at < body.length) out.push(body.slice(at));
  return out;
}

/** The mono head of a note: `unsupported · c08 · brief: evidence`, then its state when it is not plainly open. */
export function headWords(v: NoteView): string {
  const n = v.note;
  const parts = [n.kind, n.id, briefLabel(n.brief_line)];
  if (n.status === "disagreed") parts.push(n.body_v2 ? "disagreed · sharpened" : "disagreed · awaiting");
  else if (n.status !== "open") parts.push(n.status);
  if (v.stale && isLive(n)) parts.push("the text it quotes is gone");
  return parts.join(" · ");
}

export class NotesView {
  private notes: Note[] = [];
  private text = "";
  private filter = "all";
  private folded = false;
  private sheet = false;
  private replying: { id: string; text: string } | null = null;
  private editing: { id: string; text: string } | null = null;
  /** Actions sent and not yet answered, by note id. */
  private readonly pending = new Map<
    string,
    { line: string; was: string; timer: ReturnType<typeof setTimeout> }
  >();
  private error = "";
  private drawn = "";
  private flash: string | null = null;

  constructor(
    private readonly els: NotesEls,
    private readonly hooks: NotesHooks,
  ) {
    els.toggle.addEventListener("click", () => this.fold(!this.folded));
    els.close.addEventListener("click", () => this.openSheet(false));
    els.filter.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>("[data-filter]");
      if (!b?.dataset.filter) return;
      this.filter = b.dataset.filter;
      this.draw();
    });
    els.list.addEventListener("click", (e) => void this.click(e));
    els.list.addEventListener("input", (e) => {
      const t = e.target;
      if (t instanceof HTMLInputElement && this.replying) this.replying.text = t.value;
      if (t instanceof HTMLTextAreaElement && this.editing) this.editing.text = t.value;
    });
    els.list.addEventListener("keydown", (e) => {
      const t = e.target;
      if (!(t instanceof HTMLInputElement) || !this.replying) return;
      if (e.key === "Enter") {
        e.preventDefault();
        void this.sendReply();
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        this.replying = null;
        this.draw();
      }
    });
  }

  /** How many notes still wait on the writer. */
  get open(): number {
    return this.notes.filter(isLive).length;
  }

  get count(): number {
    return this.notes.length;
  }

  get sheetOpen(): boolean {
    return this.sheet;
  }

  /** The notes as the snapshot has them, and article.md as the writer has it now. */
  set(notes: readonly Note[], text: string): void {
    for (const [id, p] of this.pending) {
      const n = notes.find((x) => x.id === id);
      if (!n || stamp(n) !== p.was) this.settle(id);
    }
    this.notes = [...notes];
    this.text = text;
    this.draw();
  }

  /** Folds the list to its head (wide screens), or opens it again. */
  fold(folded: boolean): void {
    this.folded = folded;
    this.draw();
  }

  /** Raises or lowers the sheet (narrow screens). */
  openSheet(on: boolean): void {
    this.sheet = on;
    this.draw();
    if (on) this.els.close.focus();
  }

  /** Opens the list at one note and lights it: the way in from a gutter bar. */
  focus(id: string): void {
    this.folded = false;
    this.sheet = true;
    if (!this.shown().some((v) => v.note.id === id)) this.filter = "all";
    this.flash = id;
    this.draw();
    const card = this.card(id);
    if (!card) return;
    card.scrollIntoView({ block: "nearest" });
    card.focus();
    setTimeout(() => {
      if (this.flash === id) this.flash = null;
      // The list may have been redrawn since: the card on screen now is the one to dim.
      this.card(id)?.classList.remove("hit");
    }, 1600);
  }

  private card(id: string): HTMLElement | null {
    return this.els.list.querySelector<HTMLElement>(`.note[data-id="${id}"]`);
  }

  private shown(): NoteView[] {
    const { list, shelf } = arrange(filterNotes(this.notes, this.filter), this.text);
    return [...list, ...shelf];
  }

  private settle(id: string): void {
    const p = this.pending.get(id);
    if (p) clearTimeout(p.timer);
    this.pending.delete(id);
  }

  private fail(text: string): void {
    this.error = text;
    this.draw();
  }

  /** Sends one grammar line for a note and waits for the snapshot to show what the daemon made of it. */
  private async send(note: Note, line: string): Promise<void> {
    this.error = "";
    const timer = setTimeout(() => {
      if (!this.pending.has(note.id)) return;
      this.pending.delete(note.id);
      this.fail(
        `${note.id} has not changed · "${line}" may be queued or refused · see the coach's lines below`,
      );
    }, PENDING_MS);
    this.pending.set(note.id, { line, was: stamp(note), timer });
    this.draw();
    let problem: string | null;
    try {
      problem = await this.hooks.act(line, note);
    } catch (e) {
      problem = e instanceof Error ? e.message : String(e);
    }
    if (problem) {
      this.settle(note.id);
      this.fail(`not sent · ${problem}`);
    }
  }

  private async sendReply(): Promise<void> {
    const r = this.replying;
    const note = r ? this.notes.find((n) => n.id === r.id) : undefined;
    if (!r || !note) return;
    const text = r.text.trim();
    if (!text) {
      this.fail(`say why you disagree with ${note.id}, then send`);
      return;
    }
    this.replying = null;
    await this.send(note, `re ${note.id}: ${text}`);
  }

  private async click(e: Event): Promise<void> {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-act]");
    const id = b?.closest<HTMLElement>(".note")?.dataset.id;
    const note = this.notes.find((n) => n.id === id);
    if (!b || !note || (b instanceof HTMLButtonElement && b.disabled)) return;
    switch (b.dataset.act) {
      case "jump":
        this.hooks.jump(note);
        break;
      case "done":
        await this.send(note, `done ${note.id}`);
        break;
      case "dismiss":
        await this.send(note, `dismiss ${note.id}`);
        break;
      case "mute":
        await this.send(note, `dismiss ${note.id} on purpose`);
        break;
      case "disagree":
        this.replying = { id: note.id, text: "" };
        this.editing = null;
        this.draw();
        this.card(note.id)?.querySelector<HTMLInputElement>(".reply-in")?.focus();
        break;
      case "send":
        await this.sendReply();
        break;
      case "cancel":
        this.replying = null;
        this.draw();
        break;
      case "edit": {
        const text = splitBlocks(this.text).find((b) => b.includes(note.span)) ?? "";
        this.editing = { id: note.id, text };
        this.replying = null;
        this.draw();
        this.card(note.id)?.querySelector<HTMLTextAreaElement>(".edit-in")?.focus();
        break;
      }
      case "save": {
        const ed = this.editing;
        if (!ed) break;
        const problem = this.hooks.saveBlock(note, ed.text);
        if (problem) this.fail(`not saved · ${problem}`);
        else {
          this.editing = null;
          this.error = "";
          this.draw();
        }
        break;
      }
      case "back":
        this.editing = null;
        this.draw();
        break;
    }
  }

  private draw(): void {
    const { els } = this;
    els.root.hidden = this.notes.length === 0;
    els.root.classList.toggle("folded", this.folded);
    els.root.classList.toggle("sheet-open", this.sheet);
    if (this.notes.length === 0) {
      this.sheet = false;
      this.drawn = "";
      return;
    }
    const { list, shelf } = arrange(filterNotes(this.notes, this.filter), this.text);
    const key = JSON.stringify([
      [...list, ...shelf].map((v) => [stamp(v.note), v.block, v.stale, v.edited]),
      this.notes.map((n) => [n.id, n.status, n.pass]),
      this.filter,
      this.folded,
      this.sheet,
      this.replying?.id,
      this.editing?.id,
      [...this.pending.keys()],
      this.error,
      this.flash,
    ]);
    if (key === this.drawn) return;
    this.drawn = key;

    els.toggle.textContent = `notes · ${this.open} open ${this.folded ? "▸" : "▾"}`;
    els.toggle.setAttribute("aria-expanded", String(!this.folded));
    els.err.textContent = this.error;
    els.err.hidden = this.error === "";
    els.filter.replaceChildren(
      ...filterItems(this.notes).map((i) => {
        const b = el("button", `hb f ${i.key === this.filter ? "text" : "muted"}`, `${i.label} ${i.count}`);
        b.type = "button";
        b.dataset.filter = i.key;
        b.setAttribute("aria-pressed", String(i.key === this.filter));
        return b;
      }),
    );

    const rows: HTMLElement[] = list.map((v) => this.note(v));
    if (shelf.length > 0) {
      const rule = el("div", "divider shelf");
      rule.append(el("span", "", "shelf"));
      rows.push(rule, ...shelf.map((v) => this.note(v)));
    }
    if (rows.length === 0) rows.push(el("p", "mono muted none", "no notes under this filter"));
    const hadFocus =
      document.activeElement instanceof HTMLElement && els.list.contains(document.activeElement);
    els.list.replaceChildren(...rows);
    if (hadFocus) {
      const field = els.list.querySelector<HTMLElement>(".reply-in, .edit-in");
      field?.focus();
    }
    if (!this.folded || this.sheet) {
      const unseen = [...list, ...shelf].filter((v) => v.note.seen_at === null).map((v) => v.note.id);
      if (unseen.length > 0) this.hooks.seen(unseen);
    }
  }

  private btn(text: string, act: string, cls = "text", disabled = false): HTMLButtonElement {
    const b = el("button", `hb act ${cls}`, text);
    b.type = "button";
    b.dataset.act = act;
    b.disabled = disabled;
    return b;
  }

  private note(v: NoteView): HTMLElement {
    const n = v.note;
    const live = isLive(n);
    const card = el("div", `note ${live ? (v.stale ? "stale" : "live") : "closed"}`);
    card.dataset.id = n.id;
    card.tabIndex = -1;
    if (this.flash === n.id) card.classList.add("hit");

    const head = this.btn(headWords(v), "jump", "nhead mono muted", v.stale);
    head.title = v.stale ? "the text this note quotes is no longer in the article" : "show the paragraph";
    card.append(head);

    if (live) {
      card.append(el("p", "span", `"${n.span}"`));
      const body = el("p", "nbody");
      body.append(...bodyNodes(n.body));
      card.append(body);
    }
    if (n.reply && (live || n.status === "withdrawn"))
      card.append(el("p", "mono muted reply", `re ${n.id}: ${n.reply}`));
    if (n.body_v2 && (live || n.status === "withdrawn")) {
      const v2 = el("div", "v2");
      const body = el("p", "nbody");
      body.append(...bodyNodes(n.body_v2));
      v2.append(body);
      if (live) v2.append(el("span", "mono muted", `${n.id} v2`));
      card.append(v2);
    }

    const pending = this.pending.get(n.id);
    if (pending) {
      card.append(el("div", "mono muted wait", `${pending.line} · sent, waiting`));
      return card;
    }
    if (this.editing?.id === n.id) {
      const ta = el("textarea", "edit-in");
      ta.value = this.editing.text;
      ta.rows = 5;
      ta.setAttribute("aria-label", `The paragraph ${n.id} is about`);
      const acts = el("div", "acts");
      acts.append(this.btn("save", "save"), this.btn("back", "back", "muted"));
      card.append(ta, acts);
      return card;
    }
    if (this.replying?.id === n.id) {
      const row = el("div", "mono replyrow");
      const label = el("label", "muted", `re ${n.id}:`);
      const input = el("input", "reply-in");
      input.type = "text";
      input.autocomplete = "off";
      input.id = `reply-${n.id}`;
      input.value = this.replying.text;
      input.setAttribute("aria-label", `Why you disagree with ${n.id}`);
      label.htmlFor = input.id;
      row.append(label, input, this.btn("send", "send"), this.btn("cancel", "cancel", "muted"));
      card.append(row);
      return card;
    }
    if (live) {
      const acts = el("div", "acts");
      acts.append(this.btn("done", "done", v.edited ? "text" : "muted", !v.edited));
      // One exchange per note: once the coach has answered, the writer closes it.
      if (n.status === "open") acts.append(this.btn("disagree", "disagree"));
      acts.append(this.btn("dismiss", "dismiss"));
      if (!v.stale) acts.append(this.btn("edit", "edit", "text act-edit"));
      card.append(acts);
      if (!v.edited) card.append(el("div", "mono muted nhint", "·edit the span first"));
    } else if (n.status === "dismissed") {
      card.append(
        n.muted
          ? el("span", "mono muted", `muted · STYLE.md ← do not flag: "${n.span}"`)
          : this.btn("on purpose, stop flagging this", "mute", "muted"),
      );
    }
    return card;
  }
}

/** What a sent action waits to see change. */
const stamp = (n: Note) => JSON.stringify([n.id, n.status, n.muted, n.body_v2, n.reply]);
