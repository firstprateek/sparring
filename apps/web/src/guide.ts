// The guide: a tutorial card that walks the writer from an idea to a finished article in the real app. Each step
// says what to do and points at the control; steps that can be checked (an idea kept, 100 words dumped, the
// interview covered, an outline's headings, a critique's notes on the page, a pass that ran, the Tells table
// opened, a draft sent for, a pull request opened) move on by themselves once done. Where the writer is
// in the guide is kept in localStorage, so it follows them from Articles into a Room and on to the publish page;
// it is a convenience only.
import type { FileName } from "./api.ts";

/** The screens a guide card stands on. */
export type GuideWhere = "articles" | "room" | "publish";

export interface GuideFacts {
  where: GuideWhere;
  ideas?: number;
  leaf?: FileName;
  dumpWords?: number;
  articleWords?: number;
  stage?: string;
  covered?: number;
  /** Lines the writer has sent to the coach in this article. */
  said?: number;
  /** Notes the coach has left on the article. */
  notes?: number;
  /** `##` headings on the article page. */
  headings?: number;
  /** Named passes that have run: their notes, and their results in the letter. */
  passes?: number;
  /** The article is drafted: the coach wrote its draft. */
  drafted?: boolean;
  /** The writer has opened the Tells table. */
  tells?: boolean;
  /** The article has a pull request on the site. */
  pr?: boolean;
}

export interface Step {
  title: string;
  body: string;
  where: "articles" | "room" | "any";
  /** CSS selector of the control to point at. */
  target?: string;
  /** Set when the step is also done on the publish page: what to point at there, and what the card says there. */
  publish?: { target: string; body: string };
  done?: (f: GuideFacts) => boolean;
  /** Not built yet: the step only explains what is coming. */
  later?: boolean;
}

export const STEPS: readonly Step[] = [
  {
    title: "Catch an idea",
    body: "Type a one-line idea in the field at the top and press Enter. It waits in the inbox until you want to write about it.",
    where: "articles",
    target: "#idea",
    done: (f) => (f.ideas ?? 0) > 0,
  },
  {
    title: "Turn it into an article",
    body: "Click → article next to the idea. Sparring suggests a name made of lowercase words and hyphens; it becomes the article's folder and URL. Then click create article.",
    where: "articles",
    target: ".inbox .go, .inbox .slug .primary",
    done: (f) => f.where === "room",
  },
  {
    title: "Three pages, one coach",
    body: "Every article has three pages: dump, brief and article. The tabs switch the page. The coach panel beside it (below it on a narrow screen) stays the same on every tab, and so does its message box.",
    where: "room",
    target: ".tabs, .coach",
  },
  {
    title: "Dump everything",
    body: "On dump, write everything you think about the idea, in any order. Fragments and lists are fine; a blank line starts a new block. It saves as you type. Aim for about 100 words.",
    where: "room",
    target: '[data-leaf="dump"], #paras',
    done: (f) => (f.dumpWords ?? 0) >= 100,
  },
  {
    title: "Talk it through",
    body: "In the ideas stage, say anything to the coach: type in the coach panel's box and press Enter. It quotes the threads in your dump back to you and asks which one you mean.",
    where: "room",
    target: "#composer",
    done: (f) => (f.said ?? 0) > 0,
  },
  {
    title: "Start the interview",
    body: "Open the stage menu at the top right, pick interview and confirm with yes. From now on the coach asks the questions.",
    where: "room",
    target: "#stage-btn",
    done: (f) => f.stage === "interview" || (f.covered ?? 0) > 0,
  },
  {
    title: "Answer six questions",
    body: "The coach asks about six things, one at a time: thesis, reader, evidence, counter (the best argument against you), uncertainty and scar (what taught you this). The coach panel counts them. Answer in your own words; the coach quotes you and never rewrites you.",
    where: "room",
    target: "#composer, #coach-stage",
    done: (f) => (f.covered ?? 0) >= 6,
  },
  {
    title: "Read the brief",
    body: "Open brief. It says what the article is for, built from your answers, with the lines it quoted from your dump listed underneath. A ? beside a dump paragraph means it was quoted. The brief is yours to edit.",
    where: "room",
    target: '[data-leaf="brief"]',
    done: (f) => f.leaf === "brief",
  },
  {
    title: "Outline it",
    body: "Pick outline from the stage menu. On article, type a ## heading for each section with a one-line note under it, then say anything to the coach. It checks the outline against your brief and asks about the weakest section. It never proposes a heading. The guide moves on at two headings.",
    where: "room",
    target: '#stage-btn, [data-leaf="article"]',
    done: (f) => (f.headings ?? 0) >= 2,
  },
  {
    title: "Write the article",
    body: "Pick draft from the stage menu and write the piece yourself; the coach cannot edit this page. /next names the section to write, and when you say done it leaves up to five notes on it. /ask and a question parks it at the paragraph your cursor is in. Cmd+S saves a version to git. The guide moves on at 150 words.",
    where: "room",
    target: '[data-leaf="article"], #composer',
    done: (f) => (f.articleWords ?? 0) >= 150,
  },
  {
    title: "Get critiqued",
    body: "Type /critique in the coach panel's box and press Enter. The coach reads the whole article and leaves up to ten notes, each tied to an exact phrase; a bar marks the paragraph. Change the text and click done, or disagree, or dismiss. /reader has the coach read as the reader your brief describes.",
    where: "room",
    target: "#composer, #notes, #notes-btn",
    done: (f) => (f.notes ?? 0) > 0,
  },
  {
    title: "Polish",
    body: "Pick polish from the stage menu and type /pass filler. A pass looks for one kind of problem and leaves notes, or says nothing in this pass. /queue filler repeats cut runs several, also with this page closed; the results wait here. /strict every nit makes passes pickier, and /quiet folds the notes away.",
    where: "room",
    target: "#composer, #notes, #letter",
    done: (f) => (f.passes ?? 0) > 0,
  },
  {
    title: "Count the tells",
    body: "Under the article, em, ¶1 and not-x-but-y count three habits that read as machine-written: em-dashes, one-sentence paragraphs and it's not X, it's Y. Click a count to open the Tells table and jump to each one. They are counts, not verdicts. Pasting is allowed, and words pasted from the coach keep a dotted underline until you rewrite them; pasted counts them.",
    where: "room",
    target: '#tells-foot, [data-leaf="article"]',
    done: (f) => f.tells === true,
  },
  {
    title: "Stuck? Send it",
    body: "Optional. Pick send it in the stage menu, or type /sendit, and confirm with yes: the coach writes one draft from your dump and brief, and your page moves to the shelf. A dotted bar marks each block it wrote until you rewrite it. coached again puts your page back. Skip this to write every word yourself.",
    where: "room",
    target: "#stage-btn, #composer",
    done: (f) => f.drafted === true,
  },
  {
    title: "Publish",
    body: "Open the stage menu and pick publish →, or type /publish. The sheet asks for a title, a one-sentence description and a date, then three questions whose answers are stored and never published. Tick I chose these words for each run of the coach's words still in the text, or rewrite it. build and open PR builds the site with your post and opens a pull request; merging it is your click. The guide moves on when the PR is open.",
    where: "room",
    target: "#stage-btn, #composer, #pr-link",
    publish: {
      target: ".ship-btn",
      body: "This is the publish sheet. Fill in the title, a one-sentence description and the date, then answer the three questions; the answers are stored and never published. Tick I chose these words for each run of the coach's words still in the text, or go back and rewrite it. A line in red says what is missing. build and open PR builds the site with your post and opens a pull request; merging it is your click. The guide moves on when the PR is open.",
    },
    done: (f) => f.pr === true,
  },
  {
    title: "That is the loop",
    body: "Idea → dump → interview → brief → outline → draft → critique → polish → publish. Open this guide again any time with guide at the top of the screen.",
    where: "any",
  },
];

