# Sparring

A writing coach that lives in the margin. You give it rough ideas, it interviews you, and then it critiques while you write the article yourself. The page is the article. The coach never writes it, with one explicit exception you have to ask for.

**Status: in progress.** Steps 0 to 8 of the build order in [docs/design.md](docs/design.md) work: the daemon, login, the Articles screen, the room, the interview with a real Claude coach, notes (`/critique` leaves notes anchored to your text, which you fix, disagree with or dismiss, and `/reader` has the coach read as your reader), and every stage and pass: the outline check, `/next` and `/ask` while drafting, `/pass filler` and the other passes from `~/writing/passes/`, `/queue` to run several with the page closed, `/strict` and `/quiet`. "Send it" works too: `send it` in the stage menu (or `/sendit`) has the coach write one draft from your dump and brief, a dotted bar marks each block that is still its words, the head says how much is yours, your old page waits on the shelf, and `coached again` puts it back. The foot of the article counts three tells (em-dashes, one-sentence paragraphs, "it's not X, it's Y") and a count opens the Tells table; words pasted from the coach keep a dotted underline until you rewrite them, and `pasted` counts them. Publishing is built: `publish →` in the stage menu (or `/publish`) opens the publish sheet, which checks the article, asks for a tick on each run of the coach's words, builds the site with the post and opens a pull request. It has only run against a fixture site so far; the section "Publishing" below lists what to set before the first real one. The nightly backup comes next.

## How it is meant to work

- One small daemon runs on a machine you own and holds every article as plain Markdown in a git repo.
- You reach it from a laptop or a phone over the Agent Host Protocol (AHP).
- The coach is any coding agent that speaks the Agent Client Protocol (ACP). Version one uses Claude.
- The coach can read your text and leave notes. It has no tool that edits the page.
- "Send it" is the exception: the coach writes one draft, every block it wrote stays marked until you rewrite it, and the page shows how much is yours.
- A finished article goes out as a pull request to an Astro site.

## Running it

```bash
pnpm install
pnpm dev
```

`pnpm dev` builds the web client and starts the daemon on `http://127.0.0.1:7421`. The login token is in `~/.sparring/config.json`. To log in a new device without copying the token, run `pnpm login-code` on the daemon's machine: it prints a code that works once and lapses in ten minutes.

### Keeping it running and up to date

On the machine that serves it, run the daemon as a launchd service, so it starts at login and again if it dies:

```bash
pnpm service install
```

`pnpm service status` says whether it runs and which web build it serves; `pnpm service uninstall` stops it. Its output goes to `~/Library/Logs/sparring-daemon.log`.

To update, push to GitHub, then on that machine:

```bash
pnpm ship
```

It refuses uncommitted changes, pulls, installs, runs lint, typecheck and the tests, builds, and restarts the service. It stops at the first failure, so a failing test never reaches the running daemon. `pnpm ship --no-pull` ships what is checked out. Open pages notice the new build within a minute and offer "sparring was updated · reload"; the Room saves first, and waits if something could not be kept. The desktop app needs no update for this: it loads its pages from the daemon.

### Publishing

Publishing turns one reviewed commit of an article into a pull request on the Astro site. It is off until the machine and the site are set up, and the publish sheet says in red what is missing. Nothing below has been run against the real site yet.

1. In `~/.sparring/config.json`, set the site repo and the author of the post commits. The daemon reads these each time the sheet opens, so no restart is needed.

   ```json
   {
     "site_repo": "<owner>/<name>",
     "publish": { "git_name": "<your name>", "git_email": "<your email>" }
   }
   ```

2. Give Sparring its own clone of the site. The daemon never clones by itself, and it only ever pushes branches named `post/<slug>`.

   ```bash
   git clone git@github.com:<owner>/<name>.git ~/.sparring/site
   ```

3. On the site's `main`, replace every placeholder in `src/site.config.ts` with the real domain, including the lowercase `url`. The sheet refuses while that file matches `todo-replace-before-launch`, and the build gate refuses a canonical link or a feed link on `example.com`.

4. Log `gh` in on the daemon's machine (`gh auth login`). The sheet checks `gh auth status` and that `gh repo view <owner>/<name> --json viewerPermission` says WRITE or ADMIN. Node 22.12 or newer, `npm`, `gh` and `git` must be on the daemon's `PATH`; `pnpm service install` writes that `PATH` into the launchd job.

