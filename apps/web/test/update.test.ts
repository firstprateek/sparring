// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { pageBuild, servedBuild, UpdateWatch } from "../src/update.ts";

function setPageBuild(id: string): void {
  const meta = document.createElement("meta");
  meta.name = "sparring-build";
  meta.content = id;
  document.head.append(meta);
}

const serving = (body: unknown, status = 200) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

afterEach(() => {
  document.head.replaceChildren();
  document.body.replaceChildren();
});

describe("build ids", () => {
  it("reads the page's build, and none on a page vite did not build", () => {
    expect(pageBuild()).toBe("");
    setPageBuild("aaa");
    expect(pageBuild()).toBe("aaa");
  });

  it("treats a daemon that is down or answers oddly as no answer", async () => {
    expect(await servedBuild(serving({ build: "bbb" }))).toBe("bbb");
    expect(await servedBuild(serving({ build: "bbb" }, 502))).toBeNull();
    expect(await servedBuild(serving({ nope: 1 }))).toBeNull();
    const down = vi.fn(async () => {
      throw new TypeError("failed to fetch");
    }) as unknown as typeof fetch;
    expect(await servedBuild(down)).toBeNull();
  });
});

describe("the update line", () => {
  it("shows only when the daemon serves a different build", async () => {
    setPageBuild("aaa");
    const same = new UpdateWatch({ fetcher: serving({ build: "aaa" }) });
    await same.check();
    expect(same.bar.hidden).toBe(true);
    const newer = new UpdateWatch({ fetcher: serving({ build: "bbb" }) });
    await newer.check();
    expect(newer.bar.hidden).toBe(false);
  });

  it("sits at the right end of the page's head, inside head-right when there is one", async () => {
    setPageBuild("aaa");
    document.body.innerHTML = `<div class="sp"><header class="bar"><span class="brand"></span><span class="head-right"><button id="theme"></button></span></header></div>`;
    const w = new UpdateWatch({ fetcher: serving({ build: "bbb" }) });
    await w.check();
    expect(w.bar.parentElement?.className).toBe("head-right");
    expect(w.bar.previousElementSibling?.id).toBe("theme");
    expect(w.bar.classList.contains("in-head")).toBe(true);
    expect(w.bar.textContent).toContain("new version");
    expect(w.bar.querySelector("button.primary")?.textContent).toBe("reload");
  });

  it("uses the visible head, and is pinned to the top on a page without one", async () => {
    setPageBuild("aaa");
    document.body.innerHTML = `<div class="sp" hidden><header class="head"></header></div><div class="iv"><header class="iv-head"></header></div>`;
    const w = new UpdateWatch({ fetcher: serving({ build: "bbb" }) });
    await w.check();
    expect(w.bar.parentElement?.className).toBe("iv-head");
    document.body.replaceChildren();
    const bare = new UpdateWatch({ fetcher: serving({ build: "bbb" }) });
    await bare.check();
    expect(bare.bar.parentElement).toBe(document.body);
    expect(bare.bar.classList.contains("in-head")).toBe(false);
  });

  it("stays hidden while the desktop app offers its restart", async () => {
    setPageBuild("aaa");
    const restart = document.createElement("div");
    restart.className = "update restart";
    document.body.append(restart);
    const w = new UpdateWatch({ fetcher: serving({ build: "bbb" }) });
    await w.check();
    expect(w.bar.hidden).toBe(true);
  });

  it("never checks on a page without a build id", async () => {
    const fetcher = serving({ build: "bbb" });
    await new UpdateWatch({ fetcher }).check();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("stays away after later, until a newer build than the one put off", async () => {
    setPageBuild("aaa");
    let served = "bbb";
    const fetcher = vi.fn(async () => Response.json({ build: served })) as unknown as typeof fetch;
    const w = new UpdateWatch({ fetcher });
    await w.check();
    const later = w.bar.querySelector<HTMLButtonElement>('button[aria-label="later"]');
    later?.click();
    expect(w.bar.hidden).toBe(true);
    await w.check();
    expect(w.bar.hidden).toBe(true);
    served = "ccc";
    await w.check();
    expect(w.bar.hidden).toBe(false);
  });

  it("reloads only when nothing would be lost, and says why it waits", async () => {
    setPageBuild("aaa");
    const reload = vi.fn();
    let wait: string | null = "dump.md not saved yet";
    const w = new UpdateWatch({ fetcher: serving({ build: "bbb" }), reload, beforeReload: async () => wait });
    await w.check();
    const go = w.bar.querySelector<HTMLButtonElement>("button.primary");
    go?.click();
    await vi.waitFor(() => expect(w.bar.textContent).toContain("not yet · dump.md not saved yet"));
    expect(reload).not.toHaveBeenCalled();
    wait = null;
    go?.click();
    await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
  });
});
