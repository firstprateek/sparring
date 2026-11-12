// The Room: the three leaves of one article as tabs over one page, saved to ~/writing as you type, with the
// coach panel beside it over AHP. The coach panel is the same on every tab: the stage, the turns, the composer. The article's session and chat are found in the root session list by
// `_meta.sparring.slug`; the stage menu changes the session's `stage`; the composer sends chat lines, kept in
// the outbox while the socket is down; `⋯` opens the transcript. The margin's letter shows the host lines in
// `_meta.sparring.letter`; the dump leaf's blocks quoted by `briefNotes` carry `?`, and the brief leaf's margin
// lists those quotes. The coach's notes on the article are listed in the coach panel (notes.ts), each block with
// a live note carries a bar in the gutter, and the two jump to each other. A bump of `commentsRev` fetches the
// snapshot again. At phone width in `interview` the
// Room becomes the phone interview screen (interview.ts).
import "@fontsource/source-serif-4/400.css";
import "@fontsource/source-serif-4/400-italic.css";
import "@fontsource/source-serif-4/600.css";
import "@fontsource/jetbrains-mono/400.css";
import "./base.css";
import "./room.css";
import "./interview.css";
import "./guide.css";
import { joinBlocks, splitBlocks, wordCount } from "@sparring/protocol/blocks";
import type { Stage } from "@sparring/protocol/commands";
import { isLive, type Note } from "@sparring/protocol/notes";
import { checkOutgoing } from "./actions.ts";
import { ahp, useAhp } from "./ahp/hub.ts";
import { api, type BriefNote, type FileName, type Snapshot } from "./api.ts";
import { adoptBrief, briefNotesOf, quoteMarks, renderQuotes } from "./brief.ts";
import { Composer } from "./composer.ts";
import { Guide } from "./guide.ts";
import { BUILT, LEAF_HELP, stageHelp } from "./help.ts";
import { InterviewScreen, interviewDone, PHONE_QUERY } from "./interview.ts";
import { Leaf } from "./leaf.ts";
import { letterRows } from "./letter.ts";
import { renderTurns, Transcript } from "./log.ts";
import { ensureLogin } from "./login.ts";
import { NotesView } from "./notes.ts";
import { Outbox } from "./outbox.ts";
import { Page } from "./page.ts";
import { ago } from "./rows.ts";
import {
  ArticleList,
  ChatLines,
  chatOf,
  hostQueued,
  metaOf,
  setStage,
  stageOf,
  transcript,
} from "./session.ts";
import { StageMenu } from "./stage-menu.ts";
import { connectionWords } from "./status.ts";
import { UpdateWatch } from "./update.ts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const NO_SESSION = "this article has no coach session yet · see the note in the coach panel";

const params = new URLSearchParams(location.search);
const slug = params.get("slug") ?? "";
const askedLeaf = params.get("leaf");
const els = {
  slug: $("slug"),
  words: $("words"),
  saved: $("saved"),
  letter: $("letter"),
  paras: $("paras"),
  body: $("body"),
  asideBrief: $("aside-brief"),
  quotes: $("quotes"),
  leafHelp: $("leaf-help"),
  coachStage: $("coach-stage"),
  turns: $("turns"),
  log: $("log"),
  logList: $("log-list"),
  logBtn: $<HTMLButtonElement>("log-btn"),
  logEsc: $<HTMLButtonElement>("log-esc"),
  notesBtn: $<HTMLButtonElement>("notes-btn"),
};
const leafButtons = [...document.querySelectorAll<HTMLButtonElement>("button[data-leaf]")];

let active: FileName = "article";
const leaves = new Map<FileName, Leaf>();
let shownCommit: { sha: string; until: number } | null = null;
let snapStage = "";
let briefNotes: BriefNote[] = [];
/** The coach's notes on the article, as the last snapshot had them. */
let notes: Note[] = [];
/** True once the snapshot is in and the leaves exist. */
let loaded = false;

