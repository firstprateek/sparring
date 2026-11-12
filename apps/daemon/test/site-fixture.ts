// A fixture copy of the site for the publish tests and for trying publish by hand with no network: a small
// Astro-shaped repo (posts in src/content/posts, a strict four-key front matter, `npm run build` writing
// dist/writing/<slug>/index.html and dist/rss.xml), a local bare repo as its origin, Sparring's clone of it at
// `<home>/site`, and a `gh` stub that records its arguments. Nothing here reaches GitHub.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const BUILD = `// The fixture's build: what the real site's \`astro build\` does to a post, in one file with no dependencies.
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
const url = /url:\\s*"([^"]+)"/.exec(readFileSync("src/site.config.ts", "utf8"))?.[1] ?? "";
const KEYS = ["title", "date", "description", "draft"];
rmSync("dist", { recursive: true, force: true });
const items = [];
for (const file of readdirSync("src/content/posts").sort()) {
  if (!file.endsWith(".md")) continue;
  if (file.startsWith("_") && !process.env.INCLUDE_FIXTURES) continue;
  const slug = file.slice(0, -3);
  const m = /^---\\n([\\s\\S]*?)\\n---\\n([\\s\\S]*)$/.exec(readFileSync("src/content/posts/" + file, "utf8"));
  if (!m) throw new Error(file + ": no front matter");
  const data = {};
  for (const line of m[1].split("\\n")) {
    const kv = /^([a-z]+): (.*)$/.exec(line);
    if (!kv) throw new Error(file + ": bad front matter line: " + line);
    data[kv[1]] = kv[2];
  }
  const keys = Object.keys(data);
  for (const k of keys) if (!KEYS.includes(k)) throw new Error(file + ": unrecognized key " + k);
  for (const k of KEYS) if (!keys.includes(k)) throw new Error(file + ": missing " + k);
  const d = new Date(data.date + "T00:00:00Z");
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== data.date) throw new Error(file + ": invalid date " + data.date);
  if (data.draft === "true") continue;
  const title = JSON.parse(data.title);
  mkdirSync("dist/writing/" + slug, { recursive: true });
  writeFileSync(
    "dist/writing/" + slug + "/index.html",
    '<!doctype html><html><head><link rel="canonical" href="' + url + "/writing/" + slug + '/"><title>' + title + "</title></head><body><h1>" + title + "</h1><pre>" + m[2].replace(/</g, "&lt;") + "</pre></body></html>",
  );
  items.push("<item><title>" + title + "</title><link>" + url + "/writing/" + slug + "/</link></item>");
}
writeFileSync("dist/rss.xml", '<?xml version="1.0"?><rss version="2.0"><channel><link>' + url + "/</link>" + items.join("") + "</channel></rss>");
console.log("built " + items.length + " pages");
`;

const GH = `#!/bin/sh
# A stand-in for gh: records each call in gh.log beside it and answers what Sparring reads. No network.
D="$(cd "$(dirname "$0")" && pwd)"
printf '%s\\n' "$*" >> "$D/gh.log"
body=""
prev=""
for a in "$@"; do
  [ "$prev" = "--body-file" ] && body="$a"
  prev="$a"
done
case "$1 $2" in
  "auth status")
    [ -f "$D/fail-auth" ] && { echo "You are not logged into any GitHub hosts." >&2; exit 1; }
    exit 0 ;;
  "repo view")
    echo '{"viewerPermission":"WRITE"}' ;;
  "pr create")
    [ -f "$D/fail-pr" ] && { echo "pull request create failed: the stub was told to fail" >&2; exit 1; }
    n=$(( $(cat "$D/pr.count" 2>/dev/null || echo 0) + 1 ))
    echo "$n" > "$D/pr.count"
    [ -n "$body" ] && cp "$body" "$D/pr-$n.body"
    echo "https://github.com/fixture-owner/fixture-site/pull/$n" ;;
  "pr edit")
    [ -n "$body" ] && cp "$body" "$D/pr-$3.body"
    echo "https://github.com/fixture-owner/fixture-site/pull/$3" ;;
  "pr view")
    if [ -f "$D/merged-$3" ]; then echo '{"state":"MERGED","mergedAt":"2026-11-11T10:00:00Z"}'
    elif [ -f "$D/closed-$3" ]; then echo '{"state":"CLOSED","mergedAt":null}'
    else echo '{"state":"OPEN","mergedAt":null}'; fi ;;
  *)
    echo "gh stub: unexpected call: $*" >&2; exit 2 ;;
