// The Room, step 1: the three leaves of one article as a block page, saved to ~/writing as you type.
// The coach, the notes and the stage menu arrive with AHP in later steps.
import "@fontsource/source-serif-4/400.css";
import "@fontsource/source-serif-4/400-italic.css";
import "@fontsource/source-serif-4/600.css";
import "@fontsource/jetbrains-mono/400.css";
import "./base.css";
import "./room.css";
import { wordCount } from "@sparring/protocol/blocks";
import { api, type FileName } from "./api.ts";
import { Leaf } from "./leaf.ts";
import { Page } from "./page.ts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const slug = new URLSearchParams(location.search).get("slug") ?? "";
const els = {
  slug: $("slug"),
  stage: $("stage-word"),
  words: $("words"),
  saved: $("saved"),
  letter: $("letter"),
  paras: $("paras"),
};
const leafButtons = [...document.querySelectorAll<HTMLButtonElement>("button[data-leaf]")];

let active: FileName = "article";
const leaves = new Map<FileName, Leaf>();
let shownCommit: { sha: string; until: number } | null = null;

const page = new Page(els.paras, (text) => leaves.get(active)?.edit(text));

function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
}

/** The foot and the letter, from the active leaf. */
function render(): void {
  const leaf = leaves.get(active);
  if (!leaf) return;
  els.words.textContent = `${wordCount(leaf.text)} words`;
  const st = leaf.state;
  if (shownCommit && Date.now() < shownCommit.until) els.saved.textContent = `committed ${shownCommit.sha}`;
  else if (st.kind === "saving") els.saved.textContent = "saving";
  else if (st.kind === "retrying") els.saved.textContent = "unsaved · retrying";
  else if (st.kind === "diskFull") els.saved.textContent = "disk full · not saved";
  else if (st.kind === "conflict") els.saved.textContent = "unsaved";
  else if (leaf.dirty) els.saved.textContent = "unsaved";
  else els.saved.textContent = `saved ${ago(Date.now() - st.at)}`;

  const conflict = [...leaves.values()].find((l) => l.state.kind === "conflict");
  els.letter.hidden = !conflict;
  if (conflict) {
    const keep = button("keep mine", () => void conflict.keepMine());
    const take = button("take disk", () => void conflict.takeDisk());
    const where = conflict.file === "article" ? [] : [span(`${conflict.file}.md`), span("·")];
    els.letter.replaceChildren(
      ...where,
      span("disk changed while offline"),
      span("·"),
      keep,
      span("·"),
      take,
    );
  }
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
  page.show(leaves.get(file)?.text ?? "", file);
  render();
}

function onLeafChange(leaf: Leaf, commit?: string): void {
  if (commit) shownCommit = { sha: commit.slice(0, 7), until: Date.now() + 2000 };
  // `take disk` replaced the text: show it when it is the leaf on screen.
  if (leaf.file === active && !leaf.dirty && leaf.state.kind === "saved" && page.text() !== leaf.text) {
    page.show(leaf.text, leaf.file);
  }
  render();
}

async function main(): Promise<void> {
  if (!slug) {
    location.replace("/");
    return;
  }
  document.title = `${slug} · Sparring`;
  els.slug.textContent = slug;
  const snap = await api.snapshot(slug);
  els.stage.textContent = snap.stage;
  for (const f of ["article", "dump", "brief"] as const) {
    const leaf = new Leaf(slug, f, snap.files[f].text, snap.files[f].sha, onLeafChange);
    leaves.set(f, leaf);
    leaf.replay();
  }
  try {
    const recent = JSON.parse(localStorage.getItem("sparring-recent") ?? "[]") as string[];
    localStorage.setItem(
      "sparring-recent",
      JSON.stringify([slug, ...recent.filter((s) => s !== slug)].slice(0, 20)),
    );
  } catch {}
  const first =
    snap.files.article.text.trim() === "" && snap.files.dump.text.trim() !== "" ? "dump" : "article";
  showLeaf(first);
  page.focusEnd();
}

for (const b of leafButtons) b.addEventListener("click", () => showLeaf(b.dataset.leaf as FileName));

document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "s") {
    e.preventDefault();
    void leaves.get(active)?.saveNow(true);
  }
});
window.addEventListener("pagehide", () => {
  for (const l of leaves.values()) if (l.dirty) void l.saveNow(false);
});
setInterval(render, 1000);

main().catch((e: unknown) => {
  els.letter.hidden = false;
  els.letter.replaceChildren(span(e instanceof Error ? e.message : String(e)));
});