const page = new Page(
  els.paras,
  (text) => {
    leaves.get(active)?.edit(text);
    // The foot and the notes follow the typing at once: Done goes live with the keystroke that earns it.
    render();
  },
  {
    gutter: true,
    onMark: (id) => notesView.focus(id),
  },
);
/** The phone interview's page: always the dump. */
const ivPage = new Page($("iv-paras"), (text) => leaves.get("dump")?.edit(text));
const phone = window.matchMedia(PHONE_QUERY);
/** Under this width the coach panel is below the page and the notes are a sheet. */
const narrow = window.matchMedia("(max-width: 760px)");

// ───────────────────────────── AHP state ─────────────────────────────

const conn = ahp();
let sessionUri: string | undefined;
let chatUri: string | undefined;
let releases: (() => void)[] = [];
let list: ArticleList | undefined;

const lines = new ChatLines(
  conn,
  () => chatUri,
  (text, reason) => {
    composer.restore(text);
    composer.note(`not sent · ${reason}`);
  },
);
const outbox = new Outbox(`sparring-outbox:${slug}`, lines.send);

const stageMenu = new StageMenu(
  $<HTMLButtonElement>("stage-btn"),
  $("stage-word"),
  $("stage-menu"),
  (stage) => {
    if (!sessionUri) return NO_SESSION;
    return setStage(conn, sessionUri, stage, stageRefused);
  },
);

/**
 * The turns stay on their last line while the writer has not scrolled away, also when the notes above them or the
 * composer below change height.
 */
let turnsStuck = true;
els.turns.addEventListener("scroll", () => {
  turnsStuck = els.turns.scrollHeight - els.turns.scrollTop - els.turns.clientHeight < 24;
});
if (typeof ResizeObserver !== "undefined") {
  new ResizeObserver(() => {
    if (turnsStuck) els.turns.scrollTop = els.turns.scrollHeight;
  }).observe(els.turns);
}

/** Problems the letter shows in red until they clear: a stage the host refused, a session that failed. */
const problems = new Map<string, string>();
function problem(key: string, text: string | null): void {
  if (text) problems.set(key, text);
  else problems.delete(key);
  render();
}
function stageRefused(reason: string): void {
  problem("stage", `stage not changed · ${reason}`);
}

/** A composer line: checked, then sent or kept in the outbox. Returns true when it went out now. */
function sendLine(from: Composer, text: string): boolean {
  const problem = checkOutgoing(text);
  if (problem) {
    from.note(problem);
    from.restore(text);
    return false;
  }
  const went = outbox.push(text) === "sent";
  // What was just said is what the writer wants to see: the turns go back to their last line.
  turnsStuck = true;
  renderAhp();
  els.turns.scrollTop = els.turns.scrollHeight;
  return went;
}

const composer = new Composer($<HTMLTextAreaElement>("composer"), $("slash"), $("comp-note"), $("queued"), {
  line: (text) => void sendLine(composer, text),
  log: () => setLog(true),
  escape: () => setLog(false),
});
const ivComposer = new Composer(
  $<HTMLTextAreaElement>("iv-composer"),
  $("iv-slash"),
  $("iv-note"),
  $("iv-queued"),
  {
    line: (text) => void sendLine(ivComposer, text),
    log: () => interview.fold(false),
    escape: () => {},
  },
);
$<HTMLFormElement>("comp-form").addEventListener("submit", (e) => {
  e.preventDefault();
  composer.submit();
  $<HTMLTextAreaElement>("composer").focus();
});
$<HTMLFormElement>("iv-form").addEventListener("submit", (e) => {
  e.preventDefault();
  ivComposer.submit();
  $<HTMLTextAreaElement>("iv-composer").focus();
});
outbox.onChange(() => renderQueued());

const interview = new InterviewScreen(
  {
    root: $("iv"),
    title: $("iv-title"),
    stageBtn: $<HTMLButtonElement>("iv-stage-btn"),
    stageWord: $("iv-stage-word"),
    menu: $("iv-menu"),
    stages: $("iv-stages"),
    sendit: $<HTMLButtonElement>("iv-sendit"),
    senditLine: $("iv-sendit-line"),
    menuError: $("iv-menu-error"),
    topics: $("iv-topics"),
    sheet: $("iv-sheet"),
    sheetBtn: $<HTMLButtonElement>("iv-sheet-btn"),
    sheetBody: $("iv-sheet-body"),
    thread: $("iv-thread"),
  },
  (stage) => {
    if (!sessionUri) return NO_SESSION;
    return setStage(conn, sessionUri, stage, stageRefused);
  },
);
phone.addEventListener("change", () => renderAhp());

