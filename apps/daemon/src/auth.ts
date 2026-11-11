// Lifted from firstprateek/i-inc at 274b42b.
// Trimmed. The daemon's lock, shared by the REST API and the AHP
// WebSocket upgrade: the `sparring` cookie, which holds an HMAC of the token and never the token, or the token
// as an `Authorization: Bearer` header; plus the Host and Origin allow-lists.
import { createHmac, timingSafeEqual } from "node:crypto";

export const COOKIE = "sparring";
/** 400 days, the longest a browser keeps a cookie. Every page load renews it, so a device stays logged in. */
export const COOKIE_MAX_AGE = 34_560_000;

/** Origins that are not a Host on the list but may still talk to the daemon: the Tauri desktop shell. */
export const EXTRA_ORIGINS = ["tauri://localhost", "http://tauri.localhost"];

/** Compares secrets in constant time. */
export function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** What the cookie holds for this token. */
export function cookieValue(token: string): string {
  return createHmac("sha256", token).update("cookie-v1").digest("hex");
}

/** The `sparring` cookie's value, if the request has one. */
export function sessionCookie(req: Request): string | undefined {
  return /(?:^|;\s*)sparring=([^;]+)/.exec(req.headers.get("cookie") ?? "")?.[1];
}

/** How the request proves itself, or undefined. */
export function credential(req: Request, token: string): "bearer" | "cookie" | undefined {
  const bearer = /^Bearer (.+)$/.exec(req.headers.get("authorization") ?? "")?.[1];
  if (bearer !== undefined && same(bearer, token)) return "bearer";
  const cookie = sessionCookie(req);
  if (cookie !== undefined && same(cookie, cookieValue(token))) return "cookie";
  return undefined;
}

export function authorized(req: Request, token: string): boolean {
  return credential(req, token) !== undefined;
}

/** Is this Host header one the daemon answers? Unset list: any (tests). */
export function hostAllowed(hosts: string[] | undefined, host: string): boolean {
  return !hosts || hosts.includes(host);
}

/** Is this Origin one of ours? A request with no Origin (not a browser) passes. */
export function originAllowed(hosts: string[] | undefined, origin: string | null): boolean {
  return (
    !origin ||
    !hosts ||
    EXTRA_ORIGINS.includes(origin) ||
    hosts.some((h) => origin === `http://${h}` || origin === `https://${h}`)
  );
}

/** The Set-Cookie line for a login. `Secure` everywhere but loopback, where there is no TLS. */
export function loginCookie(token: string, host: string): string {
  const loopback = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host);
  const secure = loopback ? "" : "; Secure";
  return `${COOKIE}=${cookieValue(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${COOKIE_MAX_AGE}${secure}`;
}
