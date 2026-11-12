// The nightly backup. One run is three steps, each a job in the writing repo's git queue: a snapshot of
// sparring.db written to `<writing_dir>/.sparring-backup/sparring.db`, a commit of that path on main, then a push
// of every branch and every `refs/sparring/*` ref to `backup_remote`. With no remote set the first two still
// happen and the push is skipped. The remote is read from config.json on every run, so a fix needs no restart.
// The push can never ask for a password or hang: git runs with GIT_TERMINAL_PROMPT=0, ssh in BatchMode with a
// connect timeout, and the whole command is killed after two minutes. What happened is kept in
// `~/.sparring/backup.json`, which `pnpm backup` and `pnpm service status` read when no daemon answers.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type BackupState, dueAtStart, EMPTY_BACKUP, nextRun, shownRemote } from "@sparring/protocol/backup";
import { expandHome } from "./config.ts";
import type { Db } from "./db.ts";
import { GitError, type GitQueue } from "./git.ts";

/** The snapshot's path inside the writing repo. */
export const BACKUP_PATH = ".sparring-backup/sparring.db";
/** What a run pushes: every branch and every kept text. Never forced. */
export const BACKUP_REFSPECS = ["refs/heads/*:refs/heads/*", "refs/sparring/*:refs/sparring/*"] as const;

const PUSH_TIMEOUT_MS = 120_000;
const TICK_MS = 30_000;

/** What backup.json holds: the state without the parts that are only true of a running daemon. */
type Stored = Omit<BackupState, "running" | "remote" | "nextAt">;

/** `backup_remote` from config.json as it stands now, or null. A `~/` path is made absolute. */
export function readBackupRemote(home: string): string | null {
  try {
    const raw = JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as Record<string, unknown>;
    const v = typeof raw.backup_remote === "string" ? raw.backup_remote.trim() : "";
    return v ? expandHome(v) : null;
  } catch {
    return null;
  }
}

function readStored(home: string): Stored {
  const { running: _r, remote: _m, nextAt: _n, ...empty } = EMPTY_BACKUP;
  try {
    const raw = JSON.parse(readFileSync(join(home, "backup.json"), "utf8")) as Partial<Stored>;
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
    return {
      lastRunAt: num(raw.lastRunAt),
      ok: typeof raw.ok === "boolean" ? raw.ok : null,
      error: typeof raw.error === "string" ? raw.error : null,
      pushed: raw.pushed === true,
      lastLocalAt: num(raw.lastLocalAt),
      lastGoodAt: num(raw.lastGoodAt),
      commit: typeof raw.commit === "string" ? raw.commit : null,
    };
  } catch {
    return empty;
  }
}

/** The backup's state with no daemon to ask: what the last run left in backup.json, and the remote as set now. */
export function readBackupState(home: string): BackupState {
  const remote = readBackupRemote(home);
  return {
    ...readStored(home),
    running: false,
    remote: remote === null ? null : shownRemote(remote),
    nextAt: null,
  };
}

/** The reason in a failed git command: its last line that says something, without any password, kept short. */
function why(e: unknown): string {
  if (e instanceof GitError) {
    if (e.result.timedOut) return "timed out";
    const lines = `${e.result.stderr}\n${e.result.stdout}`
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !/^(hint:|To |Done$|Please make sure|and the repository exists)/.test(l));
    const fatal = lines.find((l) => /^(fatal|error|ssh):/i.test(l)) ?? lines.find((l) => l.startsWith("!"));
    const line = fatal ?? lines[lines.length - 1] ?? `git exited ${e.result.code}`;
    return redact(line).slice(0, 200);
  }
  return redact(e instanceof Error ? e.message : String(e)).slice(0, 200);
}

const redact = (s: string) => s.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/gi, "$1");

export interface BackupOptions {
  /** The daemon's open database: the snapshot is taken through it. */
  db: Db;
  /** The writing repo's queue. */
  git: GitQueue;
  /** Where `backup.json` is kept. */
  home: string;
  /** `backup_remote` now. Read on every run. */
  remote?: () => string | null;
  now?: () => number;
  pushTimeoutMs?: number;
  log?: (m: string) => void;
}

