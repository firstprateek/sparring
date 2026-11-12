import { describe, expect, it } from "vitest";
import {
  type BackupState,
  backupLine,
  CATCH_UP_MS,
  dueAtStart,
  EMPTY_BACKUP,
  nextRun,
  STALE_MS,
  shownRemote,
} from "../src/backup.ts";

const at = (d: number, h: number, mi: number) => new Date(2026, 10, d, h, mi).getTime();
const NOW = at(11, 14, 0);
const H = 3_600_000;
const good: BackupState = {
  ...EMPTY_BACKUP,
  remote: "git@example.com:me/backup.git",
  ok: true,
  pushed: true,
  lastRunAt: NOW - 2 * H,
  lastLocalAt: NOW - 2 * H,
  lastGoodAt: NOW - 2 * H,
};

describe("the backup schedule", () => {
  it("is 03:30 local time, tonight or tomorrow", () => {
    expect(nextRun(at(11, 3, 29))).toBe(at(11, 3, 30));
    expect(nextRun(at(11, 3, 30))).toBe(at(12, 3, 30));
    expect(nextRun(NOW)).toBe(at(12, 3, 30));
    expect(new Date(nextRun(NOW)).getHours()).toBe(3);
    expect(new Date(nextRun(NOW)).getMinutes()).toBe(30);
  });

  it("catches up at start when the last good backup is more than 24 hours old, or there is none", () => {
    expect(dueAtStart(EMPTY_BACKUP, NOW)).toBe(true);
    expect(dueAtStart({ ...good, lastGoodAt: null }, NOW)).toBe(true);
    expect(dueAtStart({ ...good, lastGoodAt: NOW - CATCH_UP_MS }, NOW)).toBe(false);
    expect(dueAtStart({ ...good, lastGoodAt: NOW - CATCH_UP_MS - 1 }, NOW)).toBe(true);
    // A fresh local snapshot does not stand in for a push once a remote is set.
    expect(dueAtStart({ ...good, lastGoodAt: null, lastLocalAt: NOW }, NOW)).toBe(true);
    // With no remote the local snapshot is all there is.
    expect(dueAtStart({ remote: null, lastGoodAt: null, lastLocalAt: NOW - H }, NOW)).toBe(false);
    expect(dueAtStart({ remote: null, lastGoodAt: null, lastLocalAt: NOW - 25 * H }, NOW)).toBe(true);
  });
});

describe("the backup line", () => {
  it("is `backup · <age>` when fine", () => {
    expect(backupLine(good, NOW)).toEqual({ text: "backup · 2h", bad: false });
    expect(backupLine({ ...good, lastGoodAt: NOW - STALE_MS }, NOW).bad).toBe(false);
  });

  it("is red past 36 hours, after a failure and with no remote, and names the fix each time", () => {
    const stale = backupLine({ ...good, lastGoodAt: NOW - STALE_MS - 1 }, NOW);
    expect(stale.bad).toBe(true);
    expect(stale.text).toContain("backup_remote in config.json");

    const failed = backupLine({ ...good, ok: false, error: "push · timed out" }, NOW);
    expect(failed).toEqual({
      text: "backup failed · push · timed out · check backup_remote in config.json · last good 2h ago",
      bad: true,
    });
    // A snapshot that failed is not the remote's doing.
    const disk = backupLine({ ...good, ok: false, error: "snapshot · database or disk is full" }, NOW);
    expect(disk.text).toBe("backup failed · snapshot · database or disk is full · last good 2h ago");

    const unset = backupLine({ ...EMPTY_BACKUP, ok: true, lastLocalAt: NOW - 60_000 }, NOW);
    expect(unset.bad).toBe(true);
    expect(unset.text).toBe(
      "backup · no remote set, so nothing leaves this machine · set backup_remote in config.json to a private repo · local snapshot 1m ago",
    );
  });

  it("says a run is going on, and that none has run yet", () => {
    expect(backupLine({ ...good, running: true }, NOW)).toEqual({ text: "backing up…", bad: false });
    expect(backupLine({ ...EMPTY_BACKUP, remote: "x" }, NOW)).toEqual({
      text: "backup · not run yet",
      bad: false,
    });
  });

  it("never shows the password of an https remote", () => {
    expect(shownRemote("https://me:secret@github.com/me/b.git")).toBe("https://github.com/me/b.git");
    expect(shownRemote("git@github.com:me/b.git")).toBe("git@github.com:me/b.git");
    expect(shownRemote("/tmp/b.git")).toBe("/tmp/b.git");
  });
});
