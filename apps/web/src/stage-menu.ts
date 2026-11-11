// The stage word in the Room's head and its menu: the six stages (interview with its topics, marked from
// `covered`), then `advance to <stage> · yes · no`. Yes asks the host for the change; the word follows the
// session once the host has taken it.
import { STAGES, type Stage, TOPICS } from "@sparring/protocol/commands";
import { stageLabel } from "./rows.ts";

export class StageMenu {
  private stage = "";
  private covered: readonly string[] = [];
  private drafting = false;
  private pending: Stage | null = null;
  private error = "";

  constructor(
    private readonly button: HTMLButtonElement,
    private readonly word: HTMLElement,
    private readonly menu: HTMLElement,
    /** Sends the change; returns an error in words, or null when it went out. */
    private readonly pick: (stage: Stage) => string | null,
  ) {
    button.addEventListener("click", () => (this.isOpen() ? this.close() : this.open()));
    menu.addEventListener("click", (e) => this.click(e));
    document.addEventListener(
      "click",
      (e) => {
        if (!this.isOpen()) return;
        const t = e.target as Node;
        if (menu.contains(t) || button.contains(t)) return;
        this.close(false);
      },
      true,
    );
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || !this.isOpen()) return;
      this.close();
    });
  }

  /** The article's stage as the host has it. */
  set(stage: string, covered: readonly string[] | undefined, drafting = false): void {
    const same =
      stage === this.stage && drafting === this.drafting && (covered ?? []).join() === this.covered.join();
    this.stage = stage;
    this.covered = covered ?? [];
    this.drafting = drafting;
    if (this.pending === stage) this.pending = null;
    this.word.textContent = drafting ? "drafting…" : stage ? stageLabel(stage, this.covered) : "";
    if (!same && this.isOpen()) this.render();
  }

  isOpen(): boolean {
    return !this.menu.hidden;
  }

  open(): void {
    this.pending = null;
    this.error = "";
    this.render();
    this.menu.hidden = false;
    this.button.setAttribute("aria-expanded", "true");
    this.menu.querySelector<HTMLElement>(`[data-stage="${this.stage}"]`)?.focus();
  }

  close(focus = true): void {
    this.menu.hidden = true;
    this.pending = null;
    this.error = "";
    this.button.setAttribute("aria-expanded", "false");
    if (focus) this.button.focus();
  }

  private click(e: Event): void {
    const t = e.target as HTMLElement;
    const pick = t.closest<HTMLElement>("[data-stage]");
    if (pick) {
      const s = pick.dataset.stage as Stage;
      this.pending = s === this.stage ? null : s;
      this.error = "";
      this.render();
      this.menu
        .querySelector<HTMLElement>(this.pending ? '[data-act="yes"]' : `[data-stage="${s}"]`)
        ?.focus();
      return;
    }
    const act = t.closest<HTMLElement>("[data-act]")?.dataset.act;
    if (act === "yes" && this.pending) {
      const err = this.pick(this.pending);
      if (err) {
        this.error = err;
        this.render();
      } else this.close();
    } else if (act === "no") {
      this.pending = null;
      this.error = "";
      this.render();
      this.menu.querySelector<HTMLElement>(`[data-stage="${this.stage}"]`)?.focus();
    }
  }

  private render(): void {
    const kids: HTMLElement[] = [];
    for (const s of STAGES) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = `t it ${s === this.stage ? "text" : "muted"}`;
      b.dataset.stage = s;
      b.textContent = stageLabel(s, this.covered);
      if (s === this.stage) b.setAttribute("aria-current", "true");
      kids.push(b);
      if (s === "interview") {
        const topics = document.createElement("div");
        topics.className = "topics";
        for (const topic of TOPICS) {
          const span = document.createElement("span");
          span.className = this.covered.includes(topic) ? "text" : "muted";
          span.textContent = topic;
          topics.append(span);
        }
        kids.push(topics);
      }
    }
    if (this.pending) {
      const pend = document.createElement("div");
      pend.className = "muted pend";
      const ask = document.createElement("span");
      ask.textContent = `advance to ${this.pending}`;
      pend.append(ask, dot(), act("yes"), dot(), act("no"));
      if (this.error) {
        const err = document.createElement("span");
        err.textContent = `not sent · ${this.error}`;
        pend.append(err);
      }
      kids.push(pend);
    }
    this.menu.replaceChildren(...kids);
  }
}

function dot(): HTMLSpanElement {
  const s = document.createElement("span");
  s.textContent = "·";
  return s;
}

function act(name: "yes" | "no"): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "t text";
  b.dataset.act = name;
  b.textContent = name;
  return b;
}
