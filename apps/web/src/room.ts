// The Room: the three leaves of one article as a block page, saved to ~/writing as you type, with the coach in
// the margin over AHP. The article's session and chat are found in the root session list by
// `_meta.sparring.slug`; the stage menu changes the session's `stage`; the composer sends chat lines, kept in
// the outbox while the socket is down; `⋯` opens the transcript. The margin's letter shows the host lines in
// `_meta.sparring.letter`; the dump leaf's blocks quoted by `briefNotes` carry `?`, and the brief leaf's margin
// lists those quotes. A bump of `commentsRev` fetches the snapshot again. At phone width in `interview` the
// Room becomes the phone interview screen (interview.ts).
import "@fontsource/source-serif-4/400.css";
import "@fontsource/source-serif-4/400-italic.css";
import "@fontsource/source-serif-4/600.css";
import "@fontsource/jetbrains-mono/400.css";
import "./base.css";
import "./room.css";
import "./interview.css";
import { wordCount } from "@sparring/protocol/blocks";
import { checkOutgoing } from "./actions.ts";
import { ahp, useAhp } from "./ahp/hub.ts";
import { api, type BriefNote, type FileName, type Snapshot } from "./api.ts";
import { adoptBrief, briefNotesOf, quoteMarks, renderQuotes } from "./brief.ts";
import { Composer } from "./composer.ts";
import { InterviewScreen, interviewDone, PHONE_QUERY } from "./interview.ts";
import { Leaf } from "./leaf.ts";
import { letterRows } from "./letter.ts";
import { renderTurns, Transcript } from "./log.ts";
import { ensureLogin } from "./login.ts";
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

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

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
  asideDump: $("aside-dump"),
  asideBrief: $("aside-brief"),
  turns: $("turns"),
  log: $("log"),
  logList: $("log-list"),
  logBtn: $<HTMLButtonElement>("log-btn"),
  logEsc: $<HTMLButtonElement>("log-esc"),
};
const leafButtons = [...document.querySelectorAll<HTMLButtonElement>("button[data-leaf]")];

let active: FileName = "article";
const leaves = new Map<FileName, Leaf>();
let shownCommit: { sha: string; until: number } | null = null;
let snapStage = "";
let briefNotes: BriefNote[] = [];
/** True once the snapshot is in and the leaves exist. */
let loaded = false;

const page = new Page(els.paras, (text) => leaves.get(active)?.edit(text), { gutter: true });
/** The phone interview's page: always the dump. */
const ivPage = new Page($("iv-paras"), (text) => leaves.get("dump")?.edit(text));
const phone = window.matchMedia(PHONE_QUERY);

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
    if (!sessionUri) return "this article has no session yet";
    return setStage(conn, sessionUri, stage);
  },
);

/** A composer line: checked, then sent or kept in the outbox. Returns true when it went out now. */
function sendLine(from: Composer, text: string): boolean {
  const problem = checkOutgoing(text);
  if (problem) {
    from.note(problem);
    from.restore(text);
    return false;
  }
  const went = outbox.push(text) === "sent";
  renderAhp();
  return went;
}

const composer = new Composer($<HTMLTextAreaElement>("composer"), $("slash"), $("comp-note"), $("queued"), {
  line: (text) => {
    // A line that went out opens the transcript so the reply shows; a queued one leaves the margin in view.
    if (sendLine(composer, text) && active !== "dump") setLog(true);
  },
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
    if (!sessionUri) return "this article has no session yet";
    return setStage(conn, sessionUri, stage);
  },
);
phone.addEventListener("change", () => renderAhp());

const transcriptView = new Transcript(els.logList, els.log);

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
  if (active === "dump") renderTurns(els.turns, said, interviewDone(meta?.covered));
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
  } else page.show(leaves.get(active)?.text ?? "", active);
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
    } catch (e) {
      console.info(`snapshot refetch failed: ${e instanceof Error ? e.message : e}`);
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
  markPage();
  renderQuotes(els.asideBrief, briefNotes);
}

/** The `?` marks: on the dump leaf, the blocks a brief quote comes from. */
function markPage(): void {
  page.setMarks(active === "dump" ? (b) => quoteMarks([b], briefNotes)[0] === true : null);
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
  if (conflict) {
    const keep = button("keep mine", () => void conflict.keepMine());
    const take = button("take disk", () => void conflict.takeDisk());
    const where = conflict.file === "article" ? [] : [span(`${conflict.file}.md`), span("·")];
    rows.push(row(...where, span("disk changed while offline"), span("·"), keep, span("·"), take));
  }
  rows.push(...hostLetter());
  const info = conn.info;
  const down = info.status === "reconnecting" || (info.status === "connecting" && info.attempt > 0);
  if (down || info.status === "failed") rows.push(row(span(connectionWords(info))));
  els.letter.hidden = rows.length === 0;
  const same =
    rows.length === els.letter.children.length && rows.every((r, i) => r === els.letter.children[i]);
  if (!same) els.letter.replaceChildren(...rows);
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
function button(text: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "t";
  b.textContent = text;
  b.addEventListener("click", onClick);
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
  els.body.classList.toggle("on-dump", file === "dump");
  els.asideDump.hidden = file !== "dump";
  els.asideBrief.hidden = file !== "brief";
  page.show(leaves.get(file)?.text ?? "", file);
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
    page.show(leaf.text, leaf.file);
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
  els.slug.textContent = slug;
  await ensureLogin(() => {
    conn.retryNow();
    if (!loaded) void load().catch(showError);
  });
  await load();
  useAhp();
  list = new ArticleList(conn);
  list.onChange(attach);
}

function showError(e: unknown): void {
  els.letter.hidden = false;
  els.letter.replaceChildren(row(span(e instanceof Error ? e.message : String(e))));
}

for (const b of leafButtons) b.addEventListener("click", () => showLeaf(b.dataset.leaf as FileName));

document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "s") {
    e.preventDefault();
    void leaves.get(active)?.saveNow(true);
  } else if (e.key === "Escape" && !els.log.hidden) {
    setLog(false);
    els.logBtn.focus();
  }
});
window.addEventListener("pagehide", () => {
  for (const l of leaves.values()) if (l.dirty) void l.saveNow(false);
});
setInterval(render, 1000);

main().catch(showError);
