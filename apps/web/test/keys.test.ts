// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyChrome, ZoomPill } from "../src/desktop.ts";
import { type KeyGroup, Keys, keyLabel, mod } from "../src/keys.ts";

const press = (key: string, init: KeyboardEventInit = {}, target: EventTarget = document.body) => {
  const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e;
};

const made: Keys[] = [];
const keysOf = (groups: KeyGroup[]): Keys => {
  const k = new Keys(groups);
  made.push(k);
  return k;
};

afterEach(() => {
  for (const k of made.splice(0)) k.destroy();
  document.body.replaceChildren();
});

describe("key labels", () => {
  it("names the modifier the way the keyboard does", () => {
    expect(keyLabel("Mod+1", true)).toBe("⌘1");
    expect(keyLabel("Mod+1", false)).toBe("Ctrl+1");
  });

  it("matches Cmd or Ctrl with the key and nothing else", () => {
    const hit = mod("j");
    expect(hit(new KeyboardEvent("keydown", { key: "j", metaKey: true }))).toBe(true);
    expect(hit(new KeyboardEvent("keydown", { key: "J", ctrlKey: true }))).toBe(true);
    expect(hit(new KeyboardEvent("keydown", { key: "j" }))).toBe(false);
    expect(hit(new KeyboardEvent("keydown", { key: "j", metaKey: true, shiftKey: true }))).toBe(false);
  });
});

describe("the shortcuts list", () => {
  it("opens on Cmd+/, lists every group, and closes on Escape without the page seeing it", () => {
    const keys = keysOf([{ title: "this page", items: [{ keys: "Mod+J", what: "jump" }] }]);
    const pageEsc = vi.fn();
    document.addEventListener("keydown", (e) => e.key === "Escape" && pageEsc());
    press("/", { metaKey: true });
    expect(keys.isOpen).toBe(true);
    expect(keys.back.textContent).toContain("this page");
    expect(keys.back.textContent).toContain("jump");
    expect(keys.back.textContent).toContain("everywhere");
    press("Escape");
    expect(keys.isOpen).toBe(false);
    expect(pageEsc).not.toHaveBeenCalled();
  });

  it("opens on ? only outside a field", () => {
    const keys = keysOf([]);
    const field = document.createElement("textarea");
    document.body.append(field);
    press("?", {}, field);
    expect(keys.isOpen).toBe(false);
    press("?");
    expect(keys.isOpen).toBe(true);
  });

  it("runs a shortcut, and not while the list is open", () => {
    const run = vi.fn();
    const keys = keysOf([{ title: "g", items: [{ keys: "Mod+J", what: "jump", when: mod("j"), run }] }]);
    expect(press("j", { metaKey: true }).defaultPrevented).toBe(true);
    expect(run).toHaveBeenCalledOnce();
    keys.open();
    press("j", { metaKey: true });
    expect(run).toHaveBeenCalledOnce();
  });
});

describe("the head as a title bar", () => {
  it("gives the window buttons' place in the head's own units", () => {
    const root = document.createElement("div");
    applyChrome(root, { zoom: 1, full: false, lights: { y: 22, x: 76 } });
    expect(root.style.getPropertyValue("--lights-y")).toBe("22.00px");
    expect(root.style.getPropertyValue("--lights-x")).toBe("90.00px");
    expect(root.style.getPropertyValue("--head-zoom")).toBe("1.0000");
  });

  it("keeps the head its plain size when the page zooms", () => {
    const root = document.createElement("div");
    applyChrome(root, { zoom: 2, full: false, lights: { y: 22, x: 76 } });
    expect(root.style.getPropertyValue("--head-zoom")).toBe("0.5000");
    expect(root.style.getPropertyValue("--menu-zoom")).toBe("2.0000");
    expect(root.style.getPropertyValue("--lights-y")).toBe("22.00px");
  });

  it("leaves no room for window buttons in full screen", () => {
    const root = document.createElement("div");
    applyChrome(root, { zoom: 1, full: true, lights: null });
    expect(root.style.getPropertyValue("--lights-y")).toBe("");
    expect(root.classList.contains("fullscreen")).toBe(true);
  });
});

describe("the zoom pill", () => {
  it("stays hidden on the first report, shows a change, and offers a reset away from 100%", () => {
    vi.useFakeTimers();
    const reset = vi.fn();
    const pill = new ZoomPill(reset, 2500);
    pill.set(1, true);
    expect(pill.el.hidden).toBe(true);
    pill.set(1.1, true);
    expect(pill.el.hidden).toBe(false);
    expect(pill.el.textContent).toBe("110%reset");
    pill.el.querySelector("button")?.click();
    expect(reset).toHaveBeenCalledOnce();
    pill.set(1, true);
    expect(pill.el.textContent).toBe("100%");
    vi.advanceTimersByTime(2600);
    expect(pill.el.hidden).toBe(true);
    vi.useRealTimers();
  });

  it("has no reset in a build that cannot be asked", () => {
    const pill = new ZoomPill(() => {});
    pill.set(1, false);
    pill.set(1.25, false);
    expect(pill.el.textContent).toBe("125%");
  });
});
