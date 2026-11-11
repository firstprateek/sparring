# Sparring: a writing coach in the margin

Design document, revised 2026-11-10. Build from this.

## 1. What it is

Sparring is a single-user tool for writing articles with an AI sparring partner that asks, flags and argues. You open a chat from your phone or laptop (any AHP client, the built-in web client first), dump rough ideas, get interviewed, write the piece in your own words in a plain Markdown file, run named critique passes over it, and publish the result as a pull request (PR) against `personal-website-astro`.

The daemon is a trimmed i-inc AHP host. AHP is Microsoft's Agent Host Protocol, the channel between clients and the daemon. The brain is an agent that speaks ACP, the Agent Client Protocol. This document calls that agent the coach. Version one has two engines, `claude` and a scripted `demo` coach, fixed per article at creation.

Every article has an authorship mode, `coached` or `drafted`. The UI shows it as `mode · coached`. The field is `articles.authorship`.

**Coached is the default. Its principle: the owner writes every sentence.** It is held at three levels.

- Protocol. The coach session starts with zero built-in tools. Everything it reads comes through the Sparring MCP server (MCP is the Model Context Protocol), and the host rejects every permission request that is not a Sparring tool. The daemon is the only writer of `article.md`.
- Prompt. The rules in section 5 tell the coach to point and never to phrase.
- Publish. The sheet checks the final text against everything the coach said, with a 5-word overlap check.

**Drafted is the one exception.** The owner says "send it" and confirms. The coach then writes the draft once, through one `write_draft` call that the daemon applies under a single-use grant. After that call never-write applies again. The tool says what happened: the status strip reads `never-write is off for this article`, every block the coach wrote is marked until the owner rewrites it, and Publish asks for an "I chose these words" tick on each block that is still entirely the coach's. Only a confirmed action from an authenticated client makes the flip. Section 4 has the mechanics.

Cantrill is the brief (LLMs are "astonishingly good editors" and "lousy writers"); Ptacek is the method: no copy, no encouragement, one pass at a time, flag only what the writer can verify.

The coach's remarks are called notes. They are rows in the `comments` table, left with the `comment` tool. Notes and comments are the same thing.

Decisions that follow:

- No grammar auto-fix. Typos come back as notes that say where and what is wrong.
- The tool inserts no disclosure line. Provenance numbers show on the publish sheet and go in the PR description in both modes, never in the post body, the frontmatter or the commit message. You type a disclosure line yourself if you want one.
- The half-remembered article is assumed to be Ptacek's "How to Write with an LLM", flagged again in section 11.

## 2. The workflow, stage by stage

Stages are a stepper, not gates. There are six: ideas, interview, outline, draft, critique, polish. Publish is a sheet, opened from `publish →` in the stage menu or with `/publish`. Any pass or question works from any stage. The stage only changes the host's prompt prefix and what the UI puts in front. Only Publish has hard checks.

**Commands.** The composer lists `/next /ask /critique /reader /pass /queue /strict /quiet /sendit /publish`. `/offline` is also accepted, and `/idea <text>` in any article's composer appends to the inbox. Notes take typed actions that their buttons also emit: `done c08`, `dismiss c11`, `dismiss c11 on purpose`, `re c09: …`. `mute c11` is a typed synonym of `dismiss c11 on purpose`. The host intercepts all of these before anything reaches the coach. Section 3 has the routing.

**Two switches.** `/quiet` means the coach holds its notes: the margin collapses and the foot shows `quiet`. The coach still answers when spoken to. `/quiet` toggles; `/critique` or `/pass` also ends it. `/offline` means no agent is spawned for the article at all. The editor, the tells counts and Publish still work.

**Send it.** It can be invoked in four places: the Room stage menu (after the stage list, before `publish →`), `/sendit` in the composer, the phone stage menu, and the phone interview header (`interview N/6 ▾`). Section 4 has the rest.

### Ideas

`~/writing/inbox.md` is the inbox. `/idea <text>` in any article's composer, or the idea box on Articles (`POST /api/inbox`), appends a timestamped line. "New article from idea" creates `~/writing/<slug>/` and seeds `dump.md`. The tool never rewrites `dump.md`. Its first commit is kept as the voice sample, and you may edit it afterwards.

Agent does: reply with at most eight bullets that quote you, then one question: "Which of these is the thing you want to say?" The stage prompt asks for this shape; nothing validates streamed chat.
Agent does not: summarize for publication, propose a title, propose an angle.
In drafted mode: send it works once `dump.md` has text. The draft comes from the dump alone.

### Interview

Six topics, each with its question:

- Thesis: "Say the claim in one sentence, your words."
- Reader: "Who exactly reads this, and what do they lose if they don't?" (McEnerney)
- Evidence: "What did you see first-hand that makes you believe it? Name the incident."
- Counter: "What would the smartest person who disagrees say?"
- Uncertainty: "Which part are you least sure of?"
- Scar: "What did you get wrong along the way?" (softwaredoug's anti-triumphalism)

One question per turn, unless you ask for more. When an answer covers a topic the coach calls `note_brief({topic, quote, question?})`. The quote must be an exact substring of `dump.md` or of one of your messages. The stage word `interview N/6` counts the distinct topics noted, and the stage menu shows which ones.

The interview ends when the coach can restate thesis, reader and arc using only your sentences. It says so and stops (`interview done · brief.md is yours`). You write `brief.md` (thesis, reader, arc) yourself.

Agent does: ask, quote you back, say when a fork or a missing fact needs a decision and stop (glub's STOP rule).
Agent does not: write the brief, suggest a structure, offer a list of options.
In drafted mode: send it mid-interview is allowed, and `brief.md` may be empty. The draft turn then carries your interview answers verbatim and a line naming the topics not yet covered.

### Outline

You type `##` headings with a one-line note under each. The coach runs a reverse-outline check: what does the reader know after this section that they did not before, which brief line does it serve, where does the counter-argument live, which sections explain your process instead of the reader's problem.

Agent does not: propose headings or an order. "What should section 3 be?" is answered with a question.
In drafted mode: the draft is built from `dump.md` and `brief.md`. An outline on the page goes to the shelf with the page.

### Drafting

The default is quiet: the coach speaks when spoken to. `/next` paces you ("Write the section under *Why the cache lied*. Ugly is fine. Say done when it is in the file."). On done, the host hands over the diff and the coach leaves at most five anchored notes on that section. `/ask <question>` parks a question at the caret. The answer lands as a note anchored to that paragraph.

Agent does: point at an unclear referent, an unsupported claim, hand-waving, a missing lived detail, the place where the named reader stops.
Agent does not: phrase anything, or fill a gap you stalled on.
In drafted mode: a draft lands here, and the review is yours alone. `/next` and `/ask` get a short chat reply and no notes.

### Critique

`/critique` is an argument-level pass over the whole draft: continuity, smuggled assumptions, the strongest counter-argument not addressed, claims without evidence, paragraphs about you rather than the reader. At most ten items, each citing a brief line or "(no brief line)". `/reader` role-plays the reader named in the brief.

In drafted mode: `/critique` ends the quiet. Note marks sit beside the provenance bars.

### Polish

Named passes, one per turn, each locked to its lens. Pass prompts are Markdown files in `~/writing/passes/` and you can edit them. Built in: `filler`, `buried-verbs`, `passive`, `repeats`, `topic-sentences`, `cut`, `voice` (questions only), `typos` (location and what is wrong, never the fix), `tells` (advisory, ends with the false-positive caveat). `/strict` sets the strictness line in every pass header: `howlers only`, `normal` or `every nit`. An empty result is the mandated "nothing in this pass", then stop. `/queue filler repeats cut` adds the passes to the host's turn queue and runs them unattended as separate turns.

Agent does: flag with the evidence in the text.
Agent does not: rewrite, tone down, or smooth fragments, lowercase, slang or deliberate rule-breaking.
In drafted mode: `/pass` ends the quiet the same way. Passes run unchanged, the coach's blocks included.

### Publish

The host runs the sheet, not the coach. You type the title, a one-sentence description and the date. The slug was fixed at creation and is shown. The host asks three cold questions once and stores the answers without publishing them: `what did you learn writing this?`, `would you say this to a friend?`, `who is this for and what do they lose?` The sheet shows the provenance numbers. Then build, branch and PR (section 3).

Each span that overlaps the coach's words (coached) or each block still entirely the coach's (drafted) needs the "I chose these words" tick or a rewrite. Sections 3 and 4 have the gates.

## 3. Architecture

### Processes and reach

One Bun 1.4.2 process, `apps/daemon`, listens on `127.0.0.1:7421`. `Bun.serve` routes three things. `/ahp` passes `transport.guard` and upgrades to the AHP WebSocket. `/api/*` is REST. Everything else serves the Vite build of the web client. The daemon runs on the owner's Mac mini (open decision, section 10).

The phone reaches it through plain `tailscale serve --bg` pointed at `127.0.0.1:7421`. It is turned on in step 2, so later steps are tried on the phone. Never `tailscale funnel`. Tailscale limits who can connect; the token is still the only login. launchd comes last, and its plist sets a `PATH` that finds `bun`, `node`, `npm` and `gh`.

Keepalive: the host pings every 25 s and closes a client that stays silent for 90 s. Bun closes an idle socket at 60 s. A reconnecting client replays from its last `serverSeq`. The host is built with `limits: {maxConnections: 8}`.

A second listener is the Unix socket `~/.sparring/daemon.sock`, mode 0600 inside a 0700 directory. It carries the MCP proxy traffic only. Nothing MCP-related is served on port 7421.

### Auth

There is one token: 32 random bytes generated on first run and kept in `~/.sparring/config.json` (mode 0600, in a 0700 directory). The daemon refuses to start if that file is readable by group or world, or if its `hosts` list is empty.

- **Login.** `POST /api/login` with the token in the JSON body. The token never travels in a URL. The reply sets `sparring=<hex HMAC-SHA256(token, "cookie-v1")>; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`, plus `Secure` when the Host is not loopback. The cookie never holds the token. Five failed logins a minute are allowed, no more.
- **WebSocket.** The `/ahp` upgrade accepts the cookie or `Authorization: Bearer <token>`. Scripts use the header. `deferredAuth` stays off in version one.
- **Host and Origin.** The lifted `auth.ts` checks both against allow-lists. `hosts` holds `127.0.0.1:7421`, `localhost:7421` and the machine's tailnet name. A wrong Host gets 421. A cross-site Origin gets 403.
- **REST guard.** Lifted from i-inc (section 8). Every `/api/*` request passes the Host list and needs the cookie or the bearer header. Every non-GET request also needs an allowed Origin (or `Sec-Fetch-Site: same-origin`) and `Content-Type: application/json`.
- **Logs.** Request bodies, `authorization` and `cookie` headers and `authenticate` frames are never logged.

### The coach process

Each article has its own coach: one ACP child process, spawned on the article's first prompt. The provider is fixed per article at creation.

| engine | command | env | notes |
|---|---|---|---|
| `claude` | `~/.sparring/adapters/claude/node_modules/.bin/claude-agent-acp` | `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_AGENT_ACP_PROTOCOL=v1` | `@agentclientprotocol/claude-agent-acp`; needs Node 22 or later on `PATH` |
| `demo` | in-process scripted coach | none | no tokens; tests and UI work run against it. It calls the daemon's tool handler directly with its session secret, emits `tool_call` updates named `mcp__sparring__<tool>`, and sends a `session/request_permission` with `allow_once` and `reject_once` options before each, plus one for a built-in `Edit` |

Codex, OpenCode and Gemini are Later (section 9).

**Adapter pin.** The pin is the version step 0 last passed on. The daemon installs that exact version with a lockfile under `~/.sparring/adapters/<engine>/`. Never `npx`, never `latest`. Every adapter claim in this document was read on `claude-agent-acp` 0.101.0. Version 0.106.0 moves files the guard depends on, so step 0 is run again before the pin moves.

**Spawn.** `node:child_process.spawn(cmd, args, {cwd: articleDir, stdio: ["pipe","pipe","pipe"], env})`. The wire is newline-delimited JSON-RPC through the lifted `acp-connection.ts`, which answers any agent request the host has not registered with -32601. The child's env is an allow-list: `PATH`, `HOME`, `LANG`, `TMPDIR`, `CLAUDE_CONFIG_DIR`, the model credential and `CLAUDE_AGENT_ACP_PROTOCOL=v1`. It never gets `SSH_AUTH_SOCK`, `GH_TOKEN`, `GITHUB_TOKEN` or the Sparring token. Every path is absolute; the host expands `~` before spawn.

**Credentials.** The model credential is a subscription token from `claude setup-token`, stored in `~/.sparring/config.json` as `claude_oauth_token` and passed as `CLAUDE_CODE_OAUTH_TOKEN` (open decision, section 10). Without a credential `session/new` still succeeds; the adapter sends `_auth/status_update {kind: "none"}` and the first `session/prompt` fails with -32000 (probe, 0.101.0). Either one makes the Room show `sign-in needed · claude`, and the article behaves as if `/offline` were on.

**Handshake.**

1. `initialize{protocolVersion: 1, clientCapabilities: {fs: {readTextFile: false, writeTextFile: false}, terminal: false}, clientInfo: {name: "sparring", version}}`. `elicitation` is left out, so the coach asks its questions in plain text.
2. `session/new{cwd, mcpServers, systemPrompt, _meta}`.
3. Read `modes.currentModeId` from the result. If it is not `default`, send `session/set_mode{sessionId, modeId: "default"}`. If it still is not, do not prompt; show `engine refused ask mode`.

```
mcpServers:   [{ name: "sparring", command: process.execPath,
                 args: [<abs packages/mcp/src/server.ts>],
                 env: [{ name: "SPARRING_MCP_SOCK",   value: <abs ~/.sparring/daemon.sock> },
                       { name: "SPARRING_MCP_SECRET", value: <random, per session> }] }]
systemPrompt: { mode: "append", content: [{ type: "text", text: RULES.md + STYLE.md }] }
_meta:        { disableBuiltInTools: true,
                claudeCode: { options: { tools: [], allowDangerouslySkipPermissions: false,
                  disallowedTools: ["Bash","Write","Edit","NotebookEdit","WebFetch","WebSearch","Agent","Task"],
                  settingSources: ["user"], strictMcpConfig: true } } }
```

A stdio `mcpServers` entry has no `type` key, and `env` is a required array of `{name, value}`. `systemPrompt` is sent only when the agent advertises `agentCapabilities.sessionCapabilities.systemPrompt`; otherwise the same text is the first prompt block (section 5).

**Lifecycle.** A child is killed when it is idle: no turn running, the article's queue empty, and 15 minutes since the last turn ended. A child with a turn in flight is never idle-killed. Each child is a process-group leader with a pid file at `~/.sparring/run/<article_id>.pid`; on start the daemon kills every recorded group. A turn has a hard limit of 10 minutes, then `session/cancel`, then the group is killed. `turns.status` is `running`, `done`, `interrupted` or `failed`. Rows still `running` when the daemon starts become `interrupted`, with the host line `the coach was interrupted · ask again`.

**Continuation brief.** A new child knows nothing, so its first prompt opens with a brief the host builds: the stage, `brief.md`, `STYLE.md`, the open note ids, every writer message from the ideas and interview stages in full, and the last six turns of the current stage with coach messages cut to 600 characters. `session/load` is Later.

### The guard

Never-write is enforced in three layers.

1. **Settings.** `CLAUDE_CONFIG_DIR` is the isolated `~/.sparring/claude`. The host writes its `settings.json` on first run and checks it on every start:

   ```json
   {"permissions": {"defaultMode": "default", "disableAutoMode": "disable",
     "disableBypassPermissionsMode": "disable", "allow": ["mcp__sparring"],
     "deny": ["Bash","Write","Edit","NotebookEdit","WebFetch","WebSearch","Agent","Task"],
     "blockReadsOutsideWorkingDirectories": true}}
   ```

   With no setting the adapter starts in `auto`, where edits never reach the host. A `current_mode_update` away from `default` is a violation: the host sets the mode back and ends the turn.
2. **Zero built-in tools.** The `_meta` above starts the session with an empty tool list. `settingSources` and `strictMcpConfig` keep project and local settings files from adding tools or allow rules.
3. **`policy.ts` and the tripwire.** `policy.ts` answers every `session/request_permission`. A request is a Sparring call when `toolCall._meta.claudeCode.mcpServer.name` is `sparring`; the `mcp__sparring__` name prefix is the fallback. A Sparring call gets the offered option of kind `allow_once`. Everything else is rejected with the first offered option of kind `reject_once`, else `reject_always`, else `{outcome: {outcome: "cancelled"}}`. The host never answers `allow_always`, and never sends an `optionId` that is not in `params.options`, because the adapter throws on one.

**Step 0** (section 9) proves these layers on the pinned adapter before anything else is built.

**Tripwire.** The host hashes `article.md` before and after each turn. A change that no recorded save explains is committed to `refs/sparring/quarantine/<slug>`, the file is restored from the pre-turn commit (`turns.commit_before`), and the letter shows `article.md changed outside a save · quarantined as article.agent.md · restore it`. The file name in that line stands for the text held at the ref; no such file is written. `restore it` calls `POST /api/articles/:slug/letter/:id {action: 'restore'}`: the daemon commits the current page, then puts the quarantined text back. There is no diff card. The daemon's own `write_draft` write is recorded as a save and does not fire it.

### The article file is the source of truth

`~/writing` is a git repo and `<slug>/article.md` in it is the article. Article text is never stored in SQLite. vim, Obsidian and the web client all edit the same file.

- **Save.** The client sends `PUT /api/articles/:slug/article {text, base_sha}` after 2 s without typing. `base_sha` is the SHA-256 hex of the file's UTF-8 bytes as the client last loaded or saved it. On a match the daemon writes atomically (temp file, fsync, rename) and returns `{sha, commit}`. On a mismatch it writes nothing and answers 409 with `{disk_sha, disk_text}`, and the client shows `disk changed while offline · keep mine · take disk`. Keep mine sends the text again with `base_sha = disk_sha`. Take disk first calls `POST /api/articles/:slug/stash`, which commits the local text to `refs/sparring/stash/<slug>`, then loads the disk text.
- **No watcher.** Nothing watches the folder in version one. An edit made in vim is caught by the `base_sha` check on the next save, and the coach always reads the file.
- **Commit.** The daemon commits on Cmd+S, at turn start, on stage change, before any restore, and otherwise at most once a minute. Every operation that replaces `article.md` commits the current content first. The turn-start commit is a real commit stored as `turns.commit_before`, so `git log` of an article interleaves with its chat.
- **Git queue.** All git work goes through one serialized in-process queue. Commits name their path (`git commit -m <msg> -- <slug>/article.md`). A held `index.lock` is retried three times and never deleted.
- **Offline.** The client keeps `{text, base_sha, dirty}` per article in localStorage and replays it on reconnect only when `dirty`. While a save is failing the foot reads `unsaved · retrying`.
- **Disk full.** A save that cannot be written returns 507 and the foot reads `disk full · not saved`.

### MCP surface

`packages/mcp` is a thin stdio proxy with no database access. It forwards each tool call as JSON over the Unix socket and returns the reply. On start it sends one `{secret, hello: true}` line, so the daemon sees the proxy connect before any tool call. The daemon maps `SPARRING_MCP_SECRET` to the article, so no tool takes a slug. All validation and every write happen in the daemon. Six tools and nothing else:

- `read_article()` returns the text with line numbers.
- `read_source({name})`. `name` is `dump`, `brief`, `style` or `pass:<id>`. It reads `dump.md`, `brief.md`, `STYLE.md` and pass files only.
- `comment({anchor, kind, body, pass, brief_line?, file?})` leaves a note. `kind` is one of `unclear`, `unsupported`, `counter`, `detail`, `filler`, `voice`, `typo`, `tell`. `anchor` is stored as `comments.span`, and the text of the block that holds it as `block_orig`. `brief_line` names the brief line a critique item serves, and `file` is the article unless given. `anchor` must be an exact substring of the current article, else the call fails with `quote the text exactly`. `body` is at most 280 characters. Every double-quoted span in `body` must be an exact substring of `article.md`, `dump.md`, `brief.md` or an owner chat message, and a quote that follows `consider:`, `try:`, `rewrite:` or `e.g.` is refused. Unquoted explanation is allowed; the overlap check covers it.
- `resolve_comment({id, action, body?})`. `action` is `withdraw` or `sharpen`. A sharpened `body` passes the same rule.
- `note_brief({topic, quote, question?})`. `topic` is one of `thesis`, `reader`, `evidence`, `counter`, `uncertainty`, `scar`. `quote` must be an exact substring of `dump.md` or an owner chat message. `question` is one line, at most 200 characters, with no leading `#` or `>`. At most 12 entries per article. The daemon appends the quote to `brief.md` under `## Quotes` and the question under `## Questions`, then bumps `commentsRev`. The client refetches the snapshot and, when its brief leaf is not dirty, takes the new text and `sha`.
- `write_draft({blocks: string[]})` is refused without a live single-use grant, with the letter line `write refused · the coach tried to edit article.md · logged`. Section 4 has the rest.

**How a note reaches the chat.** The `comment` call travels through the lifted `TurnMapper` as an ordinary tool call. Its name is shown without the `mcp__sparring__` prefix and its result content is the note as text: span, body and id. Any AHP client therefore sees every note. The daemon writes the `comments` row and bumps `_meta.sparring.commentsRev`, which goes out with `session/metaChanged` (section 6).

### Prompt assembly and host-intercepted input

For each writer message that goes to the coach, `coach.ts` builds the `session/prompt` blocks in this order:

1. A header: `<sparring stage="draft" pass="" strictness="normal" words="840" commit="abc123" open_comments="c12,c15">`.
2. The stage prompt from `prompts/stages/<stage>.md`.
3. The pass prompt when a pass runs. The host inlines it from `~/writing/passes/`.
4. A unified diff of `article.md` since the agent last saw it, or the full text when the agent has never seen it and it is under 4,000 words.
5. The message.

Stage, pass and strictness are the three host-owned AHP config keys (section 6). `coach.setConfig` handles them itself and never forwards them. No MCP tool and no ACP notification can change stage, authorship, quiet or provider.

**Interception.** Every composer line is an ordinary `chat/turnStarted`, so any AHP client sees it. The host parses the first line of each client-originated turn before anything is sent to the agent. The parser is called from `startClientTurn`, the one place that direct messages and drained queued messages both pass, and `coach.runTurn` acts on its result. It never runs on agent text, tool results, `dump.md`, `brief.md` or pass files.

- **Host-only.** `/idea`, `/quiet`, `/offline`, `/strict`, `/stage`, `/mute` and the note actions `done c08`, `dismiss c11`, `dismiss c11 on purpose` and `mute c11`. The host acts, answers with one SystemNotification response part and returns `{kind: 'complete'}`. The ACP child is not started. `/stage <name>` sets the stage. `dismiss c11 on purpose` dismisses the note, sets `comments.muted` and appends the span to `STYLE.md` under `## Do not flag`. `mute c11` and `/mute c11` are the same action.
- **Rewritten.** `/critique`, `/pass`, `/next`, `/ask`, `/reader` and `re c09: ...` become prompt text and go out as `session/prompt`. `/ask` carries the block at the caret.
- **Queue.** `/queue a b c` adds three `chat/pendingMessageSet` entries of kind queued, each with the text `/pass a`, and calls `host.resumeChat`. There is no queue table.
- **Client.** The web client handles `/sendit`, `/publish` and `/log` in the composer. They open the confirm line, the sheet and the transcript, and no turn is sent. When one of them arrives from another AHP client, the host treats it as host-only: it answers with one line and changes nothing.

The command list lives once, in `packages/protocol/src/commands.ts`, and is served through the AHP completions command. `/idea`, `/offline`, `/stage`, `/mute` and `/log` are accepted but not listed. The agent's `available_commands_update` is not merged in.

**Host lines.** The trimmed host gains `hostLine(chat, text, meta)`. With a turn active it emits a SystemNotification part into that turn. Otherwise it opens and completes a turn whose `message.origin.kind` is `systemNotification`, inside the per-chat `tails` chain. The part carries `_meta: {'sparring.line': 'stage' | 'refused' | 'mode' | 'divider'}`. The host starts a turn of its own, such as the draft turn, through the same chain and the same `coach.runTurn`, with no client message.

### Storage and backup

Section 7 lists what `~/.sparring/` and `~/writing/` hold. Backup is nightly and runs through the git queue. `backup_remote` in `config.json` names a private repo. The daemon writes a SQLite `.backup` of `sparring.db` to `~/writing/.sparring-backup/sparring.db`, commits that path on `main`, then runs `git -C ~/writing push <backup_remote> 'refs/heads/*' 'refs/sparring/*'`.

### Latency and cost

The working assumption is that a ten-note pass over 1,500 words takes 30 to 90 seconds. It is measured on the first real article. That wait is why `/queue` exists: run the passes at night and read the notes on the phone in the morning.

`usage_update{used, size, cost?}` from the agent maps to `chat/usage`. The host sums it per article into the two usage columns on `articles`. The footer hides the figure when the engine sends neither. `_meta["_claude/rateLimit"]`, when present, drives the `rate limited` status line.

### Publishing into the Astro site

Publishing lives in `apps/daemon/src/publish.ts`. It turns one reviewed commit of `article.md` into a PR on `firstprateek/personal-website-astro`. The site facts here were checked at commit `f493459`: Astro 7.3.1, Node 22.12 or newer, no CI, no host yet.

**The contract.** Posts are flat files in `src/content/posts/`, served at `/writing/<slug>/`. The frontmatter is a `z.strictObject` with exactly four required keys: `title`, `date`, `description`, `draft`. A fifth key fails the build. So does a date like `2026-02-30`. The file name never starts with `_`. Body headings start at `##` because the title is the page `h1`. A `draft: true` post gets no route, so the publisher always writes `draft: false`.

**First run, on the machine.** `~/.sparring/config.json` holds `site_repo` (the `owner/name`), `publish.git_name` and `publish.git_email`. Sparring owns a clone at `~/.sparring/site/`. The preflight checks the rest, and the sheet shows what fails:

- `gh auth status --hostname github.com` exits 0, and `gh repo view <site_repo> --json viewerPermission` says WRITE or ADMIN.
- `git -C ~/.sparring/site ls-remote --exit-code origin refs/heads/main` succeeds with no prompt when the launchd-started daemon runs it. If ssh cannot do that, the clone's remote becomes https and pushes use `git -c credential.helper='!gh auth git-credential'`.
- Node 22.12 or newer, `npm`, `gh` and `git` are on the daemon's `PATH`, which the launchd plist sets.
- The git identity is set. The clone has `extensions.worktreeConfig` on, and each worktree gets `user.name` and `user.email` through `git config --worktree`.

**First run, on the site.** Every placeholder in `src/site.config.ts` on `main` is replaced, including the lowercase `url`. Section 10 has the repo setting and the host.

**Preflight and the pinned commit.** Opening the sheet calls `GET /api/articles/:slug/publish`, the preflight. Section 7 has its shape. It commits the current page and runs `git fetch --prune origin`. Every site file is read with `git show origin/main:<path>`, never from a working tree. `origin/main · clean` means the fetch succeeded and no publish worktree is left over for this slug. The sheet's read-only pane shows the output of `buildPost(meta, article)`, a pure function that produces the exact file. It writes the four frontmatter keys in the order `title`, `date`, `description`, `draft`, with title and description as trimmed single lines passed through `JSON.stringify`, never by string concatenation. `POST /api/articles/:slug/publish` names the commit the owner reviewed, and the daemon publishes exactly that commit. It repeats every check against it and answers 409 with a fresh preflight if the page, the site or a check changed. The browser's checks are a courtesy. The daemon's are the gate.

**The checks, in order.**

1. Site. `src/site.config.ts` on `origin/main` must not match `/todo[-_]replace[-_]before[-_]launch/i`.
2. Fields. `title` and `description` are non-empty. `date` is a real calendar date, filled from the browser's local date. It is the publish date and the site's only ordering signal.
3. Slug. It passed `^[a-z0-9]+(-[a-z0-9]+)*$`, at most 64 characters, not `index`, when the article was created, and it never changes. If `src/content/posts/<slug>.md` is on `origin/main` and this article has no `publishes` row with `pr_state = merged`, the file belongs to another post and is refused.
4. Body. It is `git show <article_commit>:<slug>/article.md` from `~/writing`, with `<!-- -->` comments removed outside code, then trimmed. Refused: a leading `---` block, a `# ` heading, `![`, raw HTML outside fenced and inline code (CommonMark autolinks pass), link schemes other than `http`, `https`, `mailto` and relative, and invisible characters. Headings below `###` are a warning.
5. Provenance gate. In coached mode every agent-word span found by the 5-word overlap check carries its `I chose these words` tick. Section 4 has the drafted gate.

**Worktree and branch.** The worktree is `~/.sparring/worktrees/<slug>`, outside both repos. The daemon runs `git worktree prune`, removes the path if present, then `git worktree add -B <branch> <path> <base>`. Three cases set the branch and the base:

- `first`: the slug is new. Branch `post/<slug>` from `origin/main`.
- `update_open`: this article's PR is still open. Same branch, from `origin/<branch>`. The push updates the PR, and `gh pr edit <n> --repo <site_repo> --body-file <tmp>` updates its description. It also covers a branch that is on origin with no PR after a crash: same branch, from `origin/<branch>`, then `gh pr create`.
- `edit_merged`: the earlier PR was merged, or closed without merging. Branch `post/<slug>-2`, then `-3`, from `origin/main`. The sheet reads `exists · branch post/<slug>-2 · diff` and shows the diff against the merged file. The original `date` is kept unless the owner changes it.

**The build gate.** The daemon writes `src/content/posts/<slug>.md`, runs `npm ci`, then `npm run build`, which is `astro build --force`. Each gets five minutes. Git and `gh` calls get 60 seconds. The exit code decides. Then the daemon asserts:

- `dist/writing/<slug>/index.html` exists and `dist/rss.xml` contains `/writing/<slug>/`.
- Neither file matches the placeholder pattern. The canonical link and every RSS `<link>` have a host that does not end in `example.com`.
- No `dist/writing/_fixture-*` folder exists.
- `git status --porcelain` lists exactly the one post file.

**Commit, push, PR.** The commit message is `Add post: <title>` or `Update post: <title>`. Then `git push -u origin <branch>`, then `gh pr create --fill --body-file <tmp> --head <branch> --repo <owner/name>`. Every git and `gh` call is an argv array, never a shell string. The environment is built from scratch: `PATH`, `HOME`, `SSH_AUTH_SOCK` if present, `CI=1`, `ASTRO_TELEMETRY_DISABLED=1`, `GIT_TERMINAL_PROMPT=0`, `GIT_SSH_COMMAND='ssh -o BatchMode=yes'`, and never `INCLUDE_FIXTURES`. The pushed ref must start with `refs/heads/post/`. The host never pushes to `main`. Merging is a human click: with no CI, the PR is the only review surface.

**The PR description.** It gives the route and file, the date, the word count, the build line and the Sparring article commit. Under the line `Provenance (recorded by Sparring; not part of the post)` it gives the mode and its numbers. Coached: questions, notes, done, dismissed, disagreed, violations, pasted words, and the agent-word spans kept and ticked. Drafted: the block counts, the percent of words that are the writer's, and the coach blocks ticked. Both end with the disclosure line state.

**Crash recovery.** There is one mutex per article. A second request gets 409. Each attempt is one `publishes` row whose `step` moves through `validate`, `worktree`, `write`, `build`, `commit`, `push`, `pr`, then `done` or `failed`. On start the daemon marks any unfinished row failed at its step, prunes its worktree and posts one host line naming the step. Nothing before `push` has left the machine, so a retry starts clean. A crash after `push` leaves a branch with no PR, and the next publish takes the `update_open` path. The worktree is removed after `done`. After a failure it stays until the next attempt.

**Progress.** Publish is a job. Its log lines, each command and its result, go to `~/.sparring/logs/publish-<id>.log` and to `_meta.sparring.publish: {id, step, lines, error?}`, sent with `session/metaChanged` as part of the full merged `_meta` (section 6). A phone that reconnects gets the whole log from `_meta`. The PR link is also posted in the chat. `articles.published_at` comes from `mergedAt`, read with `gh pr view` at most once a minute.

## 4. Drafted mode

### The flip

Only one call changes authorship: `POST /api/articles/:slug/authorship {to, confirm: true}` from a logged-in client. `/sendit` opens the confirm line `the coach writes the draft from dump.md and brief.md · what is on the page moves to the shelf · yes · no`. The yes click makes the call. Agent text, a tool result or file content can never make it, and it is not an AHP config key. When the article is already drafted, `/sendit` opens the stage menu with focus on `coached again` and no confirm line, and the route answers 409 to `{to: 'drafted'}`.

The flip works from any stage. The daemon answers 409 while the article is offline and while a turn runs, with no host line. If `dump.md` is empty it refuses: the line `nothing to draft from · dump.md is empty` is posted with `hostLine` and added to `letter` with kind `draftEmpty`. Otherwise it creates the grant, `articles.draft_grant`, sets `_meta.sparring.drafting`, and starts the draft turn itself through `coach.runTurn`. No client message is involved. Authorship still reads `coached` and the page is untouched until the draft is accepted.

### The draft turn and `write_draft`

The draft turn runs in the same coach session that did the interview, so the coach has the answers in context. Its prompt (section 5) asks for one `write_draft({blocks: string[]})` call.

`policy.ts` allows `write_draft` with `allow_once` only while the grant is live. The daemon checks the grant again at the socket, so the guard does not depend on the adapter asking. The call is valid when `blocks` is non-empty, no block is blank, headings start at `##`, and the text is at most 6,000 words. A failed check returns the rule text and the coach may retry inside the same turn.

On an accepted call the daemon does this in one transaction (`draft.ts`):

1. Commits the current page and records it as `page_before_commit`. Records the stage as `stage_before_draft`.
2. Writes `article.md` atomically from the blocks, joined by blank lines, and commits it. That commit is `draft_commit`. It gets the ref `refs/sparring/drafts/<slug>/<n>`, the coach's nth draft, whose parent is the page before it.
3. Sets authorship to `drafted`, the stage to `draft`, `coach_quiet` on, `agent_seen_commit` to `draft_commit`, and clears the grant.

The grant is spent. Never-write applies to this article again, and the daemon stays the only writer of `article.md`. The host logs `mode coached → drafted · never-write is off for this article`, and `stage X → draft` if the stage was not already draft. The coach line reads `write_draft article.md · N ¶ from dump.md and brief.md`, where N is the block count, then `Drafted from your sentences where you had them. The review is yours; I stay quiet until you ask.`

### The wait and the reveal

While the turn runs the stage word reads `drafting…` and the page is read-only. The draft lands whole. The client then reveals it block by block at 220 ms, or all at once under reduced motion. Section 6 has the strip and the tag.

### The shelf

The shelf is git, not files. Nothing is added to the article folder. `GET /api/articles/:slug/shelf` returns `{text, commit}` for the page at `page_before_commit`, and the UI shows it beside the draft so the owner can copy from it.

### Coached again

The confirm line is `discard the coach's draft · your page comes back from the shelf · yes · no`. The yes click posts `{to: 'coached', confirm: true}`. The daemon commits the current page first. It restores the page from `page_before_commit`, returns the stage to `stage_before_draft`, sets authorship to `coached` and turns `coach_quiet` off. The host logs `mode drafted → coached · the coach's draft moved to the shelf` and `stage draft → <that stage>`. The coach's draft stays as its git ref. The UI does not show it. A later `/sendit` writes draft n+1.

### Provenance

Provenance answers one question: which words on the page are the writer's. It is computed, never stored. The baseline is `<slug>/article.md` at `draft_commit`. One pure function in `packages/protocol/src/provenance.ts` runs in the browser for the live tag and in the daemon for the publish gate.

It splits both texts into blocks on blank lines (`blocks.ts`). A block's words are the matches of `/[a-z0-9'’]+/g` on its lower-cased text with a leading `## ` stripped. A block's hash is the SHA-256 hex of its words joined by single spaces; `ticked` and `acks_json` hold these. Blocks are matched by content, never by index. A baseline block matches a block when the words they share are at least half of either one's words. A block's baseline is the multiset union of every baseline block that matches it. New words are the block's words minus that baseline.

- Words equal to the baseline: `coach`.
- Changed, with under half its words new: `edited`.
- At least one word, and new words over its words is 0.5 or more: `yours`.
- No matching baseline block: every word is new, so `yours`.

"N% yours" is `Math.round(100 * new / Math.max(1, total))` with both summed over all blocks. Because equality is on the word list, whitespace or line-ending changes cannot turn a coach block into anything else.

The page has no split, merge or reorder code. Blocks are whatever the file holds, and the one rule covers each case:

- Added block: no match, so `yours`.
- Deleted block: it leaves the page and the totals.
- Reordered block: it matches by content, so nothing changes.
- Split block: each piece matches its source. The pieces are `edited` and none of their words are new.
- Merged blocks: both sources match, so merging two coach blocks gives a `coach` block with no new words.

The rule is conservative. The writer's own sentences that the coach reused count as the coach's.

### The guards in drafted mode

Nothing is loosened except the one call.

- The `write_draft` input is left out of the overlap corpus. Otherwise the whole page would match.
- Saves still carry `base_sha`. A stale tab that replays an old save after the draft gets 409 and `disk changed while offline · keep mine · take disk`.

### The quiet coach

After a draft the coach holds its notes, and the margin shows the quiet block (section 6). While `coach_quiet` is on, the `comment` tool is refused and a plain question gets three sentences at most. `/critique` or `/pass` ends the quiet. Those turns add three rules to the prompt: the draft is the writer's page now, do not defend it, and no fix text.

### Publish ticks

In drafted mode the publish sheet lists every block still `coach`, each with the `I chose these words` tick (section 6). The client sends the hashes of the ticked blocks in `ticked`. The daemon recomputes provenance on the pinned commit and refuses with 409 if an unticked coach block remains. The ticks are stored as `acks_json` on the `publishes` row. The chat-overlap list is not shown; overlaps are still recorded. The block counts and the percent go in the PR description.

### Failures

A failed draft never touches the page, because the shelf move and the write happen only inside the accepted call.

- The turn ends with no accepted `write_draft`, is cancelled, hits the 10-minute limit, or the agent exits. The daemon clears the grant and the `drafting` flag. Host line: `draft failed · nothing was written · your page is unchanged`. Authorship stays `coached`.
- The daemon restarts with an unspent grant. It clears the grant on start and posts the same line.
- The transaction fails partway. It rolls back, the file is restored from `page_before_commit`, and the failed-draft line is posted.

## 5. The coach's operating rules

The rules live in `packages/protocol/prompts/RULES.md`. The host sends them, followed by `STYLE.md` as it stands at spawn, through `systemPrompt` or as the first prompt block (section 3). No `CLAUDE.md` or `AGENTS.md` is generated. The system prompt cannot be swapped mid-session, so what changes travels with the turn: the header names the stage, the pass and the strictness, a later change to `STYLE.md` is read through `read_source`, and the drafting instruction rides in the draft turn's own prompt.

1. **Identity.** You are a sparring partner for one writer. You ask, flag and explain. In a coached article the writer writes every word. In a drafted article you wrote one draft because the writer asked, and from then on it is the writer's page like any other.
2. **Never write.** DO NOT WRITE COPY. Do not draft, rewrite, complete, expand, or suggest a sentence, phrase, heading or title for the piece, even when asked. The single exception is the one `write_draft` call in a draft turn, which only the writer can start. Never suggest send it. Everywhere else, any words you supply are disqualified and waste the writer's time. Answer a request for phrasing with a question about what the writer is trying to say. You have no edit tools; `write_draft` without a grant is refused and logged. Point, don't write.
3. **No encouragement.** Praise is noise. Never say strong, great, nice, LGTM. Do not open with an assessment of quality. If a pass finds nothing, say "nothing in this pass" and stop.
4. **Stage lock.** The header names the stage and the pass. Stay inside it. Note a typo in one word; never build a structural critique from typos.
5. **Question discipline.** One question per message unless told otherwise. Prefer "what did you see?" over "have you considered?" Never a list of options. In the interview, cover the six topics in whatever order the dump suggests, skip what is already answered, and record each covered topic with `note_brief`. Stop when you can restate thesis, reader and arc in the writer's sentences, and say so.
6. **STOP rule.** Whenever a decision about content, order or emphasis is needed, stop and ask. Do not push through.
7. **Note discipline.** Use the `comment` tool for anything tied to a span. Quote exactly, and put in double quotes only the writer's own text. Say what is wrong and why in one or two sentences. No fix text. At most five notes per section and ten per pass. Every critique item cites the brief line it serves or says "(no brief line)". Say what evidence made you flag it.
8. **Voice.** Fragments, lowercase, slang and odd punctuation are choices. Never ask the writer to tone down. Flag them only in the voice pass, as a question. `STYLE.md` lists things the writer has told you to stop flagging; obey it.
9. **AI-tells checklist.** The tells module counts; you judge content only. The list: em-dash density, emoji, single-sentence paragraphs, "it's not X, it's Y" and "not just X but also Y", empty rule-of-three runs, "genuinely", "delve", "tapestry", "landscape", "crucial", closers that restate the piece. Do not scold. Flag only a construction that carries no content, and say which. These produce false positives; Cantrill's own post trips them. It is the writer's call.
10. **Provenance.** Everything you say is recorded. The writer may not use your words from chat or notes, and the publisher compares the final text with this transcript in both modes. In a drafted article the blocks you wrote are tracked, and the writer must rewrite or tick each one at publish. Do not try to be quotable.
11. **Disagreement.** When the writer disagrees with a note, either call `resolve_comment` with one line or sharpen the note with a reason the writer can verify. Never argue past one exchange.
12. **Format.** Plain prose in chat. No headers, no bold, no emoji, no bullets longer than the writer's own.

**The draft turn.** Its prompt says: write the piece once with `write_draft`, one paragraph or `##` heading per block. Use the writer's own sentences from `dump.md`, `brief.md` and the interview wherever they exist. Do not invent facts, numbers or incidents. Leave an uncovered topic out. Then say one line and stay quiet.

## 6. UI and AHP channels

The web client is TypeScript on Vite with no component framework. Each approved mock page becomes one HTML file plus one module. The look is the site's own: Source Serif 4 at 17px/1.65 in a `min(68ch, 100% - 3rem)` column, JetBrains Mono for labels, six `light-dark()` colours (`--bg --subtle --text --muted --rule --accent`), 1px rules, 2px radii, no cards. Both fonts are self-hosted from `@fontsource/source-serif-4` and `@fontsource/jetbrains-mono`, as the site does, and the mocks' Google Fonts links are removed, because the lifted CSP allows no outside font or style host. Coach text goes through one escape function or the lifted markdown renderer. The Content Security Policy (CSP) from i-inc's `web-static.ts` is served on every page. No screen has an Apply button.

**Articles.** The head reads `sparring`, then `claude · 41k tok` (the engine and the sum of every row's `tokens`) and the `theme · auto` button, which cycles auto, light, dark into `sparring-theme`. Below sit the `>` idea field, the `inbox` list with `→ article` on each idea, the `articles` list and `+ new article`. A row shows the title and a mono tail: stage (`interview 4/6`), `612w`, open notes (`·6`), save age (`2h`), `18k tok`, or `PR #4` once a PR exists. The sub line is the coach's open question, or else the last host line (`nothing in this pass · cut`, `build finished · PR #4 is open`). Rows come from the AHP root session list and its `_meta.sparring`; there is no REST list. The client calls `listSessions` after every reconnect, then follows `root/sessionSummaryChanged`. The inbox is `GET` and `POST /api/inbox`. `→ article` and `+ new article` ask for a slug and call `POST /api/articles`. The foot reads `j k move · enter open · n new · i idea`, four client-side keys (move the row focus, open the row, focus `+ new article`, focus the idea field), and `sparring.tailnet.ts.net · connected`: the page's host name and the socket state.

**Room.** Opening the Room calls `GET /api/articles/:slug` once for the three files, the notes and the resume letter, then follows the session. The running head holds `← articles`, the slug, the leaves `dump · brief · article`, the thesis line with the reader on hover (`thesis`, `reader`), the tag `drafted · N% yours` in drafted mode, and the stage word as a button.

The stage menu lists `ideas`, `interview 6/6`, `outline`, `draft`, `critique`, `polish`, with the six topics under `interview` read from `covered`. Picking a stage shows `advance to critique · yes · no`, and yes dispatches `session/configChanged {stage}`. Below sit `send it` or `coached again`, each with its confirm line and backed by `POST /api/articles/:slug/authorship`, then `publish →`. On yes to `send it` the client closes the menu and switches to the article leaf. The stage word reads `drafting…` while `drafting` is true.

The page is one textarea per block. Blocks are the blank-line split of the file and have no ids. A block with a live note carries a solid gutter mark. In drafted mode it also carries a dotted provenance bar: accent for `coach`, muted for `edited`, none for `yours`. Pasting is allowed. The client posts pasted text to `POST /api/articles/:slug/pastes`, and spans that match the coach's words get a muted underline.

The margin, top to bottom:

- **Letter.** Host lines from `letter`, one per kind in section 7, such as `nothing in this pass · cut`. The client ticks `running filler… 12s` from `run`. Three lines are the client's own: `disk changed while offline · keep mine · take disk` after a 409, `reconnecting… 4s`, and `queued` in the composer. After 24 hours away the snapshot adds the resume letter (stage, save age, open question, unread notes), built with no agent.
- **Status strip**, drafted mode only, in place of the write-refused line: `drafted · the coach wrote article.md · never-write is off for this article`.
- **Quiet block**, while `authorship` is `drafted` and `coachQuiet` is true, in place of the filter row, the notes, the shelf rule and the foot's `N open ·`: `the coach is quiet. this review is yours.`, `/critique when you want notes`, `13 ¶ · 13 coach · 0 edited · 0 yours`, `0% of the words are yours`, and the legend `coach`, `edited`, `no bar: yours`. The browser computes the counts with the shared provenance function.
- **Filter row**: the items `all 6`, `open 5`, `critique 4`, `filler 1`, `voice 1`, spaced with no separator, counted from the notes by status and pass.
- **Notes**, in page order. A note shows kind, id and brief line (`unsupported · c08 · brief: evidence`, or `no brief line`), the quoted span and the body. The actions are `done`, `disagree`, `dismiss`. `done` is inert under `·edit the span first` until the anchored block differs from `block_orig`, and the daemon checks the same rule. `disagree` opens a `re c09:` input; the coach withdraws the note or sharpens it as `c09 v2` (`comments.body_v2`). A dismissed note offers `on purpose, stop flagging this`, which then reads `muted · STYLE.md ← do not flag: "…"`. A button only sends a grammar line as a chat turn: `done c08`, `dismiss c11`, `dismiss c11 on purpose`, `re c09: …`.
- **Shelf.** Notes whose span has left the file stack under the `shelf` rule. Stale is computed, not stored. The page from before a draft is a shelf entry too, read with `GET /api/articles/:slug/shelf`.
- **Composer.** A `>` prompt. Typing `/` opens the command list from section 2, served by AHP `completions`. The hint for `/quiet` keeps its approved copy, `no coach for this article`.

On the dump leaf the margin is 400px wide (280px on the other leaves). It shows the interview turns and ends with the divider `interview done · brief.md is yours`. A dump block carries a mono `?` in the gutter when a `briefNotes` quote is a substring of it; the client computes the marks from the snapshot. On the brief leaf the margin lists `quoted from dump.md`, the quotes in `briefNotes`.

The `transcript` overlay (`⋯`) is the AHP chat: writer lines, coach lines, one mono line per tool call (`comment c07 · unclear · ¶3`), and host lines as dividers (`stage draft · claude-agent-acp 0.101.0 · session loaded`).

The running foot reads `612 words · saved 12s · em 0 · ¶1 1 · not-x-but-y 1 · pasted 0`, plus `· N% yours` when drafted, with `5 open · ⋯` on the right. Cmd+S shows the commit sha for two seconds. A tell count opens the Tells table over "counts, not verdicts", seven rows (em-dash, single-sentence ¶, not-X-but-Y, genuinely, rule-of-three, sentence-length σ and first-person %, the last two beside the dump's), computed by `tells(article, dump)` in browser and daemon.

**Phone.** The Room at phone width, same data. The head is `← closed-laptop draft ▾`. Its stage menu opens with the leaves row `dump · brief · article`, which switches the leaf, then the six stages, `send it` or `coached again` with its confirm line, and `publish →`. Picking a stage on the phone dispatches `session/configChanged {stage}` at once, with no `advance to` line. Noted blocks show a tick on a right-hand rail. The foot is the sheet handle, `612w · saved · 5 notes ▴`, with `N% yours` in place of the notes count while the article is drafted and the coach is quiet. The sheet holds `log` and everything the margin holds. A phone note gains `edit`, which opens only its block with `save` and `back`. Its `disagree` fills the sheet composer with `re c09: ` and opens the sheet. The last line reads `em 0 · ¶1 1 · not-x-but-y 1` (or `drafted · N% yours`) and `tailnet · connected`.

**Phone interview.** The dump is the page. The head reads `closed-laptop · dump` and the button `interview 4/6 ▾`, whose menu lists the six stages and `send it`. A strip above the composer reads `interview · thesis reader evidence counter uncertainty scar`, marked from `covered`. The answer goes out through `>` and `send` as an ordinary turn. `send it` and yes make the authorship call and open the article leaf.

**Publish.** The sheet replaces the margin and the page is read-only. The head is `← articles`, the slug, `dump · brief · article` (a link back to the Room) and the stage word `publish`. Everything shown comes from the preflight: `origin/main · clean`, the fields (`title`, `slug`, `description`, `date`, `draft false`), the group `before you ship, three questions (stored, not published)` with the stored answers, the provenance group and the `checks` group. The `slug` field is read-only (the mock draws it as an input). Field edits go to `PUT /api/articles/:slug/meta`.

In coached mode the provenance group shows two lines from `counts` (`questions asked 11 · comments 19 · done 12 · dismissed 3`, `disagreed 1 · violations 0 · pasted words 0`), then `agent-word spans in the text` with its count and, for each entry of `spans`, the text, its source (`¶9, from interview q6`) and the tick `I chose these words`. In drafted mode those are hidden. The group shows `drafted by the coach · never-write was off for this article`, `13 ¶ · 13 coach · 0 edited · 0 yours`, `0% of the words are yours`, then `blocks still entirely the coach's words` with its count and one row per coach block (`¶<n> "<first six words>…"` over `I chose these words`), and `tick all` when there is more than one row, or `every block has your words in it` when there is none. The head shows the tag `drafted · N% yours` and the read-only page keeps the provenance bars. All of it comes from `blocks`, `yoursPct` and `authorship`. `disclosure line: none. Type one into the body if you want one.` shows in both modes.

The `checks` group shows four lines from `checks[].text`, each with `✓` when `ok`: `site.config has no placeholders`, `headings start at ##`, `no ![ in body` and `slug is new on origin/main` (replaced by `exists · branch post/<slug>-2 · diff` for `edit_merged`). They cover checks 1, 3 and 4 of section 3. The button reads `build and open PR` and is disabled with its reason (`disabled: 1 span unticked`, `disabled: 2 blocks unticked`). It reads `building…` while `publish.step` is neither `done` nor `failed`, and `PR #5 is open` once `prNumber` is set. The foot reads `598 words · read-only while publishing` and `the host runs this sheet, not the coach`, then `PR #5 · merging is your click`. At the end the stage word reads `published` (shown whenever `prUrl` is set; it is not a stage).

**Stays in the browser.** Theme and accent (`sparring-theme`, `sparring-accent` in localStorage), sheet height, open menus, and each leaf's unsent text as `{text, base_sha, dirty}`. `outbox.ts` holds chat lines sent while disconnected. A History screen is Later.

**AHP channels.**

- `ahp-root://` is the session list. Each summary carries the title and `_meta.sparring`, and the root's change key includes `_meta`.
- `ahp-session:/<articleId>`, one per article. The provider (`claude` or `demo`) is fixed at creation. The host builds the config schema with no agent running and freezes it at creation. It has three keys: `stage` (the six stages), `pass` (a pass name or empty) and `strictness` (`howlers only`, `normal`, `every nit`). Clients change them with `session/configChanged`. The agent's own ACP mode is not in it, and an agent `config_option_update` naming one of the three keys is dropped.
- `ahp-chat:/<uuid>`, one per article: interview, replies, tool calls and host lines.

`session/metaChanged` is server-only and replaces the whole `_meta`. One function, `metaFor(article)`, builds the full `sparring` object from SQLite and the running publish job. The daemon merges it into the session's `_meta` and sends the whole object on every change, with counters debounced to 2 s. Note bodies travel as tool results in the chat and in the snapshot, and a bump of `commentsRev` tells the client to fetch the snapshot again, for notes and for brief entries alike.

## 7. Data model and repo layout

The names in this section are the names everywhere. Section 6 fields named without a prefix are `_meta.sparring` fields.

**REST routes.** All on `127.0.0.1:7421`, behind the REST guard of section 3. `:slug` is looked up in `articles`, never joined into a path.

| Method and path | Body | Purpose |
|---|---|---|
| `POST /api/login` | `{token}` | Sets the `sparring` cookie. |
| `GET /api/me` | | Login probe for the hub. |
| `GET /api/inbox` | | Ideas from `inbox.md` as `[{id, date, text}]`. |
| `POST /api/inbox` | `{text}` | Appends one idea. |
| `POST /api/articles` | `{slug, inboxId?, provider?}` | Checks the slug rule, then creates the folder, the row, the session and the chat. An inbox idea moves into `dump.md`. |
| `GET /api/articles/:slug` | | Room snapshot: `{files: {article, dump, brief: {text, sha}}, commit, comments, briefNotes, resume}`. Sets `last_opened_at`. |
| `PUT /api/articles/:slug/article`, `/dump`, `/brief` | `{text, base_sha, commit?}` | Atomic save. Answers `{sha, commit}`, or 409 `{disk_sha, disk_text}`. `commit: true` is Cmd+S. |
| `POST /api/articles/:slug/stash` | `{file, text}` | `take disk`: keeps the local text at `refs/sparring/stash/<slug>`. |
| `POST /api/articles/:slug/pastes` | `{text}` | Runs the overlap function on pasted text. Answers `{spans}` and records matches. |
| `POST /api/articles/:slug/comments/seen` | `{ids}` | Sets `seen_at`. |
| `POST /api/articles/:slug/letter/:id` | `{action: 'dismiss' \| 'restore'}` | Clears a letter line, or puts the quarantined text back after committing the page. |
| `POST /api/articles/:slug/authorship` | `{to, confirm: true}` | The only way to flip `coached` and `drafted`. |
| `GET /api/articles/:slug/shelf` | | `{text, commit}` of the page at `page_before_commit`. |
| `PUT /api/articles/:slug/meta` | `{title, description, date, answers}` | Writes `meta.json` and sets the session title. |
| `GET /api/articles/:slug/publish` | | Preflight, no build: `{article_commit, origin: {sha, clean}, kind, branch, meta, counts, authorship, yoursPct, spans: [{hash, text, block, source}], blocks: [{n, hash, state, first_words}], checks: [{id, ok, text}]}`. |
| `POST /api/articles/:slug/publish` | `{article_commit, ticked: [hash]}` | Starts the job and answers `{publish_id}`. 409 with a fresh preflight when the commit is not the head or a gate fails. |

Stage, pass and strictness go through `session/configChanged`. Note actions and slash commands are chat lines. Nothing else writes.

**`_meta.sparring`.**

```ts
{ stage,                      // ideas|interview|outline|draft|critique|polish
  covered: string[],          // interview topics noted; N/6 is its length
  authorship,                 // coached|drafted, read-only mirror
  drafting, coachQuiet, offline,                 // booleans
  yoursPct?, blocks?: {coach, edited, yours},    // drafted only
  wordCount, savedAt, articleSha, commit,
  tells: {em, oneSentence, notXButY}, pastedWords,
  openComments, unreadComments, commentsRev,
  run: {pass, startedAt} | null, queued,
  letter: {id, kind, text, at}[],  // at most 3; refused|quarantine|passDone|passEmpty|draftFailed|draftEmpty|interrupted
  openQuestion?, lastLine?, thesis?, reader?,    // short strings, at most 200 characters
  publish: {id, step, lines: string[], error?} | null,
  prNumber?, prUrl?, tokens }
```

**SQLite**, `~/.sparring/sparring.db`. Four tables sit beside the lifted `ahp_*` ones.

```sql
articles(id TEXT PRIMARY KEY, slug TEXT UNIQUE, provider, chat,
  stage, strictness, authorship, coach_quiet INT, offline INT,
  brief_notes_json,        -- [{topic, quote, question?}] from note_brief
  draft_grant,             -- single use, null once spent
  draft_n INT, page_before_commit, draft_commit, stage_before_draft,
  dump_baseline_commit,    -- first commit of dump.md, the voice baseline
  article_sha, last_commit, saved_at,
  agent_seen_commit,       -- what the coach last read
  open_question, last_line, letter_json, pastes_json,
  tokens_in INT, tokens_out INT, pr_number INT, pr_url,
  published_at,           -- from mergedAt on the PR
  last_opened_at, created_at)

comments(article_id, id TEXT,            -- c07, numbered per article
  turn_id, file, kind, pass, brief_line, span, block_orig,
  body, body_v2, status,                 -- open|disagreed|done|dismissed|withdrawn
  muted INT, reply, seen_at, created_at, resolved_at,
  PRIMARY KEY (article_id, id))

publishes(id INTEGER PRIMARY KEY, article_id, n INT,
  kind,                                  -- first|update_open|edit_merged
  article_commit, authorship, yours_pct INT, counts_json, acks_json,
  origin_sha,                            -- origin/main of the site at preflight
  branch, worktree,
  step,                                  -- validate|worktree|write|build|commit|push|pr|done|failed
  error, log_json, pr_number INT, pr_url,
  pr_state,                              -- open|merged|closed
  started_at, finished_at)

turns(turn_id TEXT PRIMARY KEY, article_id,
  origin,                                -- writer|host|queue
  status,                                -- running|done|interrupted|failed
  stage, pass, commit_before, is_question INT, violation INT,
  started_at, ended_at)
```

Stale, the `done` rule, provenance, tells, word count, thesis and reader are computed from the files and never stored. `questions asked` counts `turns.is_question` and `violations` counts `turns.violation`. The title lives in `meta.json` and in the AHP session title.

**Files.** `~/writing` is the writer's git repo and the source of truth.

```
~/writing/
  STYLE.md             voice notes; "## Do not flag" grows from dismiss on purpose
  inbox.md             one idea per line
  passes/*.md          pass definitions, editable
  <slug>/article.md    dump.md, brief.md beside it
  <slug>/meta.json     {title, description, date, answers: [3 strings]}
  .sparring-backup/sparring.db    nightly SQLite .backup, committed on main
```

An article folder holds no shelf, baseline, comment or agent files.

```
~/.sparring/                mode 0700
  config.json               0600: token, hosts, claude_oauth_token, writing_dir, site_repo, default_provider,
                            backup_remote, publish.git_name, publish.git_email
  sparring.db
  daemon.sock               0600, for the MCP proxy only
  claude/settings.json      the isolated CLAUDE_CONFIG_DIR
  adapters/<engine>/        exact version plus lockfile
  site/                     clone of the site repo
  worktrees/<slug>/         one publish worktree
  run/<article_id>.pid      the ACP child
  logs/daemon.log           and logs/publish-<id>.log
```

**Git refs.** In `~/writing`: `refs/heads/main` takes every save commit, and `refs/sparring/drafts/<slug>/<n>`, `refs/sparring/quarantine/<slug>` and `refs/sparring/stash/<slug>` hold kept text. In the site clone the branch is `post/<slug>`, then `post/<slug>-2`, `-3` after a merge.

**Repo.** `github.com/firstprateek/sparring` is a pnpm 10.33.0 workspace on Bun 1.4.2 with TypeScript 7, biome and vitest.

```
apps/daemon/src/
  main.ts  config.ts  db.ts  auth.ts  rest-guard.ts  web-static.ts
  ahp/                 lifted host with hostLine, agent-process.ts, sanitize.ts
  rest.ts              the routes above
  articles.ts          create, snapshot, save, git queue, metaFor
  coach.ts             runTurn, prompt assembly, command handling, MCP socket
  policy.ts  stages.ts  resume.ts  draft.ts  publish.ts  backup.ts  demo-agent.ts
apps/daemon/test/      ahp/*.test.ts, fake-acp.ts, support.ts
apps/web/
  index.html  room.html  publish.html
  src/ahp/{connection,hub,wire}.ts
  src/api.ts  actions.ts  outbox.ts  markdown.ts
  src/articles.ts  page.ts  margin.ts  stage-menu.ts  composer.ts  log.ts  sheet.ts  publish.ts
packages/protocol/src/
  meta.ts  commands.ts  blocks.ts  provenance.ts  tells.ts  overlap.ts
packages/protocol/prompts/    RULES.md, stages/*.md, passes/*.md
packages/mcp/src/server.ts    stdio proxy to daemon.sock
tools/acp-probe.ts
docs/adapters.md
README.md
```

## 8. What to lift from i-inc

The lift base is `firstprateek/i-inc` at commit `274b42b` (2026-10-23), the tip of `~/projects/i-inc-dev`. Every i-inc line number in this document refers to that commit. GitHub main is not the base, because it wires `sinks.ts` redaction into `host.ts`. One hunk is ported from main by hand: a second steering message is stored as kind `queued` instead of replacing the first.

Daemon paths are under `apps/daemon/src/`, web paths under `apps/web/src/`.

| File | Lines | What to do | Comes along, or is cut |
|---|---|---|---|
| `ahp/wire.ts` | 187 | Verbatim | AHP package only |
| `ahp/store.ts` | 382 | Verbatim; Sparring tables are added beside it | Type `Db` from `db.ts` |
| `db.ts` | 70 | Verbatim | `bun:sqlite` on the host, `node:sqlite` in tests |
| `ahp/acp-connection.ts` | 146 | Verbatim but for one import (line 7) | `AgentProcess` comes from a new `ahp/agent-process.ts`, about 15 lines: the type at `acp.ts:32-41` without `agentId`, plus a `Launch` type |
| `ahp/acp-mapper.ts` | 480 | Verbatim; rename `iinc.locations`, `iinc.plan`, `x-iinc-plan` | `redactTokens` from `sanitize.ts` |
| `ahp/sanitize.ts` | 239, to about 60 | Keep `Caps`, `defaultCaps`, the size caps and `redactTokens` on tool-call paths | Cut the `sessions.ts` import (line 8) and the hex and base64 redaction. Message text is never redacted, so a 40-character commit id reaches chat unchanged |
| `auth.ts` | 53 | Keep `same`, `hostAllowed`, `originAllowed`; the cookie is `sparring` | Cut the sessions argument; the cookie holds an HMAC of the token |
| `ahp/transport.ts` | 196 | Keep the guard (401, 421, 403, 426, 503), limits and the backpressure close | Cut the `sessions` option (19-23), `sweep()` (71-76) and `signedOut` (78) |
| `ahp/backend.ts` | 152 | Keep the interface | Cut `attachApp`, `liveEmployees`, `hold`, `openChat`, `closeChat` |
| `ahp/host.ts` | 2431, to about 1900 | Trim, see below | Imports `db.ts`, `backend.ts`, `sanitize.ts`, `store.ts`. The `images.ts` import goes |
| `ahp/session-host.ts` | 1305 | Not copied. `coach.ts` (about 600) and `policy.ts` (about 150) replace it | Copy `launchSession` (879), the idle sweep (713), `continuationBrief` (1054), `onAgentRequest` (1192), `outcome()` (1218). Fill `mcpServers`, empty at 917 and 929. Cut slots, the app gate, hold, the brain feed and working copies |
| `main.ts` | 338 | Copy the `Bun.serve` block (265-286) and `shutdown()` with its signal handlers (292-335) | Nothing else |
| `app.ts` | 418 | Copy `new AhpHost` with `verifyToken` (208-215) and `new AhpTransport` (249-253) | Nothing else |
| `api.ts` | 3483 | Copy the REST guard only (3127-3139): host check 421, origin check 403 on state-changing routes, content type 415 | It becomes `rest-guard.ts` |
| `web-static.ts` | 234 | Verbatim | Node builtins only. `contentSecurityPolicy(host)` keeps its `ws://` and `wss://` sources |
| `workspace.ts` | 628 | Idioms only: `git worktree prune` (144), `worktree add -B` (159, 162), `worktree remove --force` (373) | No code copied; it imports a dozen i-inc modules |
| `demo-agent.ts` | 340 | Rewrite as the scripted coach: it asks one question, calls `comment`, asks to edit `article.md`, calls `write_draft` | `AgentProcess` and `Launch` from `agent-process.ts`, not `acp.ts` |
| `tools/m1/acp-probe.ts` | 243 | Rewrite for step 0 | Becomes `tools/acp-probe.ts`. Cut the container CLI (61), the bypass mode pick (211-216), the `allow_always` answer (133) and the empty `mcpServers` (193) |
| web `ahp/wire.ts` | 143 | Verbatim | AHP package only |
| web `ahp/connection.ts` | 827 | Copy | Cut `isTicketSession` (119, used at 539) and the presence method (766-780). Add `outbox.ts` (about 80), because dispatch refuses while the socket is closed (757) |
| web `ahp/hub.ts` | 81 | Copy | It imports the i-inc `api.ts` (line 5). The login probe at line 31 becomes `GET /api/me` |
| web `conversations/actions.ts` | 233 | Copy the builders | Imports only the AHP package and `wire.ts` |
| web `conversations/markdown.ts` | 710 | Copy the parser (to about line 557) with `probe.ts` (6) and `visible.ts` (15) | The renderer (from about 560) returns Lit templates. Rewrite it as DOM builders that set `textContent`. Cut the `lit` import and `highlight.ts` (295) |
| `apps/daemon/test/ahp/*` | about 4,290 | Copy seven test files, `fake-acp.ts` (651) and `support.ts` (398); run with `vitest run` | Retype `fake-acp.ts` to `agent-process.ts` and cut its `@i-inc/core` import. `demo-agent.test.ts` is rewritten against `coach.ts`, because its rig (`session-rig.ts`) builds a `SessionHost`. Cut the `schema.ts` and `web-sessions.ts` imports from `bun-fixture.ts`. Cut the presence, read-only, multi-chat and web-session cases |

**The `host.ts` trim.** Delete presence (152-208, 1127-1162), read-only sessions (1552-1663), `createChatCommand` and `disposeChat` (1677-1758), image attachments (`sniffImage` at 2179, `iinc.embedded` at 2201-2221) and `canStartTurn` (187, 1825, 1914, 2402). That is about 500 lines. The completions source `iinc.commands` (1344) becomes the static command list. Add `hostLine(chat, text, meta)`. Add `_meta` to the `noteSummary` change key and to the `changes` payload it sends (839-855), so Articles rows update without a re-list. Set `hooks.onCreateSession`, because `createSessionCommand` (1366) throws without it, and always pass a title. Use `limits: {maxConnections: 8}` (it is 32 at line 121). The budget is four evenings, because every cut runs through the turn code. It is done when the ported `host.test.ts`, `store.test.ts` and `transport.test.ts` pass.

**Rename pass.** `grep -rn 'iinc\|i-inc\|i_inc\|i\.inc'` over the lifted tree returns nothing. That covers `serverInfo` (`host.ts:1216`), `RESETS_AT_META` (296), `DEFAULT_TITLE` (61) and the error text at `actions.ts:231`.

**Leave.** `ticket-channels.ts`, `conversations.ts`, `conversation-push.ts`, `sessions.ts`, `machines.ts`, `acp.ts`, `images.ts`, `presence.ts`, `web-sessions.ts`, `sinks.ts`, and everything about employees, teams, sandboxes, the brain, the GitHub bot, rate meters, Web Push and owner signup.

## 9. Build steps

An evening is two to three focused hours with a coding agent typing. Every "done when" runs in vitest against the scripted `demo` coach and spends no tokens. Every "try" is done by the owner by hand.

### Step 0: the probe (1 evening)

`tools/acp-probe.ts` runs against the adapter version installed under `~/.sparring/adapters/claude/` and writes `docs/probe-claude-<version>.md`. Step 0 also writes `packages/mcp/src/server.ts`, and the probe itself listens on a scratch Unix socket in place of the daemon, answering every tool call with a fixed result. Phase A sends no prompt. Phase B sends three scripted prompts on the owner's say-so and is the only part that spends tokens. The pin becomes the version this passed on.

| | Question | Pass condition |
|---|---|---|
| A1 | Does login work under the isolated config dir? | `session/new` succeeds with `CLAUDE_CONFIG_DIR=~/.sparring/claude` and the token. Without the token the error is -32000, which the Room later shows as `sign-in needed · claude` |
| A2 | Which mode does the session start in? | `modes.currentModeId` is `default` |
| A3 | Is the MCP proxy started? | The probe sees the `sparring` entry connect on the socket with the right secret |
| A4 | What does the agent advertise? | `protocolVersion`, `sessionCapabilities.systemPrompt`, `agentCapabilities.loadSession` and `configOptions` are written down |
| B1 | Does a tool call reach the socket? | "Call the comment tool once" gives a `tool_call` named `mcp__sparring__comment` and one call received on the socket |
| B2 | What does a permission request for an MCP tool carry? | `toolCall._meta.claudeCode.mcpServer.name` is `sparring`, or the name prefix matches. The option kinds are written down |
| B3 | Is the tool list only the Sparring tools? | "Append a line to article.md" gives no tool call outside `mcp__sparring__` and the file hash is unchanged |
| M2 | Can a launchd job reach the site remote? | A launchd-started `git ls-remote origin` on the site clone exits 0 with `BatchMode=yes`, or on the https fallback of section 3 |
| M3 | Does the site keep raw HTML? | A post with `<script>` is built in a scratch clone and the result written down. The refusal stays either way |

A failed A or B row stops the build. If B3 fails, the coach moves to its own macOS user before anything else is built.

### Steps 1 to 10

**1. Write and save (3 to 4 evenings).** Daemon REST and static files on loopback, the `~/writing` repo with a repo-local git identity, article creation by `POST /api/articles` (folder and row only), the Room opened by slug in the URL with the block page, saves with `base_sha`, the slug rule. No coach. *Done when:* a PUT saves and commits; a stale `base_sha` returns 409 with the disk text; a bad slug is refused. *Try:* write a dump and three paragraphs, then find them in `git log`.

**2. AHP with the scripted coach (5 to 6 evenings).** The daemon lift, with four of these evenings on the `host.ts` trim. Then `agent-process.ts`, the scripted coach, login, the REST guard, the CSP, `tailscale serve --bg`, the web connection, the Articles screen from the root session list, the composer, the transcript and the stage menu. From this step `POST /api/articles` also creates the session and chat, and start-up creates them for rows that lack one. *Done when:* the ported suite passes initialize, subscribe, dispatch, reconnect replay, snapshot and queued message; the rename grep is empty; a POST from a foreign origin gets 403. *Try:* type in the composer, read the scripted answer, reload, and the transcript is still there. The Host name `tailscale serve` forwards is in `hosts` and the phone loads the login page.

**3. Real coach on the phone (4 evenings).** `coach.ts`, `policy.ts`, the settings pin, `RULES.md` through `systemPrompt`, the `ideas` and `interview` stage prompts, `/idea`, `/stage`, `/offline`, the MCP proxy on `daemon.sock` with `read_article`, `read_source` and `note_brief`, the continuation brief, the idle kill, the tripwire, the outbox, the phone interview screen. *Done when:* the scripted coach asks to edit and is rejected with the file unchanged; a change made behind the daemon's back lands in `refs/sparring/quarantine/<slug>` and the page is restored; after a forced kill the next prompt contains the first interview answer word for word; one `note_brief` moves the counter to `interview 1/6`; `/offline` starts no process; a line typed in airplane mode shows queued and is sent once after reconnect. *Try:* a real interview from the phone.

**4. Notes (4 evenings).** `comment`, `resolve_comment`, the `critique` stage prompt, `/critique`, `/reader`, margin notes, the filter row, the note grammar, edit-gated Done, the phone sheet. *Done when:* the scripted coach leaves two notes; every sample note in the mocks is accepted; a body with a quoted phrase that is in none of the four sources is rejected; Done is disabled until the block changes; `dismiss c11 on purpose` appends to `STYLE.md`. *Try:* `/critique` on a real draft.

**5. Stages and passes (2 evenings).** The `outline`, `draft` and `polish` stage prompts, pass files, `/pass`, `/next`, `/ask`, `/queue`, `/strict`, `/quiet`. *Done when:* the prompt for `/pass filler` contains `passes/filler.md` and the strictness line; three queued passes run with no client connected. *Try:* queue three passes at night. The first real article starts here.

**6. Drafted mode (2 to 3 evenings).** The authorship route, the grant, `write_draft`, the draft refs, provenance, the block reveal and "coached again". *Done when:* `write_draft` is accepted once under a grant and refused the second time; in coached mode it is refused with the `write refused` letter line; a failed draft leaves the page byte for byte; the provenance fixtures give `coach`, `edited` and `yours` with a paragraph inserted in the middle; "coached again" restores the page byte for byte and the stage to `stage_before_draft`. *Try:* send it on a scratch article, edit until the footer reads over 50% yours, then go back to coached.

**7. Tells and pasted words (1 to 2 evenings).** `tells.ts`, the footer counts, `overlap.ts`, the paste underline. *Done when:* `tells()` on `test/fixtures/tells.md` returns the seven numbers in the fixture header; a pasted coach sentence is underlined; `write_draft` text is not in the overlap corpus. *Try:* paste a line from chat into the page.

**8. Publish (3 evenings).** Needs the real domain in `src/site.config.ts`. `publish.ts`, the sheet, the gates, the job log, the PR description. *Done when,* against a fixture copy of the site with a local bare repo as origin and a `gh` stub on PATH: the diff touches one path, the right one; a job killed before `push` is marked `failed` at its step and the next publish starts clean; a job killed after `push` gets its PR on the next publish; a second publish gives `post/<slug>-2`; each refusal fires, including an unticked coach block and a sha that is not the reviewed one. *Try:* publish a throwaway `draft: false` post to the real repo (a `draft: true` post gets no route), check `dist/writing/<slug>/index.html` and the RSS line, then close the PR unmerged.

**9. Always on (1 evening).** The launchd plist with its PATH copied from `tools/host/inc.i.daemon.plist`, the nightly backup, the README. *Done when:* `launchctl print` shows the job running after a reboot; the backup remote holds `refs/sparring/*` and a `main` whose tree has `.sparring-backup/sparring.db`. *Try:* close every terminal and use the phone.

**10. First article out (2 to 3 evenings).** Fix what the first real article breaks. *Done when:* the PR is merged, and pass latency and token numbers are in `docs/adapters.md`.

The total is 28 to 33 evenings. There is a plain editor for one article after step 1 (about evening 5), a real phone interview after step 3 (about evening 14) and the full coached loop after step 4 (about evening 18).

### Later

- CodeMirror 6; a file watcher for live sync with other editors.
- The tripwire diff card.
- `session/load` as the resume path.
- `/judge`, the History screen, per-pass accept and dismiss rates.
- In-app voice memos with whisper.cpp.
- More engines, each hidden until its own probe file passes: Codex through `@agentclientprotocol/codex-acp`, OpenCode through `opencode-ai`, Gemini through `gemini --acp`.
- Web Push for "notes are waiting".
- An existing AHP client such as VS Code against the host, with `deferredAuth`; `elicitation/create` if adapters advertise it.
- Images in posts, and a headless page check of the built post.
- A tagged Tailscale service and a separate macOS user for the coach.

## 10. Risks and open decisions

**Adapter drift.** The guard rests on adapter behaviour read on one version. No version moves without a passing probe file.

**One OS user.** The coach runs as the owner, beside the `gh` token and the ssh key. Zero built-in tools makes that acceptable, and row B3 is the proof.

**Prose leaks in chat.** The file is guarded, the chat is not. The owner can retype a sentence from a reply. The paste underline and the publish overlap list catch most of it.

**Drafted mode as the easy path.** One click gives a whole draft. The answer is numbers, not friction: "N% yours" in the footer, a tick per coach block at publish, and the numbers in the PR description.

**Optimizing toward LLM taste.** Note caps, strictness, the dump as the reference and the "stop flagging this" memory push against it. If drafts read flatter than dumps after two articles, drop passes.

**Publishing from launchd.** The machine has no global git identity and ssh from launchd is unproven. Row M2, the `publish.git_*` keys and `BatchMode` make a failure fast and visible. A merged PR publishes nothing until the site has a host.

**One machine.** The backup covers a lost disk, not downtime. When the daemon machine is off, nothing works.

These decisions are the owner's and are open. The default is what this document builds.

| Decision | Default | Needed by |
|---|---|---|
| Daemon machine | The owner's Mac mini | Step 0 |
| Claude account | Subscription token from `claude setup-token`, passed as `CLAUDE_CODE_OAUTH_TOKEN` | Step 0 |
| OS user for the coach | The owner's own user, on the condition that row B3 passes | Step 0 |
| GitHub credential | The existing `gh` login. A fine-grained token limited to the site repo before a second engine is enabled | Step 8 |
| Git author on posts | `publish.git_name` and `publish.git_email`; no default | Step 8 |
| Site domain and host | The domain is in `src/site.config.ts` before the first publish. The host is undecided. PR preview deploys are off or private | Step 8 |
| "Automatically delete head branches" on the site repo | On | Step 8 |
| Backup remote | A private repo named in `backup_remote`; none yet | Step 9 |
| Largest draft `write_draft` accepts | 6,000 words | Step 6 |

## 11. Sources

**Articles**
- Bryan Cantrill, "Your intellectual fly is open", https://bcantrill.dtrace.org/2025/12/05/your-intellectual-fly-is-open/ ; HN thread https://news.ycombinator.com/item?id=49585644
- Best guess for the HN piece: Thomas Ptacek, "How to Write with an LLM", https://sockpuppet.org/blog/2026/09/17/how-to-write-with-an-llm/ ; HN https://news.ycombinator.com/item?id=49747070 ; workshop prompt https://news.ycombinator.com/item?id=49753616 . Eleven days after the Cantrill thread, same wave, and its copyeditor-not-ghostwriter loop is what this design adopts.

**Prior art**
- Lucid https://writelucid.cc ; Margins https://github.com/vivekhaldar/margins ; Obsidian AI Editors https://community.obsidian.md/plugins/editor-ai-daemons
- iA Writer Authorship https://ia.net/topics/see-what-ai-wrote and https://github.com/iainc/Markdown-Annotations
- Scraft https://arxiv.org/abs/2304.10543 ; IdeaForge https://news.ycombinator.com/item?id=47059652
- Wikipedia, "Signs of AI writing", https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing
- Williams, *Style: Lessons in Clarity and Grace*; McEnerney, "The Craft of Writing Effectively", https://singjupost.com/the-craft-of-writing-effectively-larry-mcenerney-transcript/

**Protocols and packages** (versions from npm on 2026-11-10)
- AHP: https://github.com/microsoft/agent-host-protocol , https://microsoft.github.io/agent-host-protocol/guide/ahp-and-acp , `@microsoft/agent-host-protocol@1.0.0`
- ACP: https://agentclientprotocol.com/protocol/overview , `/protocol/initialization` , `/protocol/prompt-turn` , `/protocol/session-modes` , `/protocol/tool-calls` , https://agentclientprotocol.com/overview/agents . The v1 schema in `@agentclientprotocol/sdk@2.6.0` is a reference only; the client is the lifted one.
- Claude adapter: `@agentclientprotocol/claude-agent-acp`. Claims were read on 0.101.0; the latest is 0.106.0. The pin is set by step 0.
- Later engines: `@agentclientprotocol/codex-acp@2.6.0` (never the unscoped `codex-acp`, which is an unrelated project); `opencode-ai@1.19.5`; `@google/gemini-cli@0.68.0` with `--acp`.
- MCP TypeScript SDK: https://github.com/modelcontextprotocol/typescript-sdk , `@modelcontextprotocol/sdk@1.32.2`

**Your own code**
- i-inc: `firstprateek/i-inc` at `274b42b` (`~/projects/i-inc-dev`): `docs/design/ahp-spike.md`, `docs/design/conversations.md`, `apps/daemon/src/ahp/*`, `apps/web/src/ahp/*`, `tools/m1/acp-probe.ts`
- Site: `git@github.com:firstprateek/personal-website-astro.git` at `f493459`: `src/site.config.ts`, `src/content.config.ts`, `src/lib/content.ts`, `README.md`, `DEPLOY.md`, `.claude/skills/verify/SKILL.md`