/** Note ids already reported as seen, so each is sent once. */
const seenSent = new Set<string>();

const notesView = new NotesView(
  {
    root: $("notes"),
    toggle: $<HTMLButtonElement>("notes-toggle"),
    close: $<HTMLButtonElement>("notes-close"),
    filter: $("notes-filter"),
    body: $("notes-body"),
    err: $("notes-err"),
    list: $("notes-list"),
  },
  {
    act: async (line) => {
      // Done is judged on what is on disk: the page is saved first.
      if (line.startsWith("done ")) {
        const leaf = leaves.get("article");
        if (leaf?.dirty) await leaf.saveNow(false);
        if (leaf && (leaf.dirty || leaf.state.kind !== "saved"))
          return "article.md is not saved yet · try again once the foot says saved";
      }
      const problem = checkOutgoing(line);
      if (problem) return problem;
      outbox.push(line);
      renderAhp();
      return null;
    },
    jump: (note) => {
      if (active !== "article") showLeaf("article");
      const at = page.find(note.span);
      if (at < 0) return;
      if (narrow.matches) notesView.openSheet(false);
      page.reveal(at);
    },
    saveBlock: (note, text) => {
      const leaf = leaves.get("article");
      if (!leaf) return "the article is not loaded";
      if (leaf.state.kind === "conflict") return "choose keep mine or take disk first";
      const blocks = splitBlocks(leaf.text);
      const at = blocks.findIndex((b) => b.includes(note.span));
      if (at < 0) return "that paragraph is no longer in the article";
      if (active === "article" && !interview.visible && page.setBlock(page.find(note.span), text))
        return null;
      blocks[at] = text;
      leaf.edit(joinBlocks(blocks));
      render();
      return null;
    },
    seen: (ids) => {
      const fresh = ids.filter((id) => !seenSent.has(id));
      if (fresh.length === 0) return;
      for (const id of fresh) seenSent.add(id);
      api.seen(slug, fresh).then(
        () => problem("seen", null),
        (e: unknown) => {
          for (const id of fresh) seenSent.delete(id);
          problem("seen", `notes not marked as read · ${e instanceof Error ? e.message : e}`);
        },
      );
    },
  },
);
els.notesBtn.addEventListener("click", () => {
  if (narrow.matches) notesView.openSheet(!notesView.sheetOpen);
  else {
    notesView.fold(false);
    $("notes").scrollIntoView({ block: "nearest" });
    $<HTMLButtonElement>("notes-toggle").focus();
  }
});

const transcriptView = new Transcript(els.logList, els.log);
/** Made once the writer is logged in, so the card never sits over the login form. */
let guide: Guide | undefined;
/** What renderAhp last saw, for the guide. */
let seen = { stage: "", covered: 0, said: 0 };

function updateGuide(): void {
  if (!loaded) return;
  const words = (f: FileName) => wordCount(leaves.get(f)?.text ?? "");
  guide?.update({
    where: "room",
    leaf: active,
    dumpWords: words("dump"),
    articleWords: words("article"),
    notes: notes.length,
    ...seen,
  });
}

/** Finds the article's session and chat in the root list and holds them open. */
function attach(): void {
  const summary = list?.bySlug(slug);
  if (!summary) return;
  if (summary.resource !== sessionUri) {
    for (const r of releases) r();
    releases = [];
    sessionUri = summary.resource;
    chatUri = undefined;
    releases.push(conn.watch(sessionUri));
  }
  const chat = chatOf(conn.session(sessionUri ?? "") ?? summary);
  if (chat && chat !== chatUri) {
    chatUri = chat;
    releases.push(conn.watch(chatUri));
  }
  renderAhp();
}

