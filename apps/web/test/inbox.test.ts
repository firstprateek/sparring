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
