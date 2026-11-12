// "sparring was updated · reload": shown when the daemon serves a newer build than the one this page loaded.
// The page's build is in `<meta name="sparring-build">` and the served one in `/build.json`, both written by
// `vite build` (vite.config.ts). The check runs on load, when the page comes back into view or online, and
// every minute while it is in view. A daemon that is down or restarting is not an update, so a failed check
// says nothing.

export const CHECK_EVERY_MS = 60_000;

/** The build this page came from, or "" for a page not built by vite (the dev server). */
export function pageBuild(doc: Document = document): string {
  return doc.querySelector<HTMLMetaElement>('meta[name="sparring-build"]')?.content ?? "";
}

/** The build the daemon serves now, or null when it cannot be asked. */
export async function servedBuild(fetcher: typeof fetch = fetch): Promise<string | null> {
  try {
    const res = await fetcher("/build.json", { cache: "no-store" });
    if (!res.ok) return null;
    const body = (await res.json()) as { build?: unknown };
    return typeof body.build === "string" && body.build ? body.build : null;
  } catch {
    return null;
  }
}

export interface UpdateOptions {
  /** Runs before the reload; a string is why the page must not reload yet (shown, and the reload waits). */
  beforeReload?: () => Promise<string | null>;
  fetcher?: typeof fetch;
  reload?: () => void;
}

export class UpdateWatch {
  readonly bar: HTMLElement;
  private readonly mine = pageBuild();
  private readonly note: HTMLElement;
  private readonly go: HTMLButtonElement;
  /** A build the "later" button put off: not offered again until a newer one. */
  private putOff = "";
  private checking = false;

  constructor(private readonly opts: UpdateOptions = {}) {
    this.bar = document.createElement("div");
    this.bar.className = "update mono";
    this.bar.setAttribute("role", "status");
    this.bar.hidden = true;
    const text = document.createElement("span");
    text.textContent = "sparring was updated";
    this.note = document.createElement("span");
    this.note.className = "err";
    this.go = document.createElement("button");
    this.go.type = "button";
    this.go.className = "btn primary";
    this.go.textContent = "reload";
    this.go.addEventListener("click", () => void this.reload());
    const later = document.createElement("button");
    later.type = "button";
    later.className = "hb";
    later.textContent = "later";
    later.addEventListener("click", () => {
      this.putOff = this.bar.dataset.build ?? "";
      this.bar.hidden = true;
    });
    this.bar.append(text, this.go, later, this.note);
    document.body.append(this.bar);
  }

  /** Starts the checks. A page without a build id (the dev server) never checks. */
  start(): this {
    if (!this.mine) return this;
    void this.check();
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") void this.check();
    });
    addEventListener("online", () => void this.check());
    setInterval(() => {
      if (document.visibilityState === "visible") void this.check();
    }, CHECK_EVERY_MS);
    return this;
  }

  async check(): Promise<void> {
    if (!this.mine || this.checking) return;
    this.checking = true;
    try {
      const served = await servedBuild(this.opts.fetcher);
      if (!served || served === this.mine || served === this.putOff) return;
      this.bar.dataset.build = served;
      this.bar.hidden = false;
    } finally {
      this.checking = false;
    }
  }

  private async reload(): Promise<void> {
    this.go.disabled = true;
    this.note.textContent = "";
    try {
      const wait = (await this.opts.beforeReload?.()) ?? null;
      if (wait) {
        this.note.textContent = `not yet · ${wait}`;
        return;
      }
      (this.opts.reload ?? (() => location.reload()))();
    } finally {
      this.go.disabled = false;
    }
  }
}
