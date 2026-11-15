// "new version · reload": shown when the daemon serves a newer build than the one this page loaded, at the
// right end of the page's head (the top right, decided 2026-11-15). The desktop app's "new version · restart"
// (desktop.ts) uses the same spot and look, and wins while it is up, since a restart loads the new pages too.
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

/** The page's visible head, where a "new version" line goes: inside `.head-right` when it has one. The room's
 *  interview hides the room with `html.iv-on` (interview.css), not with `hidden`, so that class picks its head. */
export function headSlot(doc: Document = document): HTMLElement | null {
  const interview = doc.documentElement.classList.contains("iv-on");
  const heads = [...doc.querySelectorAll<HTMLElement>(".sp > header, .iv > header")].filter(
    (h) => !h.closest("[hidden]") && (h.closest(".iv") ? interview : !interview),
  );
  const head = heads[0] ?? doc.querySelector<HTMLElement>(".sp > header");
  return head ? (head.querySelector<HTMLElement>(".head-right") ?? head) : null;
}

const following = new WeakSet<Document>();

/** Puts a "new version" line in the head (or, on a page without one, pinned to the top of the window), and
 *  keeps every such line in the visible head when the room switches to the interview and back. */
export function placeInHead(el: HTMLElement, doc: Document = document): void {
  const slot = headSlot(doc);
  el.classList.toggle("in-head", !!slot);
  const into = slot ?? doc.body;
  if (el.parentElement !== into) into.append(el);
  if (following.has(doc) || typeof MutationObserver === "undefined") return;
  following.add(doc);
  new MutationObserver(() => {
    for (const line of doc.querySelectorAll<HTMLElement>(".update")) placeInHead(line, doc);
  }).observe(doc.documentElement, { attributes: true, attributeFilter: ["class"] });
}

/** A "new version" line: the words, the button, and × to put it off. Its `why` says why it must wait. */
export function newVersionLine(
  action: string,
  go: () => void,
  later: () => void,
): { el: HTMLElement; go: HTMLButtonElement; why: HTMLElement } {
  const el = document.createElement("div");
  el.className = "update mono";
  el.setAttribute("role", "status");
  const text = document.createElement("span");
  text.className = "t";
  text.textContent = "new version";
  const why = document.createElement("span");
  why.className = "err";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn primary";
  btn.textContent = action;
  btn.setAttribute("aria-label", `new version · ${action}`);
  btn.addEventListener("click", go);
  const off = document.createElement("button");
  off.type = "button";
  off.className = "off";
  off.textContent = "×";
  off.title = "later";
  off.setAttribute("aria-label", "later");
  off.addEventListener("click", later);
  el.append(text, why, btn, off);
  return { el, go: btn, why };
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
    const line = newVersionLine(
      "reload",
      () => void this.reload(),
      () => {
        this.putOff = this.bar.dataset.build ?? "";
        this.bar.hidden = true;
      },
    );
    this.bar = line.el;
    this.go = line.go;
    this.note = line.why;
    this.bar.hidden = true;
    placeInHead(this.bar);
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
      // The app's restart is already offered, and loads the new pages too.
      if (document.querySelector(".update.restart")) return;
      placeInHead(this.bar);
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
        this.note.title = wait;
        return;
      }
      (this.opts.reload ?? (() => location.reload()))();
    } finally {
      this.go.disabled = false;
    }
  }
}
