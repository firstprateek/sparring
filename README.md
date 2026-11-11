# Sparring

A writing coach that lives in the margin. You give it rough ideas, it interviews you, and then it critiques while you write the article yourself. The page is the article. The coach never writes it, with one explicit exception you have to ask for.

**Status: design only.** The UI and the architecture are written down here. No product code exists yet.

## How it is meant to work

- One small daemon runs on a machine you own and holds every article as plain Markdown in a git repo.
- You reach it from a laptop or a phone over the Agent Host Protocol (AHP).
- The coach is any coding agent that speaks the Agent Client Protocol (ACP). Version one uses Claude.
- The coach can read your text and leave notes. It has no tool that edits the page.
- "Send it" is the exception: the coach writes one draft, every block it wrote stays marked until you rewrite it, and the page shows how much is yours.
- A finished article goes out as a pull request to an Astro site.

## What is here

| Path | What |
|---|---|
| [docs/design.md](docs/design.md) | The design document: workflow, architecture, drafted mode, data model, build steps, open decisions |
| [docs/ui-spec.md](docs/ui-spec.md) | The UI specification |
| [docs/drafted-mode-mock-spec.md](docs/drafted-mode-mock-spec.md) | The brief the "send it" mocks were built from |
| [mocks/](mocks/) | Clickable HTML mocks: articles, room, publish, phone, phone interview |

To try the mocks, open `mocks/index.html` in a browser. They are static pages with sample data and talk to nothing.

## Background

- Bryan Cantrill, [Your intellectual fly is open](https://bcantrill.dtrace.org/2025/12/05/your-intellectual-fly-is-open/)
