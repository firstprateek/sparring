// The stage word in the Room's head and its menu: the six stages (interview with its topics, marked from
// `covered`), then `advance to <stage> · yes · no`. Yes asks the host for the change; the word follows the
// session once the host has taken it. Under the stages sits `send it`, or `coached again` in a drafted article,
// each with its own confirm line; yes makes the authorship call. The two confirm lines never show together.
import { STAGES, type Stage, TOPICS } from "@sparring/protocol/commands";
import { stageLabel } from "./rows.ts";

export const SENDIT_ASK = [
  "the coach writes the draft from dump.md and brief.md",
  "what is on the page moves to the shelf",
];
export const COACHED_ASK = ["discard the coach's draft", "your page comes back from the shelf"];

type Authorship = "coached" | "drafted";
type Pending = { kind: "stage"; stage: Stage } | { kind: "flip" } | null;

export class StageMenu {
  private stage = "";
  private covered: readonly string[] = [];
  private drafting = false;
  private offline = false;
  private authorship: Authorship = "coached";
  private pending: Pending = null;
  private error = "";
  /** The authorship call is out and has not answered. */
  private flipping = false;

  constructor(
    private readonly button: HTMLButtonElement,
    private readonly word: HTMLElement,
    private readonly menu: HTMLElement,
    /** Sends the change; returns an error in words, or null when it went out. */
    private readonly pick: (stage: Stage) => string | null,
    /** Makes the authorship call; resolves with an error in words, or null when the daemon took it. */
    private readonly flip: (to: Authorship) => Promise<string | null> = async () => "not available here",
  ) {
    button.addEventListener("click", () => (this.isOpen() ? this.close() : this.open()));
    menu.addEventListener("click", (e) => void this.click(e));
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

  /** The article's stage as the host has it. While `offline` the word reads `offline`, muted. */
  set(
    stage: string,
    covered: readonly string[] | undefined,
    drafting = false,
    offline = false,
    authorship: Authorship = "coached",
  ): void {
    const same =
      stage === this.stage &&
      drafting === this.drafting &&
      authorship === this.authorship &&
      (covered ?? []).join() === this.covered.join();
    this.stage = stage;
    this.covered = covered ?? [];
    this.drafting = drafting;
    this.offline = offline;
    if (authorship !== this.authorship && this.pending?.kind === "flip") this.pending = null;
    this.authorship = authorship;
    if (this.pending?.kind === "stage" && this.pending.stage === stage) this.pending = null;
    this.word.textContent = this.offline
      ? "offline"
      : drafting
        ? "drafting…"
        : stage
          ? stageLabel(stage, this.covered)
          : "";
    this.button.classList.toggle("is-offline", this.offline);
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

  /**
   * `/sendit`: the menu opens on the send-it confirm line with focus on `yes`. In a drafted article it opens with
   * focus on `coached again` and no confirm line.
   */
  openSendit(): void {
    this.open();
    if (this.authorship === "drafted" || this.drafting) {
      this.menu.querySelector<HTMLElement>("[data-flip]")?.focus();
      return;
    }
    this.pending = { kind: "flip" };
    this.render();
    this.menu.querySelector<HTMLElement>('[data-act="yes"]')?.focus();
  }

  close(focus = true): void {
    this.menu.hidden = true;
    this.pending = null;
    this.error = "";
    this.button.setAttribute("aria-expanded", "false");
    if (focus) this.button.focus();
  }

  private async click(e: Event): Promise<void> {
    const t = e.target as HTMLElement;
    const pick = t.closest<HTMLElement>("[data-stage]");
    if (pick) {
      const s = pick.dataset.stage as Stage;
      this.pending = s === this.stage ? null : { kind: "stage", stage: s };
      this.error = "";
      this.render();
      this.menu
        .querySelector<HTMLElement>(this.pending ? '[data-act="yes"]' : `[data-stage="${s}"]`)
        ?.focus();
      return;
    }
    if (t.closest("[data-flip]")) {
      if (this.drafting) return;
      this.pending = this.pending?.kind === "flip" ? null : { kind: "flip" };
      this.error = "";
      this.render();
      this.menu.querySelector<HTMLElement>(this.pending ? '[data-act="yes"]' : "[data-flip]")?.focus();
      return;
    }
    const act = t.closest<HTMLElement>("[data-act]")?.dataset.act;
    if (act === "yes" && this.pending?.kind === "stage") {
      const err = this.pick(this.pending.stage);
      if (err) {
        this.error = err;
        this.render();
      } else this.close();
    } else if (act === "yes" && this.pending?.kind === "flip" && !this.flipping) {
      this.flipping = true;
      this.error = "";
      this.render();
      const err = await this.flip(this.authorship === "drafted" ? "coached" : "drafted");
      this.flipping = false;
      if (err) {
        this.error = err;
        if (this.isOpen()) this.render();
      } else if (this.isOpen()) this.close(false);
    } else if (act === "no") {
      const wasFlip = this.pending?.kind === "flip";
      this.pending = null;
      this.error = "";
      this.render();
      this.menu.querySelector<HTMLElement>(wasFlip ? "[data-flip]" : `[data-stage="${this.stage}"]`)?.focus();
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
    if (this.pending?.kind === "stage")
      kids.push(this.confirm([`advance to ${this.pending.stage}`], "not sent"));

    const flip = document.createElement("button");
    flip.type = "button";
    flip.className = `t it flip ${this.pending?.kind === "flip" ? "text" : "muted"}`;
    flip.dataset.flip = "1";
    flip.textContent = this.drafting
      ? "drafting…"
      : this.authorship === "drafted"
        ? "coached again"
        : "send it";
    flip.disabled = this.drafting;
    flip.setAttribute("aria-expanded", String(this.pending?.kind === "flip"));
    kids.push(flip);
    if (this.pending?.kind === "flip")
      kids.push(
        this.confirm(
          this.authorship === "drafted" ? COACHED_ASK : SENDIT_ASK,
          this.authorship === "drafted" ? "not changed" : "not started",
        ),
      );
    this.menu.replaceChildren(...kids);
  }

  /** A confirm line: its words, `yes · no`, and under it in red why the last yes did not go through. */
  private confirm(words: readonly string[], failed: string): HTMLElement {
    const pend = document.createElement("div");
    // A long line reads as running text, so no `·` is left alone at the start of a row.
    pend.className = words.length > 1 ? "muted pend flow" : "muted pend";
    for (const w of words) {
      const ask = document.createElement("span");
      ask.textContent = w;
      pend.append(ask, dot());
    }
    const yes = act("yes");
    yes.disabled = this.flipping;
    if (this.flipping) yes.textContent = "sending…";
    // `· yes · no` stays on one row.
    const yn = document.createElement("span");
    yn.className = "yn";
    pend.lastElementChild?.remove();
    yn.append(dot(), yes, dot(), act("no"));
    pend.append(yn);
    if (this.error) {
      const err = document.createElement("span");
      err.className = "err";
      err.setAttribute("role", "alert");
      err.textContent = `${failed} · ${this.error}`;
      pend.append(err);
    }
    return pend;
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
