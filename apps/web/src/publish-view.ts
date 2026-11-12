// The publish sheet (design section 6, "Publish"): everything it shows comes from the preflight. Top to bottom:
// what is missing when publishing is not set up (in red), the fields, the three questions, the provenance group
// with its ticks, the checks, the button with its reason, and the job's log. The fields are built once so typing
// is never interrupted; the groups under them are redrawn when a new preflight or a new job state arrives.
import { splitBlocks } from "@sparring/protocol/blocks";
import { blockHash, countsLine } from "@sparring/protocol/provenance";
import {
  blockers,
  jobRunning,
  type PostMeta,
  type Preflight,
  type PublishJob,
  QUESTIONS,
  TICK_LABEL,
  unticked,
} from "@sparring/protocol/publish";
import { tagText, yoursLine } from "./drafted.ts";

export interface SheetHooks {
  /** Stores the fields, then answers the preflight that follows, or an error in words. */
  saveMeta(meta: PostMeta): Promise<Preflight | string>;
  /** Starts the job. Answers null when it started, else why not, with the fresh preflight when the daemon sent one. */
  ship(ticked: string[]): Promise<null | { error: string; preflight?: Preflight }>;
  /** The browser's local date, `YYYY-MM-DD`. */
  today(): string;
  /** The ticks changed: kept for this tab. */
  ticksChanged?(ticked: string[]): void;
}

export interface ShipState {
  label: string;
  disabled: boolean;
  /** `disabled: 1 span unticked`, or "". */
  reason: string;
}

/** The button: its words, whether it can be pressed, and why not. */
export function shipState(
  p: Preflight,
  job: PublishJob | null,
  ticked: readonly string[],
  busy: "" | "saving" | "starting" | "settling" = "",
): ShipState {
  if (jobRunning(job) || busy === "starting") return { label: "building…", disabled: true, reason: "" };
  // The job just ended and the preflight that knows its PR is on its way.
  if (busy === "settling")
    return {
      label: job?.step === "failed" ? "build failed" : "built",
      disabled: true,
      reason: "reading the site again…",
    };
  // The commit on screen is the one already published: there is nothing new to send.
  if (p.pr && p.published_commit === p.article_commit)
    return {
      label: `PR #${p.pr.number} ${p.pr.state === "open" ? "is open" : p.pr.state === "merged" ? "is merged" : "was closed"}`,
      disabled: true,
      reason: "",
    };
  const label =
    p.pr?.state === "open" && p.kind === "update_open"
      ? `build and update PR #${p.pr.number}`
      : "build and open PR";
  const why = blockers(p, ticked);
  if (why.length > 0)
    return {
      label,
      disabled: true,
      reason: `disabled: ${why[0]}${why.length > 1 ? ` · and ${why.length - 1} more` : ""}`,
    };
  if (busy === "saving") return { label, disabled: true, reason: "saving the fields…" };
  return { label, disabled: false, reason: "" };
}

