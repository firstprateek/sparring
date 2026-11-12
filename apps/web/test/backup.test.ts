// @vitest-environment happy-dom
import { type BackupState, EMPTY_BACKUP } from "@sparring/protocol/backup";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BackupFoot } from "../src/backup.ts";

const NOW = new Date(2026, 10, 11, 14, 0).getTime();
const H = 3_600_000;
const good: BackupState = {
  ...EMPTY_BACKUP,
  remote: "git@example.com:me/writing-backup.git",
  ok: true,
  pushed: true,
  lastRunAt: NOW - 3 * H,
  lastLocalAt: NOW - 3 * H,
  lastGoodAt: NOW - 3 * H,
  commit: "abc1234",
};

function foot(first: BackupState | Error, ran?: BackupState | Error) {
  const el = document.createElement("p");
  document.body.append(el);
  const answer = (v: BackupState | Error) => (v instanceof Error ? Promise.reject(v) : Promise.resolve(v));
  const get = vi.fn(() => answer(first));
  const run = vi.fn(() => answer(ran ?? first));
  const f = new BackupFoot(
    el,
    { get, run, words: (e) => (e instanceof Error ? e.message : "?") },
    () => NOW,
    0,
  );
  const line = () => el.querySelector(".backup-line") as HTMLElement;
  const btn = () => el.querySelector(".backup-run") as HTMLButtonElement;
  return { el, f, get, run, line, btn };
}

afterEach(() => document.body.replaceChildren());

describe("the backup line on Articles", () => {
  it("is hidden until the state is read, then reads `backup · 3h`, muted, with `back up now`", async () => {
    const t = foot(good);
    expect(t.el.hidden).toBe(true);
    await t.f.load();
    expect(t.el.hidden).toBe(false);
    expect(t.line().textContent).toBe("backup · 3h");
    expect(t.line().classList.contains("muted")).toBe(true);
    expect(t.line().classList.contains("err")).toBe(false);
    expect(t.el.classList.contains("bad")).toBe(false);
    expect(t.btn().textContent).toBe("back up now");
    expect(t.btn().hidden).toBe(false);
  });

  it("is red and names backup_remote in config.json when no remote is set", async () => {
    const t = foot({ ...EMPTY_BACKUP, ok: true, lastRunAt: NOW - H, lastLocalAt: NOW - H });
    await t.f.load();
    expect(t.line().classList.contains("err")).toBe(true);
    expect(t.el.classList.contains("bad")).toBe(true);
    expect(t.line().textContent).toContain("no remote set");
    expect(t.line().textContent).toContain("set backup_remote in config.json to a private repo");
    expect(t.line().textContent).toContain("local snapshot 1h ago");
  });

  it("is red with the reason when the last backup failed", async () => {
    const t = foot({
      ...good,
      ok: false,
      pushed: false,
      lastRunAt: NOW - 60_000,
      error: "push · fatal: '/tmp/x.git' does not appear to be a git repository",
    });
    await t.f.load();
    expect(t.line().classList.contains("err")).toBe(true);
    expect(t.line().textContent).toBe(
      "backup failed · push · fatal: '/tmp/x.git' does not appear to be a git repository · check backup_remote in config.json · last good 3h ago",
    );
  });

  it("is red when the last good backup is older than 36 hours", async () => {
    const t = foot({ ...good, lastGoodAt: NOW - 37 * H });
    await t.f.load();
    expect(t.line().classList.contains("err")).toBe(true);
    expect(t.line().textContent).toContain("last good 1d ago");
    expect(t.line().textContent).toContain("backup_remote in config.json");
    const fine = foot({ ...good, lastGoodAt: NOW - 35 * H });
    await fine.f.load();
    expect(fine.line().classList.contains("err")).toBe(false);
    expect(fine.line().textContent).toBe("backup · 1d");
  });

  it("`back up now` runs one, says `backing up…` meanwhile, then shows the new age", async () => {
    const t = foot(good, { ...good, lastRunAt: NOW, lastLocalAt: NOW, lastGoodAt: NOW });
    await t.f.load();
    t.btn().click();
    expect(t.line().textContent).toBe("backing up…");
    expect(t.btn().hidden).toBe(true);
    await vi.waitFor(() => expect(t.line().textContent).toBe("backup · 0s"));
    expect(t.run).toHaveBeenCalledTimes(1);
    expect(t.btn().hidden).toBe(false);
  });

  it("asks again while a slow run is still going", async () => {
    const t = foot({ ...good, lastGoodAt: NOW }, { ...good, running: true });
    void t.f.run();
    await vi.waitFor(() => expect(t.line().textContent).toBe("backup · 0s"));
    expect(t.get).toHaveBeenCalledTimes(1);
  });

  it("says so, without `back up now`, when the daemon is older than the page and has no backup yet", async () => {
    const el = document.createElement("p");
    const old = new BackupFoot(el, {
      get: () => Promise.reject(new Error("not found")),
      run: () => Promise.reject(new Error("not found")),
      words: () => "not found",
      missing: () => true,
    });
    await old.load();
    expect(el.hidden).toBe(false);
    expect(el.querySelector(".backup-line")?.textContent).toBe(
      "backup · the daemon runs an older build · restart it to back up",
    );
    expect((el.querySelector(".backup-run") as HTMLElement).hidden).toBe(true);
  });

  it("says in red when the run or the state could not be asked for", async () => {
    const t = foot(good, new Error("could not reach the daemon"));
    await t.f.load();
    await t.f.run();
    expect(t.line().textContent).toBe("backup not run · could not reach the daemon");
    expect(t.line().classList.contains("err")).toBe(true);
    expect(t.btn().hidden).toBe(false);
    const down = foot(new Error("could not reach the daemon"));
    await down.f.load();
    expect(down.el.hidden).toBe(false);
    expect(down.line().textContent).toBe("backup · state not read · could not reach the daemon");
    expect(down.line().classList.contains("err")).toBe(true);
  });
});
