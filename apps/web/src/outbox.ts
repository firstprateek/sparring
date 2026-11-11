// Chat lines typed while the socket is closed. `dispatch` refuses while the connection is not open, so a line
// that cannot go now is kept in localStorage under the article and sent once, in order, after the reconnect.
// The composer shows `queued` beside each kept line until it has gone.

export interface OutboxLine {
  id: string;
  text: string;
  at: number;
}

/** The part of localStorage the outbox uses, so tests can hand it a map. */
export type OutboxStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** Sends one line; true when it went (the socket took it), false to keep it for later. */
export type Send = (text: string) => boolean;

function defaultStore(): OutboxStore | undefined {
  try {
    return localStorage;
  } catch {
    return undefined;
  }
}

const newId = (): string =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

export class Outbox {
  private readonly listeners = new Set<(lines: OutboxLine[]) => void>();
  /** Used when localStorage is not there (a private window): the lines then last as long as the page. */
  private memory: OutboxLine[] = [];
  private broken = false;

  constructor(
    readonly key: string,
    private readonly send: Send,
    private readonly store: OutboxStore | undefined = defaultStore(),
  ) {}

  /** The lines still waiting, oldest first. */
  lines(): OutboxLine[] {
    if (!this.store || this.broken) return [...this.memory];
    try {
      const raw = JSON.parse(this.store.getItem(this.key) ?? "[]") as unknown;
      return Array.isArray(raw)
        ? raw.filter((l): l is OutboxLine => typeof l?.id === "string" && typeof l?.text === "string")
        : [];
    } catch {
      return [];
    }
  }

  /** A line the writer sent: it goes now when nothing older is waiting and the socket takes it, else it waits. */
  push(text: string): "sent" | "queued" {
    if (this.lines().length === 0 && this.send(text)) return "sent";
    this.write([...this.lines(), { id: newId(), text, at: Date.now() }]);
    this.flush();
    return this.lines().length === 0 ? "sent" : "queued";
  }

  /** Sends what is waiting, oldest first, and stops at the first line the socket refuses. Returns how many went. */
  flush(): number {
    const sent = new Set<string>();
    for (;;) {
      // Read again each time: another tab on the same article may have sent some of them already.
      const first = this.lines().find((l) => !sent.has(l.id));
      if (!first || !this.send(first.text)) break;
      sent.add(first.id);
      this.write(this.lines().filter((l) => l.id !== first.id));
    }
    return sent.size;
  }

  /** Called with the waiting lines whenever they change. Returns the release. */
  onChange(fn: (lines: OutboxLine[]) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private write(lines: OutboxLine[]): void {
    this.memory = lines;
    if (this.store && !this.broken) {
      try {
        if (lines.length === 0) this.store.removeItem(this.key);
        else this.store.setItem(this.key, JSON.stringify(lines));
      } catch {
        this.broken = true; // storage full or refused: keep the lines in memory from now on
      }
    }
    for (const fn of [...this.listeners]) fn(lines);
  }
}
