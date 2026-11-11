// The composer at the foot of the margin: `>`, one textarea. Enter sends, Shift+Enter is a new line. Typing `/`
// opens the slash list (the listed commands with their hints); arrow keys move in it, Tab or Enter completes.
// `/log`, `/sendit` and `/publish` are the client's own and send no turn; everything else is a chat line.
import { type Command, parseCommand } from "@sparring/protocol/commands";
import { autosize } from "./page.ts";
import { completion, slashMatches } from "./slash.ts";

export interface ComposerHooks {
  /** A chat line to send. */
  line: (text: string) => void;
  /** `/log`. */
  log: () => void;
  /** Escape in an empty composer with no list open. */
  escape: () => void;
}

export const LATER = "arrives in a later step";

export class Composer {
  private matches: Command[] = [];
  private sel = 0;
  /** Escape closed the list; it stays closed until the text changes. */
  private dismissed = false;

  constructor(
    private readonly ta: HTMLTextAreaElement,
    private readonly list: HTMLElement,
    private readonly noteEl: HTMLElement,
    private readonly queuedEl: HTMLElement,
    private readonly hooks: ComposerHooks,
  ) {
    ta.addEventListener("input", () => {
      this.dismissed = false;
      this.note("");
      this.update();
      autosize(ta);
    });
    ta.addEventListener("keydown", (e) => this.key(e));
    list.addEventListener("mousedown", (e) => {
      const opt = (e.target as HTMLElement).closest<HTMLElement>("[data-i]");
      if (!opt) return;
      e.preventDefault();
      this.complete(Number(opt.dataset.i));
    });
  }

  /** One muted line above the composer; empty hides it. */
  note(text: string): void {
    this.noteEl.textContent = text;
    this.noteEl.hidden = text === "";
  }

  /** The lines waiting to go (the outbox, then what the host holds), each marked `queued`. */
  queued(lines: readonly string[]): void {
    this.queuedEl.hidden = lines.length === 0;
    this.queuedEl.replaceChildren(
      ...lines.map((l) => {
        const row = document.createElement("div");
        row.className = "q";
        const t = document.createElement("span");
        t.className = "text";
        t.textContent = l;
        const q = document.createElement("span");
        q.textContent = "queued";
        row.append(t, q);
        return row;
      }),
    );
  }

  /** Puts text back (a line the host refused), unless the writer has started another. */
  restore(text: string): void {
    if (this.ta.value.trim() !== "") return;
    this.ta.value = text;
    this.update();
    autosize(this.ta);
  }

  private open(): boolean {
    return !this.list.hidden && this.matches.length > 0;
  }

  private update(): void {
    const m = this.dismissed ? null : slashMatches(this.ta.value);
    this.matches = m ?? [];
    if (this.sel >= this.matches.length) this.sel = 0;
    this.list.hidden = this.matches.length === 0;
    this.list.replaceChildren(
      ...this.matches.map((c, i) => {
        const opt = document.createElement("div");
        opt.className = "opt";
        opt.dataset.i = String(i);
        opt.setAttribute("role", "option");
        opt.setAttribute("aria-selected", String(i === this.sel));
        const name = document.createElement("span");
        name.className = "name text";
        name.textContent = `/${c.name}`;
        name.dataset.i = String(i);
        const hint = document.createElement("span");
        hint.className = "hint muted";
        hint.textContent = c.hint;
        hint.dataset.i = String(i);
        opt.append(name, hint);
        return opt;
      }),
    );
  }

  private complete(i: number): void {
    const c = this.matches[i];
    if (!c) return;
    this.ta.value = completion(c);
    this.ta.setSelectionRange(this.ta.value.length, this.ta.value.length);
    this.ta.focus();
    this.update();
  }

  private key(e: KeyboardEvent): void {
    if (e.isComposing) return;
    if (this.open()) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const n = this.matches.length;
        this.sel = (this.sel + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
        this.update();
        return;
      }
      if (e.key === "Tab" && !e.shiftKey) {
        e.preventDefault();
        this.complete(this.sel);
        return;
      }
      if (e.key === "Enter" && !e.shiftKey && this.ta.value !== `/${this.matches[this.sel]?.name}`) {
        e.preventDefault();
        this.complete(this.sel);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        this.dismissed = true;
        this.update();
        return;
      }
    }
    if (e.key === "Escape") {
      if (this.ta.value !== "") {
        e.stopPropagation();
        this.clear();
      } else this.hooks.escape();
      return;
    }
    if (e.key !== "Enter" || e.shiftKey) return;
    e.preventDefault();
    const text = this.ta.value.trim();
    if (!text) return;
    const cmd = parseCommand(text);
    this.clear();
    if (cmd?.command.kind === "client") {
      if (cmd.command.name === "log") this.hooks.log();
      else this.note(LATER);
      return;
    }
    this.hooks.line(text);
  }

  private clear(): void {
    this.ta.value = "";
    this.dismissed = false;
    this.update();
    autosize(this.ta);
  }
}
