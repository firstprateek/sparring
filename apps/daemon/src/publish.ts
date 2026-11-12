// Publishing (design section 3, "Publishing into the Astro site"): one reviewed commit of article.md becomes a
// pull request on the site repo. The preflight says what a publish would do and what stops it; `publish` repeats
// every check on the commit the owner reviewed and then runs the job: worktree, write, build, commit, push, PR.
// Each attempt is one `publishes` row whose `step` says how far it got. Nothing here merges, and nothing pushes
// to a ref outside `refs/heads/post/`.
//
// The site is the clone at `~/.sparring/site`. Every site file is read with `git show origin/main:<path>`, never
// from a working tree. Every git, npm and gh call is an argv array run with an environment built from scratch.
import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { splitBlocks, wordCount } from "@sparring/protocol/blocks";
import { type CorpusEntry, overlap, overlapIndex } from "@sparring/protocol/overlap";
import { blockHash, blockWords, countsLine, provenance, publishBlocks } from "@sparring/protocol/provenance";
import {
  blockers,
  type PostMeta,
  type Preflight,
  type PublishCheck,
  type PublishJob,
  type PublishKind,
  type PublishSpan,
  postMeta,
  realDate,
} from "@sparring/protocol/publish";
import { type ArticleRow, type Articles, HttpError } from "./articles.ts";
import type { Db } from "./db.ts";

export const POSTS_DIR = "src/content/posts";
export const SITE_CONFIG = "src/site.config.ts";
export const PLACEHOLDER = /todo[-_]replace[-_]before[-_]launch/i;
export const postPath = (slug: string) => `${POSTS_DIR}/${slug}.md`;

/** The steps of a job, in order. A row ends at `done` or `failed`. */
export const STEPS = ["validate", "worktree", "write", "build", "commit", "push", "pr"] as const;
export type Step = (typeof STEPS)[number];

const BUILD_MS = 5 * 60_000;
const CMD_MS = 60_000;
/** The log lines `_meta.sparring.publish` carries, and how long one may be. */
const LINES_MAX = 120;
const LINE_MAX = 300;

// ───────────────────────────── the post ─────────────────────────────

/**
 * The body as it is published, and the same text with its code blanked out for the checks. `<!-- -->` comments
 * are removed outside fenced and inline code; what is left is trimmed.
 */