export interface GuideState {
  open: boolean;
  step: number;
  /** Set once the guide has been offered, so it opens by itself only the first time. */
  seen: boolean;
  small: boolean;
}

const KEY = "sparring-guide";

export function loadState(): GuideState {
  const fresh: GuideState = { open: false, step: 0, seen: false, small: false };
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return fresh;
    const s = JSON.parse(raw) as Partial<GuideState>;
    const step = Number.isInteger(s.step) ? Math.min(Math.max(0, s.step as number), STEPS.length - 1) : 0;
    return { open: s.open === true, step, seen: s.seen === true, small: s.small === true };
  } catch {
    return fresh;
  }
}

function saveState(s: GuideState): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // The guide then starts over on the next page; nothing else depends on it.
  }
}

/** The step to show for these facts: past every step here that is already done. Returns the step and what it passed. */
export function advance(step: number, f: GuideFacts): { step: number; passed: string | null } {
  let passed: string | null = null;
  let at = step;
  while (at < STEPS.length - 1) {
    // A check can pass from either screen: creating the article is seen from the Room it opens.
    const s = STEPS[at] as Step;
    if (!s.done?.(f)) break;
    passed = s.title;
    at++;
  }
  return { step: at, passed };
}

export class Guide {
  private state = loadState();
  private facts: GuideFacts | null = null;
  private passed: string | null = null;
  private readonly card: HTMLElement;
  private targets: Element[] = [];
  private factsKey = "";

  /** The card goes in `slot`, in the page's flow, so it pushes the page down and never covers a control. */
  constructor(
    private readonly where: GuideWhere,
    button: HTMLButtonElement | null,
    slot: HTMLElement = document.body,
    /** The article's Room, for a card on the publish page whose step is done there. */
    private readonly roomHref = "",
  ) {
    this.card = document.createElement("aside");
    this.card.className = "guide";
    this.card.setAttribute("aria-label", "Guide");
    this.card.setAttribute("aria-live", "polite");
    slot.append(this.card);
    button?.addEventListener("click", () => {
      this.set({ open: !this.state.open || this.state.small, small: false });
    });
    if (!this.state.seen) this.set({ open: true, seen: true });
    window.addEventListener("storage", (e) => {
      if (e.key !== KEY) return;
      this.state = loadState();
      this.draw();
    });
    this.draw();
  }

