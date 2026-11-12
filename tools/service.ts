// The daemon as a launchd service on the Mac mini: started at login (the mini logs in by itself after a
// reboot), started again if it dies, its output in ~/Library/Logs/sparring-daemon.log.
//
//   pnpm service install     write the plist and start the service (stop a daemon started by hand first)
//   pnpm service uninstall   stop it and remove the plist
//   pnpm service status      whether it runs, and which web build it serves
//   pnpm service print       the plist, without installing it
//
// `pnpm ship` (tools/ship.ts) restarts it after an update.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { loadConfig } from "../apps/daemon/src/config.ts";

export const LABEL = "app.sparring.daemon";
export const REPO = resolve(import.meta.dir, "..");
export const PLIST = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
export const LOG = join(homedir(), "Library", "Logs", "sparring-daemon.log");
const uid = process.getuid?.() ?? 501;
export const TARGET = `gui/${uid}/${LABEL}`;

const xml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function which(name: string): string | null {
  const r = spawnSync("/usr/bin/which", [name], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

/**
 * The service's PATH: the folders `bun`, `node`, `npm`, `gh` and `git` are in now, then the usual ones. launchd
 * starts a job with almost no PATH, and the coach's adapter is a `node` script.
 */
export function servicePath(): string {
  const dirs: string[] = [];
  for (const tool of ["bun", "node", "npm", "gh", "git"]) {
    const at = which(tool);
    if (at) dirs.push(dirname(at));
  }
  dirs.push("/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin");
  return [...new Set(dirs)].join(":");
}

/**
 * `bun` as the shell finds it (Homebrew's link), not `process.execPath`, which is the versioned folder an upgrade
 * deletes.
 */
const bun = () => which("bun") ?? process.execPath;

export function plist(): string {
  const env: Record<string, string> = { PATH: servicePath(), HOME: homedir(), LANG: "en_US.UTF-8" };
  if (process.env.SPARRING_HOME) env.SPARRING_HOME = process.env.SPARRING_HOME;
  const envXml = Object.entries(env)
    .map(([k, v]) => `    <key>${xml(k)}</key>\n    <string>${xml(v)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(bun())}</string>
    <string>${xml(join(REPO, "apps/daemon/src/main.ts"))}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(REPO)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${envXml}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${xml(LOG)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(LOG)}</string>
</dict>
</plist>
`;
}

/** The service's pid, 0 when loaded but not running, null when launchd does not know it. */
export function servicePid(): number | null {
  const r = spawnSync("launchctl", ["print", TARGET], { encoding: "utf8" });
  if (r.status !== 0) return null;
  return Number(/^\s*pid = (\d+)/m.exec(r.stdout)?.[1] ?? 0);
}

/** Whoever listens on the daemon's port, or null. */
function listener(port: number): number | null {
  const r = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" });
  const pid = Number(r.stdout.trim().split("\n")[0]);
  return pid > 0 ? pid : null;
}

export const port = () => loadConfig().port;

/** The web build the daemon answers with, or null when it does not answer. */
export async function servedBuild(): Promise<string | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port()}/build.json`, {
      headers: { host: `127.0.0.1:${port()}` },
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return null;
    return ((await res.json()) as { build?: string }).build ?? null;
  } catch {
    return null;
  }
}

export function builtBuild(): string | null {
  try {
    return JSON.parse(readFileSync(join(REPO, "apps/web/dist/build.json"), "utf8")).build ?? null;
  } catch {
    return null;
  }
}

/** Waits for a daemon other than `oldPid` to answer with the build on disk. */
export async function waitForDaemon(oldPid: number | null, seconds = 30): Promise<boolean> {
  const want = builtBuild();
  for (let i = 0; i < seconds * 2; i++) {
    const pid = servicePid();
    if (pid && pid !== oldPid && (await servedBuild()) === want) return true;
    await Bun.sleep(500);
  }
  return false;
}

export function logTail(lines = 20): string {
  try {
    return readFileSync(LOG, "utf8").trimEnd().split("\n").slice(-lines).join("\n");
  } catch {
    return "(no log yet)";
  }
}

async function install(): Promise<void> {
  const held = listener(port());
  const mine = servicePid();
  if (held && held !== mine) {
    console.error(
      `something else listens on 127.0.0.1:${port()} (pid ${held}) · stop the daemon started by hand first, then run this again`,
    );
    process.exit(1);
  }
  mkdirSync(dirname(PLIST), { recursive: true });
  mkdirSync(dirname(LOG), { recursive: true });
  writeFileSync(PLIST, plist());
  execFileSync("plutil", ["-lint", PLIST], { stdio: "ignore" });
  if (mine !== null) spawnSync("launchctl", ["bootout", TARGET]);
  execFileSync("launchctl", ["bootstrap", `gui/${uid}`, PLIST]);
  if (await waitForDaemon(mine)) {
    console.log(`running · pid ${servicePid()} · log ${LOG}`);
  } else {
    console.error(`installed, but the daemon does not answer yet · last lines of ${LOG}:\n${logTail()}`);
    process.exit(1);
  }
}

function uninstall(): void {
  if (servicePid() !== null) execFileSync("launchctl", ["bootout", TARGET]);
  if (existsSync(PLIST)) rmSync(PLIST);
  console.log("stopped and removed · start it by hand with `pnpm start`");
}

async function status(): Promise<void> {
  const pid = servicePid();
  console.log(
    pid === null
      ? "not a service · `pnpm service install`"
      : pid
        ? `running · pid ${pid}`
        : "loaded, not running",
  );
  const served = await servedBuild();
  const built = builtBuild();
  console.log(`web build served ${served ?? "none (no answer)"} · on disk ${built ?? "none"}`);
  if (pid === 0) console.log(logTail());
}

if (import.meta.main) {
  const cmd = process.argv[2];
  if (cmd === "install") await install();
  else if (cmd === "uninstall") uninstall();
  else if (cmd === "status") await status();
  else if (cmd === "print") process.stdout.write(plist());
  else {
    console.error("usage: pnpm service install | uninstall | status | print");
    process.exit(2);
  }
}
