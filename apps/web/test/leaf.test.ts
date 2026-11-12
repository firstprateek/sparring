// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, api } from "../src/api.ts";
import { Leaf } from "../src/leaf.ts";

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("a save the daemon answers with 409", () => {
  it("counts as saved when the disk already holds exactly this text", async () => {
    vi.spyOn(api, "save").mockRejectedValue(new ApiError(409, { disk_sha: "d1", disk_text: "mine\n" }));
    const leaf = new Leaf("a", "article", "old\n", "s0", () => {});
    leaf.edit("mine\n");
    await leaf.saveNow(false);
    expect(leaf.state.kind).toBe("saved");
    expect(leaf.dirty).toBe(false);
    expect(leaf.baseSha).toBe("d1");
  });

  it("is a conflict when the disk holds something else", async () => {
    vi.spyOn(api, "save").mockRejectedValue(new ApiError(409, { disk_sha: "d1", disk_text: "theirs\n" }));
    const leaf = new Leaf("a", "article", "old\n", "s0", () => {});
    leaf.edit("mine\n");
    await leaf.saveNow(false);
    expect(leaf.state).toEqual({ kind: "conflict", diskSha: "d1", diskText: "theirs\n" });
    expect(leaf.dirty).toBe(true);
  });
});