export function cleanBody(article: string): { body: string; prose: string } {
  const lines = article.replace(/\r\n?/g, "\n").split("\n");
  let body = "";
  let prose = "";
  let chunk: string[] = [];
  const blank = (s: string) => s.replace(/[^\n]/g, " ");
  const flush = () => {
    if (chunk.length === 0) return;
    const text = chunk.join("\n");
    chunk = [];
    let i = 0;
    while (i < text.length) {
      if (text.startsWith("<!--", i)) {
        const end = text.indexOf("-->", i + 4);
        i = end < 0 ? text.length : end + 3;
        continue;
      }
      if (text[i] === "`") {
        let n = 1;
        while (text[i + n] === "`") n++;
        // An inline code span closes on a run of the same length.
        let close = -1;
        for (let j = i + n; j < text.length; j++) {
          if (text[j] !== "`") continue;
          let m = 1;
          while (text[j + m] === "`") m++;
          if (m === n) {
            close = j;
            break;
          }
          j += m - 1;
        }
        if (close >= 0) {
          const span = text.slice(i, close + n);
          body += span;
          prose += blank(span);
          i = close + n;
          continue;
        }
        body += text.slice(i, i + n);
        prose += text.slice(i, i + n);
        i += n;
        continue;
      }
      body += text[i];
      prose += text[i];
      i++;
    }
    body += "\n";
    prose += "\n";
  };
  let fence: { ch: string; n: number } | null = null;
  for (const line of lines) {
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      body += `${line}\n`;
      prose += `${blank(line)}\n`;
      if (
        m &&
        (m[1] as string)[0] === fence.ch &&
        (m[1] as string).length >= fence.n &&
        /^[ `~]*$/.test(line)
      )
        fence = null;
      continue;
    }
    if (m) {
      flush();
      fence = { ch: (m[1] as string)[0] as string, n: (m[1] as string).length };
      body += `${line}\n`;
      prose += `${blank(line)}\n`;
      continue;
    }
    chunk.push(line);
  }
  flush();
  // Both are trimmed alike, so a place in one is the same place in the other.
  const lead = body.length - body.trimStart().length;
  const end = body.trimEnd().length;
  return { body: body.slice(lead, end), prose: prose.slice(lead, end) };
}

const INVISIBLE =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this looks for
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F­᠎​-‏‪-‮⁠-⁤⁦-⁩﻿]/u;
const SCHEME = /^([a-z][a-z0-9+.-]*):/i;
const ALLOWED_SCHEMES: ReadonlySet<string> = new Set(["http", "https", "mailto"]);
const cut = (s: string, n = 40) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** What the body check found: the refusals stop a publish, the warnings do not. */
export interface BodyReport {
  frontmatter: boolean;
  h1: string | null;
  image: boolean;
  html: string | null;
  scheme: string | null;
  invisible: string | null;
  deep: string | null;
  empty: boolean;
}

/** Check 4 of section 3, on the cleaned body. */
export function checkBody(body: string, prose: string): BodyReport {
  const proseLines = prose.split("\n");
  const bodyLines = body.split("\n");
  const heading = (re: RegExp) => {
    const i = proseLines.findIndex((l) => re.test(l));
    return i < 0 ? null : cut((bodyLines[i] ?? "").trim());
  };
  let html: string | null = null;
  let scheme: string | null = null;
  const badScheme = (url: string) => {
    const m = SCHEME.exec(url.trim());
    if (m && !ALLOWED_SCHEMES.has((m[1] as string).toLowerCase())) scheme ??= `${m[1]}:`;
  };
  for (const m of prose.matchAll(/<([^<>\s][^<>]*)>/g)) {
    const inner = m[1] as string;
    // CommonMark autolinks pass: <https://…>, <mailto:…>, <name@host>.
    if (/^[a-z][a-z0-9+.-]{1,31}:[^\s<>]*$/i.test(inner)) badScheme(inner);
    else if (/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(inner)) continue;
    else if (/^[/!?]?[A-Za-z]/.test(inner) || /^[!?]/.test(inner)) html ??= cut(`<${inner}>`);
  }
  if (!html && /<!(--|\[CDATA\[|DOCTYPE)/i.test(prose)) html = "<!";
  // Inline links and images `](url`, and reference definitions `[name]: url`.
  for (const m of prose.matchAll(/\]\(\s*<?([^)\s>]+)/g)) badScheme(m[1] as string);
  for (const m of prose.matchAll(/^ {0,3}\[[^\]\n]+\]:\s*<?(\S+)/gm)) badScheme(m[1] as string);
  const inv = INVISIBLE.exec(body);
  return {
    frontmatter: /^---[ \t]*(\n|$)/.test(body),
    h1: heading(/^ {0,3}#(\s|$)/),
    image: prose.includes("!["),
    html,
    scheme,
    invisible: inv
      ? `U+${(inv[0].codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")} in ¶${
          splitBlocks(body.slice(0, inv.index + 1)).length
        }`
      : null,
    deep: heading(/^ {0,3}#{4,}(\s|$)/),
    empty: body.trim() === "",
  };
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * The exact file a publish writes. Pure. Four frontmatter keys in the order title, date, description, draft;
 * title and description are trimmed single lines passed through `JSON.stringify`; `draft` is always false, since
 * a draft post gets no route. The body is the cleaned article.
 */
export function buildPost(meta: Pick<PostMeta, "title" | "description" | "date">, article: string): string {
  const { body } = cleanBody(article);
  return [
    "---",
    `title: ${JSON.stringify(oneLine(meta.title))}`,
    `date: ${meta.date.trim()}`,
    `description: ${JSON.stringify(oneLine(meta.description))}`,
    "draft: false",
    "---",
    "",
    body,
    "",
  ].join("\n");
}

/** The body's disclosure line: the paragraph that opens with `Disclosure`, or "". */
export function disclosureLine(body: string): string {
  const hit = splitBlocks(body).find((b) => /^[\s>*_]*disclosure\b/i.test(b));
  return hit ? oneLine(hit) : "";
}

/** What the PR description is built from. */
export interface PrFacts {
  slug: string;
  meta: PostMeta;
  preflight: Preflight;
  ticked: readonly string[];
  buildLine: string;
}

/** The PR description: the route and file, the date, the word count, the build line, the article commit, then provenance. */
export function prBody(f: PrFacts): string {
  const p = f.preflight;
  const c = p.counts;
  const have = new Set(f.ticked);
  const out = [
    `Post \`/writing/${f.slug}/\` from \`${p.path}\`.`,
    "",
    `- date: ${f.meta.date}`,
    `- words: ${c.words}`,
    `- build: ${f.buildLine}`,
    `- Sparring article commit: ${p.article_commit}`,
    "",
    "Provenance (recorded by Sparring; not part of the post)",
    "",
  ];
  if (p.authorship === "drafted") {
    const coach = p.blocks.filter((b) => b.state === "coach");
    out.push(
      "- mode: drafted · the coach wrote the first draft and the writer reviewed it alone",
      `- blocks: ${countsLine({ counts: p.blockCounts })}`,
      `- ${p.yoursPct}% of the words are the writer's`,
      `- coach blocks ticked "I chose these words": ${coach.filter((b) => have.has(b.hash)).length} of ${coach.length}`,
      `- runs of the coach's chat words in the text: ${c.spans} · pasted words ${c.pastedWords}`,
    );
  } else {
    out.push(
      "- mode: coached · the writer wrote the page",
      `- questions asked ${c.questions} · comments ${c.comments} · done ${c.done} · dismissed ${c.dismissed}`,
      `- disagreed ${c.disagreed} · violations ${c.violations} · pasted words ${c.pastedWords}`,
      `- agent-word spans kept and ticked "I chose these words": ${p.spans.filter((s) => have.has(s.hash)).length} of ${p.spans.length}`,
      ...p.spans.map((s) => `  - "${oneLine(s.text)}" (¶${s.block}, ${s.source})`),
    );
  }
  out.push(`- disclosure line: ${p.disclosure ? `"${p.disclosure}"` : "none"}`, "");
  return out.join("\n");
}

// ───────────────────────────── running commands ─────────────────────────────

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}
export type Exec = (
  cmd: string,
  args: string[],
  o: { cwd: string; env: Record<string, string>; timeoutMs: number },
) => Promise<ExecResult>;

const realExec: Exec = (cmd, args, o) =>
  new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { cwd: o.cwd, env: o.env, timeout: o.timeoutMs, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const e = err as (Error & { code?: unknown; killed?: boolean }) | null;
        const code = e ? (typeof e.code === "number" ? e.code : 1) : 0;
        const note = e?.killed
          ? `\ntimed out after ${Math.round(o.timeoutMs / 1000)}s`
          : e && typeof e.code !== "number"
            ? `\n${e.message}`
            : "";
        resolve({ code, stdout: String(stdout), stderr: String(stderr) + note });
      },
    );
  });

/** What `config.json` says about publishing. Read on every preflight, so a fix needs no restart. */
export interface PublishSettings {
  siteRepo?: string;
  gitName?: string;
  gitEmail?: string;
}

/** The publish keys of `<home>/config.json`: `site_repo`, `publish.git_name`, `publish.git_email`. */
export function readPublishSettings(home: string): PublishSettings {
  try {
    const raw = JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as Record<string, unknown>;
    const pub = (raw.publish && typeof raw.publish === "object" ? raw.publish : {}) as Record<
      string,
      unknown
    >;
    const s = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
    const out: PublishSettings = {};
    const repo = s(raw.site_repo);
    const name = s(pub.git_name);
    const email = s(pub.git_email);
    if (repo) out.siteRepo = repo;
    if (name) out.gitName = name;
    if (email) out.gitEmail = email;
    return out;
  } catch {
    return {};
  }
}

