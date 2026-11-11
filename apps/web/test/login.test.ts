// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { handedToken } from "../src/login.ts";

afterEach(() => {
  history.replaceState(null, "", "/");
});

describe("the desktop token hand-off", () => {
  it("reads #token= and drops it from the address", () => {
    history.replaceState(null, "", "/room.html?a=1#token=abc%2Bdef");
    expect(handedToken()).toBe("abc+def");
    expect(location.hash).toBe("");
    expect(location.pathname + location.search).toBe("/room.html?a=1");
  });

  it("leaves any other fragment alone", () => {
    history.replaceState(null, "", "/#notes");
    expect(handedToken()).toBeUndefined();
    expect(location.hash).toBe("#notes");
  });
});
