// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, type Idea } from "../src/api.ts";
import { ideaDate, inboxRows, sortIdeas } from "../src/inbox.ts";

const IDEAS: Idea[] = [
  { id: "i1", date: "2026-11-02", text: 'every "AI pair" demo is recorded on a laptop that never sleeps' },
  { id: "i2", date: "2026-11-06T08:12:00Z", text: "the cache lied for three weeks & nobody noticed" },
  { id: "i3", date: "2026-11-06T09:00:00Z", text: "<script>alert(1)</script><img src=x onerror=alert(2)>" },
];

const hooks = (article = vi.fn(async () => {})) => ({ article, check: () => null });

describe("the inbox list", () => {
  it("shows newest first with the mock's MM-DD date", () => {
    expect(sortIdeas(IDEAS).map((i) => i.id)).toEqual(["i3", "i2", "i1"]);
    expect(ideaDate("2026-11-06T08:12:00Z")).toBe("11-06");
    expect(ideaDate("yesterday")).toBe("yesterday");
  });

  it("renders each idea's text as text, never as HTML", () => {
    const rows = inboxRows(IDEAS, hooks());
    const el = document.createElement("div");
    el.append(...rows);
    expect(el.querySelector("script")).toBeNull();
    expect(el.querySelector("img")).toBeNull();
    const texts = [...el.querySelectorAll(".inbox .text")].map((t) => t.textContent);
    expect(texts).toEqual([
      "<script>alert(1)</script><img src=x onerror=alert(2)>",
      "the cache lied for three weeks & nobody noticed",
      'every "AI pair" demo is recorded on a laptop that never sleeps',
    ]);
    expect(el.innerHTML).toContain("&lt;script&gt;");
    expect([...el.querySelectorAll(".inbox .date")].map((d) => d.textContent)).toEqual([
      "11-06",
      "11-06",
      "11-02",
    ]);
    expect([...el.querySelectorAll(".inbox .go")].every((g) => g.textContent === "→ article")).toBe(true);
  });

  it("`→ article` asks for a slug in place and makes the article from that idea", async () => {
    const article = vi.fn(async () => {});
    const rows = inboxRows([IDEAS[1] as Idea], hooks(article));
    document.body.replaceChildren(...rows);
    (document.querySelector(".go") as HTMLButtonElement).click();
    const input = document.querySelector<HTMLInputElement>("form.slug input");
    expect(input).not.toBeNull();
    expect(document.activeElement).toBe(input);
    (input as HTMLInputElement).value = "cache-lied";
    (document.querySelector("form.slug") as HTMLFormElement).requestSubmit();
    await vi.waitFor(() => expect(article).toHaveBeenCalledWith(IDEAS[1], "cache-lied"));
  });

  it("shows a slug problem instead of sending it", () => {
    const article = vi.fn(async () => {});
    const rows = inboxRows([IDEAS[0] as Idea], { article, check: () => "lowercase letters, digits and -" });
    document.body.replaceChildren(...rows);
    (document.querySelector(".go") as HTMLButtonElement).click();
    (document.querySelector("form.slug input") as HTMLInputElement).value = "Bad Slug";
    (document.querySelector("form.slug") as HTMLFormElement).requestSubmit();
    expect(article).not.toHaveBeenCalled();
    expect(document.querySelector("form.slug .err")?.textContent).toBe("lowercase letters, digits and -");
  });
});

describe("the inbox calls", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("GETs /api/inbox, POSTs {text}, and creates with {slug, inboxId}", async () => {
    const fetch = vi.fn(async () => new Response("[]", { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    await api.inbox();
    await api.addIdea("an idea");
    await api.createArticle("cache-lied", "i2");
    const calls = fetch.mock.calls as unknown as [string, RequestInit][];
    expect(calls[0]?.[0]).toMatch(/\/api\/inbox$/);
    expect(calls[0]?.[1].method).toBe("GET");
    expect(calls[1]?.[1].method).toBe("POST");
    expect(JSON.parse(String(calls[1]?.[1].body))).toEqual({ text: "an idea" });
    expect(calls[2]?.[0]).toMatch(/\/api\/articles$/);
    expect(JSON.parse(String(calls[2]?.[1].body))).toEqual({ slug: "cache-lied", inboxId: "i2" });
  });
});

describe("the slug form", () => {
  it("offers a slug from the idea and shows the rule's problem in red as it is typed", async () => {
    const { inboxRows } = await import("../src/inbox.ts");
    const { slugProblem } = await import("@sparring/protocol/slug");
    const [row] = inboxRows([{ id: "i1", date: "2026-11-11", text: "Why agents forget sockets" }], {
      check: slugProblem,
      article: async () => {},
    });
    document.body.append(row as HTMLElement);
    if (!row) throw new Error("no row");
    (row.querySelector(".go") as HTMLButtonElement).click();
    const input = row.querySelector("input") as HTMLInputElement;
    expect(input.value).toBe("why-agents-forget-sockets");
    input.value = "Has Space";
    input.dispatchEvent(new Event("input"));
    expect(input.value).toBe("has-space");
    input.value = "bad!";
    input.dispatchEvent(new Event("input"));
    const err = row?.querySelector(".err") as HTMLElement;
    expect(err.textContent).toContain("lowercase");
    expect(row?.querySelector("button.primary")?.textContent).toBe("create article");
    row?.remove();
  });

  it("says why when the daemon refuses", async () => {
    const { inboxRows } = await import("../src/inbox.ts");
    const [row] = inboxRows([{ id: "i2", date: "2026-11-11", text: "taken" }], {
      check: () => null,
      article: async () => {
        throw new Error("taken already exists");
      },
    });
    document.body.append(row as HTMLElement);
    if (!row) throw new Error("no row");
    (row.querySelector(".go") as HTMLButtonElement).click();
    const form = row.querySelector("form") as HTMLFormElement;
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    await new Promise((r) => setTimeout(r, 0));
    expect(row?.querySelector(".err")?.textContent).toBe("not created · taken already exists");
    row?.remove();
  });
});