const SITE_REPO_RE = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/;

export interface PublisherOptions {
  articles: Articles;
  db: Db;
  /** `~/.sparring`: the clone is `site/`, the worktrees `worktrees/<slug>`, the logs `logs/publish-<id>.log`. */
  home: string;
  settings: () => PublishSettings;
  /** The PATH the children get. Defaults to the daemon's own. */
  path?: string;
  /** Runs a command. Tests wrap it to stop a job where a dead daemon would have. */
  exec?: Exec;
  /** Everything the coach said in an article, for the agent-word spans. */
  corpus?: (slug: string) => Promise<{ entries: CorpusEntry[]; own: string[] }>;
  /** A host line in the article's chat. `bad` lines are drawn in red. */
  say?: (row: ArticleRow, text: string, bad: boolean) => void;
  /** The article's meta changed: send it now. */
  changed?: (articleId: string) => void;
  log?: (m: string) => void;
  buildMs?: number;
  cmdMs?: number;
  /** `git fetch` runs at most this often for a preflight (ms); a publish always fetches. */
  fetchEveryMs?: number;
  /** `gh pr view` runs at most this often per article (ms): a minute. */
  prPollMs?: number;
}

interface PublishRow {
  id: number;
  article_id: string;
  n: number;
  kind: string;
  article_commit: string;
  branch: string | null;
  worktree: string | null;
  step: string;
  error: string | null;
  log_json: string;
  pr_number: number | null;
  pr_url: string | null;
  pr_state: string | null;
  [k: string]: unknown;
}

class JobError extends Error {}

export class Publisher {
  private readonly o: PublisherOptions;
  private readonly exec: Exec;
  /** One mutex per article. */
  private readonly running = new Set<string>();
  private readonly jobs = new Set<Promise<void>>();
  private lastFetch = 0;
  private machineOkAt = 0;
  private readonly prPolledAt = new Map<string, number>();
  private watcher: ReturnType<typeof setInterval> | undefined;

  constructor(o: PublisherOptions) {
    this.o = o;
    this.exec = o.exec ?? realExec;
    o.articles.publishMeta = (row) => this.jobOf(row.id);
  }

  private get site(): string {
    return join(this.o.home, "site");
  }
  private worktree(slug: string): string {
    return join(this.o.home, "worktrees", slug);
  }
  private tilde(p: string): string {
    const h = homedir();
    return p === h ? "~" : p.startsWith(`${h}/`) ? `~/${p.slice(h.length + 1)}` : p;
  }

  /** The environment of every child, built from scratch. Never `INCLUDE_FIXTURES`. */
  env(): Record<string, string> {
    const env: Record<string, string> = {
      PATH: this.o.path ?? process.env.PATH ?? "/usr/bin:/bin",
      HOME: process.env.HOME ?? "/",
      CI: "1",
      ASTRO_TELEMETRY_DISABLED: "1",
      GIT_TERMINAL_PROMPT: "0",
      GIT_SSH_COMMAND: "ssh -o BatchMode=yes",
    };
    if (process.env.SSH_AUTH_SOCK) env.SSH_AUTH_SOCK = process.env.SSH_AUTH_SOCK;
    return env;
  }

  private run(cmd: string, args: string[], cwd: string, timeoutMs?: number): Promise<ExecResult> {
    return this.exec(cmd, args, { cwd, env: this.env(), timeoutMs: timeoutMs ?? this.o.cmdMs ?? CMD_MS });
  }

  /** git in the site clone. With an https remote, pushes and fetches take their credential from `gh`. */
  private git(args: string[], cwd = this.site, https = false): Promise<ExecResult> {
    const cred = https ? ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential"] : [];
    return this.run("git", [...cred, ...args], cwd);
  }

  // ───────────────────────────── rows ─────────────────────────────

  private rows(articleId: string): PublishRow[] {
    return this.o.db.all<PublishRow>("SELECT * FROM publishes WHERE article_id = ? ORDER BY id", articleId);
  }

  private rowById(id: number): PublishRow | undefined {
    return this.o.db.all<PublishRow>("SELECT * FROM publishes WHERE id = ?", id)[0];
  }

  /** The article's last job as `_meta.sparring.publish` carries it. */
  jobOf(articleId: string): PublishJob | null {
    const r = this.rows(articleId).at(-1);
    if (!r) return null;
    let lines: string[] = [];
    try {
      lines = JSON.parse(r.log_json) as string[];
    } catch {
      // An unreadable log shows as empty.
    }
    return { id: r.id, step: r.step, lines, ...(r.error ? { error: r.error } : {}) };
  }

  // ───────────────────────────── the preflight ─────────────────────────────

  /** What is missing before anything can be published, in words the sheet shows in red. */
  private setup(s: PublishSettings): string[] {
    const out: string[] = [];
    const config = this.tilde(join(this.o.home, "config.json"));
    if (!s.siteRepo) out.push(`site_repo is not set · the site's owner/name on GitHub, in ${config}`);
    else if (!SITE_REPO_RE.test(s.siteRepo)) out.push(`site_repo is not an owner/name · ${cut(s.siteRepo)}`);
    if (!s.gitName || !s.gitEmail)
      out.push(
        `publish.git_name and publish.git_email are not set · the author of the post's commit, in ${config}`,
      );
    if (!existsSync(join(this.site, ".git")))
      out.push(
        `no clone of the site at ${this.tilde(this.site)} · git clone git@github.com:${
          s.siteRepo && SITE_REPO_RE.test(s.siteRepo) ? s.siteRepo : "<owner>/<name>"
        }.git ${this.tilde(this.site)}`,
      );
    return out;
  }

