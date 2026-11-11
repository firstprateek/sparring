# "Send it": a drafted mode for the Sparring mocks

Sparring is a writing coach that never writes: the writer writes every sentence, the coach asks and critiques in the margin. The owner now wants an escape hatch. After a bit of brainstorming (a dump and some interview answers) they want to say "send it": the coach writes the whole draft, and the writer then refines it alone by reviewing it. You are adding that mode to ONE page of the clickable HTML mocks. Other agents are doing the other pages at the same time from this same spec, so follow the shared parts exactly.

Pages: site/room.html (laptop Room), site/phone.html (phone draft), site/publish.html (publish sheet), site/phone-interview.html (phone interview). Edit only the one page you were given. Read it in full first. The page rules it already follows are in BRIEF.md (same folder); they still apply (tokens only, no literal colours, real buttons, focus-visible, no alert/confirm/prompt, targeted DOM updates that never replace a focused textarea, textarea autosize fallback, no horizontal scroll at 390px, no em-dashes or emoji in copy you add, index.html is not yours).

## Product rules of the mode

- Two modes per article: `coached` (default, everything as it is today) and `drafted`.
- "send it" switches the article to drafted: the never-write rule is off for this one article, the coach writes article.md from dump.md and brief.md, and whatever was on the page moves to the shelf.
- Every block the coach wrote carries a provenance bar: a 2px DOTTED vertical bar in the accent colour beside the block. When the writer edits the block the bar turns dotted muted ("edited"). When at least half of the block's words are the writer's own the bar disappears ("yours"). Headings are blocks too.
- In drafted mode the coach is quiet: no margin notes until the writer asks with /critique (or /pass). The writer reviews alone.
- The page shows how much of the text is the writer's: "N% yours".
- Publishing a drafted article never blocks: it lists the blocks that are still entirely the coach's words; the writer ticks "I chose these words" on each (or "tick all") and ships.
- The writer can go back: "coached again" discards the coach's draft and restores the page.

## Shared state (exact; all localStorage access inside try/catch; every page must also work when storage throws or is empty)

- `sparring-mode`: the string `drafted`, or absent for coached.
- `sparring-draft`: JSON `{"v":1,"text":[12 strings],"state":[12 of "agent"|"mixed"|"yours"],"yours":<integer 0..100>}`. `text` is the article's 12 blocks in order, headings as `## Heading`. Written by Room and Phone on every provenance change (debounce is fine). Absent in drafted mode means: the sample ARTICLE text, every block `agent`, yours 0. Ignore it unless it parses, `v === 1`, and both arrays have length 12.
- Going to coached removes both keys.

## Shared provenance maths (exact)

```js
function words(s) { return String(s).replace(/^## /, '').toLowerCase().match(/[a-z0-9'’]+/g) || []; }
function newWords(orig, cur) {            // words in cur that the coach's block did not have
  var bag = {}, n = 0, cw = words(cur);
  words(orig).forEach(function (w) { bag[w] = (bag[w] || 0) + 1; });
  cw.forEach(function (w) { if (bag[w] > 0) bag[w]--; else n++; });
  return { n: n, total: cw.length };
}
function blockState(orig, cur) {
  if (cur === orig) return 'agent';
  var r = newWords(orig, cur);
  return r.total > 0 && r.n / r.total >= 0.5 ? 'yours' : 'mixed';
}
// overall: yours = Math.round(100 * sum(n) / max(1, sum(total))) over the 12 blocks
```
`orig` is always the page's sample ARTICLE block (the mock pretends the coach wrote exactly that text). `cur` is the textarea's value (or the stored text on load).

## Shared look (exact CSS, adapt only selectors/placement to the page)

```css
.prov{width:2px;align-self:stretch;flex:none;background:repeating-linear-gradient(to bottom,var(--accent) 0 3px,transparent 3px 6px)}
.prov.mixed{background:repeating-linear-gradient(to bottom,var(--muted) 0 3px,transparent 3px 6px)}
```
A block with state `yours` has no bar. The bar is a plain `<span class="prov" aria-hidden="true">` and the block's textarea gets `aria-description` "written by the coach" / "written by the coach, edited by you" (removed when yours). It must not collide with the existing solid note mark: where both can appear, show both side by side with a 4px gap (dotted bar first).

