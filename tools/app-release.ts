// Builds the desktop app, signs it, and hands it to the daemon to serve, so every installed copy updates itself:
// `pnpm app:release`. Installed copies ask on page load (at most every half hour) and from Sparring > Check for
// Updates (apps/desktop/src-tauri/src/main.rs).
//
// One universal build serves every Mac. It is made for the daemon's tailnet address (`SPARRING_DAEMON_URL`, or
// the first `.ts.net` name with a port in config.json's hosts); on the Mac mini the app finds the local daemon
// first. The files go to apps/web/public/app (gitignored), which `vite build` copies into the pages it serves,
// and into the current dist so the release is live at once:
//
//   Sparring_<version>.app.tar.gz   the build, for Tauri's updater plugin; signed with ~/.sparring/desktop-updater.key
//                                   (SPARRING_UPDATER_KEY to override), whose public half is in tauri.conf.json
//   updater.json                    the plugin's manifest, downloading from the tailnet address
//   updater-local.json              the same, downloading from loopback (the host reaches its daemon there)
//   Sparring.zip, latest.json       the same build for copies from before the plugin (a checksum swap): they
//                                   cross over to this build, and update with the plugin from then on
//
// Version: tauri.conf's major.minor and the 14-digit UTC build id as the patch (0.2.20261115053012). Old copies
// compare `build` in latest.json as a string of digits, so it stays 14 digits and only grows.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
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

const tauriConf = join(REPO, "apps/desktop/src-tauri/tauri.conf.json");
const [major, minor] = (JSON.parse(readFileSync(tauriConf, "utf8")) as { version: string }).version.split(
  ".",
);
const build = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const version = `${major}.${minor}.${build}`;
const url = daemonUrl();
const localUrl = `http://127.0.0.1:${loadConfig().port}`;
const keyPath = process.env.SPARRING_UPDATER_KEY ?? join(homedir(), ".sparring", "desktop-updater.key");
if (!existsSync(keyPath)) throw new Error(`no signing key at ${keyPath}`);

console.log(`▸ build ${version} for ${url}`);
const r = spawnSync(
  "pnpm",
  [
    "--filter",
    "@sparring/desktop",
    "exec",
    "tauri",
    "build",
    "--target",
    "universal-apple-darwin",
    "--config",
    JSON.stringify({ version, bundle: { createUpdaterArtifacts: true } }),
  ],
  {
    cwd: REPO,
    stdio: "inherit",
    env: {
      ...process.env,
      PATH: `${join(homedir(), ".cargo", "bin")}:${process.env.PATH ?? ""}`,
      SPARRING_DAEMON_URL: url,
      // Copies from before the plugin skip a build without it; this one does not need it, but keep it set.
      SPARRING_APP_BUILD: build,
      TAURI_SIGNING_PRIVATE_KEY: readFileSync(keyPath, "utf8"),
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD: process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? "",
    },
  },
);
if (r.status !== 0) process.exit(1);

const bundle = join(REPO, "apps/desktop/src-tauri/target/universal-apple-darwin/release/bundle/macos");
const signature = readFileSync(join(bundle, "Sparring.app.tar.gz.sig"), "utf8").trim();
// The plugin refuses a signature that does not name the announced version.
if (!Buffer.from(signature, "base64").toString("utf8").includes(`version:${version}`)) {
  throw new Error(`the signature does not carry version ${version}; check the Tauri CLI version`);
}

// SPARRING_RELEASE_OUT writes somewhere else and leaves the live pages alone, for a test on a scratch server. The
// manifests still name SPARRING_DAEMON_URL and the config's port, so point SPARRING_HOME at a scratch config whose
// port is the scratch server's, and set SPARRING_DAEMON_URL to it.
const scratchOut = process.env.SPARRING_RELEASE_OUT;
const out = scratchOut ?? join(REPO, "apps/web/public/app");
mkdirSync(out, { recursive: true });
const put = (name: string, from: string | Buffer) => {
  const part = join(out, `${name}.part`);
  if (typeof from === "string") copyFileSync(from, part);
  else writeFileSync(part, from);
  renameSync(part, join(out, name));
};

const tarball = `Sparring_${version}.app.tar.gz`;
put(tarball, join(bundle, "Sparring.app.tar.gz"));
const manifest = (base: string) => {
  const entry = { signature, url: `${base}/app/${tarball}` };
  const m = {
    version,
    notes: process.env.SPARRING_RELEASE_NOTES ?? "",
    pub_date: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    platforms: { "darwin-aarch64": entry, "darwin-x86_64": entry },
  };
  return Buffer.from(`${JSON.stringify(m, null, 2)}\n`);
};

// The crossover files for copies from before the plugin, written before the manifests point anywhere new.
const zipPart = join(out, "Sparring.zip.part");
rmSync(zipPart, { force: true });
const z = spawnSync("ditto", ["-c", "-k", "--keepParent", join(bundle, "Sparring.app"), zipPart], {
  stdio: "inherit",
});
if (z.status !== 0) process.exit(1);
renameSync(zipPart, join(out, "Sparring.zip"));
const sha256 = createHash("sha256")
  .update(readFileSync(join(out, "Sparring.zip")))
  .digest("hex");
put(
  "latest.json",
  Buffer.from(`${JSON.stringify({ build, sha256, size: statSync(join(out, "Sparring.zip")).size })}\n`),
);
put("updater.json", manifest(url));
put("updater-local.json", manifest(localUrl));

// Keep this tarball and the one before (a copy may be mid-download); older ones go. Ordered by the build id,
// never by name (0.10.x sorts before 0.9.x as text), and the one just released is never deleted.
const buildOf = (name: string) => Number(/\.(\d{14})\.app\.tar\.gz$/.exec(name)?.[1] ?? 0);
const older = readdirSync(out)
  .filter((n) => /^Sparring_.*\.app\.tar\.gz$/.test(n) && n !== tarball)
  .sort((a, b) => buildOf(b) - buildOf(a));
for (const old of older.slice(1)) rmSync(join(out, old));

const dist = join(REPO, "apps/web/dist");
if (!scratchOut && existsSync(dist)) {
  const live = join(dist, "app");
  mkdirSync(live, { recursive: true });
  // In the order a client needs them: what a manifest points at goes live before the manifest that points there.
  const order = (n: string) =>
    n.endsWith(".app.tar.gz")
      ? 0
      : n === "Sparring.zip"
        ? 1
        : n === "latest.json"
          ? 2
          : n === "updater-local.json"
            ? 3
            : 4;
  const names = readdirSync(out)
    .filter((n) => !n.endsWith(".part"))
    .sort((a, b) => order(a) - order(b));
  for (const name of names) {
    copyFileSync(join(out, name), join(live, `${name}.part`));
    renameSync(join(live, `${name}.part`), join(live, name));
  }
  for (const name of readdirSync(live)) {
    if (!existsSync(join(out, name))) rmSync(join(live, name), { force: true });
  }
}
console.log(
  `✓ released ${version} · installed copies pick it up within half an hour, or from Sparring > Check for Updates`,
);
