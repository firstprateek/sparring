// The keyboard: each page hands its shortcuts here, and Cmd+/ (Ctrl+/ off a Mac) lists every one of them in a
// panel. A shortcut with `when` is run from here; one without is only listed, because the page already handles
// it (j and k in the article list, Enter in the composer).

export interface Binding {
  /** As shown in the list. `Mod` becomes ⌘ on a Mac and Ctrl elsewhere. */
  keys: string;
  what: string;
  when?: (e: KeyboardEvent) => boolean;
  run?: () => void;
}

export interface KeyGroup {
  title: string;
  items: Binding[];
}

const isMac = () => /Mac|iPhone|iPad/.test(navigator.userAgent);

/** `Mod+1` as the reader's keyboard names it: `⌘1` or `Ctrl+1`. */
export function keyLabel(keys: string, mac = isMac()): string {
  return mac ? keys.replace(/Mod\+Shift\+/g, "⇧⌘").replace(/Mod\+/g, "⌘") : keys.replace(/Mod\+/g, "Ctrl+");
}

/** Matches Cmd or Ctrl with one key, and no other modifier. */
export function mod(key: string): (e: KeyboardEvent) => boolean {
  return (e) => (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === key;
}

function typing(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
}

const EVERYWHERE: KeyGroup = {
  title: "everywhere",
  items: [
    { keys: "Mod+/", what: "show or hide this list" },
    { keys: "Mod++  Mod+-  Mod+0", what: "zoom in, zoom out, actual size" },
    { keys: "Mod+R", what: "reload the page" },
    { keys: "Tab  Shift+Tab", what: "move to the next or previous button or field" },
    { keys: "Esc", what: "close what is open, or leave a field" },
  ],
};

export class Keys {
  readonly back: HTMLElement;
  private readonly groups: KeyGroup[];
  private before: HTMLElement | null = null;

  constructor(groups: KeyGroup[], button?: HTMLElement | null) {
    this.groups = [...groups, EVERYWHERE];
    this.back = document.createElement("div");
    this.back.className = "keys-back";
    this.back.hidden = true;
    this.back.addEventListener("mousedown", (e) => {
      if (e.target === this.back) this.close();
    });
    document.body.append(this.back);
    button?.addEventListener("click", () => this.toggle());
    // Capture, so a page's own Escape handling does not also run while the list is open.
    window.addEventListener("keydown", this.onKey, true);
  }

  private readonly onKey = (e: KeyboardEvent) => this.key(e);

  /** Stops listening and removes the panel. */
  destroy(): void {
    window.removeEventListener("keydown", this.onKey, true);
    this.back.remove();
  }

  get isOpen(): boolean {
    return !this.back.hidden;
  }

  toggle(): void {
    if (this.isOpen) this.close();
    else this.open();
  }

  open(): void {
    if (this.isOpen) return;
    this.before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.back.replaceChildren(this.panel());
    this.back.hidden = false;
    this.back.querySelector<HTMLButtonElement>("button")?.focus();
  }

  close(): void {
    if (!this.isOpen) return;
    this.back.hidden = true;
    this.back.replaceChildren();
    this.before?.focus();
    this.before = null;
  }

  private key(e: KeyboardEvent): void {
    if (e.isComposing) return;
    if (mod("/")(e) || (e.key === "?" && !e.metaKey && !e.ctrlKey && !e.altKey && !typing(e))) {
      e.preventDefault();
      e.stopImmediatePropagation();
      this.toggle();
      return;
    }
    if (this.isOpen) {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        this.close();
      } else if (e.key === "Tab") {
        // One button in the panel: focus stays on it.
        e.preventDefault();
      }
      return;
    }
    for (const g of this.groups) {
      for (const b of g.items) {
        if (!b.when?.(e)) continue;
        e.preventDefault();
        e.stopImmediatePropagation();
        b.run?.();
        return;
      }
    }
  }

  private panel(): HTMLElement {
    const panel = document.createElement("div");
    panel.className = "keys-panel mono";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-label", "Keyboard shortcuts");
    const head = document.createElement("div");
    head.className = "keys-head";
    const title = document.createElement("span");
    title.textContent = "keyboard shortcuts";
    const x = document.createElement("button");
    x.type = "button";
    x.className = "hb";
    x.textContent = "close";
    x.addEventListener("click", () => this.close());
    head.append(title, x);
    panel.append(head);
    for (const g of this.groups) {
      const h = document.createElement("h3");
      h.className = "muted";
      h.textContent = g.title;
      const list = document.createElement("dl");
      for (const b of g.items) {
        const dt = document.createElement("dt");
        for (const part of keyLabel(b.keys).split(/\s{2,}/)) {
          const k = document.createElement("kbd");
          k.textContent = part;
          dt.append(k);
        }
        const dd = document.createElement("dd");
        dd.textContent = b.what;
        list.append(dt, dd);
      }
      panel.append(h, list);
    }
    return panel;
  }
}
