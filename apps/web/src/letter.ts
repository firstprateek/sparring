// The letter's host lines from `_meta.sparring.letter`: most recent first, at most three, each in its kind's copy.
// A quarantine line ends in `restore it`, which posts `{action: 'restore'}` for that line. A pass result
// (`filler · 2 notes`, `nothing in this pass · cut`) ends in `dismiss`, since a night's queue leaves three of them.
// The mock draws no dismiss on the other kinds, so they have no action here. `tickerText` is the line that counts
// while a pass runs, and `resumeRows` the resume letter the snapshot carries after time away.
import type { LetterKind, SparringMeta } from "@sparring/protocol/meta";

export type LetterLine = SparringMeta["letter"][number];

/** The copy for a kind when the daemon sent no text of its own. */
const COPY: Partial<Record<LetterKind, string>> = {
  refused: "write refused · the coach tried to edit article.md · logged",
  quarantine: "article.md changed outside a save · quarantined as article.agent.md",
  passEmpty: "nothing in this pass",
  draftEmpty: "nothing to draft from · dump.md is empty",
  interrupted: "the coach was interrupted · ask again",
};

const RESTORE = "restore it";

/** The lines to show: most recent first, at most three. */
export function letterLines(letter: readonly LetterLine[] | undefined): LetterLine[] {
  return [...(letter ?? [])]
    .map((l, i) => ({ l, i }))
    .sort((a, b) => (Date.parse(b.l.at) || 0) - (Date.parse(a.l.at) || 0) || b.i - a.i)
    .slice(0, 3)
    .map(({ l }) => l);
}

/** A line's words, split at ` · ` so each part is its own span. The quarantine line's `restore it` is the button. */
export function letterParts(line: LetterLine): string[] {
  const text = (line.text ?? "").trim() || COPY[line.kind] || line.kind;
  const parts = text
    .split(/\s+·\s+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (line.kind === "quarantine" && parts.at(-1) === RESTORE) parts.pop();
  return parts;
}

export type Restore = (id: string) => Promise<void>;

const PASS_KINDS: ReadonlySet<LetterKind> = new Set<LetterKind>(["passDone", "passEmpty"]);

/**
 * One `.ln` row per line, ready for the letter. `restore` posts the restore and throws on failure; `dismiss`, when
 * given, does the same for a pass result.
 */
export function letterRows(
  letter: readonly LetterLine[] | undefined,
  restore: Restore,
  dismiss?: Restore,
): HTMLDivElement[] {
  return letterLines(letter).map((line) => {
    const row = document.createElement("div");
    row.className = "ln";
    row.dataset.id = line.id;
    row.dataset.kind = line.kind;
    letterParts(line).forEach((p, i) => {
      if (i > 0) row.append(span("·"));
      row.append(span(p));
    });
    if (line.kind === "quarantine") {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "t";
      b.textContent = RESTORE;
      b.addEventListener("click", async () => {
        b.disabled = true;
        b.textContent = "restoring…";
        row.querySelector(".err")?.remove();
        try {
          await restore(line.id);
        } catch (e) {
          b.disabled = false;
          b.textContent = RESTORE;
          const err = span(`not restored · ${e instanceof Error ? e.message : String(e)}`);
          err.className = "err";
          b.after(err);
        }
      });
      row.append(span("·"), b);
    }
    if (dismiss && PASS_KINDS.has(line.kind)) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "t";
      b.textContent = "dismiss";
      b.setAttribute("aria-label", `Dismiss: ${letterParts(line).join(", ")}`);
      b.addEventListener("click", async () => {
        b.disabled = true;
        row.querySelector(".err")?.remove();
        try {
          await dismiss(line.id);
        } catch (e) {
          b.disabled = false;
          const err = span(`not dismissed · ${e instanceof Error ? e.message : String(e)}`);
          err.className = "err";
          b.after(err);
        }
      });
      row.append(span("·"), b);
    }
    return row;
  });
}

/**
 * The line that counts while the coach works: `running filler… 12s`, with `· 2 queued` while passes wait behind
 * it. A turn with no pass reads `the coach is answering… 12s`. Empty when nothing runs.
 */
export function tickerText(
  run: SparringMeta["run"] | undefined,
  queued: number | undefined,
  now = Date.now(),
): string {
  const waiting = queued && queued > 0 ? `${queued} queued` : "";
  if (!run) return waiting ? `${waiting} · starting…` : "";
  const began = Date.parse(run.startedAt);
  const secs = Number.isNaN(began) ? 0 : Math.max(0, Math.floor((now - began) / 1000));
  const what = run.pass ? `running ${run.pass}…` : "the coach is answering…";
  return [`${what} ${secs}s`, waiting].filter(Boolean).join(" · ");
}

/** The resume letter of a snapshot: what changed while the writer was away. */
export interface Resume {
  stage: string;
  savedAt: string | null;
  awaySince: string;
  openQuestion?: string;
  unread: { id: string; kind: string; pass: string; span: string }[];
}

const UNREAD_SHOWN = 6;

const clip = (s: string, max: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/**
 * The resume letter as letter rows: where the article stands, the coach's open question, then the unread notes,
 * each a button that opens its note. `ago` words a time span; `dismiss` puts the letter away.
 */
export function resumeRows(
  r: Resume,
  o: { ago: (ms: number) => string; open: (id: string) => void; dismiss: () => void; now?: number },
): HTMLDivElement[] {
  const now = o.now ?? Date.now();
  const since = (iso: string | null) => {
    const t = iso ? Date.parse(iso) : Number.NaN;
    return Number.isNaN(t) ? "" : o.ago(Math.max(0, now - t));
  };
  const ln = (...kids: (HTMLElement | string)[]) => {
    const d = document.createElement("div");
    d.className = "ln resume";
    kids.forEach((k, i) => {
      if (i > 0) d.append(span("·"));
      d.append(typeof k === "string" ? span(k) : k);
    });
    return d;
  };
  const away = since(r.awaySince);
  const saved = since(r.savedAt);
  const x = document.createElement("button");
  x.type = "button";
  x.className = "t";
  x.textContent = "dismiss";
  x.setAttribute("aria-label", "Dismiss the welcome back lines");
  x.addEventListener("click", o.dismiss);
  const head = [
    away ? `welcome back · last here ${away} ago` : "welcome back",
    `stage ${r.stage}`,
    ...(saved ? [`saved ${saved} ago`] : []),
  ].join(" · ");
  const rows = [ln(head, x)];
  if (r.openQuestion) rows.push(ln(`the coach asked: ${clip(r.openQuestion, 160)}`));
  const n = r.unread.length;
  rows.push(ln(n === 0 ? "no unread notes" : `${n} unread ${n === 1 ? "note" : "notes"}`));
  for (const u of r.unread.slice(0, UNREAD_SHOWN)) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "t unread";
    b.dataset.note = u.id;
    b.textContent = `${u.id} · ${u.pass || u.kind} · “${clip(u.span, 40)}”`;
    b.addEventListener("click", () => o.open(u.id));
    const d = document.createElement("div");
    d.className = "ln resume";
    d.append(b);
    rows.push(d);
  }
  if (n > UNREAD_SHOWN) rows.push(ln(`and ${n - UNREAD_SHOWN} more in the notes`));
  return rows;
}

function span(text: string): HTMLSpanElement {
  const s = document.createElement("span");
  s.textContent = text;
  return s;
}
