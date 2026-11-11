// The claude engine's process side: the settings pin, the allow-listed env, process groups and pid files.
import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ResponsePartKind, ROOT, TurnState } from "../src/ahp/wire.ts";
import {
  claudeEnv,
  claudeLaunch,
  claudePaths,
  ensureSettings,
  GUARD_SETTINGS,
  killRecordedGroups,
  spawnGroup,
} from "../src/claude.ts";
import { type Any, TestClient } from "./ahp/support.ts";
import { rig } from "./rig.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "sparring-home-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

/** A stand-in adapter: a shell script that starts a grandchild and waits. Prints the grandchild's pid. */
function fakeAdapter(): string {
  const p = join(home, "fake-adapter.sh");
  writeFileSync(p, "#!/bin/sh\nsleep 300 &\necho $!\nwait\n");
  chmodSync(p, 0o755);
  return p;
}

describe("the settings pin", () => {
  it("is written on first run, 0600 in a 0700 folder, and accepted after", () => {
    ensureSettings(home);
    const p = claudePaths(home);
    expect(JSON.parse(readFileSync(p.settings, "utf8"))).toEqual(GUARD_SETTINGS);
    expect(statSync(p.settings).mode & 0o777).toBe(0o600);
    expect(statSync(p.configDir).mode & 0o777).toBe(0o700);
    expect(() => ensureSettings(home)).not.toThrow();
    // key order is not a difference
    const reordered = {
      permissions: Object.fromEntries(Object.entries(GUARD_SETTINGS.permissions).reverse()),
    };
    writeFileSync(p.settings, JSON.stringify(reordered));
    expect(() => ensureSettings(home)).not.toThrow();
  });

  it("refuses to spawn when the file differs", async () => {
    ensureSettings(home);
    const p = claudePaths(home);
    const loose = structuredClone(GUARD_SETTINGS) as Any;
    loose.permissions.allow.push("Edit");
    writeFileSync(p.settings, JSON.stringify(loose));
    expect(() => ensureSettings(home)).toThrow(/is not the guard's settings/);
    // through the coach: the turn fails to start, nothing is spawned
    mkdirSync(join(home, "adapters", "claude", "node_modules", ".bin"), { recursive: true });
    const t = await rig({ claude: claudeLaunch({ home, token: "x" }) });
    const a = await t.article("a", "claude");
    const c = new TestClient(t.host);
    await c.init([ROOT, a.chat]);
    await t.say(c, a.chat, "hello");
    const turn = t.host.chatState(a.chat)?.turns[0] as Any;
    expect(turn.state).toBe(TurnState.Error);
    expect(turn.responseParts.at(-1)).toMatchObject({ kind: ResponsePartKind.Error });
    expect(turn.responseParts.at(-1).error.message).toMatch(
      /^the coach did not start: .*is not the guard's settings/,
    );
    expect(existsSync(join(home, "run"))).toBe(false);
  });
});

describe("the child's environment", () => {
  it("is an allow-list: no SSH agent, no GitHub token, no Sparring token", () => {
    const saved = { ...process.env };
    process.env.SSH_AUTH_SOCK = "/tmp/agent";
    process.env.GH_TOKEN = "gh";
    process.env.GITHUB_TOKEN = "gh";
    try {
      const env = claudeEnv(home, "tok");
      expect(Object.keys(env).sort()).toEqual(
        [
          "CLAUDE_AGENT_ACP_PROTOCOL",
          "CLAUDE_CODE_OAUTH_TOKEN",
          "CLAUDE_CONFIG_DIR",
          "HOME",
          "LANG",
          "PATH",
          "TMPDIR",
        ].filter((k) => k in env),
      );
      expect(env).toMatchObject({
        CLAUDE_CONFIG_DIR: join(home, "claude"),
        CLAUDE_AGENT_ACP_PROTOCOL: "v1",
        CLAUDE_CODE_OAUTH_TOKEN: "tok",
      });
      expect(env.SSH_AUTH_SOCK).toBeUndefined();
      expect(env.GH_TOKEN).toBeUndefined();
      expect(claudeEnv(home, undefined).CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    } finally {
      process.env = saved;
    }
  });
});

describe("process groups", () => {
  it("spawns a group leader with a pid file, and kill() ends the whole group and the file", async () => {
    const pidFile = join(home, "run", "art.pid");
    const proc = spawnGroup({
      cmd: fakeAdapter(),
      cwd: home,
      env: { PATH: process.env.PATH ?? "" },
      pidFile,
      graceMs: 200,
    });
    const grandchild = await new Promise<number>((r) =>
      proc.stdout.once("data", (d: Buffer) => r(Number(String(d).trim()))),
    );
    const [pidText, cmd] = readFileSync(pidFile, "utf8").split("\n");
    const pid = Number(pidText);
    expect(cmd).toMatch(/fake-adapter\.sh$/);
    expect(statSync(pidFile).mode & 0o777).toBe(0o600);
    expect(alive(pid) && alive(grandchild)).toBe(true);
    proc.kill();
    await proc.exited;
    await sleep(50);
    expect(alive(grandchild)).toBe(false);
    expect(existsSync(pidFile)).toBe(false);
  });

  it("on start, kills every recorded group whose leader still runs the command, and leaves a reused pid alone", async () => {
    const runDir = join(home, "run");
    mkdirSync(runDir, { recursive: true });
    const script = fakeAdapter();
    // a group a dead daemon left: started detached, recorded by hand
    const left = spawn(script, [], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
    const grandchild = await new Promise<number>((r) =>
      left.stdout?.once("data", (d: Buffer) => r(Number(String(d).trim()))),
    );
    writeFileSync(join(runDir, "old.pid"), `${left.pid}\n${script}\n`);
    // a pid file whose pid is now someone else (this test runner)
    writeFileSync(join(runDir, "reused.pid"), `${process.pid}\n/nowhere/claude-agent-acp\n`);
    writeFileSync(join(runDir, "junk.pid"), "not a pid\n");
    expect(killRecordedGroups(runDir)).toBe(1);
    await sleep(100);
    expect(alive(left.pid as number)).toBe(false);
    expect(alive(grandchild)).toBe(false);
    expect(alive(process.pid)).toBe(true);
    expect(execFileSync("ls", [runDir], { encoding: "utf8" }).trim()).toBe("");
  });

  it("kills the recorded groups when the coach starts", async () => {
    const runDir = join(home, "run");
    mkdirSync(runDir, { recursive: true });
    const script = fakeAdapter();
    const left = spawn(script, [], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
    await new Promise((r) => left.stdout?.once("data", r));
    writeFileSync(join(runDir, "x.pid"), `${left.pid}\n${script}\n`);
    await rig({ runDir });
    await sleep(100);
    expect(alive(left.pid as number)).toBe(false);
  });
});
