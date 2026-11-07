// Mines — the panel. All rules live in ./.logic.ts (unit-tested, no DOM); everything here is
// rendering, input and persistence: drawing the board, keyboard/mouse/touch input (click to
// reveal, right-click or long-press to flag, click a revealed number to chord it), best time per
// difficulty in localStorage, pause, and the win/lose banners.

import {
  DIFFICULTIES,
  chord,
  newGame,
  remainingMines,
  reveal,
  toggleFlag,
  type Difficulty,
  type GameState,
} from "./.logic.js";

interface Ctx {
  dashboard: string;
  api: { base: string | null; get(path: string): Promise<unknown> };
  panel(title?: string): HTMLElement;
}

const DIFFICULTY_KEY = "adi.gamemines.difficulty";
const LONG_PRESS_MS = 450;
const MOVE_TOLERANCE = 10;

const DIFFICULTY_LABELS: Record<Difficulty, string> = {
  beginner: "Beginner · 9×9 · 10 mines",
  intermediate: "Intermediate · 16×16 · 40 mines",
  expert: "Expert · 30×16 · 99 mines",
};

const NUMBER_COLORS: Record<number, string> = {
  1: "#4A7FD6",
  2: "#4A9B5E",
  3: "#D65B4A",
  4: "#5B3F9E",
  5: "#8C5A3C",
  6: "#3E9B9B",
  7: "#2A2A2A",
  8: "#6F6C67",
};

// Drawn as inline SVG rather than an emoji glyph (🚩/💣): a headless or minimal Linux install
// commonly ships no emoji font at all, which renders either one as a tofu box — an SVG needs
// none, and looks the same everywhere.
const FLAG_ICON =
  '<svg viewBox="0 0 24 24" width="62%" height="62%">' +
  '<path d="M5 2v20" stroke="#E8532A" stroke-width="2.4" stroke-linecap="round"/>' +
  '<path d="M5 3 L19 7.5 L5 12 Z" fill="#E8532A"/>' +
  "</svg>";
const MINE_ICON =
  '<svg viewBox="0 0 24 24" width="62%" height="62%">' +
  '<g stroke="#2A2A2A" stroke-width="2" stroke-linecap="round">' +
  '<line x1="12" y1="2" x2="12" y2="22"/><line x1="2" y1="12" x2="22" y2="12"/>' +
  '<line x1="5" y1="5" x2="19" y2="19"/><line x1="19" y1="5" x2="5" y2="19"/>' +
  "</g>" +
  '<circle cx="12" cy="12" r="6" fill="#2A2A2A"/>' +
  '<circle cx="9.5" cy="9.5" r="1.4" fill="#fff"/>' +
  "</svg>";

function bestKey(d: Difficulty): string {
  return `adi.gamemines.best.${d}`;
}

function loadBest(d: Difficulty): number | null {
  const raw = Number(localStorage.getItem(bestKey(d)));
  return Number.isFinite(raw) && raw > 0 ? raw : null;
}

function saveBest(d: Difficulty, seconds: number) {
  localStorage.setItem(bestKey(d), String(seconds));
}

function loadDifficulty(): Difficulty {
  const raw = localStorage.getItem(DIFFICULTY_KEY);
  return raw === "beginner" || raw === "intermediate" || raw === "expert" ? raw : "beginner";
}

/** Three digits, like a classic Minesweeper counter — clamped so an absurd timer never breaks
 *  the layout. */
function secondsText(seconds: number): string {
  return String(Math.max(0, Math.min(999, Math.floor(seconds)))).padStart(3, "0");
}

/** The mine counter, which a careless over-flag can legitimately drive negative. */
function mineCounterText(n: number): string {
  const clamped = Math.max(-99, Math.min(999, Math.trunc(n)));
  return clamped < 0 ? `-${String(-clamped).padStart(2, "0")}` : String(clamped).padStart(3, "0");
}

