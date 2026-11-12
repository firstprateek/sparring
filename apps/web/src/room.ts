// The Room: the three leaves of one article as tabs over one page, saved to ~/writing as you type, with the
// coach panel beside it over AHP. The coach panel is the same on every tab: the stage, the turns, the composer. The article's session and chat are found in the root session list by
// `_meta.sparring.slug`; the stage menu changes the session's `stage`; the composer sends chat lines, kept in
// the outbox while the socket is down; `⋯` opens the transcript. The margin's letter shows the host lines in
// `_meta.sparring.letter`; the dump leaf's blocks quoted by `briefNotes` carry `?`, and the brief leaf's margin
// lists those quotes. The coach's notes on the article are listed in the coach panel (notes.ts), each block with
// a live note carries a bar in the gutter, and the two jump to each other. A bump of `commentsRev` fetches the
// snapshot again. While a pass runs the letter counts (`running filler… 12s`), a pass result stays there until
// dismissed, and after time away it opens with the resume letter. `/ask` takes the paragraph the caret is in.
// `/quiet` folds the notes and puts `quiet` in the foot. At phone width in `interview` the
// Room becomes the phone interview screen (interview.ts).
//
// Drafted mode: `send it` in the stage menu (or `/sendit`) shows its confirm line, and yes makes the authorship
// call. While the coach drafts the stage word reads `drafting…` and the article is read-only; when the draft is
// accepted the Room fetches the snapshot and lands it block by block. From then on each block carries its
// provenance bar, the head and the foot say `N% yours`, the letter carries the status strip, the quiet block
// stands where the notes do until `/critique` or `/pass`, and `shelf` in the foot opens the page from before the
// draft. `coached again` puts that page back.
//
// Tells and pasted words: on the article leaf the foot counts three tells as the page is typed, and a count
// opens the Tells table, whose hits put the caret on their span. Text pasted into the article is posted to the
// daemon, which answers the spans that are the coach's words; those carry a dotted underline while they stand,
// and `pasted N` in the foot steps through them.
//
// Publish: `publish →` in the stage menu and `/publish` save the pages and open the publish sheet (publish.ts).
// Once the article has a PR the head says `PR #5`, which opens the sheet too.
import "@fontsource/source-serif-4/400.css";
import "@fontsource/source-serif-4/400-italic.css";
import "@fontsource/source-serif-4/600.css";
import "@fontsource/jetbrains-mono/400.css";
import "./base.css";
import "./room.css";
import "./interview.css";
import "./guide.css";
import { joinBlocks, splitBlocks, wordCount } from "@sparring/protocol/blocks";
import { PASSES, parseCommand } from "@sparring/protocol/commands";
import { isLive, type Note } from "@sparring/protocol/notes";
import { type OverlapIndex, overlap, overlapIndex, overlapWords } from "@sparring/protocol/overlap";
import { type Baseline, baselineOf, type Provenance, provenance } from "@sparring/protocol/provenance";
import { type TellKey, type Tells, tells } from "@sparring/protocol/tells";
import { checkOutgoing } from "./actions.ts";
import { ahp, useAhp } from "./ahp/hub.ts";
import { ApiError, api, type BriefNote, type FileName, type Snapshot } from "./api.ts";
import { adoptBrief, briefNotesOf, quoteMarks, renderQuotes } from "./brief.ts";
import { Composer } from "./composer.ts";
import { provOf, renderQuietBlock, revealStep, tagText } from "./drafted.ts";
import { Guide } from "./guide.ts";
import { DRAFTED_HELP, DRAFTING_HELP, LEAF_HELP, stageHelp } from "./help.ts";
import { InterviewScreen, interviewDone, PHONE_QUERY } from "./interview.ts";
import { Leaf } from "./leaf.ts";
import { letterRows, resumeRows, stripRow, tickerText } from "./letter.ts";
import { renderTurns, Transcript } from "./log.ts";
import { ensureLogin } from "./login.ts";
import { NotesView } from "./notes.ts";
import { Outbox } from "./outbox.ts";
import { Page } from "./page.ts";
import { ago } from "./rows.ts";
import {
  ArticleList,
  askLine,
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
import { TellsView } from "./tells-view.ts";
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
  quiet: $("quiet"),
  modeTag: $("mode-tag"),
  prLink: $<HTMLAnchorElement>("pr-link"),
  yours: $("yours"),
  quietBlock: $("quiet-block"),
  room: $("room"),
  yoursBtn: $<HTMLButtonElement>("yours-btn"),
  shelf: $("shelf"),
  shelfText: $("shelf-text"),
  shelfErr: $("shelf-err"),
  shelfBtn: $<HTMLButtonElement>("shelf-btn"),
  shelfEsc: $<HTMLButtonElement>("shelf-esc"),
  tells: $("tells"),
  tellsFoot: $("tells-foot"),
  pasted: $<HTMLButtonElement>("pasted"),
};
const tellButtons = [...document.querySelectorAll<HTMLButtonElement>("button.tells-btn")];
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
/** The coach's draft of a drafted article, from the snapshot: what provenance is computed against. */
let draft: { commit: string; base: Baseline } | null = null;
/** The article's authorship and whether a draft turn runs, as the session last said. */
let mode: { authorship: string; drafting: boolean } | undefined;
let snapAuthorship = "coached";

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
    onPaste: (text) => {
      if (active === "article" && !interview.visible) void checkPaste(text);
    },
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
  (to) => flip(to),
  () => openPublish(),
);

