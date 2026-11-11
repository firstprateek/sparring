// The Room: the three leaves of one article as a block page, saved to ~/writing as you type, with the coach in
// the margin over AHP. The article's session and chat are found in the root session list by
// `_meta.sparring.slug`; the stage menu changes the session's `stage`; the composer sends chat lines, kept in
// the outbox while the socket is down; `⋯` opens the transcript.
import "@fontsource/source-serif-4/400.css";
import "@fontsource/source-serif-4/400-italic.css";
import "@fontsource/source-serif-4/600.css";
import "@fontsource/jetbrains-mono/400.css";
import "./base.css";
import "./room.css";
import { wordCount } from "@sparring/protocol/blocks";
import { checkOutgoing } from "./actions.ts";
import { ahp, useAhp } from "./ahp/hub.ts";
import { api, type FileName } from "./api.ts";
import { Composer } from "./composer.ts";
import { Leaf } from "./leaf.ts";
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

const slug = new URLSearchParams(location.search).get("slug") ?? "";
const els = {
  slug: $("slug"),
  words: $("words"),
  saved: $("saved"),
  letter: $("letter"),
  paras: $("paras"),
  body: $("body"),
  asideDump: $("aside-dump"),
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

const page = new Page(els.paras, (text) => leaves.get(active)?.edit(text));

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

const composer = new Composer($<HTMLTextAreaElement>("composer"), $("slash"), $("comp-note"), $("queued"), {
  line: (text) => {
    const problem = checkOutgoing(text);
    if (problem) {
      composer.note(problem);
      composer.restore(text);
      return;
    }
    // A line that went out opens the transcript so the reply shows; a queued one leaves the margin in view.
    const went = outbox.push(text) === "sent";
    renderAhp();
    if (went && active !== "dump") setLog(true);
  },
  log: () => setLog(true),
  escape: () => setLog(false),
});
outbox.onChange(() => renderQueued());

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
  composer.queued([
    ...outbox.lines().map((l) => l.text),
    ...hostQueued(chatUri ? conn.chat(chatUri) : undefined),
  ]);
}

/** The stage word, the transcript, the interview turns and the queued lines, from the session and chat. */
function renderAhp(): void {
  const session = sessionUri ? conn.session(sessionUri) : undefined;
  const meta = metaOf(session) ?? metaOf(sessionUri ? list?.bySlug(slug) : undefined);
  stageMenu.set(stageOf(session, meta, snapStage), meta?.covered, meta?.drafting === true);
  const chat = chatUri ? conn.chat(chatUri) : undefined;
  const said = transcript(chat);
  if (!els.log.hidden) transcriptView.render(said);
  if (active === "dump") renderTurns(els.turns, said);
  renderQueued();
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
  const info = conn.info;
  const down = info.status === "reconnecting" || (info.status === "connecting" && info.attempt > 0);
  if (down || info.status === "failed") rows.push(row(span(connectionWords(info))));
  els.letter.hidden = rows.length === 0;
  els.letter.replaceChildren(...rows);
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
  page.show(leaves.get(file)?.text ?? "", file);
  render();
  renderAhp();
}

function onLeafChange(leaf: Leaf, commit?: string): void {
  if (commit) shownCommit = { sha: commit.slice(0, 7), until: Date.now() + 2000 };
  // `take disk` replaced the text: show it when it is the leaf on screen.
  if (leaf.file === active && !leaf.dirty && leaf.state.kind === "saved" && page.text() !== leaf.text) {
    page.show(leaf.text, leaf.file);
  }
  render();
}

let loaded = false;

async function load(): Promise<void> {
  const snap = await api.snapshot(slug);
  snapStage = snap.stage;
  for (const f of ["article", "dump", "brief"] as const) {
    const leaf = new Leaf(slug, f, snap.files[f].text, snap.files[f].sha, onLeafChange);
    leaves.set(f, leaf);
    leaf.replay();
  }
  loaded = true;
  const first =
    snap.files.article.text.trim() === "" && snap.files.dump.text.trim() !== "" ? "dump" : "article";
  showLeaf(first);
  page.focusEnd();
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