function renderQueued(): void {
  const lines = [
    ...outbox.lines().map((l) => l.text),
    ...hostQueued(chatUri ? conn.chat(chatUri) : undefined),
  ];
  composer.queued(lines);
  ivComposer.queued(lines);
}

/** `_meta.sparring` as the session has it, else as the root list has it. */
function currentMeta() {
  const session = sessionUri ? conn.session(sessionUri) : undefined;
  return metaOf(session) ?? metaOf(sessionUri ? list?.bySlug(slug) : undefined);
}

let seenRev: number | undefined;

/** The stage word, the transcript, the interview turns and the queued lines, from the session and chat. */
function renderAhp(): void {
  const session = sessionUri ? conn.session(sessionUri) : undefined;
  const meta = currentMeta();
  const stage = stageOf(session, meta, snapStage);
  const offline = meta?.offline === true;
  stageMenu.set(stage, meta?.covered, meta?.drafting === true, offline);
  const chat = chatUri ? conn.chat(chatUri) : undefined;
  const said = transcript(chat);
  if (!els.log.hidden) transcriptView.render(said);
  renderTurns(els.turns, said, interviewDone(meta?.covered), stageHelp(stage));
  const covered = meta?.covered?.length ?? 0;
  seen = { stage, covered, said: said.filter((l) => l.kind === "you").length };
  renderCoachStage();
  renderQueued();

  if (meta && typeof meta.commentsRev === "number") {
    if (seenRev !== undefined && meta.commentsRev !== seenRev) void refetch();
    seenRev = meta.commentsRev;
  }

  interview.set({ slug, stage, covered: meta?.covered ?? [], offline, lines: said });
  setInterview(loaded && phone.matches && stage === "interview");
  renderLetter();
}

/** Switches between the Room and the phone interview, handing the dump between their pages. */
function setInterview(on: boolean): void {
  if (on === interview.visible) return;
  if (on) {
    stageMenu.close(false);
    ivPage.show(leaves.get("dump")?.text ?? "", "dump");
  } else page.show(leaves.get(active)?.text ?? "", active, LEAF_HELP[active].placeholder);
  interview.show(on);
  if (on) ivPage.resize();
  else markPage();
}

/** The snapshot again, after `commentsRev` moved: the brief notes, and brief.md unless it has unsent edits. */
let refetching: Promise<void> | null = null;
let refetchAgain = false;
async function refetch(): Promise<void> {
  if (refetching) {
    refetchAgain = true;
    return;
  }
  refetching = (async () => {
    try {
      const snap = await api.snapshot(slug);
      takeNotes(snap);
      const brief = leaves.get("brief");
      if (brief) adoptBrief(brief, snap.files.brief);
      problem("refetch", null);
    } catch (e) {
      problem(
        "refetch",
        `the notes and the brief did not refresh · ${e instanceof Error ? e.message : e} · reload to try again`,
      );
    }
  })();
  await refetching;
  refetching = null;
  if (refetchAgain) {
    refetchAgain = false;
    await refetch();
  }
}

function takeNotes(snap: Snapshot): void {
  briefNotes = briefNotesOf(snap.briefNotes);
  notes = Array.isArray(snap.comments) ? snap.comments : [];
  markPage();
  renderNotes();
  renderQuotes(els.asideBrief, briefNotes);
  els.quotes.hidden = active !== "brief" || briefNotes.length === 0;
}

/** The gutter: on the dump leaf `?` by the blocks a brief quote comes from, on the article a bar by a live note. */
function markPage(): void {
  if (active === "dump")
    page.setMarks((b) => (quoteMarks([b], briefNotes)[0] === true ? { kind: "q" } : null));
  else if (active === "article")
    page.setMarks((b) => {
      const on = notes.filter((n) => isLive(n) && b.includes(n.span));
      const first = on[0];
      return first
        ? { kind: "note", id: first.id, label: on.map((n) => `${n.id} ${n.kind}`).join(" · ") }
        : null;
    });
  else page.setMarks(null);
}