// ───────────────────────────── tells and pasted words ─────────────────────────────

/** The pasted spans the daemon recorded: each was the coach's words when it was pasted. */
let pasteIndex: OverlapIndex = overlapIndex([]);
let pasteKey = "[]";
function takePastes(list: readonly { text: string; source: string }[] | undefined): void {
  const pastes = Array.isArray(list) ? list : [];
  const key = JSON.stringify(pastes);
  if (key === pasteKey) return;
  pasteKey = key;
  pasteIndex = overlapIndex(pastes);
  pastedMemo = null;
  markPage();
}

/** Pasted text goes to the daemon, which says which of it is the coach's words. Under five words nothing can be. */
async function checkPaste(text: string): Promise<void> {
  if (wordCount(text) < 5) return;
  try {
    const res = await api.pastes(slug, text);
    takePastes(res.pastes);
    problem("paste", null);
  } catch (e) {
    problem(
      "paste",
      `the paste was not checked against the coach's words · ${e instanceof Error ? e.message : e}`,
    );
  }
}

/** How many words on the article page are pasted coach words, as it is typed. */
let pastedMemo: { text: string; n: number } | null = null;
function pastedWords(): number {
  const text = leaves.get("article")?.text ?? "";
  if (pastedMemo?.text !== text) pastedMemo = { text, n: overlapWords(overlap(text, pasteIndex)) };
  return pastedMemo.n;
}

/** The tells of the article as it is typed, beside the dump's. Counted again only when a text moves. */
let tellsMemo: { key: string; t: Tells } | null = null;
function currentTells(): Tells {
  const article = leaves.get("article")?.text ?? "";
  const dump = leaves.get("dump")?.text ?? "";
  const key = `${article}\u0000${dump}`;
  if (tellsMemo?.key !== key) tellsMemo = { key, t: tells(article, dump) };
  return tellsMemo.t;
}

