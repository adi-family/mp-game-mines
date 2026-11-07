// Pure Minesweeper rules — no DOM, no randomness baked in (every random choice takes an
// injectable `rng`), so this file is exactly what `test/mines-logic.test.ts` exercises and
// exactly what `game.ts` renders: one rulebook, not two copies of it that could drift apart.
//
// A dot-prefixed module name is deliberate: `frontend/index.ts`'s own `moduleIds()` lists every
// `modules/*.ts` that does NOT start with `.` and auto-mounts each one as a panel — this file has
// no `default` export shaped like a panel, so it must stay off that list. `game.ts` reaches it at
// runtime as a same-origin relative import, `./.logic.js`, which the frontend server resolves
// back to this file; nothing here is special-cased, the leading dot is the whole mechanism.

export type Difficulty = "beginner" | "intermediate" | "expert";

export interface DifficultyConfig {
  rows: number;
  cols: number;
  mines: number;
}

export const DIFFICULTIES: Record<Difficulty, DifficultyConfig> = {
  beginner: { rows: 9, cols: 9, mines: 10 },
  intermediate: { rows: 16, cols: 16, mines: 40 },
  expert: { rows: 16, cols: 30, mines: 99 },
};

export type GameStatus = "playing" | "won" | "lost";

export interface GameState {
  rows: number;
  cols: number;
  mineCount: number;
  mines: boolean[][];
  adjacent: number[][];
  revealed: boolean[][];
  flagged: boolean[][];
  started: boolean;
  status: GameStatus;
  revealedCount: number;
  exploded: [number, number] | null;
}

function grid<T>(rows: number, cols: number, value: T): T[][] {
  return Array.from({ length: rows }, () => Array<T>(cols).fill(value));
}

/** A fresh, mine-less board. Mines are not placed until the first `reveal` — that deferral is
 *  the entire mechanism behind "first click is always safe." */
export function newGame(rows: number, cols: number, mineCount: number): GameState {
  return {
    rows,
    cols,
    mineCount,
    mines: grid(rows, cols, false),
    adjacent: grid(rows, cols, 0),
    revealed: grid(rows, cols, false),
    flagged: grid(rows, cols, false),
    started: false,
    status: "playing",
    revealedCount: 0,
    exploded: null,
  };
}

function inBounds(rows: number, cols: number, r: number, c: number): boolean {
  return r >= 0 && r < rows && c >= 0 && c < cols;
}

export function neighbors(rows: number, cols: number, r: number, c: number): Array<[number, number]> {
  const result: Array<[number, number]> = [];
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const nr = r + dr;
      const nc = c + dc;
      if (inBounds(rows, cols, nr, nc)) result.push([nr, nc]);
    }
  }
  return result;
}

/**
 * Mines land on every cell except a safe zone around the first click — the clicked cell and its
 * eight neighbours — so the first reveal always opens real space instead of risking a 1x1
 * island. Falls back to excluding only the clicked cell itself if the board is too small to
 * spare a 3x3 hole (never true at any of the three standard difficulties, but kept honest for an
 * arbitrary board).
 */
export function placeMines(
  rows: number,
  cols: number,
  mineCount: number,
  safeR: number,
  safeC: number,
  rng: () => number = Math.random,
): boolean[][] {
  const excluded = new Set<string>([`${safeR},${safeC}`]);
  for (const [r, c] of neighbors(rows, cols, safeR, safeC)) excluded.add(`${r},${c}`);

  let candidates: Array<[number, number]> = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!excluded.has(`${r},${c}`)) candidates.push([r, c]);
    }
  }
  if (candidates.length < mineCount) {
    candidates = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (r !== safeR || c !== safeC) candidates.push([r, c]);
      }
    }
  }

  // Fisher-Yates, picking mineCount cells off the front after a full shuffle — deterministic
  // under an injected rng, same distribution as Math.random under the real one.
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }

  const mines = grid(rows, cols, false);
  for (let i = 0; i < mineCount && i < candidates.length; i++) {
    const [r, c] = candidates[i];
    mines[r][c] = true;
  }
  return mines;
}

export function computeAdjacent(rows: number, cols: number, mines: boolean[][]): number[][] {
  const adjacent = grid(rows, cols, 0);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (mines[r][c]) continue;
      let count = 0;
      for (const [nr, nc] of neighbors(rows, cols, r, c)) {
        if (mines[nr][nc]) count++;
      }
      adjacent[r][c] = count;
    }
  }
  return adjacent;
}