export default async function gameMines(ctx: Ctx) {
  const root = ctx.panel("Mines");
  root.classList.add("mines");
  injectStyles();

  root.innerHTML = `
    <div class="mines__head">
      <select class="mines__select" data-difficulty>
        ${(Object.keys(DIFFICULTIES) as Difficulty[])
          .map((d) => `<option value="${d}">${DIFFICULTY_LABELS[d]}</option>`)
          .join("")}
      </select>
      <div class="mines__counters">
        <div class="mines__counter" title="Mines left"><span>mines</span><strong data-mines>000</strong></div>
        <div class="mines__counter" title="Time elapsed"><span>time</span><strong data-time>000</strong></div>
        <div class="mines__counter" title="Best time on this difficulty"><span>best</span><strong data-best>—</strong></div>
      </div>
      <div class="mines__actions">
        <button type="button" class="mines__btn" data-pause>Pause</button>
        <button type="button" class="mines__btn mines__btn--accent" data-new>New game</button>
      </div>
    </div>
    <p class="mines__hint">
      Click to reveal, right-click (or long-press) to flag. Click a revealed number to chord it.
      Arrow keys move the cursor, space/enter reveals or chords, F flags.
    </p>
    <div class="mines__viewport">
      <div class="mines__stage" data-stage tabindex="0">
        <div class="mines__board" data-board></div>
        <div class="mines__overlay" data-overlay hidden>
          <div class="mines__overlay-card">
            <p data-overlay-text></p>
            <button type="button" data-overlay-action>New game</button>
          </div>
        </div>
      </div>
    </div>
  `;

  const selectEl = root.querySelector<HTMLSelectElement>("[data-difficulty]")!;
  const minesEl = root.querySelector<HTMLElement>("[data-mines]")!;
  const timeEl = root.querySelector<HTMLElement>("[data-time]")!;
  const bestEl = root.querySelector<HTMLElement>("[data-best]")!;
  const pauseBtn = root.querySelector<HTMLButtonElement>("[data-pause]")!;
  const stageEl = root.querySelector<HTMLElement>("[data-stage]")!;
  const boardEl = root.querySelector<HTMLElement>("[data-board]")!;
  const overlayEl = root.querySelector<HTMLElement>("[data-overlay]")!;
  const overlayTextEl = root.querySelector<HTMLElement>("[data-overlay-text]")!;
  const overlayActionBtn = root.querySelector<HTMLButtonElement>("[data-overlay-action]")!;

  let difficulty: Difficulty = loadDifficulty();
  selectEl.value = difficulty;

  let state: GameState = newGame(0, 0, 0);
  let cells: HTMLElement[][] = [];
  let cursor: [number, number] = [0, 0];
  let elapsedMs = 0;
  let timerHandle: number | null = null;
  let lastTick = 0;
  let paused = false;
  let longPressTimer: number | null = null;
  let suppressNextClick = false;
  let touchStartXY: { x: number; y: number } | null = null;

  function cfg() {
    return DIFFICULTIES[difficulty];
  }

  function stopTimer() {
    if (timerHandle !== null) {
      clearInterval(timerHandle);
      timerHandle = null;
    }
  }

  function startTimer() {
    if (timerHandle !== null || paused) return;
    lastTick = Date.now();
    timerHandle = setInterval(() => {
      const now = Date.now();
      elapsedMs += now - lastTick;
      lastTick = now;
      timeEl.textContent = secondsText(elapsedMs / 1000);
    }, 100);
  }

  function renderBest() {
    const best = loadBest(difficulty);
    bestEl.textContent = best === null ? "—" : secondsText(best);
  }

  function sizeCells() {
    const { cols } = cfg();
    const available = Math.min(window.innerWidth - 64, 640);
    const size = Math.max(14, Math.min(30, Math.floor(available / cols)));
    boardEl.style.setProperty("--cell-size", `${size}px`);
  }

  function buildBoard() {
    const { rows, cols } = cfg();
    boardEl.innerHTML = "";
    boardEl.style.setProperty("--cols", String(cols));
    sizeCells();
    cells = [];
    for (let r = 0; r < rows; r++) {
      const row: HTMLElement[] = [];
      for (let c = 0; c < cols; c++) {
        const cell = document.createElement("div");
        cell.className = "mines__cell";
        cell.dataset.r = String(r);
        cell.dataset.c = String(c);
        boardEl.append(cell);
        row.push(cell);
      }
      cells.push(row);
    }
  }

  function renderCell(r: number, c: number) {
    const cell = cells[r][c];
    const isRevealed = state.revealed[r][c];
    const isFlagged = state.flagged[r][c];
    const isMine = state.mines[r][c];
    const isExploded = !!state.exploded && state.exploded[0] === r && state.exploded[1] === c;
    const isCursor = cursor[0] === r && cursor[1] === c;

    cell.className = "mines__cell";
    cell.classList.toggle("mines__cell--revealed", isRevealed);
    cell.classList.toggle("mines__cell--cursor", isCursor);
    cell.classList.toggle("mines__cell--exploded", isExploded);
    cell.style.color = "";
    cell.innerHTML = "";

    if (state.status === "lost" && isMine && !isFlagged) {
      cell.classList.add("mines__cell--mine");
      cell.innerHTML = MINE_ICON;
    } else if (state.status === "lost" && !isMine && isFlagged) {
      cell.classList.add("mines__cell--wrong-flag");
      cell.innerHTML = FLAG_ICON;
    } else if (!isRevealed && (isFlagged || (state.status === "won" && isMine))) {
      cell.innerHTML = FLAG_ICON;
    } else if (isRevealed) {
      const n = state.adjacent[r][c];
      if (n > 0) {
        cell.textContent = String(n);
        cell.style.color = NUMBER_COLORS[n] ?? "";
      }
    }
  }

  function renderAll() {
    const { rows, cols } = cfg();
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) renderCell(r, c);
    }
    minesEl.textContent = mineCounterText(remainingMines(state));
  }

  function showOverlay(text: string) {
    overlayTextEl.textContent = text;
    overlayEl.hidden = false;
  }

  function hideOverlay() {
    overlayEl.hidden = true;
  }

  function maybeFinish() {
    if (state.status === "won") {
      stopTimer();
      const seconds = Math.floor(elapsedMs / 1000);
      const best = loadBest(difficulty);
      if (best === null || seconds < best) {
        saveBest(difficulty, seconds);
        renderBest();
      }
      showOverlay("You cleared the field!");
    } else if (state.status === "lost") {
      stopTimer();
      showOverlay("Boom — game over");
    }
  }

  function applyAction(next: GameState) {
    const wasPlaying = state.status === "playing";
    const justStarted = !state.started && next.started;
    state = next;
    if (justStarted) startTimer();
    renderAll();
    if (wasPlaying) maybeFinish();
  }

  function doReveal(r: number, c: number) {
    if (paused || state.status !== "playing") return;
    applyAction(reveal(state, r, c));
  }

  function doChord(r: number, c: number) {
    if (paused || state.status !== "playing") return;
    applyAction(chord(state, r, c));
  }

  function doFlag(r: number, c: number) {
    if (paused || state.status !== "playing") return;
    applyAction(toggleFlag(state, r, c));
  }

  function cellAction(r: number, c: number) {
    if (state.revealed[r][c] && state.adjacent[r][c] > 0) doChord(r, c);
    else doReveal(r, c);
  }

  function start(nextDifficulty: Difficulty = difficulty) {
    difficulty = nextDifficulty;
    localStorage.setItem(DIFFICULTY_KEY, difficulty);
    selectEl.value = difficulty;
    stopTimer();
    paused = false;
    pauseBtn.textContent = "Pause";
    stageEl.classList.remove("mines__stage--paused");
    elapsedMs = 0;
    timeEl.textContent = secondsText(0);
    const { rows, cols, mines } = cfg();
    state = newGame(rows, cols, mines);
    cursor = [Math.floor(rows / 2), Math.floor(cols / 2)];
    hideOverlay();
    renderBest();
    buildBoard();
    renderAll();
  }

  function togglePause() {
    if (state.status !== "playing") return;
    paused = !paused;
    pauseBtn.textContent = paused ? "Resume" : "Pause";
    stageEl.classList.toggle("mines__stage--paused", paused);
    if (paused) stopTimer();
    else if (state.started) startTimer();
  }

  function cellFromEvent(ev: Event): [number, number] | null {
    const target = ev.target as HTMLElement;
    const el = target.closest<HTMLElement>(".mines__cell");
    if (!el || !el.dataset.r) return null;
    return [Number(el.dataset.r), Number(el.dataset.c)];
  }

  function cancelLongPress() {
    if (longPressTimer !== null) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  }

  boardEl.addEventListener("click", (ev) => {
    if (suppressNextClick) {
      suppressNextClick = false;
      return;
    }
    if (paused) return;
    const pos = cellFromEvent(ev);
    if (pos) cellAction(pos[0], pos[1]);
  });

  boardEl.addEventListener("contextmenu", (ev) => {
    ev.preventDefault();
    if (paused) return;
    const pos = cellFromEvent(ev);
    if (pos) doFlag(pos[0], pos[1]);
  });

  boardEl.addEventListener(
    "touchstart",
    (ev) => {
      const pos = cellFromEvent(ev);
      const t = ev.touches[0];
      touchStartXY = { x: t.clientX, y: t.clientY };
      if (!pos || paused) return;
      longPressTimer = window.setTimeout(() => {
        doFlag(pos[0], pos[1]);
        suppressNextClick = true;
        longPressTimer = null;
      }, LONG_PRESS_MS);
    },
    { passive: true },
  );

  boardEl.addEventListener(
    "touchmove",
    (ev) => {
      if (!touchStartXY) return;
      const t = ev.touches[0];
      if (
        Math.abs(t.clientX - touchStartXY.x) > MOVE_TOLERANCE ||
        Math.abs(t.clientY - touchStartXY.y) > MOVE_TOLERANCE
      ) {
        cancelLongPress();
      }
    },
    { passive: true },
  );

  boardEl.addEventListener("touchend", () => {
    cancelLongPress();
    touchStartXY = null;
  });

  stageEl.addEventListener("keydown", (ev) => {
    if (paused) return;
    const { rows, cols } = cfg();
    const [r, c] = cursor;
    if (ev.key === "ArrowUp") cursor = [Math.max(0, r - 1), c];
    else if (ev.key === "ArrowDown") cursor = [Math.min(rows - 1, r + 1), c];
    else if (ev.key === "ArrowLeft") cursor = [r, Math.max(0, c - 1)];
    else if (ev.key === "ArrowRight") cursor = [r, Math.min(cols - 1, c + 1)];
    else if (ev.key === " " || ev.key === "Enter") {
      ev.preventDefault();
      cellAction(r, c);
      return;
    } else if (ev.key.toLowerCase() === "f") {
      doFlag(r, c);
      return;
    } else {
      return;
    }
    ev.preventDefault();
    renderCell(r, c);
    renderCell(cursor[0], cursor[1]);
  });

  selectEl.addEventListener("change", () => start(selectEl.value as Difficulty));
  root.querySelector("[data-new]")!.addEventListener("click", () => start());
  overlayActionBtn.addEventListener("click", () => start());
  pauseBtn.addEventListener("click", togglePause);

  addEventListener("resize", sizeCells);

  start(difficulty);
}