  /** The machine checks: gh is logged in and may write, node is 22.12 or newer, npm runs. Kept for five minutes once they pass. */
  private async machine(repo: string): Promise<PublishCheck[]> {
    if (Date.now() - this.machineOkAt < 5 * 60_000) return [];
    const out: PublishCheck[] = [];
    const first = (r: ExecResult) => cut(oneLine(r.stderr || r.stdout).replace(/^error:?\s*/i, ""), 80);
    const node = await this.run("node", ["--version"], this.o.home);
    const v = /^v(\d+)\.(\d+)/.exec(node.stdout.trim());
    if (node.code !== 0 || !v) out.push({ id: "node", ok: false, text: "node is not on the daemon's PATH" });
    else if (Number(v[1]) < 22 || (Number(v[1]) === 22 && Number(v[2]) < 12))
      out.push({
        id: "node",
        ok: false,
        text: `node is ${node.stdout.trim()} · the site needs 22.12 or newer`,
      });
    const npm = await this.run("npm", ["--version"], this.o.home);
    if (npm.code !== 0) out.push({ id: "npm", ok: false, text: "npm is not on the daemon's PATH" });
    const auth = await this.run("gh", ["auth", "status", "--hostname", "github.com"], this.o.home);
    if (auth.code !== 0)
      out.push({ id: "gh", ok: false, text: `gh is not logged in · gh auth login · ${first(auth)}` });
    else {
      const view = await this.run("gh", ["repo", "view", repo, "--json", "viewerPermission"], this.o.home);
      let perm = "";
      try {
        perm = String((JSON.parse(view.stdout) as { viewerPermission?: unknown }).viewerPermission ?? "");
      } catch {
        // Not JSON: reported below.
      }
      if (view.code !== 0)
        out.push({ id: "permission", ok: false, text: `gh cannot see ${repo} · ${first(view)}` });
      else if (perm !== "WRITE" && perm !== "ADMIN" && perm !== "MAINTAIN")
        out.push({
          id: "permission",
          ok: false,
          text: `gh may not write to ${repo} · permission ${perm || "none"}`,
        });
    }
    if (out.length === 0) this.machineOkAt = Date.now();
    return out;
  }

  private async show(ref: string, path: string): Promise<string | null> {
    const r = await this.git(["show", `${ref}:${path}`]);
    return r.code === 0 ? r.stdout : null;
  }

  private async hasRef(ref: string): Promise<boolean> {
    return (await this.git(["rev-parse", "--verify", "-q", `${ref}^{commit}`])).code === 0;
  }

  private async https(): Promise<boolean> {
    return (await this.git(["remote", "get-url", "origin"])).stdout.trim().startsWith("https://");
  }

  /** The agent-word spans of the text: every run of five words the coach said first, or that was pasted from it. */
  private async spans(row: ArticleRow, text: string): Promise<PublishSpan[]> {
    const corpus = this.o.corpus
      ? await this.o.corpus(row.slug)
      : { entries: this.o.articles.coachWritten(row), own: [await this.o.articles.read(row.slug, "dump")] };
    const pasted = this.o.articles
      .pastes(row)
      .map((p) => ({ source: `pasted from ${p.source}`, text: p.text }));
    // A recorded paste was the coach's words when it was pasted; nothing the writer said since makes it theirs.
    const index = overlapIndex(corpus.entries, corpus.own);
    for (const [k, v] of overlapIndex(pasted).grams) index.grams.set(k, v);
    const out: PublishSpan[] = [];
    const seen = new Set<string>();
    let n = 0;
    for (const block of splitBlocks(text)) {
      if (blockWords(block).length === 0) continue;
      n++;
      for (const s of overlap(block, index)) {
        const hash = blockHash(s.text);
        if (seen.has(hash)) continue;
        seen.add(hash);
        out.push({
          hash,
          text: s.text,
          block: n,
          source: s.source.startsWith("pasted") ? s.source : `from ${s.source}`,
        });
      }
    }
    return out;
  }