/** True once the writer has opened the Tells table, for the guide. */
let tellsSeen = false;
const tellsView = new TellsView(els.tells, {
  jump: (hit) => {
    if (active !== "article") showLeaf("article");
    const block = splitBlocks(leaves.get("article")?.text ?? "")[hit.block];
    if (block === undefined || !page.select(block, hit.start, hit.end)) return;
    // Under 760px the table is a sheet over the page: it steps aside so the span can be seen. The tick stays.
    if (narrow.matches) setTells(false, null, true);
  },
  close: () => {
    setTells(false);
    tellButtons[0]?.focus();
  },
});
function setTells(open: boolean, row: TellKey | null = null, keepTick = false): void {
  els.tells.hidden = !open;
  for (const b of tellButtons) b.setAttribute("aria-expanded", String(open));
  if (open) {
    tellsSeen = true;
    tellsView.set(currentTells());
    tellsView.expand(row);
  } else if (!keepTick) page.clearTick();
  render();
}
for (const b of tellButtons)
  b.addEventListener("click", () => {
    const key = b.dataset.tell as TellKey;
    const t = currentTells();
    // The count that was clicked opens its own hits; clicking again closes the table.
    setTells(els.tells.hidden === true, t.hits[key].length > 0 ? key : null);
  });
els.pasted.addEventListener("click", () => {
  if (active === "article") page.nextUnder();
});

/** The foot's tells and `pasted N`: on the article leaf only, and counted from the page as it is typed. */
function renderTells(): void {
  // Under 760px a drafted article's foot says `N% yours` in place of the tells.
  const show = loaded && active === "article" && !(narrow.matches && isDrafted());
  els.tellsFoot.hidden = !show;
  if (!show) {
    if (!els.tells.hidden && active !== "article") setTells(false);
    return;
  }
  const t = currentTells();
  const words: Record<string, string> = {
    em: `em ${t.em}`,
    oneSentence: `¶1 ${t.oneSentence}`,
    notXButY: `not-x-but-y ${t.notXButY}`,
  };
  for (const b of tellButtons) {
    const text = words[b.dataset.tell ?? ""] ?? "";
    if (b.textContent !== text) b.textContent = text;
  }
  const n = pastedWords();
  const pasted = `pasted ${n}`;
  if (els.pasted.textContent !== pasted) els.pasted.textContent = pasted;
  els.pasted.disabled = n === 0;
  els.pasted.classList.toggle("has", n > 0);
  if (!els.tells.hidden) tellsView.set(t);
}

// ───────────────────────────── drafted mode ─────────────────────────────

const isDrafted = () => (currentMeta()?.authorship ?? snapAuthorship) === "drafted";

/**
 * The yes click of `send it` or `coached again`: the one call that changes authorship. The page is saved first,
 * since what is on it moves to the shelf. Resolves with why it did not go through, or null.
 */
async function flip(to: "coached" | "drafted"): Promise<string | null> {
  const leaf = leaves.get("article");
  if (leaf?.state.kind === "conflict") return "choose keep mine or take disk first";
  if (leaf?.dirty) await leaf.saveNow(false);
  if (leaf && (leaf.dirty || leaf.state.kind !== "saved"))
    return "article.md is not saved yet · try again once the foot says saved";
  try {
    await api.authorship(slug, to);
  } catch (e) {
    return e instanceof ApiError ? e.message : "could not reach the daemon";
  }
  // The draft lands on the article leaf, and so does the page that comes back.
  if (active !== "article") showLeaf("article");
  if (to === "coached") setShelf(false);
  return null;
}

/**
 * `publish →` in the stage menu, or `/publish`: every page is saved first, since the sheet shows what is on disk,
 * then the publish sheet opens. Resolves with why it did not open.
 */
async function openPublish(): Promise<string | null> {
  for (const leaf of leaves.values()) {
    if (leaf.state.kind === "conflict") return `${leaf.file}.md: choose keep mine or take disk first`;
    if (leaf.dirty) await leaf.saveNow(false);
    if (leaf.dirty || leaf.state.kind !== "saved")
      return `${leaf.file}.md is not saved yet · try again once the foot says saved`;
  }
  location.href = `/publish.html?slug=${encodeURIComponent(slug)}`;
  return null;
}

