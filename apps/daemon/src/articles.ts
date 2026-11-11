// Articles on disk. `~/writing` is a git repo and `<slug>/article.md` in it is the article: the daemon saves
// with a base_sha check, writes atomically and commits through one git queue. SQLite holds the row, never the
// text. `metaFor` builds the `_meta.sparring` an article's AHP session carries.
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { wordCount } from "@sparring/protocol/blocks";
import type { Stage, TOPICS } from "@sparring/protocol/commands";
import type { LetterKind, SparringMeta } from "@sparring/protocol/meta";
import { slugProblem } from "@sparring/protocol/slug";
import type { Db } from "./db.ts";
import { GitQueue } from "./git.ts";

export const FILES = ["article", "dump", "brief"] as const;
export type FileName = (typeof FILES)[number];

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: Record<string, unknown>,
  ) {
    super(String(body.error ?? status));
  }
}

export interface ArticleRow {
  id: string;
  slug: string;
  provider: string;
  /** The article's AHP chat, `ahp-chat:/<uuid>`; null until the coach has made it. */
  chat: string | null;
  stage: string;
  strictness: string;
  authorship: string;
  article_sha: string | null;
  last_commit: string | null;
  saved_at: string | null;
  last_line: string | null;
  open_question: string | null;
  created_at: string;
  [k: string]: unknown;
}

/** The AHP session of an article: one per article, named by its id. */
export const sessionUri = (articleId: string) => `ahp-session:/${articleId}`;

export interface SaveResult {
  sha: string;
  /** The commit this save made, or null when it was left for the next commit. */
  commit: string | null;
}

export const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

const now = () => new Date().toISOString();

export interface ArticlesOptions {
  gitName: string;
  gitEmail: string;
  defaultProvider: string;
  /** A save that is not Cmd+S commits only when the article's last commit is at least this old. */
  commitEveryMs?: number;
}

export class Articles {
  readonly git: GitQueue;
  private readonly commitEveryMs: number;
  private readonly lastCommitAt = new Map<string, number>();
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>();
  /** Set by the coach: makes a new article's session and chat before `create` answers. */
  onCreated: ((row: ArticleRow) => Promise<void>) | undefined;
  /** Set by the coach: a save or a commit changed what `metaFor` reads. */
  onChanged: ((row: ArticleRow) => void) | undefined;
  /** Set by the coach: what `metaFor` takes from the coach itself (the run, a sign-in that is needed). */
  metaExtra: ((row: ArticleRow) => Partial<SparringMeta>) | undefined;

  constructor(
    private readonly db: Db,
    readonly dir: string,
    private readonly opts: ArticlesOptions,
  ) {
    this.git = new GitQueue(dir);
    this.commitEveryMs = opts.commitEveryMs ?? 60_000;
  }

