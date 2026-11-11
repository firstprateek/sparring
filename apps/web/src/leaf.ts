// One file of an article as the browser holds it: the text, the base_sha it was last loaded or saved at, and
// whether it has changes the daemon has not taken. Saves go out 2 s after the last keystroke, or at once on
// Cmd+S with a commit. The unsent state is kept in localStorage and replayed on load only when dirty.
import { ApiError, api, type FileName } from "./api.ts";

export type SaveState =
  | { kind: "saved"; at: number }
  | { kind: "saving" }
  | { kind: "retrying"; reason: string; tries: number }
  | { kind: "diskFull" }
  | { kind: "conflict"; diskSha: string; diskText: string };

export interface Stored {
  text: string;
  base_sha: string;
  dirty: boolean;
}

const IDLE_MS = 2000;
const RETRY_MS = 5000;

export function storeKey(slug: string, file: FileName): string {
  return `sparring-leaf:${slug}:${file}`;
}

export function readStored(slug: string, file: FileName): Stored | null {
  try {
    const raw = localStorage.getItem(storeKey(slug, file));
    if (!raw) return null;
    const s = JSON.parse(raw) as Stored;
    return typeof s.text === "string" && typeof s.base_sha === "string" ? s : null;
  } catch {
    return null;
  }
}

export class Leaf {
  text: string;
  baseSha: string;
  dirty = false;
  state: SaveState;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight: Promise<void> | null = null;
  private again: { commit: boolean } | null = null;
  /** A Cmd+S whose save failed: the retry still commits. */
  private commitOwed = false;
  private failures = 0;
  /** False once localStorage refused the unsent text: it then lives only in this tab. */
  storageOk = true;

  constructor(
    readonly slug: string,
    readonly file: FileName,
    text: string,
    sha: string,
    private readonly onChange: (leaf: Leaf, commit?: string) => void,
  ) {
    this.text = text;
    this.baseSha = sha;
    this.state = { kind: "saved", at: Date.now() };
  }

  /** Takes the unsent text from localStorage when it was dirty, and sends it. */
  replay(): boolean {
    const s = readStored(this.slug, this.file);
    if (!s?.dirty) return false;
    this.text = s.text;
    this.baseSha = s.base_sha;
    this.dirty = true;
    void this.saveNow(false);
    return true;
  }

  /** The writer typed: keep it locally and save when they pause. */
  edit(text: string): void {
    if (text === this.text) return;
    this.text = text;
    this.dirty = true;
    this.persist();
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.saveNow(false), IDLE_MS);
  }

  /** Saves now; `commit` is Cmd+S. A save asked for while one is in flight runs right after it. */
  async saveNow(commit: boolean): Promise<void> {
    clearTimeout(this.timer);
    if (this.state.kind === "conflict") return;
    if (this.inFlight) {
      this.again = { commit: commit || (this.again?.commit ?? false) };
      return this.inFlight;
    }
    if (!this.dirty && !commit) return;
    this.inFlight = this.send(commit);
    try {
      await this.inFlight;
    } finally {
      this.inFlight = null;
    }
    const next = this.again;
    this.again = null;
    if (next && (this.dirty || next.commit)) await this.saveNow(next.commit);
  }

  private async send(commit: boolean): Promise<void> {
    const sent = this.text;
    this.state = { kind: "saving" };
    this.onChange(this);
    try {
      const res = await api.save(this.slug, this.file, sent, this.baseSha, commit);
      this.baseSha = res.sha;
      if (this.text === sent) this.dirty = false;
      this.state = { kind: "saved", at: Date.now() };
      this.commitOwed = false;
      this.failures = 0;
      this.persist();
      this.onChange(this, res.commit ?? undefined);
    } catch (e) {
      if (commit) this.commitOwed = true;
      this.failures++;
      const tries = this.failures;
      if (e instanceof ApiError && e.status === 409) {
        this.state = {
          kind: "conflict",
          diskSha: String(e.body.disk_sha ?? ""),
          diskText: String(e.body.disk_text ?? ""),
        };
      } else if (e instanceof ApiError && e.status === 507) {
        this.state = { kind: "diskFull" };
        this.timer = setTimeout(() => void this.saveNow(this.commitOwed), RETRY_MS);
      } else {
        const reason = e instanceof ApiError ? e.message : "could not reach the daemon";
        this.state = { kind: "retrying", reason, tries };
        this.timer = setTimeout(() => void this.saveNow(this.commitOwed), RETRY_MS);
      }
      this.onChange(this);
    }
  }

  /**
   * Takes text the daemon changed on its own (a refetched snapshot). Refused while the writer has changes the
   * daemon has not taken: dirty, a save in flight or waiting, or a conflict open. Returns true when it took it.
   */
  adopt(text: string, sha: string): boolean {
    if (this.dirty || this.inFlight || this.state.kind !== "saved") return false;
    if (text === this.text && sha === this.baseSha) return false;
    this.text = text;
    this.baseSha = sha;
    this.persist();
    this.onChange(this);
    return true;
  }

  /** `keep mine`: send the local text again over what is on disk. */
  async keepMine(): Promise<void> {
    if (this.state.kind !== "conflict") return;
    this.baseSha = this.state.diskSha;
    this.state = { kind: "saving" };
    await this.saveNow(false);
  }

  /** `take disk`: keep the local text at the stash ref, then load what is on disk. */
  async takeDisk(): Promise<void> {
    if (this.state.kind !== "conflict") return;
    const { diskSha, diskText } = this.state;
    await api.stash(this.slug, this.file, this.text);
    this.text = diskText;
    this.baseSha = diskSha;
    this.dirty = false;
    this.state = { kind: "saved", at: Date.now() };
    this.persist();
    this.onChange(this);
  }

  private persist(): void {
    try {
      const s: Stored = { text: this.text, base_sha: this.baseSha, dirty: this.dirty };
      localStorage.setItem(storeKey(this.slug, this.file), JSON.stringify(s));
      this.storageOk = true;
    } catch {
      this.storageOk = false;
    }
  }
}
