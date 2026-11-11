// ~/.sparring/config.json: the login token, the allowed Host names and where the writing repo is. Made on first
// run. The daemon refuses to start when the file can be read by anyone but the owner, or lists no hosts.
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Config {
  token: string;
  hosts: string[];
  writing_dir: string;
  port: number;
  git_name: string;
  git_email: string;
  default_provider: "claude" | "demo";
  claude_oauth_token?: string;
  site_repo?: string;
  backup_remote?: string;
}

export const DEFAULT_PORT = 7421;

/** Where Sparring keeps its own state. Tests point it elsewhere with SPARRING_HOME. */
export function sparringHome(): string {
  return process.env.SPARRING_HOME ?? join(homedir(), ".sparring");
}

/** `~/x` as an absolute path. Every path handed to git or a child process is absolute. */
export function expandHome(p: string): string {
  return p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

/** Reads the config, filling in and saving any key it lacks. Throws when the file is not private. */
export function loadConfig(home = sparringHome()): Config {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  if ((statSync(home).mode & 0o077) !== 0) chmodSync(home, 0o700);
  const path = join(home, "config.json");
  let raw: Partial<Config> = {};
  if (existsSync(path)) {
    if ((statSync(path).mode & 0o077) !== 0) {
      throw new Error(`${path} can be read by other users; run: chmod 600 ${path}`);
    }
    raw = JSON.parse(readFileSync(path, "utf8")) as Partial<Config>;
  }
  const port = raw.port ?? DEFAULT_PORT;
  const filled: Config = {
    ...raw,
    token: raw.token ?? randomBytes(32).toString("hex"),
    hosts: raw.hosts ?? [`127.0.0.1:${port}`, `localhost:${port}`],
    writing_dir: raw.writing_dir ?? "~/writing",
    port,
    git_name: raw.git_name ?? "Sparring",
    git_email: raw.git_email ?? "sparring@localhost",
    // "demo" until the real coach lands in step 3.
    default_provider: raw.default_provider ?? "demo",
  };
  if (JSON.stringify(filled) !== JSON.stringify(raw)) {
    writeFileSync(path, `${JSON.stringify(filled, null, 2)}\n`, { mode: 0o600 });
    chmodSync(path, 0o600);
  }
  if (filled.hosts.length === 0) throw new Error(`${path} lists no hosts`);
  return { ...filled, writing_dir: expandHome(filled.writing_dir) };
}