/** The coach panel's head: the stage, with what it counts. */
function renderCoachStage(): void {
  const { stage, covered } = seen;
  els.coachStage.textContent =
    stage === "interview"
      ? `interview · ${covered}/6 covered`
      : stage === "critique" && notes.length > 0
        ? `critique · ${notesView.open} open`
        : BUILT.has(stage as Stage)
          ? stage
          : `${stage} · not built yet`;
}

/** The notes list and the foot's notes button, from the snapshot's notes and the article as it is typed. */
function renderNotes(): void {
  notesView.set(notes, leaves.get("article")?.text ?? "");
  els.notesBtn.hidden = notes.length === 0;
  const open = notesView.open;
  els.notesBtn.textContent = `${open} open ${open === 1 ? "note" : "notes"} ▴`;
  els.notesBtn.setAttribute("aria-expanded", String(notesView.sheetOpen));
  if (seen.stage) renderCoachStage();
}

conn.onChange((uris) => {
  if (sessionUri && uris.has(sessionUri)) attach();
  if (chatUri && uris.has(chatUri)) {
    if (conn.info.status === "open" && conn.chat(chatUri)) outbox.flush();
    renderAhp();
  }
});
conn.onInfo((i) => {
  if (i.status === "open" && chatUri && conn.chat(chatUri)) outbox.flush();
  render();
});

function setLog(open: boolean): void {
  els.log.hidden = !open;
  els.logBtn.setAttribute("aria-expanded", String(open));
  if (open) {
    renderAhp();
    els.log.scrollTop = els.log.scrollHeight;
  }
}
els.logBtn.addEventListener("click", () => {
  setLog(els.log.hidden === true);
  if (!els.log.hidden) els.logEsc.focus();
});
els.logEsc.addEventListener("click", () => {
  setLog(false);
  els.logBtn.focus();
});

// ───────────────────────────── page, foot and letter ─────────────────────────────

/** The foot and the letter, from the active leaf and the socket. */
function render(): void {
  updateGuide();
  if (loaded) renderNotes();
  const leaf = leaves.get(active);
  if (leaf) {
    els.words.textContent = `${wordCount(leaf.text)} words`;
    const st = leaf.state;
    if (shownCommit && Date.now() < shownCommit.until) els.saved.textContent = `committed ${shownCommit.sha}`;
    else if (st.kind === "saving") els.saved.textContent = "saving";
    else if (st.kind === "retrying") els.saved.textContent = "unsaved · retrying";
    else if (st.kind === "diskFull") els.saved.textContent = "disk full · not saved";
    else if (st.kind === "conflict") els.saved.textContent = "unsaved";
    else if (leaf.dirty) els.saved.textContent = "unsaved";
    else els.saved.textContent = `saved ${ago(Date.now() - st.at)}`;
  }

  const rows: HTMLElement[] = [];
  const conflict = [...leaves.values()].find((l) => l.state.kind === "conflict");
  if (conflict) rows.push(conflictRow(conflict));
  for (const [key, text] of problems) rows.push(problemRow(key, text));
  const failing = [...leaves.values()].find((l) => l.state.kind === "retrying" && l.state.tries >= 3);
  if (failing?.state.kind === "retrying") {
    rows.push(errRow(`${failing.file}.md is not saving · ${failing.state.reason} · retrying every 5 s`));
  }
  if (outbox.memoryOnly) {
    rows.push(errRow("this browser is not keeping queued lines · they are lost if this tab closes"));
  }
  if ([...leaves.values()].some((l) => !l.storageOk)) {
    rows.push(errRow("this browser is not keeping unsaved text · it lives only in this tab until it saves"));
  }
  if (loaded && list?.loaded && !list.bySlug(slug)) rows.push(noSessionRow());
  rows.push(...hostLetter());
  const info = conn.info;
  const down = info.status === "reconnecting" || (info.status === "connecting" && info.attempt > 0);
  if (down || info.status === "failed") rows.push(errRow(connectionWords(info)));
  els.letter.hidden = rows.length === 0;
  const same =
    rows.length === els.letter.children.length && rows.every((r, i) => r === els.letter.children[i]);
  if (!same) els.letter.replaceChildren(...rows);
}

