// Updates the Mac mini to what is on GitHub: `pnpm ship`. It stops at the first step that fails, so a failing
// test never reaches the running daemon.
//
//   1. refuse uncommitted changes (the build must be what git says it is)
//   2. git pull --ff-only (skip with --no-pull, to ship what is already checked out)
//   3. pnpm install --frozen-lockfile
//   4. lint, typecheck, tests
//   5. build the web client
//   6. restart the launchd service and wait until it answers with the new build
//
// Open pages then show "sparring was updated · reload" within a minute (apps/web/src/update.ts).
import { spawnSync } from "node:child_process";
import { builtBuild, LOG, logTail, REPO, servicePid, TARGET, waitForDaemon } from "./service.ts";

const pull = !process.argv.includes("--no-pull");

function step(title: string, cmd: string, args: string[]): void {
  console.log(`\n▸ ${title}`);
  const r = spawnSync(cmd, args, { cwd: REPO, stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`\n✗ ${title} failed · the running daemon was not touched`);
    process.exit(1);
  }
}

const dirty = spawnSync("git", ["status", "--porcelain", "--untracked-files=no"], {
  cwd: REPO,
  encoding: "utf8",
}).stdout.trim();
if (dirty) {
  console.error(`uncommitted changes · commit or stash them first:\n${dirty}`);
  process.exit(1);
}

const before = builtBuild();
if (pull) step("pull", "git", ["pull", "--ff-only"]);
step("install", "pnpm", ["install", "--frozen-lockfile"]);
step("lint", "pnpm", ["check"]);
step("typecheck", "pnpm", ["typecheck"]);
step("test", "pnpm", ["test"]);
step("build", "pnpm", ["build"]);

const pid = servicePid();
if (pid === null) {
  console.error(
    "\nbuilt, but the daemon is not a service yet, so nothing was restarted · run `pnpm service install` once",
  );
  process.exit(1);
}
console.log("\n▸ restart");
const r = spawnSync("launchctl", ["kickstart", "-k", TARGET], { stdio: "inherit" });
if (r.status !== 0 || !(await waitForDaemon(pid))) {
  console.error(`\n✗ the daemon did not come back · last lines of ${LOG}:\n${logTail()}`);
  process.exit(1);
}
const after = builtBuild();
const sha = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: REPO, encoding: "utf8" }).stdout.trim();
console.log(
  `\n✓ shipped ${sha} · pid ${servicePid()} · ${
    after === before
      ? "web build unchanged, no reload needed"
      : `web build ${after}, open pages will offer a reload`
  }`,
);