/** The provenance of the page as it is typed; null in a coached article. Computed again only when the text moves. */
let provMemo: { key: string; p: Provenance } | null = null;
function currentProv(): Provenance | null {
  if (!draft || !isDrafted()) return null;
  const text = leaves.get("article")?.text ?? "";
  const key = `${draft.commit}\n${text}`;
  if (provMemo?.key !== key) provMemo = { key, p: provenance(draft.base, text) };
  return provMemo.p;
}

/** The snapshot's draft becomes the baseline, and the article page gets its bars (or loses them). */
function takeDraft(snap: Snapshot): void {
  snapAuthorship = snap.authorship;
  draft =
    snap.authorship === "drafted" && snap.draft
      ? { commit: snap.draft.commit, base: baselineOf(snap.draft.text) }
      : null;
  provMemo = null;
  markPage();
}

/**
 * Authorship changed under the Room (the draft was accepted, or the page came back): the snapshot is fetched
 * again and the article leaf takes what is on disk. A draft that was just accepted lands block by block.
 */
let landNext = false;
async function modeChanged(landed: boolean): Promise<void> {
  try {
    const snap = await api.snapshot(slug);
    takeNotes(snap);
    takePastes(snap.pastes);
    const leaf = leaves.get("article");
    landNext = landed && active === "article" && !interview.visible;
    takeDraft(snap);
    // Refused while the writer has unsent text: the next save then meets the base_sha check and asks.
    leaf?.adopt(snap.files.article.text, snap.files.article.sha);
    landNext = false;
    problem("mode", null);
  } catch (e) {
    landNext = false;
    problem("mode", `the page did not refresh · ${e instanceof Error ? e.message : e} · reload to see it`);
  }
  render();
}

/** The shelf: the page from before the draft, read-only, beside the article so it can be copied from. */
async function setShelf(open: boolean): Promise<void> {
  els.shelf.hidden = !open;
  els.shelfBtn.setAttribute("aria-expanded", String(open));
  if (!open) return;
  els.shelfErr.hidden = true;
  els.shelfText.textContent = "";
  try {
    const { text } = await api.shelf(slug);
    if (text.trim() === "") {
      const p = document.createElement("p");
      p.className = "help";
      p.textContent = "The page was empty before the draft.";
      els.shelfText.replaceChildren(p);
    } else
      els.shelfText.replaceChildren(
        ...splitBlocks(text).map((b) => {
          const p = document.createElement("p");
          p.textContent = b;
          return p;
        }),
      );
  } catch (e) {
    els.shelfErr.textContent = `the shelf did not open · ${e instanceof Error ? e.message : e}`;
    els.shelfErr.hidden = false;
  }
}
els.shelfBtn.addEventListener("click", () => {
  void setShelf(els.shelf.hidden === true).then(() => {
    if (!els.shelf.hidden) els.shelfEsc.focus();
  });
});
els.shelfEsc.addEventListener("click", () => {
  void setShelf(false);
  els.shelfBtn.focus();
});

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

/**
 * `/ask <question>`: the question is parked at the paragraph the caret is in on the article page. The page is
 * saved first, since the host looks for that paragraph on disk. With no paragraph the question goes alone and
 * the coach answers in chat.
 */
async function sendAsk(from: Composer, text: string): Promise<void> {
  const leaf = leaves.get("article");
  const block = active === "article" && !interview.visible ? page.caretBlock() : null;
  if (block !== null && leaf) {
    if (leaf.dirty) await leaf.saveNow(false);
    if (leaf.dirty || leaf.state.kind !== "saved") {
      from.restore(text);
      from.note("article.md is not saved yet · /ask again once the foot says saved");
      return;
    }
  }
  sendLine(from, askLine(text, block), true);
}