/** The conflict row, kept across renders so a click in flight keeps its disabled buttons. */
let conflictEl: { leaf: Leaf; el: HTMLDivElement } | null = null;
function conflictRow(leaf: Leaf): HTMLDivElement {
  if (conflictEl?.leaf === leaf && leaf.state.kind === "conflict") return conflictEl.el;
  const run = (what: string, fn: () => Promise<void>) => async () => {
    keep.disabled = take.disabled = true;
    try {
      await fn();
      problem("conflict", null);
    } catch (e) {
      problem("conflict", `${what} failed · ${e instanceof Error ? e.message : e}`);
    } finally {
      keep.disabled = take.disabled = false;
      conflictEl = null;
    }
  };
  const keep = button("keep mine", () => void run("keep mine", () => leaf.keepMine())());
  const take = button("take disk", () => void run("take disk", () => leaf.takeDisk())());
  const where = leaf.file === "article" ? [] : [span(`${leaf.file}.md`), span("·")];
  const el = row(
    ...where,
    span("this page changed on disk while you were offline"),
    span("·"),
    keep,
    span("·"),
    take,
  );
  el.classList.add("err");
  conflictEl = { leaf, el };
  return el;
}

/** A red line with a dismiss. */
const problemEls = new Map<string, { text: string; el: HTMLDivElement }>();
function problemRow(key: string, text: string): HTMLDivElement {
  const had = problemEls.get(key);
  if (had?.text === text) return had.el;
  const el = row(
    span(text),
    button("dismiss", () => problem(key, null)),
  );
  el.classList.add("err");
  problemEls.set(key, { text, el });
  return el;
}

function errRow(text: string): HTMLDivElement {
  const el = row(span(text));
  el.classList.add("err");
  return el;
}

/** The article is in the list of files but has no AHP session: offer to start one. */
let noSessionEl: HTMLDivElement | null = null;
function noSessionRow(): HTMLDivElement {
  if (noSessionEl) return noSessionEl;
  const start = button("start it", async () => {
    start.disabled = true;
    try {
      await api.startSession(slug);
      problem("session", null);
      noSessionEl = null;
    } catch (e) {
      problem("session", e instanceof Error ? e.message : String(e));
    } finally {
      start.disabled = false;
    }
  });
  noSessionEl = row(
    span("this article has no coach session, so the coach cannot hear you"),
    span("·"),
    start,
  );
  noSessionEl.classList.add("err");
  return noSessionEl;
}

/** The host's letter lines, rebuilt only when they change so a `restore it` in flight keeps its state. */
let letterKey = "";
let letterEls: HTMLDivElement[] = [];
function hostLetter(): HTMLDivElement[] {
  const letter = currentMeta()?.letter ?? [];
  const key = JSON.stringify(letter);
  if (key !== letterKey) {
    letterKey = key;
    letterEls = letterRows(letter, async (id) => {
      await api.letter(slug, id, "restore");
    });
  }
  return letterEls;
}

function renderLetter(): void {
  if (loaded) render();
}

function row(...kids: HTMLElement[]): HTMLDivElement {
  const d = document.createElement("div");
  d.className = "ln";
  d.append(...kids);
  return d;
}
function span(text: string): HTMLSpanElement {
  const s = document.createElement("span");
  s.textContent = text;
  return s;
}
function button(text: string, onClick: () => void | Promise<void>): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "t";
  b.textContent = text;
  b.addEventListener("click", () => void onClick());
  return b;
}

function showLeaf(file: FileName): void {
  active = file;
  for (const b of leafButtons) {
    const on = b.dataset.leaf === file;
    b.classList.toggle("on", on);
    b.classList.toggle("off", !on);
    if (on) b.setAttribute("aria-current", "true");
    else b.removeAttribute("aria-current");
  }
  els.leafHelp.textContent = LEAF_HELP[file].help;
  els.quotes.hidden = file !== "brief" || briefNotes.length === 0;
  page.show(leaves.get(file)?.text ?? "", file, LEAF_HELP[file].placeholder);
  markPage();
  render();
  renderAhp();
}