5. Run the two open checks from the design (rows M2 and M3 of step 0) and note the results in `docs/adapters.md`.

   M2, can a launchd job reach the site remote? It must print `exit 0`:

   ```bash
   launchctl submit -l app.sparring.m2 -o /tmp/sparring-m2.log -e /tmp/sparring-m2.log -- /bin/sh -c 'GIT_TERMINAL_PROMPT=0 GIT_SSH_COMMAND="ssh -o BatchMode=yes" git -C "$HOME/.sparring/site" ls-remote --exit-code origin refs/heads/main; echo "exit $?"'
   sleep 10; cat /tmp/sparring-m2.log; launchctl remove app.sparring.m2
   ```

   If ssh cannot do that from launchd, switch the clone to https, and Sparring takes the credential from `gh` for every fetch and push:

   ```bash
   git -C ~/.sparring/site remote set-url origin https://github.com/<owner>/<name>.git
   ```

   M3, does the site keep raw HTML? Build a post with a `<script>` in a scratch clone and look for it. Sparring refuses raw HTML in a post either way.

   ```bash
   git clone ~/.sparring/site /tmp/site-m3 && cd /tmp/site-m3
   printf -- '---\ntitle: "m3"\ndate: 2026-01-01\ndescription: "m3"\ndraft: false\n---\n\nBefore <script>alert(1)</script> after.\n' > src/content/posts/m3-probe.md
   npm ci && npm run build && grep -c "<script>alert" dist/writing/m3-probe/index.html
   cd / && rm -rf /tmp/site-m3
   ```

6. The first real publish is the "try" of step 8 in the design: publish a throwaway post, check `dist/writing/<slug>/index.html` and the RSS line in the PR, then close the PR unmerged. Merging is always your click. Turn on "Automatically delete head branches" in the site repo.

Each publish writes its log to `~/.sparring/logs/publish-<id>.log` and the PR description it sent to `publish-<id>.pr.md` beside it. To try the whole thing with no network, `apps/daemon/test/site-fixture.ts` builds a fixture site with a local bare origin and a `gh` stub; `apps/daemon/test/step8.test.ts` shows how it is wired.

### Desktop app

[apps/desktop](apps/desktop) is a Tauri shell around the daemon. It needs Rust (`rustup`). Its launcher page asks for the daemon's address and then loads the daemon's own pages, so the app is the web client in its own window. On the machine that runs the daemon it reads the token from `~/.sparring/config.json` and skips the login form. **Sparring → Change Daemon…** goes back to the launcher.

```bash
pnpm --filter @sparring/desktop build
```

The app lands in `apps/desktop/src-tauri/target/release/bundle/macos/Sparring.app`.

For another Mac, such as a laptop on the tailnet, build a universal app that opens on the daemon's tailnet address, then log in once with the token:

```bash
SPARRING_DAEMON_URL=https://<mac-mini>.<tailnet>.ts.net:7443 pnpm --filter @sparring/desktop build:universal
```

That build lands under `target/universal-apple-darwin/`. It is signed ad hoc, so copy it with `scp` rather than through a browser, or clear the quarantine flag with `xattr -dr com.apple.quarantine`.

## What is here

| Path                                                             | What                                                                                               |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| [docs/design.md](docs/design.md)                                 | The design document: workflow, architecture, drafted mode, data model, build steps, open decisions |
| [docs/ui-spec.md](docs/ui-spec.md)                               | The UI specification                                                                               |
| [docs/drafted-mode-mock-spec.md](docs/drafted-mode-mock-spec.md) | The brief the "send it" mocks were built from                                                      |
| [apps/daemon](apps/daemon)                                       | The daemon: AHP host, REST, coach process, git-backed articles                                     |
| [apps/web](apps/web)                                             | The web client the daemon serves                                                                   |
| [apps/desktop](apps/desktop)                                     | The Tauri desktop shell                                                                            |
| [mocks/](mocks/)                                                 | Clickable HTML mocks: articles, room, publish, phone, phone interview                              |

To try the mocks, open `mocks/index.html` in a browser. They are static pages with sample data and talk to nothing.

## Background

- Bryan Cantrill, [Your intellectual fly is open](https://bcantrill.dtrace.org/2025/12/05/your-intellectual-fly-is-open/)