  /**
   * `GET /api/articles/:slug/publish`: commits the page, fetches the site, and answers everything the sheet
   * shows. No build. With publishing not set up it still answers the fields, the provenance and the body checks,
   * so the owner can see what a publish will ask for.
   */
  async preflight(slug: string, o: { fetch?: boolean } = {}): Promise<Preflight> {
    const a = this.o.articles;
    const row = a.row(slug);
    const commit = await a.publishCommit(slug);
    const text = (await a.showAt(commit, `${slug}/article.md`)) ?? "";
    const meta = postMeta(JSON.parse((await a.showAt(commit, `${slug}/meta.json`)) || "{}"));
    const { body, prose } = cleanBody(text);
    const report = checkBody(body, prose);
    const path = postPath(slug);
    const settings = this.o.settings();
    const setup = this.setup(settings);
    const configured = setup.length === 0;
    const repo = settings.siteRepo ?? "";

    // Provenance: the blocks when drafted, the spans always (recorded in either mode, listed when coached).
    const base = row.authorship === "drafted" ? await a.draftBaseline(slug) : null;
    const prov = base ? provenance(base.text, text) : null;
    const spans = await this.spans(row, text);
    const counts = {
      ...a.publishCounts(row),
      pastedWords: overlap(text, a.pastes(row)).reduce((n, s) => n + s.words, 0),
      spans: spans.length,
      words: wordCount(body),
    };

    const checks: PublishCheck[] = [];
    const extra: PublishCheck[] = [];
    let origin: Preflight["origin"] = { sha: "", clean: false, text: "origin/main · not set up", bad: true };
    let kind: PublishKind = "first";
    let branch = `post/${slug}`;
    let diff: string | undefined;
    let pr: Preflight["pr"] = null;
    const rows = this.rows(row.id);
    let slugCheck: PublishCheck = {
      id: "slug",
      ok: false,
      warn: true,
      text: "slug not checked on origin/main yet",
    };
    let siteCheck: PublishCheck = { id: "site", ok: false, warn: true, text: "site.config not checked yet" };

    if (configured) {
      const https = await this.https();
      const due = o.fetch === true || Date.now() - this.lastFetch >= (this.o.fetchEveryMs ?? 20_000);
      const fetched = due ? await this.git(["fetch", "--prune", "origin"], this.site, https) : null;
      if (fetched?.code === 0) this.lastFetch = Date.now();
      const sha = (await this.git(["rev-parse", "--verify", "-q", "origin/main^{commit}"])).stdout.trim();
      const leftover = existsSync(this.worktree(slug)) && !this.running.has(row.id);
      if (fetched && fetched.code !== 0) {
        extra.push({
          id: "remote",
          ok: false,
          text: `the site remote did not answer · ${cut(oneLine(fetched.stderr), 80)}`,
        });
        origin = { sha, clean: false, text: "origin/main · not fetched", bad: true };
      } else if (!sha) {
        extra.push({ id: "remote", ok: false, text: "the site clone has no origin/main" });
        origin = { sha, clean: false, text: "origin/main · missing", bad: true };
      } else
        origin = {
          sha,
          clean: !leftover,
          text: leftover
            ? "origin/main · a failed build's worktree is left · the next build clears it"
            : "origin/main · clean",
        };
      extra.push(...(await this.machine(repo)));

      if (sha) {
        const config = await this.show("origin/main", SITE_CONFIG);
        siteCheck =
          config === null
            ? { id: "site", ok: false, text: `${SITE_CONFIG} is not on origin/main` }
            : PLACEHOLDER.test(config)
              ? { id: "site", ok: false, text: "site.config still has a placeholder · fix it on main first" }
              : { id: "site", ok: true, text: "site.config has no placeholders" };

        // Which branch, from what. An open PR is updated; a merged or closed one is followed by -2, -3.
        const open = rows.findLast((r) => r.pr_number !== null && r.pr_state === "open");
        if (open) {
          const gone = !(await this.hasRef(`origin/${open.branch}`));
          await this.refreshPr(row, gone);
        }
        const now = this.rows(row.id);
        const stillOpen = now.findLast((r) => r.pr_number !== null && r.pr_state === "open");
        const past = now.filter((r) => r.pr_number !== null && r.pr_state !== "open");
        const merged = past.some((r) => r.pr_state === "merged");
        const next = past.length === 0 ? `post/${slug}` : `post/${slug}-${past.length + 1}`;
        const onMain = (await this.show("origin/main", path)) !== null;
        if (stillOpen?.branch && (await this.hasRef(`origin/${stillOpen.branch}`))) {
          kind = "update_open";
          branch = stillOpen.branch;
          pr = { number: Number(stillOpen.pr_number), url: String(stillOpen.pr_url ?? ""), state: "open" };
        } else if (await this.hasRef(`origin/${next}`)) {
          // A branch a crashed job pushed, with no PR yet: the same branch, and the PR is made this time.
          kind = "update_open";
          branch = next;
        } else {
          kind = past.length === 0 ? "first" : "edit_merged";
          branch = next;
        }
        if (onMain && !merged)
          slugCheck = {
            id: "slug",
            ok: false,
            text: `${path} is on origin/main and is not this article's · pick another slug`,
          };
        else if (kind === "edit_merged" || (onMain && merged)) {
          slugCheck = { id: "slug", ok: true, text: `exists · branch ${branch} · diff` };
          if (onMain) diff = await this.diffAgainst("origin/main", path, buildPost(meta, text));
        } else if (kind === "update_open")
          slugCheck = {
            id: "slug",
            ok: true,
            text: pr
              ? `PR #${pr.number} is open · branch ${branch}`
              : `branch ${branch} is on origin · no PR yet`,
          };
        else slugCheck = { id: "slug", ok: true, text: "slug is new on origin/main" };
      }
    }
    const last = this.rows(row.id).findLast((r) => r.pr_number !== null);
    if (!pr && last)
      pr = { number: Number(last.pr_number), url: String(last.pr_url ?? ""), state: last.pr_state ?? "open" };

    checks.push(
      siteCheck,
      report.h1
        ? {
            id: "headings",
            ok: false,
            text: `a # heading in the body · the title is the page's h1 · ${report.h1}`,
          }
        : { id: "headings", ok: true, text: "headings start at ##" },
      report.image
        ? { id: "images", ok: false, text: "![ in body · images are not published yet" }
        : { id: "images", ok: true, text: "no ![ in body" },
      slugCheck,
    );
    // The rest show only when they have something to say.
    if (report.empty) checks.push({ id: "empty", ok: false, text: "article.md is empty" });
    if (!oneLine(meta.title)) checks.push({ id: "title", ok: false, text: "title is empty" });
    if (!oneLine(meta.description))
      checks.push({ id: "description", ok: false, text: "description is empty" });
    if (!realDate(meta.date.trim()))
      checks.push({
        id: "date",
        ok: false,
        text: meta.date.trim() ? `date is not a real date · ${cut(meta.date.trim(), 20)}` : "date is empty",
      });
    const unanswered = meta.answers.filter((x) => !x.trim()).length;
    if (unanswered > 0)
      checks.push({
        id: "answers",
        ok: false,
        text: `${unanswered} ${unanswered === 1 ? "question" : "questions"} unanswered`,
      });
    if (report.frontmatter)
      checks.push({
        id: "frontmatter",
        ok: false,
        text: "the body opens with a --- block · the host writes the front matter",
      });
    if (report.html) checks.push({ id: "html", ok: false, text: `raw HTML in body · ${report.html}` });
    if (report.scheme)
      checks.push({
        id: "links",
        ok: false,
        text: `link scheme not allowed · ${report.scheme} · http, https, mailto or relative`,
      });
    if (report.invisible)
      checks.push({ id: "invisible", ok: false, text: `invisible character in body · ${report.invisible}` });
    if (report.deep)
      checks.push({ id: "deep", ok: false, warn: true, text: `heading below ### · ${report.deep}` });
    checks.push(...extra);

    return {
      slug,
      article_commit: commit,
      configured,
      setup,
      origin,
      kind,
      branch,
      meta,
      counts,
      authorship: prov ? "drafted" : "coached",
      yoursPct: prov?.yoursPct ?? 100,
      blockCounts: prov?.counts ?? { coach: 0, edited: 0, yours: 0 },
      spans,
      blocks: prov ? publishBlocks(prov) : [],
      checks,
      post: buildPost(meta, text),
      path,
      disclosure: disclosureLine(body),
      ...(diff !== undefined ? { diff } : {}),
      pr,
      published_commit: this.rows(row.id).findLast((r) => r.step === "done")?.article_commit ?? null,
      publish: this.jobOf(row.id),
    };
  }