  /** New facts from the page: may finish the current step. */
  update(f: GuideFacts): void {
    const key = JSON.stringify(f);
    if (key === this.factsKey) return;
    this.factsKey = key;
    this.facts = f;
    if (this.state.open) {
      const { step, passed } = advance(this.state.step, f);
      if (step !== this.state.step) {
        this.passed = passed;
        this.set({ step });
        return;
      }
    }
    this.draw();
  }

  /** Points at the step's control again, after the page redrew it. */
  retarget(): void {
    const s = STEPS[this.state.step] as Step;
    const target = this.targetOf(s);
    if (!this.state.open || this.state.small || !target || !this.here(s)) return;
    for (const t of this.targets) t.classList.remove("guide-target");
    this.targets = [...document.querySelectorAll(target)];
    for (const t of this.targets) t.classList.add("guide-target");
  }

  /** Whether the step is done on this screen. */
  private here(s: Step): boolean {
    if (this.where === "publish") return s.where === "any" || s.publish !== undefined;
    return s.where === "any" || s.where === this.where;
  }

  private targetOf(s: Step): string | undefined {
    return this.where === "publish" ? s.publish?.target : s.target;
  }

  private set(patch: Partial<GuideState>): void {
    this.state = { ...this.state, ...patch };
    saveState(this.state);
    if (patch.open !== undefined || patch.step !== undefined) {
      // A step that is already done (the writer did it before opening the guide) is passed at once.
      if (this.state.open && this.facts) {
        const { step, passed } = advance(this.state.step, this.facts);
        if (step !== this.state.step) {
          this.passed = passed;
          this.state = { ...this.state, step };
          saveState(this.state);
        }
      }
    }
    this.draw();
  }

  private go(step: number): void {
    this.passed = null;
    this.state = { ...this.state, step: Math.min(Math.max(0, step), STEPS.length - 1) };
    saveState(this.state);
    this.draw();
  }

  private draw(): void {
    for (const t of this.targets) t.classList.remove("guide-target");
    this.targets = [];
    const { open, step, small } = this.state;
    this.card.hidden = !open;
    if (!open) return;
    const s = STEPS[step] as Step;
    const n = `${step + 1} of ${STEPS.length}`;
    this.card.classList.toggle("small", small);
    if (small) {
      const pill = this.btn(`guide · ${n} · ${s.title}`, "t pill-btn", () => this.set({ small: false }));
      this.card.replaceChildren(pill);
      return;
    }

    const head = el("div", "g-head mono");
    head.append(
      el("span", "", `guide · ${n}`),
      ...(this.passed ? [el("span", "g-passed", `✓ ${this.passed}`)] : []),
      el("span", "g-fill"),
      this.btn("hide", "t g-x", () => this.set({ small: true })),
      this.btn("close", "t g-x", () => this.set({ open: false })),
    );
    const kids: HTMLElement[] = [head];
    const title = el("h2", "g-title", s.title);
    if (s.later) title.append(el("span", "g-tag mono", "not built yet"));
    kids.push(title, el("p", "g-body", (this.where === "publish" && s.publish?.body) || s.body));

    const elsewhere = !this.here(s);
    if (elsewhere) {
      const p = el("p", "g-where mono");
      if (s.where === "articles") {
        p.append("this step is on the Articles screen · ");
        const a = el("a", "g-link", "go to Articles") as HTMLAnchorElement;
        a.href = "/";
        p.append(a);
      } else if (this.where === "publish" && this.roomHref) {
        p.append("this step is in the article · ");
        const a = el("a", "g-link", "back to the article") as HTMLAnchorElement;
        a.href = this.roomHref;
        p.append(a);
      } else p.append("open an article to do this step");
      kids.push(p);
    }

    const nav = el("div", "g-nav");
    if (step > 0) nav.append(this.btn("back", "btn", () => this.go(step - 1)));
    const last = step === STEPS.length - 1;
    const checked = !!s.done && !s.later;
    if (last) nav.append(this.btn("finish", "btn primary", () => this.set({ open: false, step: 0 })));
    else
      nav.append(
        this.btn(checked ? "skip" : "next", checked ? "btn" : "btn primary", () => this.go(step + 1)),
      );
    if (checked) nav.append(el("span", "g-wait mono", "moves on when you have done it"));
    kids.push(nav);
    this.card.replaceChildren(...kids);

    const target = this.targetOf(s);
    if (target && !elsewhere) {
      this.targets = [...document.querySelectorAll(target)];
      for (const t of this.targets) t.classList.add("guide-target");
    }
  }

  private btn(text: string, cls: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.className = cls;
    b.textContent = text;
    b.addEventListener("click", onClick);
    return b;
  }
}

function el(tag: string, cls: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
