import { LISTED } from "@sparring/protocol/commands";
import { describe, expect, it } from "vitest";
import { completion, slashMatches } from "../src/slash.ts";

const names = (text: string) => slashMatches(text)?.map((c) => c.name) ?? null;

describe("slash list", () => {
  it("opens on a bare slash with every listed command and its hint", () => {
    expect(names("/")).toEqual(LISTED.map((c) => c.name));
    expect(slashMatches("/")?.find((c) => c.name === "quiet")?.hint).toBe("no coach for this article");
  });

  it("filters by the start of the name", () => {
    expect(names("/p")).toEqual(["pass", "publish"]);
    expect(names("/pa")).toEqual(["pass"]);
    expect(names("/q")).toEqual(["queue", "quiet"]);
    expect(names("/zz")).toEqual([]);
  });

  it("does not list the unlisted commands", () => {
    expect(names("/lo")).toEqual([]);
    expect(names("/st")).toEqual(["strict"]);
  });

  it("closes once there is a space, a second line or no slash", () => {
    expect(names("/pass filler")).toBeNull();
    expect(names("/pass\n")).toBeNull();
    expect(names("hello /p")).toBeNull();
    expect(names("")).toBeNull();
  });

  it("completes to the command and a space", () => {
    const pass = LISTED.find((c) => c.name === "pass");
    expect(pass && completion(pass)).toBe("/pass ");
  });
});
