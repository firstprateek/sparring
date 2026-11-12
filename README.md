# Sparring

A writing coach that lives in the margin. You give it rough ideas, it interviews you, and then it critiques while you write the article yourself. The page is the article. The coach never writes it, with one explicit exception you have to ask for.

**Status: in progress.** Steps 0 to 3 of the build order in [docs/design.md](docs/design.md) work: the daemon, login, the Articles screen, the room and the interview with a real Claude coach. Notes, passes, "send it" and publishing come next.

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