Legend, wherever a page shows the quiet block (below): three small items in one mono muted row: a 12px-tall dotted accent bar + "coach", a dotted muted bar + "edited", and "no bar: yours".

## Shared proto-strip control (Room, Phone, Publish; not the interview page)

Add one button to the existing proto strip, after the theme button: id `proto-mode`, text `mode · coached` or `mode · drafted`, same styling as the theme button, 44px tall. Clicking toggles the mode instantly with no animation: to drafted = fresh draft (remove `sparring-draft`, set `sparring-mode`), to coached = remove both keys and restore the page's original sample state. It is scaffolding so each page's two states can be seen directly. The strip must still fit: at 390px it may wrap but must not cover the page's own controls (the phone page already measures the strip height; keep that working and re-measure after the label changes).

## Shared copy (use verbatim)

- Menu item, coached mode: `send it`
- Its confirm line: `the coach writes the draft from dump.md and brief.md · what is on the page moves to the shelf · yes · no` (yes and no are buttons)
- Menu item, drafted mode: `coached again`
- Its confirm line: `discard the coach's draft · your page comes back from the shelf · yes · no`
- Mode tag: `drafted · N% yours`
- Status strip (replaces "write refused · the coach tried to edit article.md · logged" while drafted): `drafted` · `the coach wrote article.md` · `never-write is off for this article`
- Quiet block, in this order: `the coach is quiet. this review is yours.` then `/critique when you want notes` then the counts line `12 ¶ · A coach · M edited · Y yours` then `N% of the words are yours` then the legend.
- While the draft streams in, the stage word reads `drafting…`
- Transcript/log lines on send it: host `mode coached → drafted · never-write is off for this article`; coach `write_draft article.md · 12 ¶ from dump.md and brief.md\nDrafted from your sentences where you had them. The review is yours; I stay quiet until you ask.`; and host `stage X → draft` only when the stage was not already draft.
- Log line on coached again: host `mode drafted → coached · the coach's draft moved to the shelf`
- Slash list addition (pages that have a slash list): `/sendit` with the hint `the coach writes the draft; you review alone`

## Page: site/room.html

1. Stage menu: after the stage list and before `publish →`, add the `send it` button (same `.it` look, muted), separated like `publish →` is. Clicking it shows its confirm line in the menu using the existing pending/confirm pattern (the stage-advance pending and the send-it pending are mutually exclusive). In drafted mode the item reads `coached again` with its own confirm.
2. `/sendit` in the composer slash list; submitting `/sendit` opens the stage menu with the send-it confirm showing and moves focus to `yes`.
3. On yes (send it): close the menu, switch to the article leaf, set stage to draft, append the log lines, set the mode and persist. Then stream: empty the article column and append the 12 ARTICLE blocks one every 220ms (all at once under prefers-reduced-motion), each with its dotted accent bar. Stage word shows `drafting…` until the last block lands, then `draft`. Autosize each textarea as it lands. Blocks are editable.
4. Header: a muted mono tag `drafted · N% yours` just left of the stage button (hidden in coached mode). Footer: add `· N% yours` to the left group while drafted (hidden in coached mode).
5. Margin on the article leaf while drafted: the status strip copy above replaces "write refused…"; the filter row, the notes list and the shelf divider are hidden and the quiet block is shown in their place. The dump and brief leaves are unchanged.
6. Typing in an article block while drafted: recompute that block's state, update its bar and aria-description, the header tag, footer, and quiet-block counts, and persist `sparring-draft`. Never re-render the paragraph list while typing.
7. `/critique` or `/pass …` submitted in the composer while drafted: the existing behaviour still happens, and the quiet block gives way to the normal filter row + notes list (the coach is no longer quiet; the status strip stays). Note marks and provenance bars then sit side by side in the gutter. `state.edited` gating for "done" keeps working; after send it, `state.edited` starts empty.
8. On yes (coached again) and on the strip toggle back to coached: remove the keys, rebuild the article blocks from ARTICLE, restore `state.edited = {11: true}`, quiet off, tag/footer/quiet block hidden, original status strip back, log line appended.
9. On load: if `sparring-mode` is `drafted`, start in drafted mode without streaming, using `sparring-draft` text and states when valid.
10. The paragraph container currently gets its listeners attached inside `buildParas`; make sure rebuilding the article blocks does not attach listeners twice.
11. Below 760px the page is one column; the tag may wrap with the header. Nothing may scroll horizontally at 390px.

