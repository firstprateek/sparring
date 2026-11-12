// The backup line at the foot of Articles: `backup · 3h` when the nightly backup is fine, and a red line that
// names the fix when the last run failed, no remote is set, or the last good backup is too old. `back up now`
// runs one (`POST /api/backup`). The words are `backupLine` from the protocol package, the same line `pnpm
// backup` prints.
import { type BackupState, backupLine } from "@sparring/protocol/backup";

export interface BackupCalls {
  get(): Promise<BackupState>;
  run(): Promise<BackupState>;
  /** An error in words. */
  words(e: unknown): string;
  /** True when the daemon has no backup route: it runs a build from before the backup and was not restarted. */
  missing?(e: unknown): boolean;
}

const POLL_MS = 2000;

export class BackupFoot {
  private state: BackupState | null = null;
  private problem = "";
  /** A line that is not a failure: the daemon is older than this page. */
  private note = "";
  private busy = false;
  private shown = "";
  private readonly line = document.createElement("span");
  private readonly dot = document.createElement("span");
  private readonly btn = document.createElement("button");

  constructor(
    private readonly el: HTMLElement,
    private readonly calls: BackupCalls,
    private readonly now: () => number = Date.now,
    private readonly pollMs = POLL_MS,
  ) {
    this.line.className = "backup-line";
    this.line.setAttribute("role", "status");
    this.dot.textContent = " · ";
    this.dot.setAttribute("aria-hidden", "true");
    this.btn.type = "button";
    this.btn.className = "t backup-run";
    this.btn.textContent = "back up now";
    this.btn.title = "Snapshots the database into the writing repo and pushes it to backup_remote.";
    this.btn.addEventListener("click", () => void this.run());
    el.replaceChildren(this.line, this.dot, this.btn);
    el.hidden = true;
  }

  /** Reads the state from the daemon. A failure to read is said in red, not hidden. */
  async load(): Promise<void> {
    if (this.busy) return;
    try {
      this.take(await this.calls.get());
    } catch (e) {
      if (this.calls.missing?.(e))
        this.note = "backup · the daemon runs an older build · restart it to back up";
      else this.problem = `backup · state not read · ${this.calls.words(e)}`;
      this.render();
    }
  }

  /** `back up now`. */
  async run(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.problem = "";
    this.render();
    try {
      let s = await this.calls.run();
      // A slow push is answered as `running`: ask until it is over.
      while (s.running) {
        this.state = s;
        this.render();
        await new Promise((r) => setTimeout(r, this.pollMs));
        s = await this.calls.get();
      }
      this.busy = false;
      this.take(s);
    } catch (e) {
      this.busy = false;
      this.problem = `backup not run · ${this.calls.words(e)}`;
      this.render();
    }
  }

  private take(s: BackupState): void {
    this.state = s;
    this.problem = "";
    this.note = "";
    this.render();
  }

  /** Draws the line again. Called every second so the age moves on. */
  render(): void {
    const line = this.busy
      ? { text: "backing up…", bad: false }
      : this.problem
        ? { text: this.problem, bad: true }
        : this.note
          ? { text: this.note, bad: false }
          : this.state
            ? backupLine(this.state, this.now())
            : null;
    const key = JSON.stringify([line, this.busy]);
    if (key === this.shown) return;
    this.shown = key;
    this.el.hidden = line === null;
    if (!line) return;
    this.line.textContent = line.text;
    this.line.classList.toggle("err", line.bad);
    this.line.classList.toggle("muted", !line.bad);
    this.el.classList.toggle("bad", line.bad);
    const running = this.busy || this.state?.running === true || this.note !== "";
    this.dot.hidden = running;
    this.btn.hidden = running;
  }
}
