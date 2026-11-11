// Articles: the `>` idea field and the inbox (`GET` and `POST /api/inbox`, `→ article` on each idea), every
// article from the AHP root session list and its `_meta.sparring`, `+ new article`, and the keys j, k, enter, n
// and i. There is no REST list; a save made elsewhere reaches the row through root/sessionSummaryChanged.
import "@fontsource/source-serif-4/400.css";
import "@fontsource/jetbrains-mono/400.css";
import "./base.css";
import "./index.css";
import type { SessionSummary } from "@microsoft/agent-host-protocol";
import { slugProblem } from "@sparring/protocol/slug";
import { ahp, useAhp } from "./ahp/hub.ts";
import { ApiError, api, type Idea } from "./api.ts";
import { daemonHost } from "./config.ts";
import { inboxRows } from "./inbox.ts";
import { ensureLogin } from "./login.ts";
import { headLine, rowSub, rowTail } from "./rows.ts";
import { ArticleList, metaOf } from "./session.ts";
import { connectionWords } from "./status.ts";
import { wireTheme } from "./theme.ts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
wireTheme($<HTMLButtonElement>("theme"));

const els = {
  rows: $("articles"),
  empty: $("empty"),
  headLine: $("head-line"),
  headSep: $("head-sep"),
  conn: $("conn"),
  newBtn: $<HTMLButtonElement>("new-btn"),
  newForm: $<HTMLFormElement>("new"),
  newInput: $<HTMLInputElement>("new-slug"),
  newError: $("new-error"),
  ideaForm: $<HTMLFormElement>("idea-form"),
  idea: $<HTMLInputElement>("idea"),
  ideaError: $("idea-error"),
  inboxSec: $("inbox-sec"),
  inbox: $("inbox"),
};

const roomUrl = (slug: string, leaf?: "dump") =>
  `/room.html?slug=${encodeURIComponent(slug)}${leaf ? `&leaf=${leaf}` : ""}`;

const failed = (err: unknown) => (err instanceof ApiError ? err.message : "could not reach the daemon");

function span(text: string, cls?: string): HTMLSpanElement {
  const s = document.createElement("span");
  if (cls) s.className = cls;
  s.textContent = text;
  return s;
}

function row(s: SessionSummary): HTMLAnchorElement | null {
  const m = metaOf(s);
  if (!m) return null;
  const a = document.createElement("a");
  a.className = "row";
  a.href = roomUrl(m.slug);
  a.dataset.slug = m.slug;
  const tail = span("", "mono muted tail");
  tail.append(...rowTail(m).map((p) => span(p.text, p.cls)));
  const top = span("", "top");
  top.append(span(s.title && s.title !== m.slug ? s.title : m.slug), tail);
  a.append(top);
  const sub = rowSub(m);
  if (sub) a.append(span(sub, "muted sub"));
  return a;
}

let list: ArticleList | undefined;
let shown = "";

function render(): void {
  if (!list) return;
  const sessions = list.list();
  // Rebuild only when something a row shows has changed, so a focused or hovered row is left alone.
  const key = JSON.stringify([
    list.loaded,
    sessions.map((s) => {
      const m = metaOf(s);
      return m ? [s.title, m.slug, rowTail(m), rowSub(m), m.provider, m.tokens] : null;
    }),
  ]);
  if (key === shown) return;
  shown = key;
  const focused = (document.activeElement as HTMLElement | null)?.dataset?.slug;
  els.rows.replaceChildren(...sessions.map(row).filter((r): r is HTMLAnchorElement => r !== null));
  if (focused) els.rows.querySelector<HTMLElement>(`[data-slug="${CSS.escape(focused)}"]`)?.focus();
  els.empty.hidden = !list.loaded || sessions.length > 0;
  const head = headLine(sessions.map(metaOf).filter((m) => m !== undefined));
  els.headLine.textContent = head;
  els.headSep.hidden = head === "";
}

function renderConn(): void {
  els.conn.textContent = `${daemonHost()} · ${connectionWords(ahp().info)}`;
}