/** How a log line is drawn: a link, a result, a failure, a command's output, or a command. */
export function logLineKind(text: string): "link" | "ok" | "bad" | "out" | "cmd" {
  if (/^https?:\/\//.test(text)) return "link";
  if (text.startsWith("✓")) return "ok";
  if (text.startsWith("✗")) return "bad";
  if (text.startsWith("  ")) return "out";
  return "cmd";
}

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

/**
 * The read-only page: the front matter as the file has it, then the body block by block. In a drafted article a
 * block the coach wrote keeps its dotted bar, and an edited one its muted bar.
 */
export function renderPost(front: HTMLElement, body: HTMLElement, p: Preflight): void {
  const m = /^---\n([\s\S]*?)\n---\n\n?([\s\S]*)$/.exec(p.post);
  front.textContent = m ? `---\n${m[1]}\n---` : "";
  const state = new Map(p.blocks.map((b) => [b.hash, b.state]));
  const kids: HTMLElement[] = [];
  for (const block of splitBlocks(m ? (m[2] as string) : p.post)) {
    if (block.trim() === "") continue;
    const heading = /^(#{2,6}) /.exec(block);
    const node = el(heading ? "h2" : "p", heading ? "blk hd" : "blk", block);
    const st = p.authorship === "drafted" ? state.get(blockHash(block)) : undefined;
    if (st === "coach" || st === "edited") {
      const bar = el("span", st === "edited" ? "prov mixed" : "prov");
      bar.setAttribute("aria-hidden", "true");
      node.append(bar);
      node.setAttribute(
        "aria-description",
        st === "edited" ? "written by the coach, edited by you" : "written by the coach",
      );
    }
    kids.push(node);
  }
  if (kids.length === 0) kids.push(el("p", "help", "article.md is empty."));
  body.replaceChildren(...kids);
}

export class PublishSheet {
  private p: Preflight | null = null;
  private job: PublishJob | null = null;
  private ticked = new Set<string>();
  private busy: "" | "saving" | "starting" | "settling" = "";
  private error = "";
  private fieldError = "";
  private diffOpen = false;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private dirty = false;
  private saving: Promise<void> | null = null;

  private readonly top = el("div", "top");
  private readonly setup = el("div", "setup err");
  private readonly fields = el("div", "grp kv");
  private readonly questions = el("div", "grp");
  private readonly prov = el("div", "grp");
  private readonly checks = el("div", "grp");
  private readonly ship = el("div", "grp ship");
  private readonly log = el("div", "log");
  private readonly title = el("input", "v");
  private readonly desc = el("textarea", "v");
  private readonly date = el("input", "v");
  private readonly answers = QUESTIONS.map(() => el("input", "v ans"));
  private readonly fieldErr = el("span", "err field-err");
  private readonly btn = el("button", "btn primary ship-btn");
  private readonly reason = el("span", "reason");
  private readonly shipErr = el("span", "err ship-err");
  private built = false;

  constructor(
    private readonly root: HTMLElement,
    private readonly hooks: SheetHooks,
    ticked: readonly string[] = [],
    /** How long after the last keystroke the fields are stored (ms). */
    private readonly saveAfterMs = 700,
  ) {
    for (const h of ticked) this.ticked.add(h);
    this.log.setAttribute("aria-live", "polite");
    this.setup.setAttribute("role", "alert");
    this.fieldErr.setAttribute("role", "alert");
    this.shipErr.setAttribute("role", "alert");
    this.btn.type = "button";
    this.btn.addEventListener("click", () => void this.onShip());
    this.prov.addEventListener("change", (e) => this.onTick(e));
    this.prov.addEventListener("click", (e) => {
      if (!(e.target as HTMLElement).closest("[data-tick-all]")) return;
      for (const h of this.need()) this.ticked.add(h);
      this.hooks.ticksChanged?.([...this.ticked]);
      this.renderProv();
      this.renderShip();
    });
    this.checks.addEventListener("click", (e) => {
      if (!(e.target as HTMLElement).closest("[data-diff]")) return;
      this.diffOpen = !this.diffOpen;
      this.renderChecks();
    });
  }

  /** The hashes a publish needs a tick for, in the order the sheet lists them. */
  private need(): string[] {
    const p = this.p;
    if (!p) return [];
    return p.authorship === "drafted"
      ? p.blocks.filter((b) => b.state === "coach").map((b) => b.hash)
      : p.spans.map((s) => s.hash);
  }

  get tickedList(): string[] {
    return [...this.ticked];
  }

  /** A new preflight: the groups are redrawn; a field keeps what is typed in it while it has the caret. */
  set(p: Preflight): void {
    const first = this.p === null;
    this.p = p;
    if (this.busy === "settling") this.busy = "";
    if (this.job === null || (p.publish && p.publish.id >= this.job.id)) this.job = p.publish;
    if (!this.built) this.build();
    if (first) {
      this.fill(p.meta, true);
      // The date is the publish date, filled from the browser's local date.
      if (!p.meta.date.trim()) {
        this.date.value = this.hooks.today();
        this.changed();
        void this.flush();
      }
    } else if (!this.dirty) this.fill(p.meta, false);
    this.render();
  }

  /** The job as the session's meta has it, live. Returns true when a job just ended, so the page fetches a preflight. */
  setJob(job: PublishJob | null): boolean {
    if (!job || (this.job && job.id < this.job.id)) return false;
    const was = jobRunning(this.job) || this.busy === "starting";
    const key = JSON.stringify(job);
    if (key === JSON.stringify(this.job)) return false;
    this.job = job;
    if (this.busy === "starting") this.busy = "";
    const ended = was && !jobRunning(job);
    if (ended) this.busy = "settling";
    if (this.p) {
      this.renderShip();
      this.renderLog();
      // The log is under the button: while a job moves, its last line is kept on screen.
      if (was || jobRunning(job)) this.log.lastElementChild?.scrollIntoView?.({ block: "nearest" });
    }
    return ended;
  }

  /** A failure of the page itself (the preflight did not load), in red over the button. */
  fail(text: string): void {
    this.error = text;
    if (this.busy === "settling") this.busy = "";
    if (!this.built) {
      const line = el("p", "err", text);
      line.setAttribute("role", "alert");
      this.root.replaceChildren(line);
      return;
    }
    this.renderShip();
  }

  private fill(m: PostMeta, all: boolean): void {
    const put = (f: HTMLInputElement | HTMLTextAreaElement, v: string) => {
      if (all || document.activeElement !== f) f.value = v;
    };
    put(this.title, m.title);
    put(this.desc, m.description);
    put(this.date, m.date);
    for (const [i, a] of this.answers.entries()) put(a, m.answers[i] ?? "");
    autosize(this.desc);
  }

  private values(): PostMeta {
    return {
      title: this.title.value,
      description: this.desc.value,
      date: this.date.value,
      answers: this.answers.map((a) => a.value) as PostMeta["answers"],
    };
  }

  private build(): void {
    this.built = true;
    const p = this.p as Preflight;
    const label = (text: string, f: HTMLElement, id: string) => {
      const l = el("label", "", text);
      l.htmlFor = id;
      f.id = id;
      return l;
    };
    this.title.type = "text";
    this.title.placeholder = "the post's title";
    this.title.maxLength = 300;
    this.desc.rows = 2;
    this.desc.placeholder = "one sentence: what the post says";
    this.desc.maxLength = 1000;
    this.date.type = "text";
    this.date.placeholder = "YYYY-MM-DD";
    this.date.inputMode = "numeric";
    this.date.maxLength = 10;
    this.date.autocomplete = "off";
    const slug = el("span", "v ro-v", p.slug);
    slug.title = "The slug was fixed when the article was made. It is the post's address.";
    this.fields.append(
      label("title", this.title, "f-title"),
      this.title,
      el("span", "", "slug"),
      slug,
      label("description", this.desc, "f-desc"),
      this.desc,
      label("date", this.date, "f-date"),
      this.date,
      el("span", "", "draft"),
      el("span", "v ro-v", "false"),
      this.fieldErr,
    );
    this.questions.append(el("span", "", "before you ship, three questions (stored, not published)"));
    QUESTIONS.forEach((q, i) => {
      const a = this.answers[i] as HTMLInputElement;
      a.type = "text";
      a.placeholder = "your answer";
      a.maxLength = 2000;
      a.autocomplete = "off";
      const row = el("div", "q");
      const l = label(q, a, `f-q${i + 1}`);
      l.className = "q-text";
      const line = el("div", "q-a");
      line.append(el("span", "", ">"), a);
      row.append(l, line);
      this.questions.append(row);
    });
    for (const f of [this.title, this.desc, this.date, ...this.answers]) {
      f.addEventListener("input", () => this.changed());
      f.addEventListener("blur", () => void this.flush());
    }
    this.desc.addEventListener("input", () => autosize(this.desc));
    this.ship.append(this.btn, this.reason, this.shipErr);
    this.root.replaceChildren(
      this.top,
      this.setup,
      this.fields,
      this.questions,
      this.prov,
      this.checks,
      this.ship,
      this.log,
    );
    autosize(this.desc);
  }

  /** A field was typed in: stored a moment after the last keystroke. */
  private changed(): void {
    this.dirty = true;
    if (this.busy === "") this.busy = "saving";
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.flush(), this.saveAfterMs);
    this.renderShip();
  }

  /** Stores the fields now, if they wait. */
  async flush(): Promise<void> {
    clearTimeout(this.saveTimer);
    if (this.saving) await this.saving;
    if (!this.dirty) return;
    this.dirty = false;
    this.saving = (async () => {
      const res = await this.hooks.saveMeta(this.values());
      if (typeof res === "string") {
        this.fieldError = `not saved · ${res}`;
        this.dirty = true;
      } else {
        this.fieldError = "";
        this.p = res;
      }
      if (!this.dirty && this.busy === "saving") this.busy = "";
      this.render();
    })();
    await this.saving;
    this.saving = null;
  }

  private onTick(e: Event): void {
    const t = e.target as HTMLInputElement;
    if (t.type !== "checkbox" || !t.dataset.hash) return;
    if (t.checked) this.ticked.add(t.dataset.hash);
    else this.ticked.delete(t.dataset.hash);
    this.hooks.ticksChanged?.([...this.ticked]);
    this.renderShip();
  }

  private async onShip(): Promise<void> {
    if (!this.p || this.btn.disabled) return;
    await this.flush();
    if (this.dirty || !this.p) return;
    if (shipState(this.p, this.job, [...this.ticked]).disabled) {
      this.renderShip();
      return;
    }
    this.busy = "starting";
    this.error = "";
    this.renderShip();
    const res = await this.hooks.ship([...this.ticked]);
    if (res) {
      this.busy = "";
      this.error = `not started · ${res.error}`;
      if (res.preflight) this.set(res.preflight);
      else this.renderShip();
    }
  }

  private render(): void {
    const p = this.p;
    if (!p) return;
    this.top.replaceChildren(
      el("span", "text", "publish"),
      el("span", p.origin.bad ? "err" : "", p.origin.text),
    );
    this.setup.hidden = p.configured;
    this.setup.replaceChildren(
      el("div", "", "publishing is not set up on this machine · nothing can be sent yet"),
      ...p.setup.map((s) => el("div", "", s)),
      el(
        "div",
        "",
        "README.md, section Publishing, lists every step · the gates below show what a publish will ask for",
      ),
    );
    this.fieldErr.textContent = this.fieldError;
    this.renderProv();
    this.renderChecks();
    this.renderShip();
    this.renderLog();
  }

  private tick(hash: string, id: string, ...words: (string | HTMLElement)[]): HTMLLabelElement {
    const l = el("label", "tick");
    l.htmlFor = id;
    const cb = el("input");
    cb.type = "checkbox";
    cb.id = id;
    cb.dataset.hash = hash;
    cb.checked = this.ticked.has(hash);
    const text = el("span", "tick-text");
    text.append(...words, el("br"), el("span", "mono chose", TICK_LABEL));
    l.append(cb, text);
    return l;
  }

  private renderProv(): void {
    const p = this.p as Preflight;
    const c = p.counts;
    const kids: HTMLElement[] = [el("span", "", "provenance")];
    if (p.authorship === "drafted") {
      const rows = p.blocks.filter((b) => b.state === "coach");
      const count = el("span", "sub", "blocks still entirely the coach's words ");
      count.append(el("span", "text", String(rows.length)));
      kids.push(
        el("span", "text", "drafted by the coach · never-write was off for this article"),
        el("span", "text", countsLine({ counts: p.blockCounts })),
        el("span", "text", yoursLine(p.yoursPct)),
        count,
        ...rows.map((b) =>
          this.tick(
            b.hash,
            `f-blk-${b.n}`,
            el("span", "", `¶${b.n} `),
            el("span", "text", `"${b.first_words}"`),
          ),
        ),
      );
      if (rows.length > 1) {
        const all = el("button", "t text tickall", "tick all");
        all.type = "button";
        all.dataset.tickAll = "1";
        kids.push(all);
      }
      if (rows.length === 0) kids.push(el("span", "text", "every block has your words in it"));
    } else {
      const count = el("span", "sub", "agent-word spans in the text ");
      count.append(el("span", "text", String(p.spans.length)));
      kids.push(
        el(
          "span",
          "text",
          `questions asked ${c.questions} · comments ${c.comments} · done ${c.done} · dismissed ${c.dismissed}`,
        ),
        el(
          "span",
          "text",
          `disagreed ${c.disagreed} · violations ${c.violations} · pasted words ${c.pastedWords}`,
        ),
        count,
        ...p.spans.map((s, i) =>
          this.tick(
            s.hash,
            `f-span-${i + 1}`,
            el("span", "text", `"${s.text}"`),
            el("span", "", ` (¶${s.block}, ${s.source})`),
          ),
        ),
      );
      if (p.spans.length > 1) {
        const all = el("button", "t text tickall", "tick all");
        all.type = "button";
        all.dataset.tickAll = "1";
        kids.push(all);
      }
    }
    kids.push(
      el(
        "span",
        "",
        p.disclosure
          ? `disclosure line: "${p.disclosure}"`
          : 'disclosure line: none. Type one into the body if you want one, starting "Disclosure:".',
      ),
    );
    this.prov.replaceChildren(...kids);
  }

  private renderChecks(): void {
    const p = this.p as Preflight;
    const kids: HTMLElement[] = [el("span", "", "checks")];
    for (const c of p.checks) {
      const line = el("span", c.ok ? "text" : c.warn ? "warn" : "err", `${c.ok ? "✓" : c.warn ? "·" : "✗"} `);
      if (c.id === "slug" && p.diff !== undefined && c.text.endsWith(" · diff")) {
        const diff = el("button", "t text diff-btn", "diff");
        diff.type = "button";
        diff.dataset.diff = "1";
        diff.setAttribute("aria-expanded", String(this.diffOpen));
        line.append(c.text.slice(0, -4), diff);
      } else line.append(c.text);
      kids.push(line);
    }
    if (this.diffOpen && p.diff !== undefined) kids.push(el("pre", "diff", p.diff));
    this.checks.replaceChildren(...kids);
  }

  private renderShip(): void {
    const p = this.p;
    if (!p) return;
    const s = shipState(p, this.job, [...this.ticked], this.busy);
    this.btn.textContent = s.label;
    this.btn.disabled = s.disabled;
    this.reason.textContent = s.reason;
    this.reason.hidden = s.reason === "";
    // A failed job is said beside the button too; its lines are in the log under it.
    const failed =
      this.job?.step === "failed" && this.busy === ""
        ? `publish ${this.job.id} ${this.job.error ?? "failed"}`
        : "";
    this.shipErr.textContent = this.error || failed;
    const left = unticked(p, [...this.ticked]).length;
    this.prov.classList.toggle("needs", left > 0);
  }

  private renderLog(): void {
    const job = this.job;
    const lines = job?.lines ?? [];
    this.log.hidden = !job;
    if (!job) return;
    const kids: HTMLElement[] = [
      el(
        "span",
        job.step === "failed" ? "err" : "",
        job.step === "failed"
          ? `publish ${job.id} · failed`
          : job.step === "done"
            ? `publish ${job.id} · done`
            : `publish ${job.id} · ${job.step}…`,
      ),
    ];
    for (const text of lines) {
      const kind = logLineKind(text);
      if (kind === "link") {
        const a = el("a", "text", text);
        a.href = text;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        kids.push(a);
      } else
        kids.push(
          el("span", kind === "ok" ? "text" : kind === "bad" ? "err" : kind === "out" ? "out" : "", text),
        );
    }
    if (job.step === "failed" && job.error && !lines.some((l) => l.includes(job.error as string)))
      kids.push(el("span", "err", `✗ ${job.error}`));
    if (job.step === "failed")
      kids.push(el("span", "", "nothing was merged · fix what it names, then build again"));
    this.log.replaceChildren(...kids);
  }

  /** The head's tag, the stage word and the foot, which live outside the sheet. */
  chrome(): { tag: string; stage: string; left: string; right: string } {
    const p = this.p;
    if (!p) return { tag: "", stage: "publish", left: "", right: "the host runs this sheet, not the coach" };
    return {
      tag: p.authorship === "drafted" ? tagText(p.yoursPct) : "",
      stage: p.pr ? "published" : "publish",
      left: `${p.counts.words} words · read-only while publishing`,
      right: p.pr ? `PR #${p.pr.number} · merging is your click` : "the host runs this sheet, not the coach",
    };
  }
}

/** Grows a textarea to its text (Safari has no field-sizing). */
function autosize(ta: HTMLTextAreaElement): void {
  ta.style.height = "auto";
  if (ta.scrollHeight > 0) ta.style.height = `${ta.scrollHeight}px`;
}
