# Mines

A classic Minesweeper, as one dashboard — three standard difficulties, a guaranteed-safe first
click, chording, flags, a timer with a best time per difficulty kept in localStorage, and nothing
on the backend: every rule lives in the browser.

This bundle carries one element:

| kind | name | what it is |
|---|---|---|
| dashboard | `game-mines` | the game itself — frontend only, a one-route backend stub for the dashboard contract |

Install it:

```sh
adi-mono marketplace install <marketplace>/game-mines
```

It arrives archived, same as every dashboard — start it from the Dashboards page, or:

```sh
adi-mono marketplace start <marketplace>/game-mines/dashboards/game-mines
```

Then open it by its hostname. No secret, no project, nothing else to configure.

## Why no backend logic

Mines' entire rulebook — mine placement, flood fill, chording, win/lose detection — runs
client-side; there is nothing for a server to compute or to keep private. The backend half of
this dashboard exists only because the dashboard contract (`guides/dashboards.md`) needs one: it
is the template's own unmodified `backend/index.ts`, answering `/api/health` so the page's status
dot has something to poll, and nothing more. No route file was added.

## How it's built

`frontend/modules/game.ts` is the panel; `frontend/modules/.logic.ts` is the whole rulebook —
pure functions over a plain grid of booleans and counts, no DOM, no randomness that isn't passed
in as an argument. The dot in its name keeps it off the shell's auto-mounted panel list
(`guides/dashboards.md`'s module discovery lists every `modules/*.ts` that doesn't start with
`.`); the panel reaches it at runtime as a same-origin `./.logic.js` import, which the frontend
server resolves straight back to this file.

The rules:

- **first click is always safe**: mines aren't placed until the very first reveal, seeded off
  that click — the clicked cell and its whole eight-neighbour ring are excluded from mine
  placement, so the opening move always clears real space instead of risking a 1x1 island.
- **flood fill**: revealing a cell with zero mine-neighbours cascades outward through every
  connected zero cell, stopping at (but still revealing) the first ring of numbered cells around
  each pocket. A mine is never pushed onto the flood — only an explicit reveal of its own cell can
  uncover one.
- **chording**: clicking an already-revealed number whose flagged-neighbour count matches its own
  value reveals every other neighbour at once — the standard "I trust my flags" shortcut. A
  mismatched count is a no-op; a wrongly-flagged neighbour that turns out to be a mine still loses,
  exactly as an ordinary click on it would.
- **win**: every safe cell revealed, independent of whether every mine got flagged. **Lose**:
  any mine revealed — the board then reveals every mine and marks any wrongly-placed flag.

Three difficulties, same as the original: Beginner (9×9, 10 mines), Intermediate (16×16, 40
mines), Expert (30×16, 99 mines) — escalating both board size and mine density for a real
difficulty curve.

`frontend/modules/game.ts` renders this onto a DOM grid sized off one `--cell-size` CSS variable,
recomputed on resize so Expert's 30 columns fit (and scroll, inside `.mines__viewport`) on a
375px phone exactly as they do on a desktop. The same flat palette (the template's own ADI tokens)
covers light and dark.

Input: left-click/tap a hidden cell to reveal it, a revealed number to chord it; right-click or a
~450ms long-press (cancelled by a 10px finger move, so a scroll never flags) to flag a hidden
cell. Arrow keys move a visible keyboard cursor, Space/Enter reveals or chords it, `F` flags it.
Pause blurs the board and stops the clock without resetting it. Best time is
`localStorage["adi.gamemines.best.<difficulty>"]`, scoped to the browser, not the backend — there
is nothing server-side to lose it with.

## Checking it works

```sh
bun test test/mines-logic.test.ts
```

14 checks against `frontend/modules/.logic.ts` directly — no DOM, no server: the safe-first-click
guarantee (`placeMines`, `reveal`), flood fill cascading and stopping at flags
(`reveal`/`floodReveal`), chording on a matched, mismatched, and wrongly-flagged neighbour set
(`chord`), and win/lose detection either cell-by-cell or in one cascading click.

A second, optional check covers what the logic tests structurally can't: whether the win/lose
overlay is actually invisible when it should be. `.mines__overlay` sets `display: flex` (to centre
its card), and an author stylesheet rule always outranks the UA's own `[hidden] { display: none }`
at equal specificity — so a missing `.mines__overlay[hidden]` override renders the overlay (and
its "New game" button) permanently, over the board, regardless of the `hidden` attribute. Neither
`bun:test`'s DOM nor happy-dom compute CSS cascade, so this needs a real browser:

```sh
bun add -d playwright && bunx playwright install chromium   # one-time, not needed to play the game
bun test test/overlay-visibility.test.ts
```

It skips (with a warning, not a failure) if Playwright isn't installed — the dashboard itself has
no dependency on it.

## Licence

MIT.
