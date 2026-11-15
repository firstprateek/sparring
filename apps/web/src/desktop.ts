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

export function wireDesktop(): void {
  if (!inDesktopApp()) return;
  const root = document.documentElement;
  root.classList.add("in-app");
  if (/Mac/.test(navigator.userAgent)) root.classList.add("mac");
  const chrome = () => applyChrome(root, (window as { __SPARRING_CHROME__?: Chrome }).__SPARRING_CHROME__);
  chrome();
  addEventListener("sparring-chrome", chrome);
  // A build from before the app said where its window buttons are: the head cannot line up with them, and it
  // has no zoom. Say so, once per launch of the page.
  setTimeout(() => {
    if ("__SPARRING_CHROME__" in window || document.querySelector(".old-app")) return;
    const note = document.createElement("div");
    note.className = "old-app mono";
    note.setAttribute("role", "status");
    const text = document.createElement("span");
    text.textContent =
      "this copy of the Sparring app is an older build · zoom and the title bar need the new one";
    const ok = document.createElement("button");
    ok.type = "button";
    ok.className = "hb";
    ok.textContent = "ok";
    ok.addEventListener("click", () => note.remove());
    note.append(text, ok);
    document.body.append(note);
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
