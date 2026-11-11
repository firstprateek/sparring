import { describe, expect, it } from "vitest";
import { slugProblem, suggestSlug } from "../src/slug.ts";

describe("suggestSlug", () => {
  it("takes the first words, lowercase, hyphenated", () => {
    expect(suggestSlug("What if agents forget their sockets?")).toBe("what-if-agents-forget-their");
    expect(suggestSlug("Don't trust   the cache")).toBe("dont-trust-the-cache");
    expect(suggestSlug("Café résumé")).toBe("cafe-resume");
  });

  it("always offers a slug the rule accepts, or nothing", () => {
    for (const t of ["!!!", "", "index", "a".repeat(90), "Ünïcode — dashes — everywhere", "x"]) {
      const s = suggestSlug(t);
      if (s !== "") expect(slugProblem(s)).toBeNull();
    }
    expect(suggestSlug("!!!")).toBe("");
  });
});
