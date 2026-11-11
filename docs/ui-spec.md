# Sparring prototype specification: Galley, with grafts

Clickable HTML prototype, static data, no backend. One `index.html`, one `styles.css`, one `app.js`, hash routing. Everything below is final copy unless marked *(sample)*, in which case it is the seeded demo content and should ship verbatim as the prototype's data.

## 0. Foundations

### Tokens

Define on `:root` with `color-scheme: light dark`. Every colour in the prototype is one of these six; nothing else is allowed in the stylesheet.

| token | light | dark | used for |
|---|---|---|---|
| `--bg` | `#fcfbf8` | `#15161a` | page and every surface |
| `--subtle` | `#f1efe9` | `#1e2026` | span highlight on hover, read-only page during publish, focused row |
| `--text` | `#1a1a1a` | `#e6e3dc` | prose, current stage, live actions, filled Publish button |
| `--muted` | `#6b6760` | `#9a968e` | apparatus, coach body text metadata, inert actions, syntax characters |
| `--rule` | `#dedbd3` | `#2c2e35` | every 1px line, dotted margin rule |
| `--accent` | `#b4521a` | `#e0804a` | anchor bars, anchor ticks, unread dot on a leaf, focus ring. Nowhere else. |

`--muted` on `--bg` measures 5.3:1 light and 6.5:1 dark. Write `light-dark()` for each. Add a `data-theme="light|dark"` override on `html` and a mono `theme` link at the far right of the Articles header so the user can flip without the OS. No red, green or yellow anywhere, including the Publish checks.

### Type

- `--serif`: `"Source Serif 4", Georgia, serif`. Page 17px / 1.65. Note bodies and chat bodies 15px / 1.5.
- `--mono`: `"JetBrains Mono", ui-monospace, monospace`. All apparatus 12px / 1.4. Nothing in mono is smaller than 12px.
- No bold anywhere. No italics except quoted spans inside a note on phone. Headings in the page are serif at 17px with `##` in `--muted`; the prototype does not render Markdown, it types it.

### Measures

- Page column: `min(68ch, 100% - 3rem)` measured in the serif at 17px (about 578px). Gutter for anchor bars: 24px to the left of the column, inside the measure's outer box.
- Margin: 280px open, 28px collapsed, 400px during `ideas` and `interview` (the Thread graft). Separated from the page by a 1px dotted `--rule`.
- Running head 40px, running foot 32px, both full width with a 1px solid `--rule` on the inner edge.
- Radii: 2px on the composer and the Publish button only. Everything else is square.
- Hit areas: any mono text action has a 44px tall invisible hit box (padding, not visible). Rail ticks on phone take the paragraph's right 44px.

### Routes

`#/articles` · `#/room/<slug>` · `#/room/<slug>?leaf=dump|brief|article` · `#/room/<slug>?view=resume` (shows the resume letter) · `#/room/<slug>?view=log` · `#/room/<slug>/publish` · `#/room/new` (empty page). Phone layout kicks in at `max-width: 600px`; add a `?frame=phone` flag that wraps the app in a 375×812 box on the laptop so the user can click the phone version without devtools.

### MVP honesty

The page is a `<textarea>`. Anchor bars sit at the *paragraph* that contains the span, computed from a hidden mirror `<div>` with identical font metrics (this mirror is in scope; it is thirty lines of JS). Margin notes are a stacked list in anchor order, each note starting at its paragraph's y when space allows and otherwise pushed down. Span-level highlight on hover and the pasted-word underline are drawn on the mirror behind the transparent textarea. Label this in a one-line mono footer of the prototype's README: `per-paragraph anchors; per-line is the CodeMirror 6 milestone`.

## 1. Articles

Grid: single column, `min(68ch, 100% - 3rem)` centred, 40px running head above.

Running head, mono 12px: left `sparring`, right `claude · 41k tok · theme`. 1px rule below.

Body, top to bottom, 24px gaps:

