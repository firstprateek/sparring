import { describe, expect, it } from "vitest";
import { cookieValue, originAllowed } from "../src/auth.ts";
import { restGuard } from "../src/rest-guard.ts";

const TOKEN = "t".repeat(64);
const guard = restGuard({ token: TOKEN, hosts: ["127.0.0.1:7421", "box.tail.ts.net"] }, async () =>
  Response.json({ passed: true }),
);
const req = (method: string, path: string, headers: Record<string, string> = {}, body?: unknown) =>
  guard(
    new Request(`http://127.0.0.1:7421${path}`, {
      method,
      headers: { host: "127.0.0.1:7421", ...headers },
      body: body === undefined ? null : JSON.stringify(body),
    }),
  );
const JSONH = { "content-type": "application/json" };

describe("rest guard", () => {
  it("refuses a request with no credential, and takes the bearer token or the cookie", async () => {
    expect((await req("GET", "/api/articles/a")).status).toBe(401);
    expect((await req("GET", "/api/me", { authorization: `Bearer ${TOKEN}` })).status).toBe(200);
    expect((await req("GET", "/api/me", { cookie: `sparring=${cookieValue(TOKEN)}` })).status).toBe(200);
    expect((await req("GET", "/api/me", { cookie: `sparring=${TOKEN}` })).status).toBe(401);
  });

  it("refuses a wrong Host, a foreign Origin and a write that is not JSON", async () => {
    const auth = { authorization: `Bearer ${TOKEN}` };
    expect((await req("GET", "/api/me", { ...auth, host: "evil.example:7421" })).status).toBe(421);
    const foreign = await req(
      "POST",
      "/api/articles",
      { ...auth, ...JSONH, origin: "https://evil.example" },
      {},
    );
    expect(foreign.status).toBe(403);
    expect(
      (await req("POST", "/api/articles", { ...auth, origin: "http://127.0.0.1:7421" }, {})).status,
    ).toBe(415);
    const ok = await req("POST", "/api/articles", { ...auth, ...JSONH, origin: "http://127.0.0.1:7421" }, {});
    expect(ok.status).toBe(200);
    expect(originAllowed(["127.0.0.1:7421"], "tauri://localhost")).toBe(true);
  });

  it("logs in with the token, sets an HMAC cookie, and stops after five failures", async () => {
    const res = await req("POST", "/api/login", JSONH, { token: TOKEN });
    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`sparring=${cookieValue(TOKEN)}`);
    expect(cookie).toContain("HttpOnly; SameSite=Strict");
    expect(cookie).not.toContain(TOKEN);
    expect(cookie).not.toContain("Secure");
    for (let i = 0; i < 5; i++)
      expect((await req("POST", "/api/login", JSONH, { token: "nope" })).status).toBe(401);
    expect((await req("POST", "/api/login", JSONH, { token: TOKEN })).status).toBe(429);
  });
});