export class Backup {
  private stored: Stored;
  private running: Promise<BackupState> | null = null;
  private nextAt: number | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;
  private readonly remote: () => string | null;
  private readonly log: (m: string) => void;

  constructor(private readonly o: BackupOptions) {
    this.now = o.now ?? Date.now;
    this.remote = o.remote ?? (() => readBackupRemote(o.home));
    this.log = o.log ?? (() => {});
    this.stored = readStored(o.home);
  }

  state(): BackupState {
    const remote = this.remote();
    return {
      ...this.stored,
      running: this.running !== null,
      remote: remote === null ? null : shownRemote(remote),
      nextAt: this.nextAt,
    };
  }

  /**
   * Starts the schedule: the next 03:30, and a run at once when the last good backup is more than a day old.
   * Returns that first run, or null when none was due.
   */
  start(): Promise<BackupState> | null {
    const now = this.now();
    this.nextAt = nextRun(now);
    // A short tick, not one long timer: a Mac that slept through 03:30 runs the backup when it wakes.
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref?.();
    return dueAtStart(this.state(), now) ? this.run() : null;
  }

  /** Runs the night's backup once its time has come. Returns the run, or null when it is not time. */
  tick(): Promise<BackupState> | null {
    const now = this.now();
    if (this.nextAt === null || now < this.nextAt) return null;
    this.nextAt = nextRun(now);
    return this.run();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.nextAt = null;
  }

  /** One backup, now. A call made while one runs gets that run. Never throws: a failure is in the state. */
  run(): Promise<BackupState> {
    this.running ??= this.once().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async once(): Promise<BackupState> {
    const { git } = this.o;
    const patch: Partial<Stored> = { pushed: false };
    let step = "snapshot";
    try {
      const commit = await git.serial(async () => {
        this.snapshot();
        step = "commit";
        await git.raw(["add", "-f", "--", BACKUP_PATH]);
        const staged = await git.raw(["diff", "--cached", "--quiet", "--", BACKUP_PATH], { ok: [0, 1] });
        if (staged.code === 1) await git.raw(["commit", "-q", "-m", "backup sparring.db", "--", BACKUP_PATH]);
        return (await git.raw(["rev-parse", "HEAD"])).stdout.trim();
      });
      patch.commit = commit;
      patch.lastLocalAt = this.now();
      const remote = this.remote();
      if (remote !== null) {
        step = "push";
        // A remote that starts with a dash would be read as an option.
        if (remote.startsWith("-")) throw new Error("backup_remote is not a repo address");
        await git.run(["push", "--porcelain", remote, ...BACKUP_REFSPECS], {
          env: { GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o ConnectTimeout=15" },
          timeoutMs: this.o.pushTimeoutMs ?? PUSH_TIMEOUT_MS,
        });
        patch.pushed = true;
        patch.lastGoodAt = this.now();
      }
      patch.ok = true;
      patch.error = null;
      this.log(`backup: ${commit.slice(0, 7)} · ${remote === null ? "no remote set, not pushed" : "pushed"}`);
    } catch (e) {
      patch.ok = false;
      patch.error = `${step} · ${why(e)}`;
      this.log(`backup failed: ${patch.error}`);
    }
    this.stored = { ...this.stored, ...patch, lastRunAt: this.now() };
    this.save();
    return { ...this.state(), running: false };
  }

  /**
   * The snapshot: `VACUUM INTO`, SQLite's own consistent copy of a live database (what the shell's `.backup`
   * gives, through plain SQL). Written beside its place and renamed, so a failed run leaves the old one whole.
   */
  private snapshot(): void {
    const path = join(this.o.git.cwd, BACKUP_PATH);
    const tmp = `${path}.tmp`;
    mkdirSync(join(this.o.git.cwd, ".sparring-backup"), { recursive: true });
    rmSync(tmp, { force: true });
    try {
      this.o.db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
      renameSync(tmp, path);
    } finally {
      rmSync(tmp, { force: true });
    }
  }

  private save(): void {
    try {
      const path = join(this.o.home, "backup.json");
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(this.stored, null, 2)}\n`, { mode: 0o600 });
      if (existsSync(tmp)) chmodSync(tmp, 0o600);
      renameSync(tmp, path);
    } catch (e) {
      this.log(`backup: state not saved · ${e instanceof Error ? e.message : e}`);
    }
  }
}