1. Idea prompt. One line, mono 12px, a `>` in `--muted` then a borderless input, placeholder empty, caret blinking. Enter appends to the inbox list below with today's date and clears. Esc blurs. No button.
2. `inbox` (mono, `--muted`). Each line: `11-06` in `--muted`, text in serif 15px `--text`, and on hover (always on phone) a mono `→ article` at the right. Clicking `→ article` replaces the line in place with `slug  ____________  ↵` and Enter navigates to `#/room/<slug>`. On phone a long press (500ms) does the same.
3. 1px rule.
4. `articles` (mono, `--muted`). Rows, 12px padding, no borders, `--subtle` background on hover or `j`/`k` focus. Each row:
   - Line 1: serif 17px title in `--text`; mono tail right-aligned in `--muted`: stage word (or `interview 4/6`), words, `·n` open, last save. Published rows show `PR #4` as the tail, a link.
   - Line 2 (Thread graft): the coach's open question for that article, serif 15px `--muted`, one line, truncated with `…`. Published rows show the last host line instead.
   - Hover swaps the tail's last-save for `18k tok`.
5. `+ new article` mono, `--muted`, turns `--text` on hover, goes to `#/room/new`.

Keys: `j`/`k` move, `Enter` open, `n` new, `i` focus the idea prompt.

*(sample)* inbox:
```
11-06  the cache lied for three weeks and nobody noticed            → article
11-02  every "AI pair" demo is recorded on a laptop that never sleeps → article
```
*(sample)* articles:
```
The laptop lid is a chaos monkey            draft    612w  ·6  2h
  Which number did you actually measure, the thirty seconds or the eleven minutes?
The interview is the product                interview 4/6   ·1  3d
  Who exactly reads this, and what do they lose if they don't?
Config is not a feature flag                polish  1210w  ·0  9d
  nothing in this pass · cut
Three worktrees, one site                   PR #4
  build finished · PR #4 is open
```

Empty state: the `>` prompt and the rule under it. Nothing else.

## 2. Room, laptop (1280)

Grid: `grid-template-rows: 40px 1fr 32px`. Middle row: `grid-template-columns: 1fr [page] 1fr [margin]` where the page occupies its measure plus 24px gutter, centred in the viewport when the margin is collapsed and shifted left by half the open margin width when open (transition `transform 200ms ease-out`). The margin is `position: sticky` to the viewport top, full height, scrolls independently.

### Running head

Mono 12px, one line, 1.5rem side padding. Left to right:

