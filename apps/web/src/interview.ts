// The phone interview: the Room at phone width while the stage is `interview`. The dump is the page (an ordinary
// leaf, saved like any other). The head reads `<slug> · dump` and the button `interview N/6 ▾`, whose menu lists
// the six stages (a pick goes out at once, with no `advance to` line) and `send it`, which shows its confirm line;
// yes makes the authorship call and the Room opens the article leaf. Last in the menu is `publish →`, which saves
// the pages and opens the publish sheet. The sheet over the page holds
// the strip `interview · thesis reader evidence counter uncertainty scar` marked from `covered`, the chat turns,
// and the `>` composer with `send`. The frame follows the visual viewport so the iOS keyboard never hides the
// composer.
import { STAGES, type Stage, TOPICS } from "@sparring/protocol/commands";
import { renderTurns } from "./log.ts";
import { stageLabel } from "./rows.ts";
import type { Line } from "./session.ts";
import { SENDIT_ASK } from "./stage-menu.ts";

/** Phone width: at or below this the Room in `interview` becomes the interview screen. */
export const PHONE_QUERY = "(max-width: 480px)";

/** The strip's topics, each marked when it is in `covered`. */
export function stripTopics(covered: readonly string[] | undefined): { topic: string; on: boolean }[] {
  const have = new Set(covered ?? []);
  return TOPICS.map((topic) => ({ topic, on: have.has(topic) }));
}

/** True when every topic has been noted: the interview is done. */
export function interviewDone(covered: readonly string[] | undefined): boolean {
  return stripTopics(covered).every((t) => t.on);
}

/** The strip: `interview · ` then the six topics, in text colour when covered, muted otherwise. */
export function renderStrip(el: HTMLElement, covered: readonly string[] | undefined): void {
  const head = document.createElement("span");
  head.textContent = "interview";
  const dot = document.createElement("span");
  dot.textContent = "·";
  dot.setAttribute("aria-hidden", "true");
  const topics = stripTopics(covered).map(({ topic, on }) => {
    const s = document.createElement("span");
    s.className = on ? "text" : "muted";
    s.dataset.topic = topic;
    s.textContent = topic;
    if (on) s.setAttribute("aria-label", `${topic}, covered`);
    return s;
  });
  el.replaceChildren(head, dot, ...topics);
}

export interface InterviewState {
  slug: string;
  stage: string;
  covered: readonly string[];
  offline: boolean;
  lines: readonly Line[];
}

export interface InterviewEls {
  root: HTMLElement;
  title: HTMLElement;
  stageBtn: HTMLButtonElement;
  stageWord: HTMLElement;
  menu: HTMLElement;
  stages: HTMLElement;
  sendit: HTMLButtonElement;
  senditLine: HTMLElement;
  publish: HTMLButtonElement;
  menuError: HTMLElement;
  topics: HTMLElement;
  sheet: HTMLElement;
  sheetBtn: HTMLButtonElement;
  sheetBody: HTMLElement;
  thread: HTMLElement;
}

export class InterviewScreen {
  private state: InterviewState = { slug: "", stage: "", covered: [], offline: false, lines: [] };
  private shown = "";
  private menuOpen = false;

