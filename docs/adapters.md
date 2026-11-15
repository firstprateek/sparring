# Adapters and the probe

The coach runs through an ACP adapter. For Claude that is `@agentclientprotocol/claude-agent-acp`.
The probe (`tools/acp-probe.ts`) checks a version of it before Sparring pins it.
It writes what it found to `docs/probe-claude-<version>.md`.

## 1. Install the adapter

```sh
bun tools/acp-probe.ts --install --version 0.101.0
```

This installs that exact version into `~/.sparring/adapters/claude/`, with a `package-lock.json`.
It never uses `npx` or `latest`.
Without `--install` the probe uses what is already there, and stops if the version differs.
On first run it also writes `~/.sparring/claude/settings.json`, the guard settings from the design.
It leaves an existing file alone.

## 2. Store the token

```sh
claude setup-token
bun tools/set-claude-token.ts
```

Paste the token at the prompt. Nothing is echoed.
A pipe works too: `pbpaste | bun tools/set-claude-token.ts`.
The token goes into `~/.sparring/config.json` as `claude_oauth_token`, mode 0600.
Other keys in that file are kept. The token is never printed.

## 3. Phase A (free)

```sh
bun tools/acp-probe.ts --version 0.101.0 --phase a
```

Phase A sends no prompt and spends no tokens.
It starts the adapter, runs the handshake and fills rows A1 to A4.
Run it once without a token and once with one; A1 only passes with the token.

## 4. Phase B (spends tokens)

```sh
bun tools/acp-probe.ts --version 0.101.0 --phase b
```

Phase B runs phase A, then sends three short prompts for rows B1 to B3.
Only the owner starts it, because it bills the subscription.

## Reading the result

Each row is `pass`, `fail`, `partial` or `not run`, with the raw values as evidence.
A failed A or B row stops the build.
The probe prints a scratch folder; its `transcript.jsonl` holds every message, with the token removed.
Rows M2 and M3 are not part of this probe.

To move the pin, install the new version, run both phases, and keep the report.

## Rows M2 and M3 (publishing), run 2026-11-15 on the Mac mini

- **M2, a launchd job reaches the site remote:** pass. `git ls-remote` over ssh (`BatchMode=yes`) from a
  `launchctl submit` job printed `refs/heads/main` and `exit 0`. The clone stays on ssh.
- **M3, the site keeps raw HTML:** yes. A post with `<script>alert(1)</script>` built with the script intact
  (Astro 7, Sätteri). Sparring's own refusal of raw HTML in a post is therefore the only guard; keep it.
- **First real publish:** a throwaway post went sheet → `post/publish-pipeline-test` → PR → CI → merge → GitHub
  Pages, then was removed on `main`. The daemon saw the merge and set `published_at`. Re-run M2 after a host move.