function onLeafChange(leaf: Leaf, commit?: string): void {
  if (commit) shownCommit = { sha: commit.slice(0, 7), until: Date.now() + 2000 };
  // `take disk` replaced the text: show it when it is the leaf on screen.
  const fresh = !leaf.dirty && leaf.state.kind === "saved";
  if (interview.visible) {
    if (leaf.file === "dump" && fresh && ivPage.text() !== leaf.text) ivPage.show(leaf.text, "dump");
  } else if (leaf.file === active && fresh && page.text() !== leaf.text) {
    page.show(leaf.text, leaf.file, LEAF_HELP[leaf.file].placeholder);
  }
  render();
}

async function load(): Promise<void> {
  const snap = await api.snapshot(slug);
  snapStage = snap.stage;
  takeNotes(snap);
  for (const f of ["article", "dump", "brief"] as const) {
    const leaf = new Leaf(slug, f, snap.files[f].text, snap.files[f].sha, onLeafChange);
    leaves.set(f, leaf);
    leaf.replay();
  }
  loaded = true;
  const first: FileName =
    askedLeaf === "dump" || askedLeaf === "brief" || askedLeaf === "article"
      ? askedLeaf
      : snap.files.article.text.trim() === "" && snap.files.dump.text.trim() !== ""
        ? "dump"
        : "article";
  showLeaf(first);
  if (!interview.visible && !phone.matches) page.focusEnd();
}

async function main(): Promise<void> {
  if (!slug) {
    location.replace("/");
    return;
  }
  document.title = `${slug} · Sparring`;
  try {
    const key = `sparring-warnings:${slug}`;
    const handed = JSON.parse(sessionStorage.getItem(key) ?? "[]") as unknown;
    sessionStorage.removeItem(key);
    if (Array.isArray(handed)) {
      for (const [i, w] of handed.entries()) problems.set(`created-${i}`, `made, but ${String(w)}`);
    }
  } catch {
    // Nothing handed over.
  }
  els.slug.textContent = slug;
  await ensureLogin(() => {
    conn.retryNow();
    if (!loaded) void load().catch(showError);
  });
  guide = new Guide("room", $<HTMLButtonElement>("guide-btn"), $("guide-slot"));
  await load();
  useAhp();
  list = new ArticleList(conn);
  list.onChange(attach);
}

function showError(e: unknown): void {
  els.letter.hidden = false;
  const back = document.createElement("a");
  back.href = "/";
  back.className = "t";
  back.textContent = "back to articles";
  const line = row(
    span(`this article did not open · ${e instanceof Error ? e.message : String(e)}`),
    span("·"),
    back,
  );
  line.classList.add("err");
  els.letter.replaceChildren(line);
  els.paras.replaceChildren();
}

for (const b of leafButtons) b.addEventListener("click", () => showLeaf(b.dataset.leaf as FileName));

document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "s") {
    e.preventDefault();
    const leaf = leaves.get(active);
    if (leaf?.state.kind === "conflict")
      problem("conflict", "not saved · choose keep mine or take disk first");
    else void leaf?.saveNow(true);
  } else if (e.key === "Escape" && notesView.sheetOpen && narrow.matches) {
    notesView.openSheet(false);
    els.notesBtn.focus();
  } else if (e.key === "Escape" && !els.log.hidden) {
    setLog(false);
    els.logBtn.focus();
  }
});
/** Before an update's reload: saves what can be saved, and refuses while something would be lost. */
async function readyToReload(): Promise<string | null> {
  await Promise.all([...leaves.values()].filter((l) => l.dirty).map((l) => l.saveNow(false)));
  const unsaved = [...leaves.entries()].filter(([, l]) => l.dirty && !l.storageOk).map(([name]) => name);
  if (unsaved.length > 0) return `${unsaved.join(", ")} not saved yet, and this browser cannot keep a copy`;
  if (outbox.memoryOnly && outbox.lines().length > 0) return "unsent messages would be lost";
  return null;
}
new UpdateWatch({ beforeReload: readyToReload }).start();

window.addEventListener("pagehide", () => {
  for (const l of leaves.values()) if (l.dirty) void l.saveNow(false);
});
setInterval(render, 1000);

main().catch(showError);
