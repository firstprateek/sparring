// The `claude` engine (design section 3, "The coach process" and "The guard"): the pinned
// `@agentclientprotocol/claude-agent-acp` under `~/.sparring/adapters/claude/`, run per article with an
// allow-listed environment, the isolated `CLAUDE_CONFIG_DIR` and the guard's settings file.
//
// Every child is a process-group leader with a pid file at `~/.sparring/run/<article_id>.pid`, so a daemon that
// died leaves nothing behind for long: on start the daemon kills every recorded group.
import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { PassThrough } from "node:stream";
import type { AgentProcess, Launch } from "./ahp/agent-process.ts";

/** The guard's settings, layer 1. Written on first run; a file that differs stops every spawn. */
export const GUARD_SETTINGS = {
  permissions: {
    defaultMode: "default",
    disableAutoMode: "disable",
    disableBypassPermissionsMode: "disable",
    allow: ["mcp__sparring"],
    deny: ["Bash", "Write", "Edit", "NotebookEdit", "WebFetch", "WebSearch", "Agent", "Task"],
    blockReadsOutsideWorkingDirectories: true,
  },
};

export const DISALLOWED_TOOLS = [...GUARD_SETTINGS.permissions.deny];

export interface ClaudePaths {
  /** `CLAUDE_CONFIG_DIR`, the isolated `~/.sparring/claude`. */
  configDir: string;
  settings: string;
  adapterBin: string;
  runDir: string;
}

export function claudePaths(home: string): ClaudePaths {
  const configDir = join(home, "claude");
  return {
    configDir,
    settings: join(configDir, "settings.json"),
    adapterBin: join(home, "adapters", "claude", "node_modules", ".bin", "claude-agent-acp"),
    runDir: join(home, "run"),
  };
}

function privateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if ((statSync(path).mode & 0o077) !== 0) chmodSync(path, 0o700);
}

/** Keys in a fixed order, so two equal objects print the same. */
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object")
    return Object.fromEntries(
      Object.keys(v as object)
        .sort()
        .map((k) => [k, canonical((v as Record<string, unknown>)[k])]),
    );
  return v;
}

/**
 * Writes `settings.json` on first run; afterwards checks it. Throws when the file is not the guard's, so the
 * caller refuses to spawn.
 */
export function ensureSettings(home: string): void {
  const p = claudePaths(home);
  privateDir(home);
  privateDir(p.configDir);
  if (!existsSync(p.settings)) {
    writeFileSync(p.settings, `${JSON.stringify(GUARD_SETTINGS, null, 2)}\n`, { mode: 0o600 });
    return;
  }
  let have: unknown;
  try {
    have = JSON.parse(readFileSync(p.settings, "utf8"));
  } catch {
    have = undefined;
  }
  if (JSON.stringify(canonical(have)) !== JSON.stringify(canonical(GUARD_SETTINGS)))
    throw new Error(`${p.settings} is not the guard's settings · fix it or delete it`);
}

/** The child's environment: an allow-list, never the daemon's own (no SSH_AUTH_SOCK, GH_TOKEN, Sparring token). */
export function claudeEnv(home: string, token: string | undefined): Record<string, string> {
  const env: Record<string, string> = {
    CLAUDE_CONFIG_DIR: claudePaths(home).configDir,
    CLAUDE_AGENT_ACP_PROTOCOL: "v1",
  };
  for (const key of ["PATH", "HOME", "LANG", "TMPDIR"]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  if (token) env.CLAUDE_CODE_OAUTH_TOKEN = token;
  return env;
}

export interface GroupSpawn {
  cmd: string;
  args?: string[];
  cwd: string;
  env: Record<string, string>;
  /** Where the pid is recorded while the child lives. */
  pidFile: string;
  /** How long a SIGTERM to the group gets before SIGKILL. */
  graceMs?: number;
}

/** Signals a process group; false when it is gone. */
function signalGroup(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false;
  }
}

/**
 * Spawns a child as the leader of a new process group, records `<pid>\n<cmd>\n` in its pid file, and removes the
 * file when the child exits. `kill()` ends the whole group: SIGTERM, then SIGKILL after the grace.
 */
export function spawnGroup(o: GroupSpawn): AgentProcess {
  const child = spawn(o.cmd, o.args ?? [], {
    cwd: o.cwd,
    env: o.env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });
  const pid = child.pid;
  let gone = false;
  const exited = new Promise<number | null>((resolve) => {
    const done = (code: number | null) => {
      if (gone) return;
      gone = true;
      if (pid) {
        // The group may outlive its leader (the MCP proxy, a tool): it goes with it.
        signalGroup(pid, "SIGKILL");
        try {
          if (readFileSync(o.pidFile, "utf8").startsWith(`${pid}\n`)) rmSync(o.pidFile, { force: true });
        } catch {}
      }
      resolve(code);
    };
    child.on("exit", (code) => done(code));
    child.on("error", () => done(null));
  });
  if (pid) {
    privateDir(join(o.pidFile, ".."));
    writeFileSync(o.pidFile, `${pid}\n${o.cmd}\n`, { mode: 0o600 });
  }
  // A child that failed to spawn has no streams worth reading: hand back ended ones.
  const ended = () => {
    const s = new PassThrough();
    s.end();
    return s;
  };
  return {
    stdin: child.stdin ?? new PassThrough(),
    stdout: child.stdout ?? ended(),
    stderr: child.stderr ?? ended(),
    exited,
    kill: () => {
      if (gone || !pid) return;
      signalGroup(pid, "SIGTERM");
      setTimeout(() => {
        if (!gone) signalGroup(pid, "SIGKILL");
      }, o.graceMs ?? 2000).unref?.();
    },
  };
}

/** The command line of a live pid, or undefined. */
function commandOf(pid: number): string | undefined {
  try {
    return (
      execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).trim() || undefined
    );
  } catch {
    return undefined;
  }
}

/**
 * On start: kills every process group a pid file records, when its leader still runs the recorded command (a
 * reused pid is left alone), and removes the files. Answers how many groups were killed.
 */
export function killRecordedGroups(runDir: string, log: (m: string) => void = () => {}): number {
  if (!existsSync(runDir)) return 0;
  let killed = 0;
  for (const name of readdirSync(runDir)) {
    if (!name.endsWith(".pid")) continue;
    const file = join(runDir, name);
    try {
      const [pidText, cmd] = readFileSync(file, "utf8").split("\n");
      const pid = Number(pidText);
      const running = Number.isInteger(pid) && pid > 1 ? commandOf(pid) : undefined;
      if (running && cmd && running.includes(basename(cmd)) && signalGroup(pid, "SIGKILL")) {
        killed++;
        log(`killed the coach group ${pid} a previous daemon left (${name})`);
      }
    } catch {}
    rmSync(file, { force: true });
  }
  return killed;
}

export interface ClaudeLaunchOptions {
  /** `~/.sparring`, or SPARRING_HOME. */
  home: string;
  /** `claude_oauth_token` from config.json. */
  token?: string;
}

/** The launch for the `claude` provider: checks the settings pin, then spawns the pinned adapter. */
export function claudeLaunch(o: ClaudeLaunchOptions): Launch {
  const p = claudePaths(o.home);
  return (r) => {
    ensureSettings(o.home);
    if (!existsSync(p.adapterBin)) throw new Error(`the claude adapter is not installed at ${p.adapterBin}`);
    return spawnGroup({
      cmd: p.adapterBin,
      cwd: r.cwd,
      env: claudeEnv(o.home, o.token),
      pidFile: join(p.runDir, `${r.articleId}.pid`),
    });
  };
}