// ───────────────────────────── + new article ─────────────────────────────

function openNew(): void {
  els.newBtn.hidden = true;
  els.newForm.hidden = false;
  els.newError.textContent = "";
  els.newInput.focus();
}
function closeNew(): void {
  els.newForm.hidden = true;
  els.newBtn.hidden = false;
  els.newInput.value = "";
  els.newError.textContent = "";
}
els.newBtn.addEventListener("click", openNew);
els.newInput.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    e.preventDefault();
    closeNew();
    els.newBtn.focus();
  }
});
els.newForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const slug = els.newInput.value.trim();
  const problem = slugProblem(slug);
  if (problem) {
    els.newError.textContent = problem;
    return;
  }
  try {
    await api.createArticle(slug);
    location.href = roomUrl(slug);
  } catch (err) {
    els.newError.textContent = failed(err);
  }
});

// ───────────────────────────── ideas ─────────────────────────────

function renderInbox(items: Idea[]): void {
  // Leave the list alone while a slug is being typed into one of its rows.
  if (els.inbox.querySelector("form.slug")) return;
  els.inbox.replaceChildren(
    ...inboxRows(items, {
      check: slugProblem,
      article: async (idea, slug) => {
        try {
          await api.createArticle(slug, idea.id);
        } catch (err) {
          throw new Error(failed(err));
        }
        location.href = roomUrl(slug, "dump");
      },
    }),
  );
  els.inboxSec.hidden = items.length === 0;
}

async function loadInbox(): Promise<void> {
  try {
    const items = await api.inbox();
    renderInbox(Array.isArray(items) ? items : []);
  } catch (err) {
    showIdeaError(`inbox · ${failed(err)}`);
  }
}

function showIdeaError(text: string): void {
  els.ideaError.textContent = text;
  els.ideaError.hidden = text === "";
}

els.idea.addEventListener("input", () => showIdeaError(""));
els.ideaForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = els.idea.value.trim();
  if (!text) return;
  els.idea.disabled = true;
  try {
    await api.addIdea(text);
    els.idea.value = "";
    await loadInbox();
  } catch (err) {
    showIdeaError(`not kept · ${failed(err)}`);
  } finally {
    els.idea.disabled = false;
    els.idea.focus();
  }
});
els.idea.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    e.preventDefault();
    els.idea.blur();
  }
});

// ───────────────────────────── keys ─────────────────────────────

document.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
  const t = e.target as HTMLElement | null;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
  const rows = [...els.rows.querySelectorAll<HTMLAnchorElement>("a.row")];
  const at = rows.indexOf(document.activeElement as HTMLAnchorElement);
  if (e.key === "j" || e.key === "k") {
    if (rows.length === 0) return;
    e.preventDefault();
    const next = at < 0 ? (e.key === "j" ? 0 : rows.length - 1) : at + (e.key === "j" ? 1 : -1);
    rows[Math.max(0, Math.min(rows.length - 1, next))]?.focus();
  } else if (e.key === "Enter" && at >= 0) {
    e.preventDefault();
    location.href = rows[at]?.href ?? location.href;
  } else if (e.key === "n") {
    e.preventDefault();
    openNew();
  } else if (e.key === "i") {
    e.preventDefault();
    els.idea.focus();
  }
});

// ───────────────────────────── start ─────────────────────────────

async function main(): Promise<void> {
  renderConn();
  await ensureLogin(() => {
    ahp().retryNow();
    void loadInbox();
  });
  void loadInbox();
  useAhp();
  const conn = ahp();
  list = new ArticleList(conn);
  list.onChange(render);
  conn.onInfo(renderConn);
  // Ideas added elsewhere (`/idea` in a Room, another device) show on the next reconnect or return to the tab.
  let wasOpen = conn.info.status === "open";
  conn.onInfo((i) => {
    const open = i.status === "open";
    if (open && !wasOpen) void loadInbox();
    wasOpen = open;
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void loadInbox();
  });
  setInterval(() => {
    renderConn();
    render(); // save ages move on
  }, 1000);
  renderConn();
}

void main();
