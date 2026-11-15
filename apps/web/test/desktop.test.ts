// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { setBeforeRestart, wireDesktop } from "../src/desktop.ts";

afterEach(() => {
  document.body.replaceChildren();
  delete (window as { __SPARRING_TITLEBAR__?: unknown }).__SPARRING_TITLEBAR__;
  delete (window as { __SPARRING_APP_UPDATE__?: unknown }).__SPARRING_APP_UPDATE__;
  vi.useRealTimers();
});

describe("the app's new build", () => {
  it("offers restart at the right end of the head, and hides the page's own reload", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = `<div class="sp"><header class="head"><a class="back"></a><button id="stage-btn"></button></header></div><div class="update mono in-head" id="reload"></div>`;
    (window as { __SPARRING_TITLEBAR__?: unknown }).__SPARRING_TITLEBAR__ = true;
    wireDesktop();
    expect(document.querySelector(".update.restart")).toBeNull();
    dispatchEvent(new Event("sparring-app-update"));
    const line = document.querySelector<HTMLElement>(".update.restart");
    expect(line?.parentElement?.className).toBe("head");
    expect(line?.previousElementSibling?.id).toBe("stage-btn");
    expect(line?.textContent).toContain("new version");
    expect(line?.querySelector("button.primary")?.textContent).toBe("restart");
    expect(document.querySelector<HTMLElement>("#reload")?.hidden).toBe(true);
    expect(document.querySelector(".app-note")).toBeNull();
    // Once only.
    dispatchEvent(new Event("sparring-app-update"));
    expect(document.querySelectorAll(".update.restart")).toHaveLength(1);
    // A page that would lose something says why, and the app is not asked.
    setBeforeRestart(async () => "dump.md not saved yet");
    line?.querySelector<HTMLButtonElement>("button.primary")?.click();
    await vi.waitFor(() => expect(line?.textContent).toContain("not yet · dump.md not saved yet"));
    line?.querySelector<HTMLButtonElement>('button[aria-label="later"]')?.click();
    expect(document.querySelector(".update.restart")).toBeNull();
  });
});
