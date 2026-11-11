import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CODE_TTL_MS, mintCode, normalizeCode, spendCode } from "../src/login-codes.ts";
import { restGuard } from "../src/rest-guard.ts";

const home = () => mkdtempSync(join(tmpdir(), "sp-codes-"));

describe("one-time login codes", () => {
  it("works once, in any case and spacing", () => {
    const h = home();
    const code = mintCode(h);
    expect(code).toMatch(/^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);
    expect(spendCode(h, ` ${code.toUpperCase().replaceAll("-", " ")} `)).toBe(true);
    expect(spendCode(h, code)).toBe(false);
    expect(statSync(join(h, "login-codes.json")).mode & 0o777).toBe(0o600);
  });

  it("lapses after ten minutes", () => {
    const h = home();
    const code = mintCode(h, 1_000);
    expect(spendCode(h, code, 1_000 + CODE_TTL_MS + 1)).toBe(false);
  });

  it("refuses what was never minted", () => {
    const h = home();
    mintCode(h);
    expect(spendCode(h, "abcd-efgh-jkmn")).toBe(false);
    expect(normalizeCode("Ab-c d")).toBe("abcd");
  });

  it("logs in through the guard and sets the cookie", async () => {
    const h = home();
    const code = mintCode(h);
    const guard = restGuard(
      { token: "t".repeat(64), hosts: ["127.0.0.1:7421"], spendCode: (c) => spendCode(h, c) },
      async () => new Response("next"),
    );
    const post = (token: string) =>
      guard(
        new Request("http://127.0.0.1:7421/api/login", {
          method: "POST",
          headers: {
            host: "127.0.0.1:7421",
            origin: "http://127.0.0.1:7421",
            "content-type": "application/json",
          },
          body: JSON.stringify({ token }),
        }),
      );
    const ok = await post(code);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("set-cookie")).toContain("sparring=");
    expect((await post(code)).status).toBe(401);
  });
});