function cloneGame(state: GameState): GameState {
  return {
    ...state,
    mines: state.mines.map((row) => row.slice()),
    adjacent: state.adjacent.map((row) => row.slice()),
    revealed: state.revealed.map((row) => row.slice()),
    flagged: state.flagged.map((row) => row.slice()),
  };
}

/** Reveal `(r0, c0)` and cascade through every connected run of zero-adjacent cells, stopping at
 *  (but still revealing) the first ring of numbered cells around each pocket — a mine is never
 *  pushed onto the stack, so this never uncovers one on its own. */
function floodReveal(next: GameState, r0: number, c0: number): void {
  const stack: Array<[number, number]> = [[r0, c0]];
  while (stack.length) {
    const [r, c] = stack.pop()!;
    if (next.revealed[r][c] || next.flagged[r][c]) continue;
    next.revealed[r][c] = true;
    next.revealedCount++;
    if (next.adjacent[r][c] === 0) {
      for (const [nr, nc] of neighbors(next.rows, next.cols, r, c)) {
        if (!next.revealed[nr][nc] && !next.flagged[nr][nc] && !next.mines[nr][nc]) {
          stack.push([nr, nc]);
        }
      }
    }
  }
}

function checkWin(next: GameState): void {
  const safeTotal = next.rows * next.cols - next.mineCount;
  if (next.revealedCount >= safeTotal) next.status = "won";
}

/**
 * Reveal one cell. The very first reveal of a game places the mines (`placeMines`, seeded off
 * this click) before anything else happens — there is no board to be unlucky on until this call
 * creates one, which is the whole mechanism behind "first click is always safe."
 */
export function reveal(
  state: GameState,
  r: number,
  c: number,
  rng: () => number = Math.random,
): GameState {
  if (state.status !== "playing" || state.flagged[r][c] || state.revealed[r][c]) return state;

  const next = cloneGame(state);
  if (!next.started) {
    next.mines = placeMines(next.rows, next.cols, next.mineCount, r, c, rng);
    next.adjacent = computeAdjacent(next.rows, next.cols, next.mines);
    next.started = true;
  }

  if (next.mines[r][c]) {
    next.revealed[r][c] = true;
    next.status = "lost";
    next.exploded = [r, c];
    for (let rr = 0; rr < next.rows; rr++) {
      for (let cc = 0; cc < next.cols; cc++) {
        if (next.mines[rr][cc]) next.revealed[rr][cc] = true;
      }
    }
    return next;
  }

  floodReveal(next, r, c);
  checkWin(next);
  return next;
}

export function toggleFlag(state: GameState, r: number, c: number): GameState {
  if (state.status !== "playing" || state.revealed[r][c]) return state;
  const next = cloneGame(state);
  next.flagged[r][c] = !next.flagged[r][c];
  return next;
}

/**
 * Chord a revealed number: if exactly as many of its neighbours are flagged as its own count
 * says, reveal every other unflagged, unrevealed neighbour at once — the standard "I trust my
 * flags" shortcut. A mismatched flag count is a no-op, same as a classic Minesweeper chord;
 * revealing a neighbour that turns out to be an unflagged mine still loses the way an ordinary
 * click on it would.
 */
export function chord(state: GameState, r: number, c: number): GameState {
  if (state.status !== "playing" || !state.revealed[r][c] || state.adjacent[r][c] === 0) {
    return state;
  }
  const around = neighbors(state.rows, state.cols, r, c);
  const flaggedCount = around.filter(([nr, nc]) => state.flagged[nr][nc]).length;
  if (flaggedCount !== state.adjacent[r][c]) return state;

  let next = state;
  for (const [nr, nc] of around) {
    if (!next.revealed[nr][nc] && !next.flagged[nr][nc]) {
      next = reveal(next, nr, nc);
    }
  }
  return next;
}

export function remainingMines(state: GameState): number {
  let flagged = 0;
  for (let r = 0; r < state.rows; r++) {
    for (let c = 0; c < state.cols; c++) {
      if (state.flagged[r][c]) flagged++;
    }
  }
  return state.mineCount - flagged;
}
