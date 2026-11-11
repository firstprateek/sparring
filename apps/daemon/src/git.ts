// One serialized queue for every git command in a repo. Commands are argv arrays, never shell strings, and run
// with a clean environment so no prompt can hang the daemon. A held index.lock is waited out, never deleted.
import { execFile } from "node:child_process";

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export class GitError extends Error {
  constructor(
    readonly args: string[],
    readonly result: GitResult,
  ) {
    super(`git ${args.join(" ")} exited ${result.code}: ${result.stderr.trim()}`);
  }
}

const LOCK_RETRIES = 3;

export function gitEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: process.env.HOME ?? "/",
    LANG: "C",
    GIT_TERMINAL_PROMPT: "0",
    GIT_SSH_COMMAND: "ssh -o BatchMode=yes",
    GIT_CONFIG_NOSYSTEM: "1",
    ...extra,
  };
  return env;
}

function execGit(cwd: string, args: string[], input?: string, env?: Record<string, string>): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = execFile(
      "git",
      args,
      { cwd, env: gitEnv(env), maxBuffer: 64 * 1024 * 1024, timeout: 60_000 },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
    if (input !== undefined) child.stdin?.end(input);
  });
}

export class GitQueue {
  private tail: Promise<unknown> = Promise.resolve();

  constructor(readonly cwd: string) {}

  /** Runs `fn` after every earlier job in this queue has finished. */
  serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => undefined);
    return next;
  }

  /** One git command, outside the queue. Callers inside `serial` use this. */
  async raw(args: string[], opts: { input?: string; env?: Record<string, string>; ok?: number[] } = {}) {
    let result = await execGit(this.cwd, args, opts.input, opts.env);
    for (let i = 0; i < LOCK_RETRIES && result.code !== 0 && /index\.lock/.test(result.stderr); i++) {
      await new Promise((r) => setTimeout(r, 200 * (i + 1)));
      result = await execGit(this.cwd, args, opts.input, opts.env);
    }
    if (!(opts.ok ?? [0]).includes(result.code)) throw new GitError(args, result);
    return result;
  }

  /** One git command inside the queue. */
  run(args: string[], opts: { input?: string; env?: Record<string, string>; ok?: number[] } = {}) {
    return this.serial(() => this.raw(args, opts));
  }
}