  /** The diff between a file on a ref of the site and the text a publish would write. */
  private async diffAgainst(ref: string, path: string, text: string): Promise<string> {
    const tmp = join(this.o.home, "logs", `diff-${process.pid}-${Date.now()}.md`);
    mkdirSync(dirname(tmp), { recursive: true });
    await writeFile(tmp, text);
    try {
      const blob = (await this.git(["hash-object", "-w", tmp])).stdout.trim();
      const r = await this.git(["diff", "--no-color", `${ref}:${path}`, blob]);
      return r.stdout.replace(/^diff --git.*\nindex.*\n--- .*\n\+\+\+ .*\n/, "") || "no change";
    } finally {
      await rm(tmp, { force: true });
    }
  }

  // ───────────────────────────── the PR's state ─────────────────────────────

  /**
   * Reads the state of the article's open PR with `gh pr view`, at most once a minute unless forced. A merged PR
   * sets `articles.published_at` from `mergedAt`.
   */
  async refreshPr(row: ArticleRow, force = false): Promise<void> {
    const repo = this.o.settings().siteRepo;
    const open = this.rows(row.id).findLast((r) => r.pr_number !== null && r.pr_state === "open");
    if (!repo || !open) return;
    const every = this.o.prPollMs ?? 60_000;
    if (!force && Date.now() - (this.prPolledAt.get(row.id) ?? 0) < every) return;
    this.prPolledAt.set(row.id, Date.now());
    const r = await this.run(
      "gh",
      ["pr", "view", String(open.pr_number), "--repo", repo, "--json", "state,mergedAt"],
      this.o.home,
    );
    if (r.code !== 0) return;
    let state = "";
    let mergedAt = "";
    try {
      const j = JSON.parse(r.stdout) as { state?: unknown; mergedAt?: unknown };
      state = String(j.state ?? "").toUpperCase();
      mergedAt = typeof j.mergedAt === "string" ? j.mergedAt : "";
    } catch {
      return;
    }
    if (state !== "MERGED" && state !== "CLOSED") return;
    const to = state === "MERGED" ? "merged" : "closed";
    this.o.db.run(
      "UPDATE publishes SET pr_state = ? WHERE article_id = ? AND pr_number = ?",
      to,
      row.id,
      open.pr_number,
    );
    if (to === "merged") {
      this.o.articles.setPublishedAt(row.id, mergedAt || new Date().toISOString());
      this.o.say?.(row, `PR #${open.pr_number} was merged · published`, false);
    } else this.o.say?.(row, `PR #${open.pr_number} was closed without merging`, false);
    this.o.changed?.(row.id);
  }

  /** Every `everyMs`, looks at the articles whose PR is open. */
  startPrWatch(everyMs = 60_000): void {
    if (this.watcher) return;
    this.watcher = setInterval(() => {
      const ids = this.o.db
        .all<{ article_id: string }>("SELECT DISTINCT article_id FROM publishes WHERE pr_state = 'open'")
        .map((r) => r.article_id);
      for (const id of ids) {
        const row = this.o.articles.byId(id);
        if (row) void this.refreshPr(row).catch(() => undefined);
      }
    }, everyMs);
    this.watcher.unref?.();
  }

  // ───────────────────────────── start-up ─────────────────────────────

  /**
   * At daemon start: a row a dead daemon left unfinished is marked `failed` at its step, its worktree is pruned,
   * and one host line names the step. Nothing before `push` has left the machine, so the next publish starts
   * clean; a job that died after its push left a branch, and the next publish opens its PR.
   */
  async recover(): Promise<void> {
    const left = this.o.db.all<PublishRow>(
      "SELECT * FROM publishes WHERE step NOT IN ('done', 'failed') ORDER BY id",
    );
    for (const r of left) {
      const step = r.step;
      const pushed = step === "pr";
      const error = `stopped at ${step} · the daemon restarted`;
      const line = pushed
        ? `publish stopped at ${step} when the daemon restarted · the branch is on the site repo · publish again to open its PR`
        : `publish stopped at ${step} when the daemon restarted · nothing left this machine · publish again`;
      let lines: string[] = [];
      try {
        lines = JSON.parse(r.log_json) as string[];
      } catch {
        // Start the log over.
      }
      lines.push(`✗ ${error}`);
      this.o.db.run(
        "UPDATE publishes SET step = 'failed', error = ?, log_json = ?, finished_at = ? WHERE id = ?",
        error,
        JSON.stringify(lines.slice(-LINES_MAX)),
        new Date().toISOString(),
        r.id,
      );
      this.fileLog(r.id, `✗ ${error}`);
      if (r.worktree) await this.dropWorktree(r.worktree);
      const row = this.o.articles.byId(r.article_id);
      if (row) {
        this.o.say?.(row, line, true);
        this.o.changed?.(row.id);
      }
      this.o.log?.(`publish ${r.id}: ${error}`);
    }
  }

  private async dropWorktree(path: string): Promise<void> {
    const cloned = existsSync(join(this.site, ".git"));
    if (cloned) await this.git(["worktree", "remove", "--force", path]);
    await rm(path, { recursive: true, force: true });
    if (cloned) await this.git(["worktree", "prune"]);
  }

  // ───────────────────────────── a publish ─────────────────────────────

