// The chat, drawn two ways: the transcript overlay (`⋯`): writer lines, coach lines through the markdown
// renderer, one mono line per tool call, host lines as dividers; and on the dump leaf, the interview turns
// (a who column and the text). Everything is set with textContent or the escaping markdown renderer.
import { MarkdownCache } from "./markdown.ts";
import type { Line } from "./session.ts";

function span(text: string, cls: string): HTMLSpanElement {
  const s = document.createElement("span");
  s.className = cls;
  s.textContent = text;
  return s;
}

function divider(text: string): HTMLDivElement {
  const d = document.createElement("div");
  d.className = "divider";
  d.append(span(text, ""));
  return d;
}

/** `09:12`, in the browser's time zone. */
export function clock(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Sticks a scroller to its bottom across a redraw when it was at the bottom before. */
function keepBottom(scroller: HTMLElement, draw: () => void): void {
  const atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 24;
  draw();
  if (atBottom) scroller.scrollTop = scroller.scrollHeight;
}

export class Transcript {
  /** One markdown cache per coach line, in order, so a streaming reply re-parses only its last chunk. */
  private caches: MarkdownCache[] = [];

  constructor(
    private readonly list: HTMLElement,
    private readonly scroller: HTMLElement,
  ) {}

  render(lines: readonly Line[]): void {
    keepBottom(this.scroller, () => {
      let coach = 0;
      const rows = lines.map((l): HTMLElement => {
        if (l.kind === "host") return divider(l.text);
        const row = document.createElement("div");
        row.className = `line ${l.kind}`;
        row.append(span(clock(l.at), "mono muted at"));
        if (l.kind === "coach") {
          const cache = this.caches[coach] ?? new MarkdownCache();
          this.caches[coach] = cache;
          coach++;
          const md = document.createElement("div");
          md.className = "md muted";
          md.append(...cache.render(l.text, l.streaming));
          row.append(md);
        } else if (l.kind === "tool") row.append(span(l.text, "muted"));
        else row.append(span(l.text, "text pre"));
        return row;
      });
      this.caches.length = coach;
      if (rows.length === 0) rows.push(span("nothing said yet", "mono muted"));
      this.list.replaceChildren(...rows);
    });
  }
}

export const INTERVIEW_DONE = "interview done · brief.md is yours";

/**
 * The interview turns (the dump leaf's margin, the phone interview's sheet): writer and coach lines, host lines
 * as dividers, and `interview done · brief.md is yours` last once every topic is covered.
 */
export function renderTurns(el: HTMLElement, lines: readonly Line[], done = false, empty = ""): void {
  keepBottom(el, () => {
    const rows: HTMLElement[] = [];
    for (const l of lines) {
      if (l.kind === "tool") continue;
      if (l.kind === "host") {
        rows.push(divider(l.text));
        continue;
      }
      const row = document.createElement("div");
      row.className = "turn";
      row.append(
        span(l.kind === "you" ? "you" : "coach", "who"),
        span(l.text, `${l.kind === "you" ? "text" : "muted"} pre`),
      );
      rows.push(row);
    }
    if (done && !lines.some((l) => l.kind === "host" && l.text === INTERVIEW_DONE)) {
      rows.push(divider(INTERVIEW_DONE));
    }
    if (empty && !rows.some((r) => r.classList.contains("turn"))) {
      const p = document.createElement("p");
      p.className = "empty";
      p.textContent = empty;
      rows.unshift(p);
    }
    el.replaceChildren(...rows);
  });
}