  constructor(
    private readonly els: InterviewEls,
    /** Sends the stage change; returns an error in words, or null when it went out. */
    private readonly pick: (stage: Stage) => string | null,
    /** `send it`, confirmed: makes the authorship call; resolves with an error in words, or null. */
    private readonly sendIt: () => Promise<string | null> = async () => "not available here",
    /** `publish →`: saves the pages and opens the publish sheet; resolves with an error in words when it could not. */
    private readonly publish: () => Promise<string | null> = async () => "not available here",
  ) {
    els.stageBtn.addEventListener("click", () => (this.menuOpen ? this.close() : this.open()));
    els.stages.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>("[data-stage]");
      if (b) this.choose(b.dataset.stage as Stage);
    });
    els.sendit.addEventListener("click", () => this.confirmSendit(els.senditLine.hidden !== false));
    els.senditLine.addEventListener("click", (e) => {
      const act = (e.target as HTMLElement).closest<HTMLElement>("[data-act]")?.dataset.act;
      if (act === "no") {
        this.confirmSendit(false);
        els.sendit.focus();
      } else if (act === "yes") void this.yes();
    });
    els.publish.addEventListener("click", () => void this.openPublish());
    document.addEventListener(
      "click",
      (e) => {
        if (!this.menuOpen) return;
        const t = e.target as Node;
        if (els.menu.contains(t) || els.stageBtn.contains(t)) return;
        this.close(false);
      },
      true,
    );
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.menuOpen) {
        e.preventDefault();
        this.close();
      }
    });
    els.sheetBtn.addEventListener("click", () => this.fold(els.sheetBody.hidden !== true));

    const vv = typeof window !== "undefined" ? window.visualViewport : null;
    if (vv) {
      vv.addEventListener("resize", this.fit);
      vv.addEventListener("scroll", this.fit);
    }
  }

  get visible(): boolean {
    return !this.els.root.hidden;
  }

  /** Shows or hides the screen. */
  show(on: boolean): void {
    if (on === this.visible) return;
    this.els.root.hidden = !on;
    document.documentElement.classList.toggle("iv-on", on);
    if (!on) this.close(false);
    else {
      this.fit();
      this.draw(true);
      this.els.thread.scrollTop = this.els.thread.scrollHeight;
    }
  }

  set(state: InterviewState): void {
    this.state = state;
    if (this.visible) this.draw(false);
  }

  /** `/sendit` from the interview's composer: the menu opens on the confirm line. */
  openSendit(): void {
    if (!this.menuOpen) this.open();
    this.confirmSendit(true);
  }

  /** Folds the sheet to its strip so the dump can be read and edited, or opens it again. */
  fold(folded: boolean): void {
    this.els.sheetBody.hidden = folded;
    this.els.sheet.classList.toggle("folded", folded);
    this.els.sheetBtn.textContent = folded ? "▴" : "▾";
    this.els.sheetBtn.setAttribute("aria-expanded", String(!folded));
    this.els.sheetBtn.setAttribute("aria-label", folded ? "Open the interview" : "Fold the interview");
    if (!folded) this.els.thread.scrollTop = this.els.thread.scrollHeight;
  }

  /** Keeps the frame inside the visual viewport, so the keyboard shrinks it instead of covering the composer. */
  private readonly fit = (): void => {
    const vv = window.visualViewport;
    if (!vv || !this.visible) return;
    const t = this.els.thread;
    const atBottom = t.scrollHeight - t.scrollTop - t.clientHeight < 24;
    this.els.root.style.setProperty("--vvh", `${Math.round(vv.height)}px`);
    this.els.root.style.setProperty("--vvt", `${Math.round(vv.offsetTop)}px`);
    if (atBottom) t.scrollTop = t.scrollHeight;
  };

  private draw(force: boolean): void {
    const s = this.state;
    const key = JSON.stringify([s.slug, s.stage, s.covered, s.offline, this.menuOpen]);
    if (force || key !== this.shown) {
      this.shown = key;
      this.els.title.textContent = `${s.slug} · dump`;
      this.els.stageWord.textContent = s.offline ? "offline" : stageLabel("interview", s.covered);
      this.els.stageBtn.classList.toggle("muted", s.offline);
      renderStrip(this.els.topics, s.covered);
      if (this.menuOpen) this.renderMenu();
    }
    renderTurns(this.els.thread, s.lines, interviewDone(s.covered));
  }

  /** Shows or hides the confirm line under `send it`: its words, then `yes · no`. */
  private confirmSendit(on: boolean): void {
    const { sendit, senditLine } = this.els;
    senditLine.hidden = !on;
    sendit.setAttribute("aria-expanded", String(on));
    sendit.classList.toggle("text", on);
    sendit.classList.toggle("muted", !on);
    if (!on) return;
    this.els.menuError.hidden = true;
    const kids: HTMLElement[] = [];
    const say = (text: string) => {
      const s = document.createElement("span");
      s.textContent = text;
      kids.push(s);
    };
    SENDIT_ASK.forEach((w, i) => {
      if (i > 0) say("·");
      say(w);
    });
    // `· yes · no` stays on one row.
    const yn = document.createElement("span");
    yn.className = "yn";
    for (const name of ["yes", "no"]) {
      const dot = document.createElement("span");
      dot.textContent = "·";
      const b = document.createElement("button");
      b.type = "button";
      b.className = "t text";
      b.dataset.act = name;
      b.textContent = name;
      yn.append(dot, b);
    }
    senditLine.replaceChildren(...kids, yn);
    senditLine.querySelector<HTMLElement>('[data-act="yes"]')?.focus();
  }

  private sending = false;
  private async yes(): Promise<void> {
    if (this.sending) return;
    this.sending = true;
    const yes = this.els.senditLine.querySelector<HTMLButtonElement>('[data-act="yes"]');
    if (yes) {
      yes.disabled = true;
      yes.textContent = "sending…";
    }
    const err = await this.sendIt();
    this.sending = false;
    if (err) {
      if (yes) {
        yes.disabled = false;
        yes.textContent = "yes";
      }
      this.els.menuError.textContent = `not started · ${err}`;
      this.els.menuError.hidden = false;
      return;
    }
    this.close(false);
  }

  private async openPublish(): Promise<void> {
    const { publish, menuError } = this.els;
    if (publish.disabled) return;
    this.confirmSendit(false);
    menuError.hidden = true;
    publish.disabled = true;
    publish.textContent = "saving…";
    const err = await this.publish();
    publish.disabled = false;
    publish.textContent = "publish →";
    if (!err) return; // the publish sheet is opening
    menuError.textContent = `not opened · ${err}`;
    menuError.hidden = false;
  }

  private open(): void {
    this.menuOpen = true;
    this.els.menuError.hidden = true;
    this.confirmSendit(false);
    this.renderMenu();
    this.els.menu.hidden = false;
    this.els.stageBtn.setAttribute("aria-expanded", "true");
    this.els.stages.querySelector<HTMLElement>('[aria-current="step"]')?.focus();
  }

  private close(focus = true): void {
    if (!this.menuOpen) return;
    this.menuOpen = false;
    this.els.menu.hidden = true;
    this.els.stageBtn.setAttribute("aria-expanded", "false");
    if (focus) this.els.stageBtn.focus();
  }

  private choose(stage: Stage): void {
    if (stage === this.state.stage) {
      this.close();
      return;
    }
    const err = this.pick(stage);
    if (err) {
      this.els.menuError.textContent = `not sent · ${err}`;
      this.els.menuError.hidden = false;
      return;
    }
    this.close(false);
  }

  private renderMenu(): void {
    const items = STAGES.map((s) => {
      const li = document.createElement("li");
      const b = document.createElement("button");
      b.type = "button";
      b.className = `t ${s === this.state.stage ? "text" : "muted"}`;
      b.dataset.stage = s;
      b.textContent = stageLabel(s, this.state.covered);
      if (s === this.state.stage) b.setAttribute("aria-current", "step");
      li.append(b);
      return li;
    });
    this.els.stages.replaceChildren(...items);
  }
}