let stylesInjected = false;
function injectStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement("style");
  style.textContent = `
    .mines__head { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-bottom: 4px; }
    .mines__select {
      background: var(--bg-raise, #1E1E1E); color: var(--ink, #ECEAE6);
      border: 1px solid var(--line-strong, rgba(255,255,255,.13)); border-radius: var(--r, 6px);
      padding: 6px 10px; font: 500 13px var(--sans, system-ui, sans-serif);
    }
    .mines__counters { display: flex; gap: 8px; margin-left: auto; }
    .mines__counter {
      display: flex; flex-direction: column; align-items: center; gap: 2px;
      min-width: 56px; padding: 5px 8px; border-radius: var(--r, 6px);
      background: var(--bg-raise, #1E1E1E); border: 1px solid var(--line, rgba(255,255,255,.07));
    }
    .mines__counter span {
      font-size: 10.5px; text-transform: uppercase; letter-spacing: .04em; color: var(--ink-3, #6F6C67);
    }
    .mines__counter strong {
      font: 600 15px var(--mono, ui-monospace, monospace); color: var(--ink, #ECEAE6);
      font-variant-numeric: tabular-nums;
    }
    .mines__actions { display: flex; gap: 8px; }
    .mines__btn {
      border: 1px solid var(--line-strong, rgba(255,255,255,.13)); background: var(--bg-raise, #1E1E1E);
      color: var(--ink, #ECEAE6); border-radius: var(--r, 6px); padding: 7px 12px;
      font: 500 13px var(--sans, system-ui, sans-serif); cursor: pointer;
    }
    .mines__btn:hover { background: var(--bg-active, #232323); }
    .mines__btn--accent { background: var(--accent, #E8532A); color: #fff; border-color: transparent; }
    .mines__btn--accent:hover { background: var(--accent-hover, #F05F35); }
    .mines__hint { margin: 0 0 12px; color: var(--ink-3, #6F6C67); font-size: 12.5px; }
    .mines__viewport { overflow: auto; max-width: 100%; padding-bottom: 4px; }
    .mines__stage { position: relative; display: inline-block; outline: none; }
    .mines__stage:focus-visible .mines__board { outline: 2px solid var(--accent, #E8532A); outline-offset: 2px; }
    .mines__board {
      display: grid;
      grid-template-columns: repeat(var(--cols), var(--cell-size, 24px));
      grid-auto-rows: var(--cell-size, 24px);
      gap: 1px;
      background: var(--bg-side, #101010);
      border-radius: 8px;
      padding: 6px;
    }
    .mines__cell {
      display: flex; align-items: center; justify-content: center;
      background: var(--bg-hover, #1B1B1B);
      border-radius: 3px;
      font: 700 calc(var(--cell-size, 24px) * 0.55) var(--sans, system-ui, sans-serif);
      color: var(--ink, #ECEAE6);
      cursor: pointer; user-select: none;
    }
    .mines__cell:hover { background: var(--bg-active, #232323); }
    .mines__cell--revealed, .mines__cell--revealed:hover { background: var(--bg, #161616); cursor: default; }
    .mines__cell--cursor { box-shadow: inset 0 0 0 2px var(--accent, #E8532A); }
    .mines__cell--exploded { background: var(--err, #E25C5C); }
    .mines__cell--wrong-flag { background: color-mix(in srgb, var(--err, #E25C5C) 35%, var(--bg-hover, #1B1B1B)); }
    .mines__overlay {
      position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
      background: color-mix(in srgb, var(--bg-side, #101010) 75%, transparent);
      border-radius: 8px;
    }
    /* \`display: flex\` above has the same specificity as the UA's \`[hidden] { display: none }\`,
       and an author rule always outranks a UA one regardless of order — so without this the
       overlay (and its "New game" button) would render permanently, \`hidden\` or not. */
    .mines__overlay[hidden] { display: none; }
    .mines__overlay-card { text-align: center; padding: 0 16px; }
    .mines__overlay-card p { margin: 0 0 14px; font: 600 18px var(--sans, system-ui, sans-serif); color: var(--ink, #ECEAE6); }
    .mines__overlay-card button {
      border: 1px solid var(--line-strong, rgba(255,255,255,.13)); background: var(--accent, #E8532A);
      color: #fff; border-radius: var(--r, 6px); padding: 8px 16px; cursor: pointer;
      font: 500 13.5px var(--sans, system-ui, sans-serif);
    }
    .mines__stage--paused .mines__board { filter: blur(4px); pointer-events: none; }
    .mines__stage--paused::after {
      content: "Paused — press Pause again to resume";
      position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
      text-align: center; padding: 12px; color: var(--ink, #ECEAE6);
      font: 600 14px var(--sans, system-ui, sans-serif);
      background: color-mix(in srgb, var(--bg-side, #101010) 55%, transparent);
      border-radius: 8px;
    }
  `;
  document.head.append(style);
}
