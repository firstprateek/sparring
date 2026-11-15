// Inside the desktop app the window has no title bar of its own: each page's head is the title bar. The head
// leaves room for the three window buttons on the left, and dragging any empty part of it moves the window.
// Tauri moves a window from an element that carries `data-tauri-drag-region`; the mark is put on the part of
// the head under the pointer as the press starts, so buttons, links and menus in the head still work.
//
// The app also says what surrounds the page (`__SPARRING_CHROME__`, then a `sparring-chrome` event each time it
// changes): the zoom, and where the window buttons are in points. The head takes its height and its left
// padding from that, so its own buttons sit on the same line as the window's at any zoom.

const HEADS = "header.bar, .head, .iv-head, .login-bar";
const LIVE = "button, a, input, textarea, select, .menu, .imenu";

export interface Chrome {
  zoom: number;
  full: boolean;
  /** True in a build that does what a page asks by a visit to `/__app/<name>` (zoom-reset, restart). */
  hooks?: boolean;
  /** The middle of the window buttons from the top of the window, and their right edge; null when hidden. */
  lights: { y: number; x: number } | null;
}

/** True in a build of the desktop app that has no system title bar; it sets this mark on every page. */
export function inDesktopApp(): boolean {
  return "__SPARRING_TITLEBAR__" in window;
}

/** How far the head grows with the page's zoom. Past this it would be taller than the window buttons' line allows. */
const HEAD_ZOOM_MAX = 1.3;

/**
 * Sizes the head for the window buttons. The buttons do not zoom and the page does, so the head is scaled back
 * to at most `HEAD_ZOOM_MAX` of its plain size and its lengths are given in its own scaled units. A menu that
 * drops out of the head is scaled forward again, to the page's zoom.
 */
export function applyChrome(root: HTMLElement, c: Chrome | undefined): void {
  const zoom = c && c.zoom > 0 ? c.zoom : 1;
  const head = Math.min(zoom, HEAD_ZOOM_MAX);
  root.classList.toggle("fullscreen", !!c?.full);
  root.style.setProperty("--head-zoom", (head / zoom).toFixed(4));
  root.style.setProperty("--menu-zoom", (zoom / head).toFixed(4));
  if (c?.lights) {
    root.style.setProperty("--lights-y", `${(c.lights.y / head).toFixed(2)}px`);
    root.style.setProperty("--lights-x", `${((c.lights.x + 14) / head).toFixed(2)}px`);
  } else {
    root.style.removeProperty("--lights-y");
    root.style.removeProperty("--lights-x");
  }
}

/** Asks the app for something. The app refuses the visit and does the thing, so the page stays where it is. */
function askApp(name: string): void {
  location.href = `/__app/${name}`;
}

/** Runs before a restart; a string is why the app must not restart yet. The Room saves its pages here. */
let beforeRestart: () => Promise<string | null> = async () => null;
export function setBeforeRestart(fn: () => Promise<string | null>): void {
  beforeRestart = fn;
}

function button(cls: string, text: string, on: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = cls;
  b.textContent = text;
  b.addEventListener("click", on);
  return b;
}

/**
 * The zoom, at the bottom right for a few seconds after it changes: the level, and a reset when it is not 100%.
 * It stays while the pointer is on it.
 */
export class ZoomPill {
  readonly el: HTMLElement;
  private last: number | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly reset: () => void,
    private readonly ms = 2500,
  ) {
    this.el = document.createElement("div");
    this.el.className = "zoom-pill mono";
    this.el.setAttribute("role", "status");
    this.el.hidden = true;
    this.el.addEventListener("mouseenter", () => clearTimeout(this.timer));
    this.el.addEventListener("mouseleave", () => this.hideSoon());
    document.body.append(this.el);
  }

  /** The zoom as the app reports it. The first report only sets the level; a change shows the pill. */
  set(zoom: number, canReset: boolean): void {
    const was = this.last;
    this.last = zoom;
    if (was === null || was === zoom) return;
    const level = document.createElement("span");
    level.textContent = `${Math.round(zoom * 100)}%`;
    this.el.replaceChildren(level);
    if (canReset && zoom !== 1) this.el.append(button("hb", "reset", this.reset));
    this.el.hidden = false;
    this.hideSoon();
  }

  private hideSoon(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.el.hidden = true;
    }, this.ms);
  }
}

/** One line at the foot of the window, with buttons; `ms` takes it away again by itself. */
function appNote(text: string, buttons: HTMLButtonElement[] = [], ms = 0): HTMLElement {
  for (const old of document.querySelectorAll(".app-note")) old.remove();
  const note = document.createElement("div");
  note.className = "app-note mono";
  note.setAttribute("role", "status");
  const line = document.createElement("span");
  line.textContent = text;
  note.append(line, ...buttons);
  document.body.append(note);
  if (ms > 0) setTimeout(() => note.remove(), ms);
  return note;
}

/** "the app was updated · restart": the new build is installed and runs from the next launch. */
function offerRestart(): void {
  if (document.querySelector(".app-note.restart")) return;
  const why = document.createElement("span");
  why.className = "err";
  const go = button("btn primary", "restart", () => {
    void (async () => {
      go.disabled = true;
      const wait = await beforeRestart().catch(() => null);
      go.disabled = false;
      if (wait) why.textContent = `not yet · ${wait}`;
      else askApp("restart");
    })();
  });
  const note = appNote("the Sparring app was updated · restart to use the new one", [
    go,
    button("hb", "later", () => note.remove()),
  ]);
  note.classList.add("restart");
  note.append(why);
}

export function wireDesktop(): void {
  if (!inDesktopApp()) return;
  const root = document.documentElement;
  root.classList.add("in-app");
  if (/Mac/.test(navigator.userAgent)) root.classList.add("mac");
  const w = window as { __SPARRING_CHROME__?: Chrome; __SPARRING_APP_UPDATE__?: unknown };
  const pill = new ZoomPill(() => askApp("zoom-reset"));
  const chrome = () => {
    applyChrome(root, w.__SPARRING_CHROME__);
    if (w.__SPARRING_CHROME__) pill.set(w.__SPARRING_CHROME__.zoom, !!w.__SPARRING_CHROME__.hooks);
  };
  chrome();
  addEventListener("sparring-chrome", chrome);
  if (w.__SPARRING_APP_UPDATE__) offerRestart();
  addEventListener("sparring-app-update", offerRestart);
  addEventListener("sparring-app-note", (e) => {
    const text = (e as CustomEvent<unknown>).detail;
    if (typeof text === "string" && text) appNote(text, [], 6000);
  });
  // A build from before the app said where its window buttons are: the head cannot line up with them, and it
  // has no zoom. Say so, once per launch of the page.
  setTimeout(() => {
    if ("__SPARRING_CHROME__" in window || document.querySelector(".app-note")) return;
    const note = appNote(
      "this copy of the Sparring app is an older build · zoom and the title bar need the new one",
      [button("hb", "ok", () => note.remove())],
    );
  }, 4000);
  addEventListener(
    "mousedown",
    (e) => {
      const at = e.target;
      if (!(at instanceof HTMLElement)) return;
      if (at.closest(HEADS) && !at.closest(LIVE)) at.dataset.tauriDragRegion = "";
    },
    true,
  );
}
