// The nightly backup, as the daemon reports it and as every screen says it: the Articles foot, `pnpm backup` and
// `pnpm service status` all draw the same line from the same state. The schedule is here too, as pure functions
// of a clock, so the daemon and the tests agree on when a night's run is due.

/** What `GET /api/backup` answers, and what the daemon keeps in `~/.sparring/backup.json`. Times are ms. */
export interface BackupState {
  /** A run is going on now. */
  running: boolean;
  /** `backup_remote` as config.json has it now, without any password in it. Null when it is not set. */
  remote: string | null;
  /** When the last run ended. Null before the first. */
  lastRunAt: number | null;
  /** Whether the last run did all it was asked. Null before the first. */
  ok: boolean | null;
  /** Why the last run failed, with the step it failed at. */
  error: string | null;
  /** The last run pushed. False when it failed first, or when no remote was set. */
  pushed: boolean;
  /** The last time the snapshot was written and committed in the writing repo. */
  lastLocalAt: number | null;
  /** The last good backup: the last time a push to the remote went through. */
  lastGoodAt: number | null;
  /** `main` of the writing repo after the last snapshot. */
  commit: string | null;
  /** When the next nightly run is due. Null when no daemon is scheduling. */
  nextAt: number | null;
}

export const EMPTY_BACKUP: BackupState = {
  running: false,
  remote: null,
  lastRunAt: null,
  ok: null,
  error: null,
  pushed: false,
  lastLocalAt: null,
  lastGoodAt: null,
  commit: null,
  nextAt: null,
};

/** The night's run is at 03:30, local time. */
export const BACKUP_HOUR = 3;
export const BACKUP_MINUTE = 30;
const HOUR = 3_600_000;
/** A start finds the last good backup older than this: it runs one at once. */
export const CATCH_UP_MS = 24 * HOUR;
/** The screens turn red when the last good backup is older than this: one missed night and a bit. */
export const STALE_MS = 36 * HOUR;

/** The first 03:30 local time after `now`. */
export function nextRun(now: number, hour = BACKUP_HOUR, minute = BACKUP_MINUTE): number {
  const d = new Date(now);
  d.setHours(hour, minute, 0, 0);
  if (d.getTime() <= now) d.setDate(d.getDate() + 1); // by the calendar, so a 23 or 25 hour day lands on 03:30 too
  return d.getTime();
}

/**
 * Whether a daemon that starts at `now` backs up at once: the last good backup is more than 24 hours old, or
 * there is none. With no remote set there is nothing to push, so the last local snapshot is what counts.
 */
export function dueAtStart(
  s: Pick<BackupState, "remote" | "lastGoodAt" | "lastLocalAt">,
  now: number,
): boolean {
  const last = s.remote === null ? s.lastLocalAt : s.lastGoodAt;
  return last === null || now - last > CATCH_UP_MS;
}

/** A span of age: `12s`, `5m`, `2h`, `3d`. */
export function age(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/** A remote without the user and password an https URL may carry. */
export function shownRemote(remote: string): string {
  return remote.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, "$1");
}

export interface BackupLine {
  /** The line: `backup · 3h` when all is well. */
  text: string;
  /** Drawn in red: the last run failed, no remote is set, or the last good backup is too old. */
  bad: boolean;
}

const FIX_UNSET = "set backup_remote in config.json to a private repo";
const FIX_CHECK = "check backup_remote in config.json";

/** The one line every screen shows for the backup. A bad line names the fix. */
export function backupLine(s: BackupState, now: number): BackupLine {
  if (s.running) return { text: "backing up…", bad: false };
  const good = s.lastGoodAt === null ? "" : ` · last good ${age(now - s.lastGoodAt)} ago`;
  if (s.ok === false) {
    // Only a failed push is the remote's doing; a failed snapshot or commit is said as it is.
    const fix = (s.error ?? "").startsWith("push") ? ` · ${FIX_CHECK}` : "";
    return { text: `backup failed · ${s.error ?? "no reason given"}${fix}${good}`, bad: true };
  }
  if (s.remote === null) {
    const local = s.lastLocalAt === null ? "" : ` · local snapshot ${age(now - s.lastLocalAt)} ago`;
    return {
      text: `backup · no remote set, so nothing leaves this machine · ${FIX_UNSET}${local}`,
      bad: true,
    };
  }
  if (s.lastGoodAt === null) return { text: "backup · not run yet", bad: false };
  if (now - s.lastGoodAt > STALE_MS) {
    return {
      text: `backup · last good ${age(now - s.lastGoodAt)} ago · ${FIX_CHECK}, and that the daemon was running at 03:30`,
      bad: true,
    };
  }
  return { text: `backup · ${age(now - s.lastGoodAt)}`, bad: false };
}
