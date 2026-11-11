// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../src/markdown.ts";

function render(text: string): HTMLElement {
  const box = document.createElement("div");
  box.append(...renderMarkdown(text));
  return box;
}

describe("markdown renderer", () => {
  it("shows a script tag in coach text as text", () => {
    const box = render('Try this <script>alert("x")</script> and <img src=x onerror=alert(1)>.');
    expect(box.querySelector("script")).toBeNull();
    expect(box.querySelector("img")).toBeNull();
    expect(box.textContent).toContain('<script>alert("x")</script>');
    expect(box.textContent).toContain("<img src=x onerror=alert(1)>");
  });

  it("keeps raw HTML inside code, emphasis and lists as text", () => {
    const box = render(
      "**<b>bold</b>**\n\n- `<iframe>`\n- <a href=javascript:alert(1)>x</a>\n\n```\n<script>1</script>\n```",
    );
    expect(box.querySelector("b, iframe, script")).toBeNull();
    expect(box.querySelector("strong")?.textContent).toBe("<b>bold</b>");
    expect(box.querySelector("li code")?.textContent).toBe("<iframe>");
    expect(box.querySelector("pre code")?.textContent).toBe("<script>1</script>");
    expect([...box.querySelectorAll("a")].map((a) => a.getAttribute("href"))).toEqual([]);
  });

  it("links only http(s) and mailto, opening in a new tab", () => {
    const box = render("[ok](https://example.com/a) [bad](javascript:alert(1)) [data](data:text/html,x)");
    const links = [...box.querySelectorAll("a")];
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["https://example.com/a"]);
    expect(links[0]?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(box.textContent).toContain("bad");
  });

  it("renders paragraphs, headings and quotes as elements", () => {
    const box = render("# Title\n\nOne *two*.\n\n> quoted");
    expect(box.querySelector("h3")?.textContent).toBe("Title");
    expect(box.querySelector("p em")?.textContent).toBe("two");
    expect(box.querySelector("blockquote")?.textContent).toBe("quoted");
  });
});
