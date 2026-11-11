// Articles on disk. `~/writing` is a git repo and `<slug>/article.md` in it is the article: the daemon saves
// with a base_sha check, writes atomically and commits through one git queue. SQLite holds the row, never the
// text.
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
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
  stage: string;
  authorship: string;
  last_commit: string | null;
  created_at: string;
  [k: string]: unknown;
}

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

  row(slug: string): ArticleRow {
    const row = this.db.all<ArticleRow>("SELECT * FROM articles WHERE slug = ?", slug)[0];
    if (!row) throw new HttpError(404, { error: `no article ${slug}` });
    return row;
  }

  /** Checks the slug rule, then makes the folder, its three files, a commit and the row. */
  async create(slug: string, provider?: string): Promise<ArticleRow> {
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
      for (const f of FILES) await writeFile(join(folder, `${f}.md`), "");
      const meta = { title: "", description: "", date: "", answers: ["", "", ""] };
      await writeFile(join(folder, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
      await this.git.raw(["add", "--", slug]);
      await this.git.raw(["commit", "-q", "-m", `new article ${slug}`, "--", slug]);
      return (await this.git.raw(["rev-parse", "HEAD"])).stdout.trim();
    });
    const at = now();
    this.db.run(
      `INSERT INTO articles (id, slug, provider, article_sha, last_commit, saved_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      randomUUID(),
      slug,
      provider ?? this.opts.defaultProvider,
      sha256(""),
      commit,
      at,
      at,
    );
    this.lastCommitAt.set(slug, Date.now());
    return this.row(slug);
  }

  private path(slug: string, file: FileName) {
    return join(this.dir, slug, `${file}.md`);
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
    return commit;
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
    return this.git.serial(async () => {
      const blob = (await this.git.raw(["hash-object", "-w", "--stdin"], { input: text })).stdout.trim();
      const index = join(this.dir, ".git", `sparring-stash-${randomUUID()}.index`);
      const env = { GIT_INDEX_FILE: index };
      try {
        await this.git.raw(["read-tree", "HEAD"], { env });
        await this.git.raw(["update-index", "--add", "--cacheinfo", `100644,${blob},${slug}/${file}.md`], {
          env,
        });
        const tree = (await this.git.raw(["write-tree"], { env })).stdout.trim();
        const ref = `refs/sparring/stash/${slug}`;
        const prev = await this.git.raw(["rev-parse", "--verify", "-q", ref], { ok: [0, 1] });
        const parents = ["-p", prev.code === 0 ? prev.stdout.trim() : "HEAD"];
        const commit = (
          await this.git.raw(["commit-tree", tree, ...parents, "-m", `stash ${slug}/${file}.md`])
        ).stdout.trim();
        await this.git.raw(["update-ref", ref, commit]);
        return commit;
      } finally {
        await rm(index, { force: true });
      }
    });
  }

  /** Commits whatever is waiting for its minute. Called on shutdown. */
  async flush(): Promise<void> {
    for (const slug of [...this.pending.keys()]) await this.commit(slug, "autosave");
  }
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