- `← articles` (link).
- Slug, `--muted`.
- Leaves: `dump · brief · article`. Current leaf `--text`, others `--muted`. Click switches the textarea content and the margin notes. `Cmd+1/2/3` also switches. When the interview is done and `brief.md` is empty, `brief` carries a 4px `--accent` dot after it.
- Brief line (Judge 1 missing #4): when the leaf is `article` and `brief.md` has a thesis, the thesis appears in the middle of the head in serif 13px `--muted`, truncated to one line. Hover shows reader too, as a second line sliding down under the head. Absent on phone.
- Stage word with `▾` at the far right: `draft ▾`. Click drops a seven-line mono list, 160px wide, `--bg`, 1px `--rule` border, no shadow: `ideas / interview 4/6 / outline / draft / critique / polish / publish`. Current in `--text`, others `--muted`. Under `interview` a second indented line lists `thesis reader evidence counter uncertainty scar` with covered topics in `--text` (Judge 3 missing #5). Clicking a later stage shows a one-line confirm in the list: `advance to critique · yes · no`. `publish` navigates to the sheet. Esc closes.

### The page

Transparent `<textarea>`, serif 17px/1.65, no border, no outline, `--text`, spellcheck off, caret `--text`. Behind it the mirror div. Anchor bars: 2px wide, `--accent`, in the 24px gutter, spanning the paragraph height. Pasted agent words: 1px dotted `--muted` underline on the mirror, `title="these are the agent's words"`. Hovering a note or focusing one with `j`/`k` paints the span's background `--subtle` on the mirror. Clicking a bar opens its note in the margin and scrolls the margin to it. `dragstart` from anywhere in the margin or transcript calls `preventDefault()`.

### The margin

Width by stage: 400px when stage is `ideas` or `interview`, 280px otherwise, 28px when collapsed. `Cmd+.` toggles. Collapsed: each note is a mono 12px mark at its paragraph's y: `unc sup cou det fil voi typ cut rep pas` or `?` for a question. Clicking any mark opens the margin on that note.

Open, top to bottom:

1. **Letter** (host-as-divider graft). Zero or more host lines, mono 12px `--muted`, each between two 1px rules. Examples with final copy: `write refused · the coach tried to edit article.md · logged` ; `disk changed while offline · keep mine · take disk` ; `article.md changed outside a save · quarantined as article.agent.md · restore it` ; `running filler… 12s` (the counter ticks every second; on completion the line becomes `filler · 4 notes` and fades after the next turn); `nothing in this pass · cut` (fades after the next turn).
2. **Filter line** (Workbench graft), mono 12px, shown only when more than five notes exist: `all 12 · open 6 · critique 3 · filler 2 · voice 1 · stale 2`. Each count is a toggle, `--text` when active, `--muted` when not. Notes sort by position in the page, never by time.
3. **Notes**, in page order, 16px apart, each positioned at its anchor's y when free, pushed down on overlap. Component in section 4.
4. **Shelf**: a 1px rule labelled `shelf` in mono `--muted`; stale notes stack under it in `--muted`. Never deleted.
5. **Composer**, pinned to the bottom of the margin with a 1px rule above. Mono 12px, `>` prompt in `--muted`, a borderless textarea that grows from one to three lines then scrolls. Typing `/` opens the slash list above the composer: `/next /ask /critique /reader /pass /queue /strict /interview /outline /stage /idea /mute /quiet /publish /log`, each with a `--muted` argument hint (`/pass filler buried-verbs passive repeats topic-sentences cut voice typos tells`). `Cmd+Enter` sends. Plain text is a reply to the coach. The composer also parses the comment grammar (Judge 2 missing #1): `done c08`, `dismiss c11`, `dismiss c11 on purpose`, `re c09: …`, `mute c11`. Every note button emits exactly these strings into the transcript, so the buttons are shortcuts for the grammar and nothing more.

**Interview mode** (stage `ideas` or `interview`, leaf `dump`): the margin is 400px and shows the transcript inline instead of the letter: coach turns in serif 15px `--muted`, writer turns in serif 15px `--text` with no decoration, host dividers between rules. The coach's verbatim-quote bullets anchor to the dump as `?` marks. The current question is also the last turn, so there is nothing to hide behind a log. When the coach's turn says the interview is done, the host divider reads `interview done · brief.md is yours`, the `brief` leaf gets its dot, and switching to `brief` shows three serif placeholders typed as labels in mono: `thesis`, `reader`, `arc`, each an empty line, with the coach text hidden and the dump's quoted spans listed in `--muted` at the margin top (Judge 3 missing #2). When the stage reaches `outline` the margin animates to 280px over 200ms.

### Transcript overlay

`⋯` in the foot, `/log`, or `Cmd+L`. Slides over the margin at the margin's width, `--bg`, 1px rule on its left, 200ms. Mono timestamps `--muted` left, bodies serif 15px: coach `--muted`, writer `--text`. Comment tool calls render as one mono line each: `comment c08 · unsupported · ¶4` with a 4px `--accent` dot that scrolls the page to the span. The agent turn that produced comments carries a right-aligned mono trailer `c07 c08 ·` (the dot is the unread marker, Thread graft). Esc closes and returns focus to the page caret.

### Running foot

Mono 12px, 1.5rem padding. Left: `612 words · saved 12s · em 0 · ¶1 1 · not-x-but-y 1 · pasted 0`. Right: `6 open · ⋯`. `Cmd+S` replaces `saved 12s` with `a41c9e2` for two seconds. Clicking any tell count expands the Tells table upward from the foot (section 7). Clicking `pasted n` cycles the caret through underlined spans. Clicking `6 open` opens the margin.

### Command palette (Workbench graft)

`Cmd+K`: 560px popover anchored top centre of the page column, mono 13px, `--bg`, 1px `--rule` border, no shadow, 2px radius. One input. Starting with `/` lists commands as in the composer. Anything else searches note bodies, the brief and page headings; results are mono: `c10 · detail · "eleven minutes"`, `brief · reader`, `## What actually dies`. Enter jumps: a note opens in the margin with the caret at its span; a heading moves the caret. Esc closes.

### Keys

`Cmd+.` margin · `Cmd+/` composer · `Cmd+K` palette · `Cmd+L` transcript · `Cmd+1/2/3` leaves · `Alt+J`/`Alt+K` next and previous open note, caret moves to the anchor and the note opens · in the margin `j`/`k` walk, `d` done, `r` disagree, `x` dismiss, `Shift+X` dismiss on purpose · `Cmd+Enter` send · `Cmd+S` save · `Cmd+Shift+P` publish · `Esc` always returns to the page caret.

### Arrival

Marks do not appear while the writer is typing. They queue until the page has had no input for 4 seconds, then fade in over 400ms in `--accent`. The foot's open count ticks as they land. After the writer scrolls past a mark once, it settles to `--muted`. `/quiet` collapses the margin to zero and centres the page; the foot shows `quiet` in place of the open count.

## 3. Room, phone (375)

Grid: `grid-template-rows: 40px 1fr 44px`. Page full width, 1.5rem gutters, serif 17px. No leaves in the head; the head is `←  closed-laptop  draft ▾`, stage word opens the seven-line list as a bottom sheet. Swiping the head left or right cycles leaves, and the head flashes the leaf name in mono for one second; the stage sheet also lists `dump · brief · article` as a top row, so the post-interview "go write the brief" step has a tap path.

Mark rail: the right 16px of the page is a dotted 1px `--rule`; anchored paragraphs show a `╂` tick in `--accent` (or `--muted` once seen). The tap target is the paragraph's right 44px. Tap: the sheet rises to half height with that note; the page scrolls so the span sits 24px above the sheet with a `--subtle` highlight.

Running foot, 44px, is the sheet handle: `612w · saved · 6 notes  ▴`. Drag or tap to open. Sheet contents in order: `log` link top right, letter lines, filter line, notes in page order (each showing its span's first line in `--muted` italic above the body, because the page is scrolled away), shelf, composer. In the sheet the composer is also reachable by a `>` button at the right of the handle, so answering an interview question is one tap, not a scroll past the notes.

Default sheet height by stage: full when stage is `ideas` or `interview`; full on `critique`/`polish` when unread notes exist (the morning after `/queue`); peek otherwise.

Focused edit (Judge 2 missing #2): each note on phone has a fourth mono action, `edit`, which opens a sheet containing only the anchored paragraph in a serif textarea, span highlighted, keyboard up, with `save · back` in mono. Saving writes the paragraph back and enables `done` on return.

The keyboard mic is the dictation path everywhere. No tab bar. Nothing scrolls horizontally; `pre` wraps with `overflow-wrap: anywhere`.

## 4. The margin note

```
unsupported · c08 · brief: evidence

"the server dropped it after thirty
seconds of silence"

Which server, and did you measure the
thirty seconds or assume them? The dump
says "it just dropped". The reader you
named will want the number or the
admission.

done   disagree   dismiss
·edit the span first
```

- Header: mono 12px `--muted`: kind, id, brief line or `no brief line`. Hovering the brief line reference highlights that line in the `brief` leaf if it is open (Workbench graft).
- Quoted span: serif 15px `--text`, the only quotation marks in the note. On laptop it is shown only when the page is scrolled away from the anchor; on phone always.
- Body: serif 15px `--muted`. Any quoted evidence from the writer's text is in `--text` inside quotes.
- Actions: mono 12px, space separated, no borders, 44px hit boxes.

States:

| state | render |
|---|---|
| **open, unedited** | `done` in `--muted`, inert, hint line `·edit the span first` under it. `disagree` and `dismiss` in `--text`. |
| **open, edited** (span changed or writer typed since arrival) | `done` turns `--text`, hint line gone, no animation. |
| **disagree** | actions row replaced by a one-line mono input prefixed `re c08:` with `send · cancel`. On send the note's header gains `disagreed · awaiting`, the transcript receives `re c08: …` in the writer's voice. The coach's reply threads under the note with a 1px connector: either `withdrawn` in the header and the body collapsed, or a sharpened body with a `v2` tag. |
| **dismissed** | collapses to the header line only, plus a second mono link `on purpose, stop flagging this`. Clicking it appends to `STYLE.md`, shows the appended line in the foot for one second (`STYLE.md ← do not flag: "it is important to note"`), and the link becomes `muted`. |
| **done** | header gains `done`, body collapses, note moves to the bottom of the list above the shelf in `--muted`. |
| **stale** | `--muted`, loses position, stacks under the shelf rule. |

Absent: avatar, timestamp, copy, apply, insert, accept, reactions, borders.

*(sample)* disagree exchange for c09, in the transcript:
```
10:41  re c09: the retry path is fine when the child survived. my daemon only
       reconciles when the socket was down for more than its own keepalive.
       the comment reads as if every wake pays the round trip.
10:41  coach   Sharpened. You say that in dump.md ("only when the socket was
       actually gone"). The draft says "on wake, the daemon reconciles" with
       no condition. Put the condition in the sentence or the counter stands.
       c09 v2
```

## 5. Resume letter

Shown at the top of the margin (laptop) or sheet (phone) when the article was last opened more than 24 hours ago. Mono 12px `--muted`, one fact per line, between two rules, computed by the host with no agent:

```
stage draft · saved 9d ago
open question: which number did you actually measure, the thirty seconds or the eleven minutes?
3 unread notes · c08 c10 c12
you dismissed: c11 filler (on purpose)
```

Clicking an id opens that note. The letter disappears after the first keystroke in the page.

## 6. Empty states and host events

- `#/room/new`: head reads `← articles  new-article  dump · brief · article  ideas ▾`; the page is blank with the caret; the margin collapsed; the foot reads `0 words`. No placeholder. The slug field appears inline in the head where the slug would be, `slug ____ ↵`.
- Empty margin: the dotted rule and nothing else.
- `nothing in this pass · cut`: one letter line.
- Write refused: `write refused · the coach tried to edit article.md · logged` as a letter line, and the same line as a host divider in the transcript.
- Reconnect (phone over Tailscale): a letter line `reconnecting… 4s` ticking; sends made during it queue and show `queued` in the composer in `--muted`; the foot's `saved` becomes `unsaved · retrying` until the save lands.

## 7. Tells table

Expands up from the foot, mono 12px, two columns, `--text` numbers, no colour:

```
em-dash                0
single-sentence ¶      1
not-X-but-Y            1
genuinely              0
rule-of-three          2
sentence-length σ      7.9   (dump 11.2)
first-person          11%    (dump 27%)
counts, not verdicts. Cantrill's own post trips this.
```

Each nonzero row expands to its hits; each hit shows the span and clicking it moves the caret and paints a `--muted` tick in the gutter. The last line is the fixed footer in `--muted`.

## 8. Publish sheet

Laptop: replaces the margin at 400px; the page stays visible, read-only, `--subtle` background. Phone: full-height sheet. Mono 12px throughout; values are inline-editable serif 15px. 1px rules between groups. 24px padding.

*(sample, filled)*:

```
publish                                      origin/main · clean
title        The laptop lid is a chaos monkey
slug         closed-laptop
description  Closing a laptop does not crash a coding agent; it
             leaves one confident about a world that stopped.
date         2026-11-07
draft        false

before you ship, three questions (stored, not published)
what did you learn writing this?
> that the bug was never the suspend, it was my trust in the transcript
would you say this to a friend?
> yes, I said most of it to Dev on Tuesday
who is this for and what do they lose?
> people building agent runtimes; they lose a week to a spinner

provenance
questions asked 11 · comments 19 · done 12 · dismissed 3
disagreed 1 · violations 0 · pasted words 0
agent-word spans in the text  1
  [ ] "treat the transcript as stale" (¶9, from interview q6)
      I chose these words
disclosure line: none. Type one into the body if you want one.

checks
✓ site.config has no placeholders
✓ headings start at ##
✓ no ![ in body

build and open PR                 disabled: 1 span unticked
```

- Slug duplicate: if the slug exists on `origin/main` the slug line gains `exists · branch post/closed-laptop-2 · diff` in `--muted`; clicking `diff` shows a plain unified diff in mono under the checks.
- The button is the only filled element in the app: `--text` background, `--bg` text, 2px radius, 36px tall. Disabled: `--muted` background, reason text beside it. Ticking the box enables it.
- Clicking it streams a mono log under a rule, one line every 600ms in the prototype: `$ git worktree add ~/.sparring/worktrees/closed-laptop -b post/closed-laptop` · `$ npm ci` · `$ npm run build` · `✓ built 41 pages in 6.2s` · `$ gh pr create --fill` · `https://github.com/firstprateek/personal-website-astro/pull/5` (a link). The stage word becomes `published`; the Articles row tail becomes `PR #5`.

## 9. Sample data

### article.md *(sample, 612 words)*

```
## The lid is the first failure you meet

I spent six years on a UI framework where the hardest bug was always the one between two renders. Nothing was wrong in either frame; the wrong thing was the gap. Agents have the same gap, and the lid of a laptop is where you find it.

The setup is ordinary. You start a coding agent on a task that will take twenty minutes, you close the lid to walk to a meeting, you open it on the other side of the building. What you expect is the agent where you left it. What you get depends on about six things nobody wrote down.

## What actually dies

The process does not die. macOS suspends it, and when the lid opens it is still there with its stack intact. What dies is everything the process believed about the outside world. Its WebSocket to the model is gone; the server dropped it after thirty seconds of silence and the client will not know until it tries to write. Its child process, the one running the test suite, got SIGSTOP and SIGCONT and now has a wall-clock timer that thinks nineteen minutes passed in zero. The file watcher missed every event. And the model, which was mid-stream when the socket went, has finished its turn into a void. The tool call it emitted was never acknowledged, so from the model's side the turn is complete and from the agent's side it never happened.

It is important to note that none of this is a crash. Every component is healthy. The agent is not broken, it is very confident about a world that stopped existing.

## The frame between two frames

In the framework we had a rule: never trust state you did not compute this frame. It was expensive and we argued about it for a year, but it was the only rule that survived contact with a tab being backgrounded for six hours. I think agent runtimes need the same rule and mostly do not have it. The agent keeps a transcript, and a transcript is a cache of what the world was. When the lid opens, the honest move is to treat the transcript as stale and re-derive: is the socket alive, did the child exit, what is on disk now versus what I think I wrote.

The runtimes I have read do something cheaper. They retry the socket and carry on. The transcript says the test suite is running, so the agent waits for a result that will never come, and the user watches a spinner for eleven minutes before killing it.

## What I did about it

I built a small daemon that owns the session instead of the agent owning it. The agent is a child the daemon can lose. On wake, the daemon reconciles: it reopens the socket, asks the model to replay from the last acknowledged turn, diffs the working tree against the last commit it made, and only then lets the agent see anything. The agent's first message after a lid-close is a system line it did not write: what changed while you were out.

It is not elegant. The replay costs tokens and the diff is sometimes noisy. But it is the first version where closing the lid stopped being a thing I had to remember not to do, which is actually the whole point of a tool that is supposed to work while I am not looking at it.

That is the test I want for every agent runtime now.
```

### Comments *(sample)*, in page order

| id | kind | span | brief | body |
|---|---|---|---|---|
| c07 | unclear | "about six things nobody wrote down" | brief: arc | You then name four: socket, child, watcher, model. Six is a count the reader will check. Which are the other two, or is the number wrong? |
| c08 | unsupported | "the server dropped it after thirty seconds of silence" | brief: evidence | Which server, and did you measure the thirty seconds or assume them? The dump says "it just dropped". The reader you named will want the number or the admission. |
| c11 | filler | "It is important to note that" | no brief line | Six words before the sentence starts. The sentence after them is the strongest in the section. |
| c12 | voice | "which is actually the whole point of a tool that is supposed to work while I am not looking at it" | brief: thesis | The dump says "I want to close the lid and not think about it." Eleven words. The draft explains the same thing in twenty-two. Which one sounds like you? |
| c09 | counter | "The runtimes I have read do something cheaper." | brief: counter | The smartest person who disagrees says retry-and-continue is right for nearly every wake and your reconcile taxes all of them for the rare one. The brief names this counter. The draft does not answer it. |
| c10 | detail | "the user watches a spinner for eleven minutes" | brief: scar | Was this you? The dump says "I sat through a whole standup watching it." That is the lived moment; the draft has an anonymous user. |

Statuses for the prototype: c07 open, c08 open and unedited, c09 disagreed with the v2 above, c10 open, c11 dismissed on purpose, c12 open and edited (so `done` is live on exactly one note).

### dump.md *(sample)*

```
ok so the thing that keeps biting me. I close the laptop with the agent mid task and when I open it the thing is just sitting there confident. not crashed. confident. the socket is dead, it just dropped, the test runner child got stopped and its timers are garbage, and the model finished its turn into nothing so the tool call never came back. none of that is an error. that is what makes it bad.

this is the same bug as the framework. the between frames bug. we had the rule never trust state you did not compute this frame and people hated it and it was right. agents keep a transcript and the transcript is just a cache.

I sat through a whole standup watching it spin. eleven minutes maybe. then killed it.

what I did: daemon owns the session, agent is a child. on wake it reconciles only when the socket was actually gone. reopen, replay from last ack, diff the tree, then let the agent see. first message after wake is from the daemon not the agent.

I want to close the lid and not think about it. that is the whole thing.
```

### brief.md *(sample)*

```
## thesis
Closing a laptop does not crash a coding agent; it leaves one confident about a world that stopped existing, and runtimes should treat the transcript as stale on wake.

## reader
Someone building or operating an agent runtime, who has watched a spinner after a sleep and blamed the model. They lose the week I lost.

## arc
The lid as the ordinary failure; what dies and what does not; the framework rule; the cheap fix most runtimes make; the daemon; the test I want.

## Questions
> "the test runner child got stopped and its timers are garbage"
Which timer, and how did you find out?
> "only when the socket was actually gone"
How does the daemon know? Keepalive, or an error on write?
```

### Interview transcript *(sample)*, 10 turns

```
coach   Read the dump. Your words, not mine:
        · "not crashed. confident."
        · "the transcript is just a cache"
        · "I sat through a whole standup watching it spin"
        · "daemon owns the session, agent is a child"
        · "I want to close the lid and not think about it"
        Which of these is the thing you want to say?
you     the confident one. not crashed, confident.
coach   Say the claim in one sentence, your words.
you     closing the lid doesn't break the agent, it leaves it sure about a
        world that's gone, and the runtime should assume that on wake.
coach   You wrote "the runtime should assume that on wake." Who exactly
        reads this, and what do they lose if they don't?
you     people building agent runtimes. they lose the week I lost blaming
        the model for a dead socket.
coach   "the week I lost." What did you see first-hand? Name the incident.
you     tuesday. closed the lid for standup, came back, the test runner
        was "running" for eleven minutes. nothing was running.
coach   You wrote "the transcript is just a cache." What would the smartest
        person who disagrees say?
you     that retry and continue is right 95% of the time and my reconcile
        step taxes every wake for the one bad one.
coach   Which part are you least sure of?
you     whether the thirty second drop is the server or my keepalive. I
        never actually measured it.
coach   "never actually measured it." What did you get wrong along the way?
you     I blamed the model for a month. wrote a bug report against the
        provider. it was my socket.
coach   I can restate thesis, reader and arc in your sentences. Interview
        done. brief.md is yours.
──────────────── interview done · brief.md is yours ────────────────
```

## 10. Alternatives considered

**Thread: the interview is the draft.** One chat per article; messages you send are filed under a heading you typed, and that file is the article, so there is no separate editor to go to. It is the best phone interview of the three and the only concept a generic AHP client gets for free, which is why its Articles preview line, host dividers and unread trailer are grafted here. It lost because writing a 1,500-word piece one paragraph per send, with a destination line to manage and a mirror that breaks after heavy editing, fights the two-hour laptop session, and because a composer whose output lands in the article is the shape the never-write principle exists to forbid, even when the bytes are yours.

**Workbench: a two-pane writing IDE.** Editor centre, vertical stage strip left, a 400px tabbed rail (coach, comments, brief, tells) right, filled status band, `Cmd+K` palette. Its keyboard table, palette-as-search, filter line, Tells table and MVP honesty were the strongest engineering in any concept and are grafted here. It lost because the frame is unmistakably an AI IDE rather than the published page, and because it typesets the coach's sentences in the same serif, size and column as the article, which is the one typographic choice that invites lifting.