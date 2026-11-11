// One-time login codes, for logging in a new device without sending the long-lived token anywhere. The owner
// mints one on the Mac mini (`pnpm login-code`), types or pastes it into the login form, and the daemon
// answers with the usual cookie. A code works once and lapses after ten minutes. Only its SHA-256 is kept, in
// ~/.sparring/login-codes.json (0600).
import { createHash, randomInt } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface Stored {
  sha: string;
  expires: number;
}

export const CODE_TTL_MS = 10 * 60_000;
const ALPHABET = "abcdefghjkmnpqrstvwxyz23456789";

const file = (home: string) => join(home, "login-codes.json");
const sha = (code: string) => createHash("sha256").update(code).digest("hex");

/** Lower case with every separator dropped, so `ABCD-efgh jkmn` is `abcdefghjkmn`. */
export function normalizeCode(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function load(home: string, now: number): Stored[] {
  if (!existsSync(file(home))) return [];
  try {
    const all = JSON.parse(readFileSync(file(home), "utf8")) as Stored[];
    return Array.isArray(all) ? all.filter((c) => typeof c.sha === "string" && c.expires > now) : [];
  } catch {
    return [];
  }
}

function store(home: string, codes: Stored[]): void {
  writeFileSync(file(home), `${JSON.stringify(codes)}\n`, { mode: 0o600 });
  chmodSync(file(home), 0o600);
}

/** A fresh code, `xxxx-xxxx-xxxx` (about 59 bits), saved by its hash. */
export function mintCode(home: string, now = Date.now()): string {
  let raw = "";
  for (let i = 0; i < 12; i++) raw += ALPHABET[randomInt(ALPHABET.length)];
  store(home, [...load(home, now), { sha: sha(raw), expires: now + CODE_TTL_MS }]);
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8)}`;
}

/** True, once, for a live code; the code is gone afterwards. */
export function spendCode(home: string, input: string, now = Date.now()): boolean {
  const raw = normalizeCode(input);
  if (raw.length !== 12) return false;
  const live = load(home, now);
  const left = live.filter((c) => c.sha !== sha(raw));
  if (left.length === live.length) return false;
  store(home, left);
  return true;
}
