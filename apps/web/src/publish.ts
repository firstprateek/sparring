// The publish page: the read-only post beside the publish sheet. Opened from the Room's stage menu
// (`publish →`) or `/publish`, as `/publish.html?slug=<slug>`. The preflight fills it; a field edit is stored
// with `PUT meta` and followed by a fresh preflight; the button posts the commit the sheet showed with the
// ticks. The job's steps arrive live in `_meta.sparring.publish` on the article's AHP session, and by asking the
// preflight again while the socket is down.
import "@fontsource/source-serif-4/400.css";
import "@fontsource/source-serif-4/400-italic.css";
import "@fontsource/source-serif-4/600.css";
import "@fontsource/jetbrains-mono/400.css";
import "./base.css";
import "./publish.css";
import { jobRunning, type Preflight } from "@sparring/protocol/publish";
import { ahp, useAhp } from "./ahp/hub.ts";
import { ApiError, api } from "./api.ts";
import { ensureLogin } from "./login.ts";
import { PublishSheet, renderPost } from "./publish-view.ts";
import { ArticleList, metaOf } from "./session.ts";
import { connectionWords } from "./status.ts";
import { UpdateWatch } from "./update.ts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const slug = new URLSearchParams(location.search).get("slug") ?? "";
const TICKS = `sparring-ticks:${slug}`;

const words = (e: unknown) => (e instanceof ApiError ? e.message : "could not reach the daemon");

function storedTicks(): string[] {
  try {
    const v = JSON.parse(sessionStorage.getItem(TICKS) ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function today(): string {
  const d = new Date();
  const two = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

let current: Preflight | null = null;
let connNote = "";

const sheet = new PublishSheet(
  $("sheet"),
  {
    saveMeta: async (meta) => {
      try {
        await api.saveMeta(slug, meta);
        const p = await api.preflight(slug);
        take(p, false);
        return p;
      } catch (e) {
        return words(e);
      }
    },
    ship: async (ticked) => {
      if (!current) return { error: "the sheet has not loaded" };
      try {
        await api.publish(slug, {
          article_commit: current.article_commit,
          origin_sha: current.origin.sha,
          ticked,
        });
        void refresh();
        return null;
      } catch (e) {
        const fresh = e instanceof ApiError ? (e.body.preflight as Preflight | undefined) : undefined;
        if (fresh) take(fresh, false);
        return { error: words(e), ...(fresh ? { preflight: fresh } : {}) };
      }
    },
    today,
    ticksChanged: (ticked) => {
      try {
        sessionStorage.setItem(TICKS, JSON.stringify(ticked));
      } catch {
        // The ticks then live in this page only.
      }
    },
  },
  storedTicks(),
);

/** A preflight arrived: the page, the sheet (unless the sheet asked for it and sets it itself) and the chrome. */
function take(p: Preflight, toSheet = true): void {
  current = p;
  renderPost($("front"), $("post"), p);
  if (toSheet) sheet.set(p);
  setTimeout(chrome, 0);
}

function chrome(): void {
  const c = sheet.chrome();
  $("mode-tag").hidden = c.tag === "";
  $("mode-tag").textContent = c.tag;
  $("stage-word").textContent = c.stage;
  $("foot-left").textContent = c.left;
  const right = $("foot-right");
  right.textContent = connNote || c.right;
  right.classList.toggle("err", connNote !== "");
}

let refreshing: Promise<void> | null = null;
function refresh(): Promise<void> {
  refreshing ??= (async () => {
    try {
      take(await api.preflight(slug));
    } catch (e) {
      sheet.fail(`the sheet did not load · ${words(e)} · reload to try again`);
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

// ───────────────────────────── the job, live ─────────────────────────────

const conn = ahp();
let list: ArticleList | undefined;
let sessionUri: string | undefined;
let release: (() => void) | undefined;

function attach(): void {
  const summary = list?.bySlug(slug);
  if (!summary) return;
  if (summary.resource !== sessionUri) {
    release?.();
    sessionUri = summary.resource;
    release = conn.watch(sessionUri);
  }
  follow();
}

function follow(): void {
  const meta = metaOf(sessionUri ? conn.session(sessionUri) : undefined) ?? metaOf(list?.bySlug(slug));
  if (!meta) return;
  // A job that just ended changed the site and the article's PR: the preflight says how.
  if (sheet.setJob(meta.publish)) void refresh();
}

conn.onChange((uris) => {
  if (sessionUri && uris.has(sessionUri)) follow();
});
conn.onInfo((i) => {
  const down =
    i.status === "reconnecting" || (i.status === "connecting" && i.attempt > 0) || i.status === "failed";
  connNote = down ? connectionWords(i) : "";
  chrome();
});
// With the socket down the log still moves: the preflight carries the job too.
setInterval(() => {
  if (conn.info.status !== "open" && jobRunning(current?.publish)) void refresh();
}, 2000);

async function main(): Promise<void> {
  if (!slug) {
    location.replace("/");
    return;
  }
  document.title = `publish ${slug} · Sparring`;
  $("slug").textContent = slug;
  $<HTMLAnchorElement>("room-link").href = `/room.html?slug=${encodeURIComponent(slug)}`;
  await ensureLogin(() => {
    conn.retryNow();
    void refresh();
  });
  await refresh();
  useAhp();
  list = new ArticleList(conn);
  list.onChange(attach);
}

new UpdateWatch({
  beforeReload: async () => (jobRunning(current?.publish) ? "a publish is running" : null),
}).start();
main().catch((e) => sheet.fail(`the sheet did not open · ${e instanceof Error ? e.message : String(e)}`));