  /** Makes `~/writing` a git repo with its own identity and a first commit, when it is not one yet. */
  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await this.git.serial(async () => {
      if (!existsSync(join(this.dir, ".git"))) await this.git.raw(["init", "-q", "-b", "main"]);
      const name = await this.git.raw(["config", "--local", "user.name"], { ok: [0, 1] });
      if (name.code !== 0) await this.git.raw(["config", "--local", "user.name", this.opts.gitName]);
      const email = await this.git.raw(["config", "--local", "user.email"], { ok: [0, 1] });
      if (email.code !== 0) await this.git.raw(["config", "--local", "user.email", this.opts.gitEmail]);
      for (const [file, text] of [
        ["STYLE.md", "# Style\n\n## Do not flag\n"],
        ["inbox.md", ""],
      ] as const) {
        if (!existsSync(join(this.dir, file))) await writeFile(join(this.dir, file), text);
      }
      const head = await this.git.raw(["rev-parse", "--verify", "-q", "HEAD"], { ok: [0, 1] });
      if (head.code !== 0) {
        await this.git.raw(["add", "--", "STYLE.md", "inbox.md"]);
        await this.git.raw(["commit", "-q", "-m", "writing repo"]);
      }
    });
  }

  all(): ArticleRow[] {
    return this.db.all<ArticleRow>("SELECT * FROM articles ORDER BY created_at");
  }

  byId(id: string): ArticleRow | undefined {
    return this.db.all<ArticleRow>("SELECT * FROM articles WHERE id = ?", id)[0];
  }

  /** The article's folder in the writing repo, absolute. */
  folder(slug: string): string {
    return join(this.dir, slug);
  }

  setChat(id: string, chat: string): void {
    this.db.run("UPDATE articles SET chat = ? WHERE id = ?", chat, id);
  }

  setStage(id: string, stage: Stage): void {
    this.db.run("UPDATE articles SET stage = ? WHERE id = ?", stage, id);
  }

  setStrictness(id: string, strictness: string): void {
    this.db.run("UPDATE articles SET strictness = ? WHERE id = ?", strictness, id);
  }

  /** The last host line, for the Articles row's sub line. */
  setLastLine(id: string, line: string): void {
    this.db.run("UPDATE articles SET last_line = ? WHERE id = ?", line.slice(0, 200), id);
  }

  /**
   * The whole `_meta.sparring` of an article, from its row and its files. What later steps fill (notes, tells,
   * the run, publishing) is zero or empty until then.
   */
  metaFor(row: ArticleRow): SparringMeta {
    const text = (() => {
      try {
        return readFileSync(this.path(row.slug, "article"), "utf8");
      } catch {
        return "";
      }
    })();
    const notes = JSON.parse(String(row.brief_notes_json ?? "[]")) as { topic?: unknown }[];
    const covered = [...new Set(notes.map((n) => n.topic).filter((x): x is string => typeof x === "string"))];
    const letter = JSON.parse(String(row.letter_json ?? "[]")) as SparringMeta["letter"];
    const prNumber = typeof row.pr_number === "number" ? row.pr_number : undefined;
    const prUrl = typeof row.pr_url === "string" ? row.pr_url : undefined;
    return {
      slug: row.slug,
      provider: row.provider === "claude" ? "claude" : "demo",
      stage: row.stage as Stage,
      covered,
      authorship: row.authorship === "drafted" ? "drafted" : "coached",
      drafting: false,
      coachQuiet: Number(row.coach_quiet ?? 0) === 1,
      offline: Number(row.offline ?? 0) === 1,
      wordCount: wordCount(text),
      savedAt: row.saved_at ?? null,
      articleSha: row.article_sha ?? null,
      commit: row.last_commit ?? null,
      tells: { em: 0, oneSentence: 0, notXButY: 0 },
      pastedWords: 0,
      openComments: 0,
      unreadComments: 0,
      commentsRev: Number(row.comments_rev ?? 0),
      run: null,
      queued: 0,
      letter: letter.slice(-3).map((l) => ({ ...l, kind: l.kind as LetterKind })),
      ...(row.open_question ? { openQuestion: row.open_question.slice(0, 200) } : {}),
      ...(row.last_line ? { lastLine: row.last_line.slice(0, 200) } : {}),
      publish: null,
      ...(prNumber !== undefined ? { prNumber } : {}),
      ...(prUrl !== undefined ? { prUrl } : {}),
      tokens: Number(row.tokens_in ?? 0) + Number(row.tokens_out ?? 0),
      ...this.metaExtra?.(row),
    };
  }

  row(slug: string): ArticleRow {
    const row = this.db.all<ArticleRow>("SELECT * FROM articles WHERE slug = ?", slug)[0];
    if (!row) throw new HttpError(404, { error: `no article ${slug}` });
    return row;
  }

  /**
   * Checks the slug rule, then makes the folder, its three files, a commit and the row, then (through the coach)
   * the article's session and chat. `id` is given when an AHP client chose the session URI.
   */
  async create(
    slug: string,
    provider?: string,
    id: string = randomUUID(),
    seed: { dump?: string } = {},
  ): Promise<ArticleRow> {
    const problem = slugProblem(slug);
    if (problem) throw new HttpError(400, { error: problem });
    if (this.db.all("SELECT 1 FROM articles WHERE slug = ?", slug).length > 0) {
      throw new HttpError(409, { error: `${slug} already exists` });
    }
    const folder = join(this.dir, slug);
    if (existsSync(folder))
      throw new HttpError(409, { error: `${slug} is already a folder in the writing repo` });
    const commit = await this.git.serial(async () => {
      await mkdir(folder);
      for (const f of FILES) await writeFile(join(folder, `${f}.md`), f === "dump" ? (seed.dump ?? "") : "");
      const meta = { title: "", description: "", date: "", answers: ["", "", ""] };
      await writeFile(join(folder, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
      await this.git.raw(["add", "--", slug]);
      await this.git.raw(["commit", "-q", "-m", `new article ${slug}`, "--", slug]);
      return (await this.git.raw(["rev-parse", "HEAD"])).stdout.trim();
    });
    const at = now();
    this.db.run(
      `INSERT INTO articles (id, slug, provider, article_sha, last_commit, saved_at, dump_baseline_commit,
         created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      slug,
      provider ?? this.opts.defaultProvider,
      sha256(""),
      commit,
      at,
      seed.dump ? commit : null,
      at,
    );
    this.lastCommitAt.set(slug, Date.now());
    // The session comes with the article; if making it fails, the next start makes it.
    await this.onCreated?.(this.row(slug)).catch((e: unknown) => console.error(e));
    return this.row(slug);
  }

  private path(slug: string, file: FileName) {
    return join(this.dir, slug, `${file}.md`);
  }

  /** One of the article's three files as it is on disk; "" when it is missing. */
  read(slug: string, file: FileName): Promise<string> {
    return readFile(this.path(slug, file), "utf8").catch(() => "");
  }

  /** `~/writing/STYLE.md`, or "". */
  style(): Promise<string> {
    return readFile(join(this.dir, "STYLE.md"), "utf8").catch(() => "");
  }

  /** A pass file, `~/writing/passes/<id>.md`, or undefined. The id is a pass name, never a path. */
  async pass(id: string): Promise<string | undefined> {
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(id)) return undefined;
    return readFile(join(this.dir, "passes", `${id}.md`), "utf8").catch(() => undefined);
  }

  /** SHA-256 of article.md as it is on disk now. */
  async diskSha(slug: string): Promise<string> {
    return sha256(await this.read(slug, "article"));
  }

  // ───────────────────────────── the coach's turns ─────────────────────────────

  /**
   * The turn-start commit: commits the article folder if anything changed, and answers the commit that holds the
   * page as it is now (`turns.commit_before`). The tripwire restores from it.
   */
  turnCommit(slug: string): Promise<string> {
    return this.git.serial(async () => {
      await this.commitLocked(slug, "turn");
      return (await this.git.raw(["rev-parse", "HEAD"])).stdout.trim();
    });
  }

  /** `git diff <from> <to> -- <slug>/article.md`, through the queue. */
  async articleDiff(slug: string, from: string, to: string): Promise<string> {
    const r = await this.git.run(["diff", "--no-color", from, to, "--", `${slug}/article.md`], {
      ok: [0, 1, 128],
    });
    return r.code === 0 ? r.stdout : "";
  }

  /**
   * The tripwire fired: article.md changed during a turn and no recorded save explains it. The changed text is
   * committed to `refs/sparring/quarantine/<slug>` (the working tree untouched), then the page is restored from
   * the pre-turn commit. Answers the quarantine commit.
   */
  async quarantine(slug: string, commitBefore: string): Promise<string> {
    const row = this.row(slug);
    return this.git.serial(async () => {
      const changed = await this.read(slug, "article");
      const commit = await this.keepAt(`refs/sparring/quarantine/${slug}`, slug, changed, "quarantine");
      const before = await this.git.raw(["show", `${commitBefore}:${slug}/article.md`], { ok: [0, 128] });
      const text = before.code === 0 ? before.stdout : "";
      await atomicWrite(this.path(slug, "article"), text);
      this.db.run("UPDATE articles SET article_sha = ? WHERE id = ?", sha256(text), row.id);
      this.changed(slug);
      return commit;
    });
  }

  /**
   * `restore it`: the daemon commits the current page, then puts the quarantined text back and commits that.
   * Answers the new commit; 409 when nothing is quarantined.
   */
  async restoreQuarantine(slug: string): Promise<{ sha: string; commit: string | null }> {
    const row = this.row(slug);
    return this.git.serial(async () => {
      const ref = `refs/sparring/quarantine/${slug}`;
      const held = await this.git.raw(["show", `${ref}:${slug}/article.md`], { ok: [0, 128] });
      if (held.code !== 0) throw new HttpError(409, { error: "nothing is quarantined" });
      await this.commitLocked(slug, "before restore");
      await atomicWrite(this.path(slug, "article"), held.stdout);
      const sha = sha256(held.stdout);
      this.db.run("UPDATE articles SET article_sha = ?, saved_at = ? WHERE id = ?", sha, now(), row.id);
      const commit = await this.commitLocked(slug, "restore quarantined");
      this.changed(slug);
      return { sha, commit };
    });
  }

  /** Commits `text` as `<slug>/article.md` on top of `ref` (or HEAD), without touching the working tree. */
  private async keepAt(
    ref: string,
    slug: string,
    text: string,
    what: string,
    file = "article",
  ): Promise<string> {
    const blob = (await this.git.raw(["hash-object", "-w", "--stdin"], { input: text })).stdout.trim();
    const index = join(this.dir, ".git", `sparring-${what}-${randomUUID()}.index`);
    const env = { GIT_INDEX_FILE: index };
    try {
      await this.git.raw(["read-tree", "HEAD"], { env });
      await this.git.raw(["update-index", "--add", "--cacheinfo", `100644,${blob},${slug}/${file}.md`], {
        env,
      });
      const tree = (await this.git.raw(["write-tree"], { env })).stdout.trim();
      const prev = await this.git.raw(["rev-parse", "--verify", "-q", ref], { ok: [0, 1] });
      const parents = ["-p", prev.code === 0 ? prev.stdout.trim() : "HEAD"];
      const commit = (
        await this.git.raw(["commit-tree", tree, ...parents, "-m", `${what} ${slug}/${file}.md`])
      ).stdout.trim();
      await this.git.raw(["update-ref", ref, commit]);
      return commit;
    } finally {
      await rm(index, { force: true });
    }
  }

  /** A coach turn begins: its `turns` row, `running`. */
  turnStarted(t: {
    turnId: string;
    articleId: string;
    origin: "writer" | "host" | "queue";
    stage: string;
    pass: string;
    commitBefore: string;
  }): void {
    this.db.run(
      `INSERT OR REPLACE INTO turns (turn_id, article_id, origin, status, stage, pass, commit_before, started_at)
       VALUES (?, ?, ?, 'running', ?, ?, ?, ?)`,
      t.turnId,
      t.articleId,
      t.origin,
      t.stage,
      t.pass,
      t.commitBefore,
      now(),
    );
  }

  turnEnded(turnId: string, status: TurnStatus, isQuestion: boolean, violation: boolean): void {
    this.db.run(
      "UPDATE turns SET status = ?, is_question = ?, violation = ?, ended_at = ? WHERE turn_id = ?",
      status,
      isQuestion ? 1 : 0,
      violation ? 1 : 0,
      now(),
      turnId,
    );
  }

  /** At start: every row still `running` becomes `interrupted`. Answers the articles they belong to. */
  interruptRunning(): string[] {
    const ids = this.db
      .all<{ article_id: string }>("SELECT DISTINCT article_id FROM turns WHERE status = 'running'")
      .map((r) => r.article_id);
    this.db.run("UPDATE turns SET status = 'interrupted', ended_at = ? WHERE status = 'running'", now());
    return ids;
  }

  /** The article's coach turns, oldest first, without the one named. */
  coachTurns(articleId: string, except = ""): { turn_id: string; stage: string; status: string }[] {
    return this.db.all(
      "SELECT turn_id, stage, status FROM turns WHERE article_id = ? AND turn_id != ? ORDER BY started_at, rowid",
      articleId,
      except,
    );
  }

  openCommentIds(articleId: string): string[] {
    return this.db
      .all<{ id: string }>(
        "SELECT id FROM comments WHERE article_id = ? AND status = 'open' ORDER BY id",
        articleId,
      )
      .map((r) => r.id);
  }

  setOffline(id: string, on: boolean): void {
    this.db.run("UPDATE articles SET offline = ? WHERE id = ?", on ? 1 : 0, id);
  }

  /** The coach's last message when it ended in a question, or null. */
  setOpenQuestion(id: string, q: string | null): void {
    this.db.run(
      "UPDATE articles SET open_question = ? WHERE id = ?",
      q === null ? null : q.slice(0, 200),
      id,
    );
  }

  addTokens(id: string, input: number, output: number): void {
    this.db.run(
      "UPDATE articles SET tokens_in = tokens_in + ?, tokens_out = tokens_out + ? WHERE id = ?",
      Math.max(0, Math.round(input)),
      Math.max(0, Math.round(output)),
      id,
    );
  }

  /** What the coach last read of article.md; null when its child is new. */
  setAgentSeen(id: string, commit: string | null): void {
    this.db.run("UPDATE articles SET agent_seen_commit = ? WHERE id = ?", commit, id);
  }

  // ───────────────────────────── the letter ─────────────────────────────

  /** Adds a host line to the article's letter (the margin keeps the last three). Answers its id. */
  addLetter(id: string, kind: LetterKind, text: string): string {
    const row = this.byId(id);
    if (!row) return "";
    const letter = JSON.parse(String(row.letter_json ?? "[]")) as SparringMeta["letter"];
    const lid = `l${randomUUID().slice(0, 8)}`;
    letter.push({ id: lid, kind, text: text.slice(0, 200), at: now() });
    this.db.run("UPDATE articles SET letter_json = ? WHERE id = ?", JSON.stringify(letter.slice(-10)), id);
    return lid;
  }

  letterLine(slug: string, letterId: string): SparringMeta["letter"][number] | undefined {
    const row = this.row(slug);
    const letter = JSON.parse(String(row.letter_json ?? "[]")) as SparringMeta["letter"];
    return letter.find((l) => l.id === letterId);
  }

  dropLetter(slug: string, letterId: string): void {
    const row = this.row(slug);
    const letter = JSON.parse(String(row.letter_json ?? "[]")) as SparringMeta["letter"];
    this.db.run(
      "UPDATE articles SET letter_json = ? WHERE id = ?",
      JSON.stringify(letter.filter((l) => l.id !== letterId)),
      row.id,
    );
    this.changed(slug);
  }

  // ───────────────────────────── brief notes ─────────────────────────────

  /**
   * One `note_brief` entry, already validated: the quote goes into brief.md under `## Quotes` and the question
   * under `## Questions`, committed through the queue; the row's `brief_notes_json` grows and `comments_rev` is
   * bumped. Answers the entries now held.
   */
  async addBriefNote(
    slug: string,
    note: { topic: (typeof TOPICS)[number]; quote: string; question?: string },
  ): Promise<{ topic: string; quote: string; question?: string }[]> {
    const row = this.row(slug);
    return this.git.serial(async () => {
      const path = this.path(slug, "brief");
      let text = await readFile(path, "utf8").catch(() => "");
      const oneLine = (t: string) => t.replace(/\s+/g, " ").trim();
      text = appendUnder(text, "## Quotes", `- ${note.topic}: "${oneLine(note.quote)}"`);
      if (note.question)
        text = appendUnder(text, "## Questions", `- ${note.topic}: ${oneLine(note.question)}`);
      await atomicWrite(path, text);
      await this.commitLocked(slug, "brief note");
      const fresh = this.row(slug);
      const notes = JSON.parse(String(fresh.brief_notes_json ?? "[]")) as {
        topic: string;
        quote: string;
        question?: string;
      }[];
      notes.push({
        topic: note.topic,
        quote: note.quote,
        ...(note.question ? { question: note.question } : {}),
      });
      this.db.run(
        "UPDATE articles SET brief_notes_json = ?, comments_rev = comments_rev + 1 WHERE id = ?",
        JSON.stringify(notes),
        row.id,
      );
      this.changed(slug);
      return notes;
    });
  }

  // ───────────────────────────── the inbox ─────────────────────────────

  /** `~/writing/inbox.md` as ideas: one per non-empty line, `- <ISO time> <text>` when the daemon wrote it. */
  async inbox(): Promise<Idea[]> {
    const text = await readFile(join(this.dir, "inbox.md"), "utf8").catch(() => "");
    return parseInbox(text);
  }

  /** Appends one timestamped idea to inbox.md and commits it. */
  async addIdea(raw: string): Promise<Idea> {
    const text = raw.replace(/\s+/g, " ").trim().slice(0, 2000);
    if (!text) throw new HttpError(400, { error: "an idea needs some text" });
    return this.git.serial(async () => {
      const path = join(this.dir, "inbox.md");
      const before = await readFile(path, "utf8").catch(() => "");
      const line = `- ${now()} ${text}`;
      const sep = before === "" || before.endsWith("\n") ? "" : "\n";
      await atomicWrite(path, `${before}${sep}${line}\n`);
      await this.commitPaths(["inbox.md"], "idea");
      return ideaOf(line) as Idea;
    });
  }

  /** Takes an idea out of inbox.md (it became an article's dump) and commits that. 404 when it is not there. */
  async takeIdea(ideaId: string): Promise<Idea> {
    return this.git.serial(async () => {
      const path = join(this.dir, "inbox.md");
      const text = await readFile(path, "utf8").catch(() => "");
      const lines = text.split("\n");
      const i = lines.findIndex((l) => ideaOf(l)?.id === ideaId);
      if (i < 0) throw new HttpError(404, { error: "no such idea in inbox.md" });
      const idea = ideaOf(lines[i] as string) as Idea;
      lines.splice(i, 1);
      await atomicWrite(path, lines.join("\n"));
      await this.commitPaths(["inbox.md"], "idea to article");
      return idea;
    });
  }

  /** Looks an idea up without taking it. */
  async idea(ideaId: string): Promise<Idea | undefined> {
    return (await this.inbox()).find((i) => i.id === ideaId);
  }

  /** Commits named paths at the repo root (inbox.md), inside the queue. */
  private async commitPaths(paths: string[], message: string): Promise<string | null> {
    await this.git.raw(["add", "--", ...paths]);
    const staged = await this.git.raw(["diff", "--cached", "--quiet", "--", ...paths], { ok: [0, 1] });
    if (staged.code === 0) return null;
    await this.git.raw(["commit", "-q", "-m", message, "--", ...paths]);
    return (await this.git.raw(["rev-parse", "HEAD"])).stdout.trim();
  }

  async snapshot(slug: string) {
    const row = this.row(slug);
    const files = {} as Record<FileName, { text: string; sha: string }>;
    for (const f of FILES) {
      const text = await readFile(this.path(slug, f), "utf8").catch(() => "");
      files[f] = { text, sha: sha256(text) };
    }
    this.db.run("UPDATE articles SET last_opened_at = ? WHERE id = ?", now(), row.id);
    const commit = (await this.git.run(["rev-parse", "HEAD"])).stdout.trim();
    return {
      slug,
      stage: row.stage,
      authorship: row.authorship,
      files,
      commit,
      comments: [],
      briefNotes: JSON.parse(String(row.brief_notes_json ?? "[]")),
      resume: null,
    };
  }

  /**
   * Saves one file when the client's base_sha is what is on disk; otherwise writes nothing and answers 409 with
   * the disk text. Commits at once on Cmd+S, otherwise at most once a minute per article.
   */
  async save(
    slug: string,
    file: FileName,
    text: string,
    baseSha: string,
    commitNow = false,
  ): Promise<SaveResult> {
    const row = this.row(slug);
    return this.git.serial(async () => {
      const path = this.path(slug, file);
      const disk = await readFile(path, "utf8").catch(() => "");
      const diskSha = sha256(disk);
      if (diskSha !== baseSha) throw new HttpError(409, { disk_sha: diskSha, disk_text: disk });
      if (disk !== text) await atomicWrite(path, text);
      const sha = sha256(text);
      if (file === "article") {
        this.db.run("UPDATE articles SET article_sha = ?, saved_at = ? WHERE id = ?", sha, now(), row.id);
      }
      const due = Date.now() - (this.lastCommitAt.get(slug) ?? 0) >= this.commitEveryMs;
      let commit: string | null = null;
      if (commitNow || due) commit = await this.commitLocked(slug, commitNow ? "save" : "autosave");
      else this.schedule(slug);
      this.changed(slug);
      return { sha, commit };
    });
  }

  /** Commits the article folder now, through the queue. Returns the new commit, or null when nothing changed. */
  commit(slug: string, message: string): Promise<string | null> {
    return this.git.serial(() => this.commitLocked(slug, message));
  }

  private async commitLocked(slug: string, message: string): Promise<string | null> {
    const timer = this.pending.get(slug);
    if (timer) clearTimeout(timer);
    this.pending.delete(slug);
    await this.git.raw(["add", "--", slug]);
    const staged = await this.git.raw(["diff", "--cached", "--quiet", "--", slug], { ok: [0, 1] });
    this.lastCommitAt.set(slug, Date.now());
    if (staged.code === 0) return null;
    await this.git.raw(["commit", "-q", "-m", `${message} ${slug}`, "--", slug]);
    const commit = (await this.git.raw(["rev-parse", "HEAD"])).stdout.trim();
    this.db.run("UPDATE articles SET last_commit = ? WHERE slug = ?", commit, slug);
    this.changed(slug);
    return commit;
  }

  private changed(slug: string): void {
    const row = this.db.all<ArticleRow>("SELECT * FROM articles WHERE slug = ?", slug)[0];
    if (!row) return;
    try {
      this.onChanged?.(row);
    } catch (e) {
      console.error(e);
    }
  }

  /** A save that did not commit gets a commit when the minute is up. */
  private schedule(slug: string) {
    if (this.pending.has(slug)) return;
    const wait = Math.max(0, this.commitEveryMs - (Date.now() - (this.lastCommitAt.get(slug) ?? 0)));
    const timer = setTimeout(() => {
      this.pending.delete(slug);
      void this.commit(slug, "autosave").catch(() => undefined);
    }, wait);
    timer.unref?.();
    this.pending.set(slug, timer);
  }

  /** `take disk`: keeps the client's text at refs/sparring/stash/<slug> without touching the working tree. */
  async stash(slug: string, file: FileName, text: string): Promise<string> {
    this.row(slug);
    return this.git.serial(() => this.keepAt(`refs/sparring/stash/${slug}`, slug, text, "stash", file));
  }

  /** Commits whatever is waiting for its minute. Called on shutdown. */
  async flush(): Promise<void> {
    for (const slug of [...this.pending.keys()]) await this.commit(slug, "autosave");
  }
}

export type TurnStatus = "running" | "done" | "interrupted" | "failed";

export interface Idea {
  id: string;
  /** When it was added (ISO), or "" for a line written by hand. */
  date: string;
  text: string;
}

const IDEA_RE = /^- (\d{4}-\d{2}-\d{2}T[\d:.]+Z) (.*)$/;

/** One inbox line as an idea; its id is a hash of the line, so it is stable while the line is. */
export function ideaOf(line: string): Idea | undefined {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return undefined;
  const id = sha256(trimmed).slice(0, 12);
  const m = IDEA_RE.exec(trimmed);
  if (m) return { id, date: m[1] as string, text: (m[2] as string).trim() };
  return { id, date: "", text: trimmed.replace(/^[-*]\s+/, "") };
}

export function parseInbox(text: string): Idea[] {
  return text
    .split("\n")
    .map(ideaOf)
    .filter((i): i is Idea => i !== undefined);
}

/**
 * Appends a line at the end of a `## Heading` section of a Markdown file, before the blank lines that close it.
 * The section is added at the end of the file when it is missing.
 */
export function appendUnder(text: string, heading: string, line: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  const at = lines.findIndex((l) => l.trim() === heading);
  if (at < 0) {
    while (lines.length && lines.at(-1)?.trim() === "") lines.pop();
    const head = lines.length ? [...lines, ""] : [];
    return `${[...head, heading, "", line].join("\n")}\n`;
  }
  let end = lines.length;
  for (let i = at + 1; i < lines.length; i++) {
    if (/^#{1,2} /.test(lines[i] as string)) {
      end = i;
      break;
    }
  }
  let insert = end;
  while (insert > at + 1 && lines[insert - 1]?.trim() === "") insert--;
  const before = lines.slice(0, insert);
  if (insert === at + 1) before.push("");
  const after = lines.slice(insert);
  const tail = end < lines.length && (after.length === 0 || after[0]?.trim() !== "") ? ["", ...after] : after;
  return `${[...before, line, ...tail].join("\n")}\n`;
}

/** Temp file in the same folder, fsync, rename: a reader sees the old file or the new one, never half. */
async function atomicWrite(path: string, text: string): Promise<void> {
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    const fh = await open(tmp, "w", 0o644);
    try {
      await fh.writeFile(text, "utf8");
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true });
    if ((e as NodeJS.ErrnoException).code === "ENOSPC") throw new HttpError(507, { error: "disk full" });
    throw e;
  }
}