  /**
   * `POST /api/articles/:slug/publish {article_commit, ticked}`: starts the job and answers `{publish_id}`. 409
   * while one runs for this article, and 409 with a fresh preflight when the commit is not the one reviewed, the
   * site moved, a check fails or a tick is missing.
   */
  async publish(
    slug: string,
    req: { article_commit: string; ticked: readonly string[]; origin_sha?: string },
  ): Promise<{ publish_id: number }> {
    const row = this.o.articles.row(slug);
    if (this.running.has(row.id))
      throw new HttpError(409, { error: "a publish is already running for this article" });
    this.running.add(row.id);
    let started = false;
    try {
      const pf = await this.preflight(slug, { fetch: true });
      const refuse = (error: string) => new HttpError(409, { error, preflight: pf });
      if (pf.article_commit !== req.article_commit)
        throw refuse("the page changed since you reviewed it · look again, then publish");
      if (req.origin_sha && pf.origin.sha !== req.origin_sha)
        throw refuse("the site's main moved since you reviewed it · look again, then publish");
      const why = blockers(pf, req.ticked);
      if (why.length > 0) throw refuse(why[0] as string);
      const settings = this.o.settings();
      const n = this.rows(row.id).length + 1;
      const wt = this.worktree(slug);
      this.o.db.run(
        `INSERT INTO publishes (article_id, n, kind, article_commit, authorship, yours_pct, counts_json, acks_json,
           origin_sha, branch, worktree, step, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'validate', ?)`,
        row.id,
        n,
        pf.kind,
        pf.article_commit,
        pf.authorship,
        pf.yoursPct,
        JSON.stringify({ ...pf.counts, blocks: pf.blockCounts }),
        JSON.stringify([...new Set(req.ticked)].slice(0, 2000)),
        pf.origin.sha,
        pf.branch,
        wt,
        new Date().toISOString(),
      );
      const id = Number(this.rows(row.id).at(-1)?.id);
      started = true;
      const job = this.job(id, row, pf, req.ticked, settings)
        .catch((e) => this.o.log?.(`publish ${id}: ${e instanceof Error ? e.message : e}`))
        .finally(() => {
          this.running.delete(row.id);
          this.jobs.delete(job);
          this.o.changed?.(row.id);
        });
      this.jobs.add(job);
      this.o.changed?.(row.id);
      return { publish_id: id };
    } finally {
      if (!started) this.running.delete(row.id);
    }
  }

  /** Resolves once no job runs. For tests and for shutdown. */
  async idle(): Promise<void> {
    while (this.jobs.size > 0) await Promise.all([...this.jobs]);
  }

  private fileLog(id: number, text: string): void {
    try {
      const dir = join(this.o.home, "logs");
      mkdirSync(dir, { recursive: true });
      appendFileSync(join(dir, `publish-${id}.log`), `${new Date().toISOString()} ${text}\n`);
    } catch {
      // The row keeps the lines the sheet shows.
    }
  }