/** A composer line: checked, then sent or kept in the outbox. Returns true when it went out now. */
function sendLine(from: Composer, text: string, asked = false): boolean {
  const cmd = asked ? null : parseCommand(text.split("\n", 1)[0] ?? "");
  if (cmd?.command.name === "ask" && cmd.rest) {
    void sendAsk(from, text);
    return false;
  }
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
  sendit: () => stageMenu.openSendit(),
  publish: () => void openPublish().then((err) => composer.note(err ? `not opened · ${err}` : "")),
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
    sendit: () => interview.openSendit(),
    publish: () => void openPublish().then((err) => ivComposer.note(err ? `not opened · ${err}` : "")),
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
    publish: $<HTMLButtonElement>("iv-publish"),
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
  () => flip("drafted"),
  () => openPublish(),
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
let seen = { stage: "", covered: 0, said: 0, drafted: false, pr: false };
/** The session's strictness and the article's quiet switch, as renderAhp last saw them. */
let strictness = "normal";
let quiet: boolean | undefined;
/** The passes that are not stage names: a note from one, or a pass result in the letter, is a pass that ran. */
const PASS_NAMES: ReadonlySet<string> = new Set(PASSES);

function updateGuide(): void {
  if (!loaded) return;
  const words = (f: FileName) => wordCount(leaves.get(f)?.text ?? "");
  guide?.update({
    where: "room",
    leaf: active,
    dumpWords: words("dump"),
    articleWords: words("article"),
    headings: splitBlocks(leaves.get("article")?.text ?? "").filter((b) => /^##+ /.test(b)).length,
    notes: notes.length,
    tells: tellsSeen,
    passes:
      notes.filter((n) => PASS_NAMES.has(n.pass)).length +
      (currentMeta()?.letter ?? []).filter((l) => l.kind === "passDone" || l.kind === "passEmpty").length,
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
  const drafting = meta?.drafting === true;
  const drafted = isDrafted();
  stageMenu.set(stage, meta?.covered, drafting, offline, drafted ? "drafted" : "coached");
  if (meta) {
    const now = { authorship: meta.authorship, drafting };
    // The draft was accepted, or the page came back from the shelf: what is on disk is not what is on screen.
    if (mode && mode.authorship !== now.authorship) void modeChanged(now.authorship === "drafted");
    mode = now;
  }
  // While the coach drafts, the article can be read and not typed in.
  page.setReadOnly(drafting && active === "article");
  const chat = chatUri ? conn.chat(chatUri) : undefined;
  const said = transcript(chat);
  if (!els.log.hidden) transcriptView.render(said);
  renderTurns(els.turns, said, interviewDone(meta?.covered), stageHelp(stage));
  const covered = meta?.covered?.length ?? 0;
  seen = {
    stage,
    covered,
    said: said.filter((l) => l.kind === "you").length,
    drafted,
    pr: typeof meta?.prNumber === "number",
  };
  const strict = session?.config?.values.strictness;
  strictness = typeof strict === "string" && strict ? strict : "normal";
  if (meta) {
    // `/quiet` folds the notes away and `quiet` shows in the foot; ending it brings them back.
    const now = meta.coachQuiet === true;
    if (now !== quiet && (quiet !== undefined || now)) {
      notesView.fold(now);
      if (now && notesView.sheetOpen) notesView.openSheet(false);
    }
    quiet = now;
    els.quiet.hidden = !now;
  }
  renderCoachStage();
  renderQueued();
  const pr = typeof meta?.prNumber === "number" ? `PR #${meta.prNumber}` : "";
  els.prLink.hidden = pr === "";
  if (pr && els.prLink.textContent !== pr) {
    els.prLink.textContent = pr;
    els.prLink.href = `/publish.html?slug=${encodeURIComponent(slug)}`;
  }

  if (meta && typeof meta.commentsRev === "number") {
    if (seenRev !== undefined && meta.commentsRev !== seenRev) void refetch();
    seenRev = meta.commentsRev;
  }

  interview.set({ slug, stage, covered: meta?.covered ?? [], offline, lines: said });
  // A draft in the making is watched on the article leaf, not from the interview screen.
  setInterview(loaded && phone.matches && stage === "interview" && !drafting);
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
  else {
    // The page was filled while the Room was hidden, when a block has no height to grow to.
    page.resize();
    markPage();
  }
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
      if (snap.draft?.commit !== draft?.commit) takeDraft(snap);
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
  // Words pasted from the coach carry a dotted underline while five of them still stand in a row.
  page.setUnder(active === "article" ? (b) => overlap(b, pasteIndex) : null);
  // In a drafted article each block the coach wrote carries its dotted bar, beside the note's solid one.
  page.setProv(active === "article" && draft && isDrafted() ? provOf(draft.base) : null);
}

/** The coach panel's head: the stage with what it counts, the strictness when it is not normal, and `quiet`. */
function renderCoachStage(): void {
  const { stage, covered } = seen;
  const parts = [
    stage === "interview"
      ? `interview · ${covered}/6 covered`
      : (stage === "critique" || stage === "polish") && notes.length > 0
        ? `${stage} · ${notesView.open} open`
        : stage,
  ];
  if (strictness !== "normal") parts.push(strictness);
  if (quiet) parts.push("quiet");
  if (seen.drafted) parts.unshift("drafted");
  els.coachStage.textContent = parts.join(" · ");
}

/** The notes list and the foot's notes button, from the snapshot's notes and the article as it is typed. */
function renderNotes(): void {
  notesView.set(notes, leaves.get("article")?.text ?? "");
  els.notesBtn.hidden = notes.length === 0 || !els.quietBlock.hidden;
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

/** Is the quiet block's sheet open (under 760px)? */
let quietSheet = false;
els.yoursBtn.addEventListener("click", () => {
  quietSheet = !quietSheet;
  render();
});
els.quietBlock.addEventListener("click", (e) => {
  if (!(e.target as HTMLElement).closest('[data-act="close"]')) return;
  quietSheet = false;
  render();
  els.yoursBtn.focus();
});

/** The tag in the head, `N% yours` in the foot, the quiet block and the shelf button: all drafted mode's. */
function renderDrafted(): void {
  const p = currentProv();
  const drafted = isDrafted();
  els.modeTag.hidden = !p;
  els.yours.hidden = !p;
  els.shelfBtn.hidden = !drafted;
  if (!drafted && !els.shelf.hidden) void setShelf(false);
  if (p) {
    els.modeTag.textContent = tagText(p.yoursPct);
    els.yours.textContent = `· ${p.yoursPct}% yours`;
  }
  // The quiet block stands where the notes do while the coach holds them.
  const quietBlock = !!p && currentMeta()?.coachQuiet === true;
  els.quietBlock.hidden = !quietBlock;
  els.room.classList.toggle("drafted-quiet", quietBlock);
  if (!quietBlock) quietSheet = false;
  // Under 760px the block is a sheet, opened from the foot's `N% yours` in place of the notes count.
  els.quietBlock.classList.toggle("sheet-open", quietSheet);
  els.yoursBtn.hidden = !quietBlock;
  els.yoursBtn.setAttribute("aria-expanded", String(quietSheet));
  if (p && quietBlock) {
    renderQuietBlock(els.quietBlock, p);
    els.yoursBtn.textContent = `${p.yoursPct}% yours ▴`;
  }
  if (quietBlock && notesView.sheetOpen) notesView.openSheet(false);
  const drafting = currentMeta()?.drafting === true;
  const help =
    active !== "article"
      ? LEAF_HELP[active].help
      : drafting
        ? DRAFTING_HELP
        : drafted
          ? DRAFTED_HELP
          : LEAF_HELP.article.help;
  if (els.leafHelp.textContent !== help) els.leafHelp.textContent = help;
}

/** The foot and the letter, from the active leaf and the socket. */
function render(): void {
  updateGuide();
  if (loaded) renderDrafted();
  if (loaded) renderNotes();
  renderTells();
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
  // Under 760px, while the coach is quiet, the strip is in the quiet block's sheet and not in the short panel.
  if (loaded && isDrafted() && !(narrow.matches && !els.quietBlock.hidden)) rows.push(strip);
  const tick = tickerRow();
  if (tick) rows.push(tick);
  rows.push(...hostLetter(), ...resumeEls);
  const info = conn.info;
  const down = info.status === "reconnecting" || (info.status === "connecting" && info.attempt > 0);
  if (down || info.status === "failed") rows.push(errRow(connectionWords(info)));
  els.letter.hidden = rows.length === 0;
  const same =
    rows.length === els.letter.children.length && rows.every((r, i) => r === els.letter.children[i]);
  if (!same) els.letter.replaceChildren(...rows);
}

/** The status strip of a drafted article: one element, so the letter is not rebuilt for it. */
const strip = stripRow();

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

/**
 * `running filler… 12s` while the coach works on a pass, with what waits behind it. One element, so the count
 * moves without the letter being rebuilt. A plain reply shows only once it has taken three seconds.
 */
const tickerEl = row(span(""));
tickerEl.classList.add("ticker");
tickerEl.setAttribute("role", "status");
function tickerRow(): HTMLDivElement | null {
  const meta = currentMeta();
  const run = meta?.run ?? null;
  const slow = run && (run.pass !== "" || Date.now() - Date.parse(run.startedAt) >= 3000);
  const text = tickerText(slow ? run : null, meta?.queued);
  if (!text) return null;
  const s = tickerEl.firstElementChild as HTMLElement;
  if (s.textContent !== text) s.textContent = text;
  return tickerEl;
}

/** The resume letter of the snapshot the Room opened with; empty once dismissed. */
let resumeEls: HTMLDivElement[] = [];

/** The host's letter lines, rebuilt only when they change so a `restore it` in flight keeps its state. */
let letterKey = "";
const dismissedLetter = new Set<string>();
let letterEls: HTMLDivElement[] = [];
function hostLetter(): HTMLDivElement[] {
  const letter = (currentMeta()?.letter ?? []).filter((l) => !dismissedLetter.has(l.id));
  const key = JSON.stringify(letter);
  if (key !== letterKey) {
    letterKey = key;
    letterEls = letterRows(
      letter,
      async (id) => {
        await api.letter(slug, id, "restore");
      },
      async (id) => {
        await api.letter(slug, id, "dismiss");
        // Gone at once here; the session's meta follows a moment later.
        dismissedLetter.add(id);
        render();
      },
    );
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
  } else if (leaf.file === active && fresh && !page.revealing && page.text() !== leaf.text) {
    // The coach's draft lands block by block; anything else is shown at once.
    if (landNext && leaf.file === "article")
      page.showReveal(leaf.text, "article", revealStep(), () => render());
    else page.show(leaf.text, leaf.file, LEAF_HELP[leaf.file].placeholder);
    markPage();
  }
  render();
}

async function load(): Promise<void> {
  const snap = await api.snapshot(slug);
  snapStage = snap.stage;
  takeNotes(snap);
  takeDraft(snap);
  takePastes(snap.pastes);
  for (const f of ["article", "dump", "brief"] as const) {
    const leaf = new Leaf(slug, f, snap.files[f].text, snap.files[f].sha, onLeafChange);
    leaves.set(f, leaf);
    leaf.replay();
  }
  loaded = true;
  if (snap.resume)
    resumeEls = resumeRows(snap.resume, {
      ago,
      open: (id) => {
        if (active !== "article") showLeaf("article");
        notesView.focus(id);
      },
      dismiss: () => {
        resumeEls = [];
        render();
      },
    });
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
  } else if (e.key === "Escape" && quietSheet) {
    quietSheet = false;
    render();
    els.yoursBtn.focus();
  } else if (e.key === "Escape" && !els.tells.hidden) {
    setTells(false);
    tellButtons[0]?.focus();
  } else if (e.key === "Escape" && !els.shelf.hidden) {
    void setShelf(false);
    els.shelfBtn.focus();
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
