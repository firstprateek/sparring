// Builds the desktop app and hands it to the daemon to serve, so every installed copy updates itself:
// `pnpm app:release`. The app asks the daemon for `/app/latest.json` when a page loads; a newer build there is
// downloaded, checked against the hash, and put in the app's place (apps/desktop/src-tauri/src/main.rs).
//
// One universal build serves every Mac. It is made for the daemon's tailnet address (`SPARRING_DAEMON_URL`, or
// the first `.ts.net` name with a port in config.json's hosts); on the Mac mini the app finds the local daemon
// first. The files go to apps/web/public/app, which `vite build` copies into the pages it serves, and into the
// current dist so the release is live at once.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../apps/daemon/src/config.ts";
import { REPO } from "./service.ts";

function daemonUrl(): string {
  if (process.env.SPARRING_DAEMON_URL) return process.env.SPARRING_DAEMON_URL;
  const host = loadConfig().hosts.find((h) => /\.ts\.net:\d+$/.test(h));
  if (!host) throw new Error("no tailnet host in config.json · set SPARRING_DAEMON_URL");
  return `https://${host}`;
}

const build = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const url = daemonUrl();
console.log(`▸ build ${build} for ${url}`);
const r = spawnSync("pnpm", ["--filter", "@sparring/desktop", "build:universal"], {
  cwd: REPO,
  stdio: "inherit",
  env: {
    ...process.env,
    PATH: `${join(homedir(), ".cargo", "bin")}:${process.env.PATH ?? ""}`,
    SPARRING_DAEMON_URL: url,
    SPARRING_APP_BUILD: build,
  },
});
if (r.status !== 0) process.exit(1);

const app = join(
  REPO,
  "apps/desktop/src-tauri/target/universal-apple-darwin/release/bundle/macos/Sparring.app",
);
const out = join(REPO, "apps/web/public/app");
mkdirSync(out, { recursive: true });
const zip = join(out, "Sparring.zip");
const z = spawnSync("ditto", ["-c", "-k", "--keepParent", app, zip], { stdio: "inherit" });
if (z.status !== 0) process.exit(1);
const sha256 = createHash("sha256").update(readFileSync(zip)).digest("hex");
const latest = `${JSON.stringify({ build, sha256, size: statSync(zip).size })}\n`;
writeFileSync(join(out, "latest.json"), latest);

const dist = join(REPO, "apps/web/dist");
if (existsSync(dist)) {
  mkdirSync(join(dist, "app"), { recursive: true });
  copyFileSync(zip, join(dist, "app", "Sparring.zip"));
  writeFileSync(join(dist, "app", "latest.json"), latest);
}
console.log(
  `✓ released build ${build} · installed copies pick it up within half an hour, or from Sparring > Check for Updates`,
);