esac
`;

export const FIXTURE_REPO = "fixture-owner/fixture-site";
export const FIXTURE_URL = "https://prose.fixture.test";

export interface SiteFixture {
  /** The Sparring home: the clone is `<home>/site`. */
  home: string;
  /** The bare repo that stands for GitHub. */
  bare: string;
  /** The folder with the `gh` stub; `path` puts it first. */
  bin: string;
  path: string;
  /** git in the bare repo; answers stdout, trimmed. */
  origin: (...args: string[]) => string;
  /** The branches origin has. */
  branches: () => string[];
  /** Every call the stub got, one line each. */
  ghCalls: () => string[];
  /** The body the stub was handed for PR `n`. */
  prBody: (n: number) => string;
  /** Makes `gh pr create` fail, or work again. */
  failPr: (on: boolean) => void;
  /** Merges PR `n`'s branch into main on origin and deletes the branch, as GitHub would. */
  merge: (n: number, branch: string) => void;
  /** Commits a change to a file on origin's main. */
  commitToMain: (path: string, text: string) => void;
}

/** Builds the fixture under `dir`. `placeholder` leaves the site config unfinished. */
export function siteFixture(dir: string, o: { placeholder?: boolean; home?: string } = {}): SiteFixture {
  const home = o.home ?? join(dir, "home");
  const bare = join(dir, "origin.git");
  const seed = join(dir, "seed");
  const bin = join(dir, "bin");
  const env = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: process.env.HOME ?? "/",
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@localhost",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@localhost",
    GIT_TERMINAL_PROMPT: "0",
  };
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  for (const d of [home, seed, bin, join(seed, "src/content/posts")]) mkdirSync(d, { recursive: true });
  const put = (path: string, text: string) => writeFileSync(join(seed, path), text);
  put(
    "package.json",
    `${JSON.stringify({ name: "fixture-site", private: true, version: "0.0.0", scripts: { build: "node build.mjs" } }, null, 2)}\n`,
  );
  put(
    "package-lock.json",
    `${JSON.stringify({ name: "fixture-site", version: "0.0.0", lockfileVersion: 3, requires: true, packages: { "": { name: "fixture-site", version: "0.0.0" } } }, null, 2)}\n`,
  );
  put(".gitignore", "node_modules/\ndist/\n");
  put("build.mjs", BUILD);
  put(
    "src/site.config.ts",
    `export const site = {\n  title: "Fixture",\n  url: "${o.placeholder ? "https://TODO-REPLACE-BEFORE-LAUNCH.example.com" : FIXTURE_URL}",\n};\n`,
  );
  put(
    "src/content/posts/hello.md",
    '---\ntitle: "Hello"\ndate: 2026-01-05\ndescription: "The first post."\ndraft: false\n---\n\nHello.\n',
  );
  git(seed, "init", "-q", "-b", "main");
  git(seed, "add", "-A");
  git(seed, "commit", "-q", "-m", "fixture site");
  git(dir, "clone", "-q", "--bare", seed, bare);
  git(dir, "clone", "-q", bare, join(home, "site"));
  writeFileSync(join(bin, "gh"), GH);
  chmodSync(join(bin, "gh"), 0o755);

  const read = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "");
  return {
    home,
    bare,
    bin,
    path: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    origin: (...args) => git(bare, ...args),
    branches: () =>
      git(bare, "for-each-ref", "--format=%(refname:short)", "refs/heads").split("\n").filter(Boolean).sort(),
    ghCalls: () => read(join(bin, "gh.log")).split("\n").filter(Boolean),
    prBody: (n) => read(join(bin, `pr-${n}.body`)),
    failPr: (on) => {
      if (on) writeFileSync(join(bin, "fail-pr"), "");
      else rmSync(join(bin, "fail-pr"), { force: true });
    },
    merge: (n, branch) => {
      git(bare, "update-ref", "refs/heads/main", `refs/heads/${branch}`);
      git(bare, "update-ref", "-d", `refs/heads/${branch}`);
      writeFileSync(join(bin, `merged-${n}`), "");
    },
    commitToMain: (path, text) => {
      git(seed, "pull", "-q", bare, "main");
      mkdirSync(join(seed, path, ".."), { recursive: true });
      writeFileSync(join(seed, path), text);
      git(seed, "add", "-A");
      git(seed, "commit", "-q", "-m", `change ${path}`);
      git(seed, "push", "-q", bare, "main");
    },
  };
}