  private async job(
    id: number,
    row: ArticleRow,
    pf: Preflight,
    ticked: readonly string[],
    settings: PublishSettings,
  ): Promise<void> {
    const slug = row.slug;
    const repo = settings.siteRepo as string;
    const wt = this.worktree(slug);
    const lines: string[] = [];
    let step: Step = "validate";
    const save = () => {
      this.o.db.run(
        "UPDATE publishes SET step = ?, log_json = ? WHERE id = ?",
        step,
        JSON.stringify(lines.slice(-LINES_MAX)),
        id,
      );
      this.o.changed?.(row.id);
    };
    const say = (text: string) => {
      lines.push(text.length > LINE_MAX ? `${text.slice(0, LINE_MAX)}…` : text);
      this.fileLog(id, text);
      save();
    };
    const at = (s: Step) => {
      step = s;
      save();
    };
    /** One command: its line, its output in the log file, and a failure that ends the job. */
    const sh = async (cmd: string, args: string[], cwd: string, o: { show?: string; ms?: number } = {}) => {
      say(`$ ${o.show ?? `${cmd} ${args.join(" ")}`}`);
      const r = cmd === "git" ? await this.git(args, cwd, https) : await this.run(cmd, args, cwd, o.ms);
      const out = `${r.stdout}\n${r.stderr}`.trim();
      if (out) this.fileLog(id, out);
      if (r.code !== 0) {
        const tail = out
          .split("\n")
          .filter((l) => l.trim())
          .slice(-6);
        for (const l of tail) say(`  ${l.trim()}`);
        throw new JobError(`${o.show ?? `${cmd} ${args[0] ?? ""}`.trim()} exited ${r.code}`);
      }
      return r;
    };
    let https = false;
    try {
      https = await this.https();
      say(`✓ checks passed · article ${pf.article_commit.slice(0, 7)} · ${pf.kind} · ${pf.branch}`);

      at("worktree");
      const base = pf.kind === "update_open" ? `origin/${pf.branch}` : "origin/main";
      if (!pf.branch.startsWith("post/"))
        throw new JobError(`refusing branch ${pf.branch} · not under post/`);
      await this.dropWorktree(wt);
      await sh("git", ["worktree", "add", "-B", pf.branch, wt, base], this.site, {
        show: `git worktree add -B ${pf.branch} ${this.tilde(wt)} ${base}`,
      });
      // The identity lives in the worktree's own config, so the clone and the machine need none.
      await this.git(["config", "extensions.worktreeConfig", "true"]);
      for (const [k, v] of [
        ["user.name", settings.gitName as string],
        ["user.email", settings.gitEmail as string],
      ] as const) {
        const r = await this.git(["config", "--worktree", k, v], wt);
        if (r.code !== 0) throw new JobError(`git config ${k} failed · ${cut(oneLine(r.stderr), 80)}`);
      }

      at("write");
      const existed = (await this.git(["cat-file", "-e", `HEAD:${pf.path}`], wt)).code === 0;
      mkdirSync(dirname(join(wt, pf.path)), { recursive: true });
      await writeFile(join(wt, pf.path), pf.post);
      const status = async () =>
        (await this.git(["status", "--porcelain", "--untracked-files=all"], wt)).stdout
          .split("\n")
          .filter((l) => l.trim())
          .map((l) => l.slice(3));
      const changed = await status();
      say(`wrote ${pf.path}${changed.length === 0 ? " · the same as the branch has" : ""}`);

      let buildLine = "not run · the post did not change";
      if (changed.length > 0) {
        at("build");
        await sh("npm", ["ci"], wt, { ms: this.o.buildMs ?? BUILD_MS });
        await sh("npm", ["run", "build"], wt, { ms: this.o.buildMs ?? BUILD_MS });
        buildLine = await this.assertBuild(wt, slug);
        const after = await status();
        if (after.length !== 1 || after[0] !== pf.path)
          throw new JobError(
            `the build changed more than the post · ${after.slice(0, 4).join(", ") || "nothing"}`,
          );
        say(`✓ built · ${buildLine}`);

        at("commit");
        const title = oneLine(pf.meta.title);
        const message = `${existed ? "Update" : "Add"} post: ${title}`;
        await this.git(["add", "--", pf.path], wt);
        await sh("git", ["commit", "-q", "-m", message, "--", pf.path], wt, {
          show: `git commit -m ${JSON.stringify(message)}`,
        });
      }

      at("push");
      const ref = `refs/heads/${pf.branch}`;
      if (!ref.startsWith("refs/heads/post/")) throw new JobError(`refusing to push ${ref}`);
      await sh("git", ["push", "-u", "origin", `${ref}:${ref}`], wt, {
        show: `git push -u origin ${pf.branch}`,
      });

      at("pr");
      const bodyFile = join(this.o.home, "logs", `publish-${id}.pr.md`);
      mkdirSync(dirname(bodyFile), { recursive: true });
      await writeFile(bodyFile, prBody({ slug, meta: pf.meta, preflight: pf, ticked, buildLine }));
      let number = pf.pr?.state === "open" ? pf.pr.number : 0;
      let url = pf.pr?.state === "open" ? pf.pr.url : "";
      if (number) {
        await sh("gh", ["pr", "edit", String(number), "--repo", repo, "--body-file", bodyFile], wt, {
          show: `gh pr edit ${number} --body-file`,
        });
      } else {
        const r = await sh(
          "gh",
          ["pr", "create", "--fill", "--body-file", bodyFile, "--head", pf.branch, "--repo", repo],
          wt,
          { show: "gh pr create --fill" },
        );
        url = (/https?:\/\/\S+/.exec(r.stdout)?.[0] ?? "").trim();
        number = Number(/\/pull\/(\d+)/.exec(url)?.[1] ?? 0);
        if (!url || !number) throw new JobError("gh pr create answered no PR link");
      }
      say(url);
      this.o.db.run(
        "UPDATE publishes SET pr_number = ?, pr_url = ?, pr_state = 'open' WHERE id = ?",
        number,
        url,
        id,
      );
      this.o.articles.setPr(row.id, number, url);

      await this.dropWorktree(wt);
      this.o.db.run(
        "UPDATE publishes SET step = 'done', log_json = ?, finished_at = ? WHERE id = ?",
        JSON.stringify(lines.slice(-LINES_MAX)),
        new Date().toISOString(),
        id,
      );
      const fresh = this.o.articles.byId(row.id) ?? row;
      this.o.say?.(fresh, `build finished · PR #${number} is open · ${url}`, false);
    } catch (e) {
      // A row the daemon no longer owns (a restart marked it already) is left as it is.
      if (this.rowById(id)?.step === "failed") return;
      const reason = e instanceof Error ? e.message : String(e);
      const error = `failed at ${step} · ${cut(reason, 160)}`;
      lines.push(`✗ ${error}`);
      this.fileLog(id, `✗ ${error}`);
      this.o.db.run(
        "UPDATE publishes SET step = 'failed', error = ?, log_json = ?, finished_at = ? WHERE id = ?",
        error,
        JSON.stringify(lines.slice(-LINES_MAX)),
        new Date().toISOString(),
        id,
      );
      const fresh = this.o.articles.byId(row.id) ?? row;
      this.o.say?.(fresh, `publish ${error}`, true);
      if (!(e instanceof JobError)) throw e;
    }
  }

  /** The build gate's assertions on `dist/`. Answers the build line of the log and the PR. */
  private async assertBuild(wt: string, slug: string): Promise<string> {
    const page = join(wt, "dist", "writing", slug, "index.html");
    const rssPath = join(wt, "dist", "rss.xml");
    const html = await readFile(page, "utf8").catch(() => null);
    if (html === null) throw new JobError(`dist/writing/${slug}/index.html was not built`);
    const rss = await readFile(rssPath, "utf8").catch(() => null);
    if (rss === null) throw new JobError("dist/rss.xml was not built");
    if (!rss.includes(`/writing/${slug}/`)) throw new JobError(`dist/rss.xml has no /writing/${slug}/`);
    if (PLACEHOLDER.test(html)) throw new JobError("the built page still has a placeholder");
    if (PLACEHOLDER.test(rss)) throw new JobError("the built feed still has a placeholder");
    const example = (url: string) => {
      try {
        return /(^|\.)example\.com$/i.test(new URL(url.trim()).hostname);
      } catch {
        return true;
      }
    };
    const canonical = /<link\b[^>]*\brel=["']?canonical["']?[^>]*>/i.exec(html)?.[0];
    const href = canonical ? /\bhref=["']([^"']+)["']/i.exec(canonical)?.[1] : undefined;
    if (!href) throw new JobError("the built page has no canonical link");
    if (example(href)) throw new JobError(`the canonical link is not on the real domain · ${cut(href, 60)}`);
    for (const m of rss.matchAll(/<link>([^<]*)<\/link>/g))
      if (example(m[1] as string))
        throw new JobError(`a feed link is not on the real domain · ${cut(m[1] as string, 60)}`);
    const built = await readdir(join(wt, "dist", "writing")).catch(() => [] as string[]);
    const fixture = built.find((d) => d.startsWith("_fixture-"));
    if (fixture) throw new JobError(`the build has a fixture post · dist/writing/${fixture}`);
    return `dist/writing/${slug}/index.html · rss ok`;
  }
}