## Page: site/phone.html

Same behaviours as Room, fitted to the phone screen's own conventions (read how its stage menu, paragraphs, mark rail, sheet, composer and edit overlay work first):
1. Stage menu: `send it` / `coached again` with built-in confirm lines (add a small confirm row in the menu; the menu currently has none, so build one in the page's style).
2. On yes: stream the 12 blocks (220ms each, all at once under reduced motion), stage word `drafting…` then `draft`. Each block gets the dotted bar on its left edge, inside the existing left gutter, without shifting the text column.
3. Sheet handle while drafted: the `5 notes` part reads `N% yours` instead. Sheet body while drafted: the status strip copy and the quiet block instead of the filter row + notes. `/critique` or `/pass` in the composer brings the notes back (and the handle shows the notes count again, with `N% yours` kept in the footer).
4. Footer left while drafted: `drafted · N% yours` replaces the tells summary.
5. Editing a block (inline or through the edit overlay's save) recomputes its state and persists `sparring-draft`.
6. Proto strip `mode` button; on load honour `sparring-mode` (no streaming) and also `location.hash === '#drafted'` (set the mode, clear any stored draft, and stream once), which is how the interview page hands over.
7. If the composer has a slash list, add `/sendit`; either way submitting `/sendit` opens the stage menu with the confirm showing.

## Page: site/publish.html

1. Proto strip `mode` button. On load and on toggle read `sparring-mode` and `sparring-draft`.
2. Coached mode: exactly as today (one agent-word span tick gates the button).
3. Drafted mode:
   - Read-only article: when a valid stored draft exists, set each of the 12 blocks' text from it (strip the leading `## ` for headings; blocks stay h2/p in place); otherwise keep the static text. Give each block whose state is `agent` or `mixed` the dotted bar at its left (in a gutter outside the text column so the measure does not change).
   - Provenance group: hide the two coached count lines and the single span tick. Show instead: `drafted by the coach · never-write was off for this article` (text colour), `12 ¶ · A coach · M edited · Y yours` and `N% of the words are yours`, then `blocks still entirely the coach's words` followed by the count, then one tick row per `agent` block in the existing `label.tick` style: `¶<n> "<first six words>…"` with `I chose these words` under it (checkbox ids `f-blk-<n>`), then a `tick all` button (plain mono text button) when there is more than one row. With zero rows show `every block has your words in it`. Keep the disclosure line.
   - The ship button is enabled when every listed row is ticked. Reason text: `disabled: N blocks unticked` (`1 block unticked`).
   - The header shows a muted `drafted · N% yours` tag before the stage word.
   - The build log and everything else are unchanged.
4. Switching mode after a build finished resets the build state.

## Page: site/phone-interview.html

1. The header's `interview N/6 ▾` becomes a real button that opens a small menu in the page's style (mono, 1px rule border, on var(--bg)) holding: the six stage names with interview current (non-interactive, muted except the current one), then `send it`. No proto-strip mode button on this page.
2. `send it` shows its confirm line in the menu. On yes: set `sparring-mode` to `drafted`, remove `sparring-draft` (both in try/catch), and navigate to `phone.html#drafted`. On no: back to the menu. Escape and an outside tap close the menu and return focus to the button.
3. Add nothing else to this page.

## Before you finish

- Extract every inline script to a temp file under `site/.check-<page>/` and run `node --check`; run a tag-balance check with `python3 -I` and html.parser; remove the temp folder.
- Re-read your diff for: listeners attached twice, a focused textarea being replaced, literal colours, storage outside try/catch, copy that differs from the verbatim strings above.
- Reply with: what you added (one line each), anything in this spec you could not do and why.
