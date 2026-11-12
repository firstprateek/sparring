// Step 9's done-when for the backup, with no network: against a local bare repo as the remote, the remote ends
// up holding `refs/sparring/*` and a `main` whose tree has `.sparring-backup/sparring.db`, and that file opens as
// a SQLite database with the articles table. Also: a failing remote records its reason and the next run
// recovers, no remote set skips the push, a push cannot wait for a password or hang, and the schedule (the next
// run, the catch-up at start) follows an injected clock.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BackupState, CATCH_UP_MS, nextRun } from "@sparring/protocol/backup";
import { describe, expect, it } from "vitest";
import { BACKUP_PATH, Backup, readBackupRemote, readBackupState } from "../src/backup.ts";
import { openDb } from "../src/db.ts";
import { GitError, GitQueue, gitEnv } from "../src/git.ts";
import { restHandler } from "../src/rest.ts";
import { dirs, rig } from "./rig.ts";

const tmp = (name: string) => {
  const d = mkdtempSync(join(tmpdir(), `sparring-${name}-`));
  dirs.push(d);
  return d;
};
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/** A writing repo with one article and one kept text under `refs/sparring/`, a bare repo to push to, and a home. */
async function setup(o: { remote?: boolean; now?: () => number } = {}) {
  const r = await rig();
  await r.article("closed-laptop");
  const stash = await r.call("POST", "/api/articles/closed-laptop/stash", {
    file: "article",
    text: "kept\n",
  });
  expect(stash.status).toBe(200);
  const home = tmp("home");
  const bare = join(tmp("remote"), "backup.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
  let remote: string | null = o.remote === false ? null : bare;
  const backup = new Backup({
    db: r.db,
    git: r.articles.git,
    home,
    remote: () => remote,
    ...(o.now ? { now: o.now } : {}),
  });
  return { ...r, home, bare, backup, setRemote: (v: string | null) => (remote = v) };
}

describe("the nightly backup", () => {
  it("leaves refs/sparring/* and a main with the database on the remote", async () => {
    const t = await setup();
    const s = await t.backup.run();
    expect(s).toMatchObject({ ok: true, pushed: true, error: null, running: false, remote: t.bare });
    expect(s.lastGoodAt).not.toBeNull();

    const refs = git(t.bare, "for-each-ref", "--format=%(refname)").split("\n");
    expect(refs).toContain("refs/heads/main");
    expect(refs).toContain("refs/sparring/stash/closed-laptop");
    expect(git(t.bare, "ls-tree", "-r", "--name-only", "main").split("\n")).toContain(BACKUP_PATH);
    // The remote's main is the writing repo's main, and the commit the state names.
    expect(git(t.bare, "rev-parse", "main")).toBe(git(t.dir, "rev-parse", "main"));
    expect(s.commit).toBe(git(t.dir, "rev-parse", "main"));
    // The kept text travelled too.
    expect(git(t.bare, "show", "refs/sparring/stash/closed-laptop:closed-laptop/article.md")).toBe("kept");

    // The file on the remote opens as a SQLite database with the articles table and the article in it.
    const out = join(tmp("restore"), "sparring.db");
    writeFileSync(
      out,
      execFileSync("git", ["show", `main:${BACKUP_PATH}`], { cwd: t.bare, maxBuffer: 64 * 1024 * 1024 }),
    );
    const copy = await openDb(out);
    expect(
      copy.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'articles'"),
    ).toHaveLength(1);
    expect(copy.all<{ slug: string }>("SELECT slug FROM articles").map((a) => a.slug)).toEqual([
      "closed-laptop",
    ]);
    copy.close();
  });

  it("commits only the snapshot, and makes no commit when the database has not changed", async () => {
    const t = await setup();
    writeFileSync(join(t.dir, "closed-laptop", "article.md"), "typed and not committed yet\n");
    const before = git(t.dir, "rev-parse", "main");
    await t.backup.run();
    expect(git(t.dir, "log", "-1", "--format=%s")).toBe("backup sparring.db");
    expect(git(t.dir, "show", "--name-only", "--format=", "HEAD")).toBe(BACKUP_PATH);
    expect(git(t.dir, "rev-parse", "HEAD~1")).toBe(before);
    // The page being typed is left as it was: not committed by the backup.
    expect(git(t.dir, "status", "--porcelain", "--", "closed-laptop")).toContain("closed-laptop/article.md");
    const head = git(t.dir, "rev-parse", "main");
    const again = await t.backup.run();
    expect(again.ok).toBe(true);
    expect(git(t.dir, "rev-parse", "main")).toBe(head);
  });

  it("records why a push failed, and the next run recovers", async () => {
    const t = await setup();
    const first = await t.backup.run();
    expect(first.ok).toBe(true);
    renameSync(t.bare, `${t.bare}.gone`);
    const bad = await t.backup.run();
    expect(bad).toMatchObject({ ok: false, pushed: false });
    expect(bad.error).toMatch(/^push · /);
    expect(bad.error).toMatch(/does not appear to be a git repository|not a git repository/);
    // The last good backup is still the first one, and the snapshot was still taken.
    expect(bad.lastGoodAt).toBe(first.lastGoodAt);
    expect(bad.lastLocalAt).toBeGreaterThanOrEqual(first.lastLocalAt as number);
    // The failure is on disk for `pnpm backup status` and the next daemon.
    expect(readBackupState(t.home)).toMatchObject({ ok: false, error: bad.error });

    renameSync(`${t.bare}.gone`, t.bare);
    await t.article("second");
    const good = await t.backup.run();
    expect(good).toMatchObject({ ok: true, pushed: true, error: null });
    expect(good.lastGoodAt).toBeGreaterThanOrEqual(bad.lastRunAt as number);
    expect(git(t.bare, "rev-parse", "main")).toBe(git(t.dir, "rev-parse", "main"));
    expect(git(t.bare, "ls-tree", "--name-only", "main")).toContain("second");
  });

  it("with no remote set still snapshots and commits, and skips the push", async () => {
    const t = await setup({ remote: false });
    const s = await t.backup.run();
    expect(s).toMatchObject({ ok: true, pushed: false, remote: null, lastGoodAt: null, error: null });
    expect(s.lastLocalAt).not.toBeNull();
    expect(git(t.dir, "ls-tree", "-r", "--name-only", "main").split("\n")).toContain(BACKUP_PATH);
    expect(git(t.bare, "for-each-ref")).toBe("");
    // Set later, the same daemon pushes on its next run.
    t.setRemote(t.bare);
    expect(await t.backup.run()).toMatchObject({ ok: true, pushed: true });
    expect(git(t.bare, "rev-parse", "main")).toBe(git(t.dir, "rev-parse", "main"));
  });

  it("joins a run that is going on, and keeps its state across a restart", async () => {
    const t = await setup();
    const a = t.backup.run();
    expect(t.backup.state().running).toBe(true);
    const b = t.backup.run();
    expect(await a).toEqual(await b);
    expect(git(t.dir, "log", "--format=%s", "--", BACKUP_PATH).split("\n")).toHaveLength(1);
    expect(statSync(join(t.home, "backup.json")).mode & 0o077).toBe(0);
    const next = new Backup({ db: t.db, git: t.articles.git, home: t.home, remote: () => t.bare });
    expect(next.state()).toMatchObject({ ok: true, pushed: true, lastGoodAt: (await a).lastGoodAt });
  });

  it("reads backup_remote from config.json on every run and never shows a password", async () => {
    const t = await setup();
    expect(readBackupRemote(t.home)).toBeNull();
    writeFileSync(join(t.home, "config.json"), JSON.stringify({ backup_remote: ` ${t.bare} ` }));
    expect(readBackupRemote(t.home)).toBe(t.bare);
    const fromConfig = new Backup({ db: t.db, git: t.articles.git, home: t.home });
    expect(await fromConfig.run()).toMatchObject({ ok: true, pushed: true, remote: t.bare });
    writeFileSync(
      join(t.home, "config.json"),
      JSON.stringify({ backup_remote: "https://me:hunter2@127.0.0.1:1/x.git" }),
    );
    const s = await fromConfig.run();
    expect(s.remote).toBe("https://127.0.0.1:1/x.git");
    expect(s.ok).toBe(false);
    expect(JSON.stringify(s)).not.toContain("hunter2");
    expect(readFileSync(join(t.home, "backup.json"), "utf8")).not.toContain("hunter2");
  });
});

describe("a push that cannot go through fails fast", () => {
  it("runs git with no terminal prompt and ssh in batch mode", () => {
    const env = gitEnv();
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(env.GIT_SSH_COMMAND).toContain("BatchMode=yes");
  });

  it("fails on an ssh remote that does not answer instead of waiting", async () => {
    const t = await setup();
    t.setRemote("ssh://git@127.0.0.1:1/nothing.git");
    const started = Date.now();
    const s = await t.backup.run();
    expect(s).toMatchObject({ ok: false, pushed: false });
    expect(s.error).toMatch(/^push · /);
    expect(Date.now() - started).toBeLessThan(20_000);
  });

  it("kills a git command that outlives its timeout", async () => {
    const q = new GitQueue(tmp("slow"));
    const started = Date.now();
    const err = await q
      .raw(["-c", "alias.wait=!sleep 20", "wait"], { timeoutMs: 300 })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitError);
    expect((err as GitError).result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("reports a push that timed out as such", async () => {
    const t = await setup();
    // A queue whose push never returns in time: the alias stands in for a remote that hangs.
    const slow = new GitQueue(t.dir);
    const raw = slow.raw.bind(slow);
    slow.raw = (args, opts) =>
      args[0] === "push" ? raw(["-c", "alias.wait=!sleep 20", "wait"], opts) : raw(args, opts);
    const b = new Backup({ db: t.db, git: slow, home: t.home, remote: () => t.bare, pushTimeoutMs: 300 });
    expect(await b.run()).toMatchObject({ ok: false, error: "push · timed out" });
  });
});

describe("the schedule", () => {
  const at = (y: number, mo: number, d: number, h: number, mi: number) =>
    new Date(y, mo - 1, d, h, mi).getTime();

  it("runs next at 03:30 local time", () => {
    expect(nextRun(at(2026, 11, 11, 14, 0))).toBe(at(2026, 11, 12, 3, 30));
    expect(nextRun(at(2026, 11, 11, 1, 0))).toBe(at(2026, 11, 11, 3, 30));
    // At 03:30 itself the next one is tomorrow's, so one night is one run.
    expect(nextRun(at(2026, 11, 11, 3, 30))).toBe(at(2026, 11, 12, 3, 30));
    expect(nextRun(at(2026, 12, 31, 23, 59))).toBe(at(2027, 1, 1, 3, 30));
  });

  it("backs up at start when there is no good backup, then once a night", async () => {
    let now = at(2026, 11, 11, 14, 0);
    const t = await setup({ now: () => now });
    const first = t.backup.start();
    expect(first).not.toBeNull();
    expect(await first).toMatchObject({ ok: true, pushed: true, nextAt: at(2026, 11, 12, 3, 30) });
    const commits = () => git(t.dir, "log", "--format=%s", "--", BACKUP_PATH).split("\n").length;
    expect(commits()).toBe(1);

    // Not yet: the afternoon, then one minute before.
    now = at(2026, 11, 11, 20, 0);
    expect(t.backup.tick()).toBeNull();
    now = at(2026, 11, 12, 3, 29);
    expect(t.backup.tick()).toBeNull();
    // The night's run, once: a second tick in the same minute does nothing.
    await t.article("written-since");
    now = at(2026, 11, 12, 3, 30);
    const night = t.backup.tick();
    expect(night).not.toBeNull();
    expect(t.backup.tick()).toBeNull();
    expect(await night).toMatchObject({ ok: true, lastGoodAt: now, nextAt: at(2026, 11, 13, 3, 30) });
    expect(commits()).toBe(2);
    // A machine that slept through the hour runs it when it wakes.
    await t.article("after-the-nap");
    now = at(2026, 11, 13, 9, 15);
    expect(await t.backup.tick()).toMatchObject({ ok: true, nextAt: at(2026, 11, 14, 3, 30) });
    expect(commits()).toBe(3);
    t.backup.stop();
    expect(t.backup.tick()).toBeNull();
  });

  it("at start, catches up only when the last good backup is more than 24 hours old", async () => {
    let now = at(2026, 11, 11, 14, 0);
    const t = await setup({ now: () => now });
    await t.backup.run();
    const restart = () =>
      new Backup({ db: t.db, git: t.articles.git, home: t.home, remote: () => t.bare, now: () => now });

    now += CATCH_UP_MS - 60_000;
    const fresh = restart();
    expect(fresh.start()).toBeNull();
    expect(fresh.state().nextAt).toBe(nextRun(now));
    fresh.stop();

    now += 120_000;
    const stale = restart();
    const run = stale.start();
    expect(run).not.toBeNull();
    expect(await run).toMatchObject({ ok: true, lastGoodAt: now });
    stale.stop();
  });

  it("at start, a failed last run is tried again once it is a day since the last good one", async () => {
    let now = at(2026, 11, 11, 14, 0);
    const t = await setup({ now: () => now });
    await t.backup.run();
    renameSync(t.bare, `${t.bare}.gone`);
    now += 2 * 3_600_000;
    expect((await t.backup.run()).ok).toBe(false);
    renameSync(`${t.bare}.gone`, t.bare);
    now += CATCH_UP_MS;
    const b = new Backup({
      db: t.db,
      git: t.articles.git,
      home: t.home,
      remote: () => t.bare,
      now: () => now,
    });
    expect(await b.start()).toMatchObject({ ok: true, pushed: true });
    b.stop();
  });

  it("with no remote, a start goes by the last local snapshot", async () => {
    let now = at(2026, 11, 11, 14, 0);
    const t = await setup({ remote: false, now: () => now });
    expect(await t.backup.start()).toMatchObject({ ok: true, pushed: false });
    t.backup.stop();
    now += 3_600_000;
    const b = new Backup({ db: t.db, git: t.articles.git, home: t.home, remote: () => null, now: () => now });
    expect(b.start()).toBeNull();
    b.stop();
  });
});

describe("GET and POST /api/backup", () => {
  const api = (t: Awaited<ReturnType<typeof setup>>, waitMs?: number) => {
    const handle = restHandler(t.articles, t.coach, undefined, t.backup, waitMs);
    return async (method: string) => {
      const res = await handle(
        new Request("http://127.0.0.1:7421/api/backup", {
          method,
          ...(method === "POST" ? { headers: { "content-type": "application/json" }, body: "{}" } : {}),
        }),
      );
      return { status: res.status, body: (await res.json()) as BackupState };
    };
  };

  it("says the state, and a POST runs a backup and answers with what happened", async () => {
    const t = await setup();
    const call = api(t);
    const before = await call("GET");
    expect(before).toMatchObject({ status: 200, body: { ok: null, lastGoodAt: null, remote: t.bare } });
    const ran = await call("POST");
    expect(ran).toMatchObject({ status: 200, body: { ok: true, pushed: true, running: false } });
    expect((await call("GET")).body).toEqual(ran.body);
    expect(git(t.bare, "ls-tree", "-r", "--name-only", "main").split("\n")).toContain(BACKUP_PATH);
  });

  it("answers `running` when a run outlasts the wait, and 503 with no backup attached", async () => {
    const t = await setup();
    const slow = await api(t, 0)("POST");
    expect(slow.body.running).toBe(true);
    expect(await t.backup.run()).toMatchObject({ ok: true, running: false });
    const none = await restHandler(t.articles)(new Request("http://127.0.0.1:7421/api/backup"));
    expect(none.status).toBe(503);
  });
});
