// Inside the desktop app the window has no title bar of its own: each page's head is the title bar. The head
// leaves room for the three window buttons on the left, and dragging any empty part of it moves the window.
// Tauri moves a window from an element that carries `data-tauri-drag-region`; the mark is put on the part of
// the head under the pointer as the press starts, so buttons, links and menus in the head still work.

const HEADS = "header.bar, .head, .iv-head, .login-bar";
const LIVE = "button, a, input, textarea, select, .menu, .imenu";

/** True in a build of the desktop app that has no system title bar; it sets this mark on every page. */
export function inDesktopApp(): boolean {
  return "__SPARRING_TITLEBAR__" in window;
}

export function wireDesktop(): void {
  if (!inDesktopApp()) return;
  const root = document.documentElement;
  root.classList.add("in-app");
  if (/Mac/.test(navigator.userAgent)) root.classList.add("mac");
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
