// Lifted from firstprateek/i-inc at 274b42b.
// The lock in front of /api/*, from its REST guard: every request
// must come to an allowed Host (421) and carry the cookie or the bearer token (401); every write must also
// come from an allowed Origin (403) and be JSON (415). Login is the one route open without a credential,
// and it allows five failures a minute.
import { authorized, hostAllowed, loginCookie, originAllowed, same } from "./auth.ts";

export interface GuardOptions {
  token: string;
  hosts: string[];
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });

const LOGIN_FAILS_PER_MINUTE = 5;

export function restGuard(opts: GuardOptions, next: (req: Request) => Promise<Response>) {
  const fails: number[] = [];
  return async (req: Request): Promise<Response> => {
    const host = req.headers.get("host") ?? "";
    if (!hostAllowed(opts.hosts, host)) return json({ error: `not served as ${host}` }, 421);
    const write = req.method !== "GET" && req.method !== "HEAD";
    if (write) {
      if (!originAllowed(opts.hosts, req.headers.get("origin"))) {
        return json({ error: "cross-site request refused" }, 403);
      }
      if (!(req.headers.get("content-type") ?? "").startsWith("application/json")) {
        return json({ error: "writes must be application/json" }, 415);
      }
    }
    const path = new URL(req.url).pathname;
    if (req.method === "POST" && path === "/api/login") {
      const now = Date.now();
      while (fails.length > 0 && (fails[0] as number) < now - 60_000) fails.shift();
      if (fails.length >= LOGIN_FAILS_PER_MINUTE)
        return json({ error: "too many tries · wait a minute" }, 429);
      const body = (await req.json().catch(() => ({}))) as { token?: unknown };
      if (typeof body.token !== "string" || !same(body.token, opts.token)) {
        fails.push(now);
        return json({ error: "wrong token" }, 401);
      }
      return json({ ok: true }, 200, { "set-cookie": loginCookie(opts.token, host) });
    }
    if (!authorized(req, opts.token)) return json({ error: "unauthorized" }, 401);
    // The client asks /api/me on every page load: renewing the cookie there keeps a device logged in for as
    // long as it is used at least once in 400 days.
    if (req.method === "GET" && path === "/api/me") {
      return json({ ok: true }, 200, { "set-cookie": loginCookie(opts.token, host) });
    }
    return next(req);
  };
}
