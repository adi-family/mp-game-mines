// Unit tests for the board/flood/chord/win rules — no DOM, no server: `bun test` runs this
// directly against the same file the browser loads (`frontend/modules/.logic.ts`).

import { describe, expect, test } from "bun:test";
import {
  chord,
  computeAdjacent,
  neighbors,
  newGame,
  placeMines,
  remainingMines,
  reveal,
  toggleFlag,
  type GameState,
} from "../frontend/modules/.logic.ts";

/** Build a fully-formed GameState from a hand-picked mine layout, bypassing placeMines, so
 *  flood/chord/win behaviour can be tested against an exact, known board. */
function stateFromMines(mines: boolean[][], revealed?: boolean[][]): GameState {
  const rows = mines.length;
  const cols = mines[0].length;
  const adjacent = computeAdjacent(rows, cols, mines);
  const mineCount = mines.flat().filter(Boolean).length;
  return {
    rows,
    cols,
    mineCount,
    mines,
    adjacent,
    revealed: revealed ?? mines.map((row) => row.map(() => false)),
    flagged: mines.map((row) => row.map(() => false)),
    started: true,
    status: "playing",
    revealedCount: revealed ? revealed.flat().filter(Boolean).length : 0,
    exploded: null,
  };
}

function findMine(mines: boolean[][]): [number, number] {
  for (let r = 0; r < mines.length; r++) {
    for (let c = 0; c < mines[r].length; c++) {
      if (mines[r][c]) return [r, c];
    }
  }
  throw new Error("no mine in grid");
}

describe("board generation — first click is always safe", () => {
  test("the clicked cell and its whole neighbourhood are mine-free", () => {
    for (const rng of [() => 0, () => 0.3, () => 0.5, () => 0.99]) {
      const mines = placeMines(9, 9, 10, 4, 4, rng);
      for (const [r, c] of [[4, 4], ...neighbors(9, 9, 4, 4)]) {
        expect(mines[r][c]).toBe(false);
      }
    }
  });

  test("exactly mineCount mines land on the board", () => {
    const mines = placeMines(16, 16, 40, 0, 0, () => 0.5);
    const total = mines.flat().filter(Boolean).length;
    expect(total).toBe(40);
  });

  test("reveal() places mines only on the first call, and never under the clicked cell", () => {
    let state = newGame(9, 9, 10);
    expect(state.started).toBe(false);
    state = reveal(state, 4, 4, () => 0.5);
    expect(state.started).toBe(true);
    expect(state.status).toBe("playing");
    expect(state.mines[4][4]).toBe(false);
    expect(state.revealed[4][4]).toBe(true);
  });

  test("a tiny board falls back to excluding only the clicked cell when the 3x3 hole won't fit", () => {
    const mines = placeMines(3, 3, 1, 1, 1, () => 0);
    expect(mines[1][1]).toBe(false);
    expect(mines.flat().filter(Boolean).length).toBe(1);
  });
});

describe("flood fill", () => {
  test("revealing a numbered cell reveals only that one cell", () => {
    // 3x3, one mine at (0,0): (0,1), (1,0), (1,1) read 1; every other safe cell reads 0.
    const mines = [
      [true, false, false],
      [false, false, false],
      [false, false, false],
    ];
    let state = stateFromMines(mines);
    state = reveal(state, 0, 1);
    expect(state.revealedCount).toBe(1);
    expect(state.revealed[0][1]).toBe(true);
    expect(state.status).toBe("playing");
  });

  test("revealing a zero cell cascades through the whole connected zero region", () => {
    const mines = [
      [true, false, false],
      [false, false, false],
      [false, false, false],
    ];
    let state = stateFromMines(mines);
    state = reveal(state, 2, 2);
    // 8 safe cells total in a 3x3 with one mine — the cascade clears every one of them, which
    // also happens to win in a single click.
    expect(state.revealedCount).toBe(8);
    expect(state.mines[0][0]).toBe(true);
    expect(state.revealed[0][0]).toBe(false);
    expect(state.status).toBe("won");
  });

  test("flagged cells block the flood and are never auto-revealed", () => {
    const mines = [
      [false, false, false],
      [false, false, false],
      [false, false, true],
    ];
    let state = stateFromMines(mines);
    state = toggleFlag(state, 1, 1);
    state = reveal(state, 0, 0);
    expect(state.flagged[1][1]).toBe(true);
    expect(state.revealed[1][1]).toBe(false);
  });
});

describe("chording", () => {
  // 3x3, mine at (0,0) only: (0,1), (1,0), (1,1) read 1; (1,1) is the revealed number under test.
  const mines = [
    [true, false, false],
    [false, false, false],
    [false, false, false],
  ];

  test("a matching flag count reveals every other neighbour at once", () => {
    let state = stateFromMines(mines, [
      [false, false, false],
      [false, true, false],
      [false, false, false],
    ]);
    state = toggleFlag(state, 0, 0); // flags the real mine
    state = chord(state, 1, 1);
    // every neighbour except the flagged mine is now revealed — 7 more cells, winning the game.
    expect(state.revealed[0][1]).toBe(true);
    expect(state.revealed[1][0]).toBe(true);
    expect(state.revealed[2][2]).toBe(true);
    expect(state.revealed[0][0]).toBe(false); // flagged, never auto-revealed
    expect(state.status).toBe("won");
  });

  test("a mismatched flag count is a no-op", () => {
    let state = stateFromMines(mines, [
      [false, false, false],
      [false, true, false],
      [false, false, false],
    ]);
    const before = state;
    state = chord(state, 1, 1); // adjacent[1][1] === 1, but nothing is flagged
    expect(state).toBe(before);
    expect(state.revealedCount).toBe(1);
  });

  test("chording a wrongly-flagged neighbour still loses on the real mine", () => {
    let state = stateFromMines(mines, [
      [false, false, false],
      [false, true, false],
      [false, false, false],
    ]);
    state = toggleFlag(state, 0, 1); // flags a safe cell, not the mine
    state = chord(state, 1, 1); // flag count still matches adjacent[1][1] === 1
    expect(state.status).toBe("lost");
    expect(state.exploded).toEqual([0, 0]);
    expect(state.revealed[0][0]).toBe(true);
  });
});

describe("win detection", () => {
  test("revealing every safe cell one at a time wins", () => {
    let state = newGame(3, 3, 1);
    state = reveal(state, 1, 1, () => 0.42);
    expect(state.status).toBe("playing");
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        if (!state.mines[r][c] && !state.revealed[r][c]) {
          state = reveal(state, r, c);
        }
      }
    }
    expect(state.status).toBe("won");
  });

  test("revealing a mine loses and reveals every mine on the board", () => {
    let state = newGame(3, 3, 1);
    state = reveal(state, 1, 1, () => 0.42);
    const [mr, mc] = findMine(state.mines);
    state = reveal(state, mr, mc);
    expect(state.status).toBe("lost");
    expect(state.exploded).toEqual([mr, mc]);
    expect(state.revealed[mr][mc]).toBe(true);
  });

  test("no further action is possible once the game is lost", () => {
    let state = newGame(3, 3, 1);
    state = reveal(state, 1, 1, () => 0.42);
    const [mr, mc] = findMine(state.mines);
    state = reveal(state, mr, mc);
    const lost = state;
    state = reveal(state, 0, 0);
    expect(state).toBe(lost);
    state = toggleFlag(state, 0, 0);
    expect(state).toBe(lost);
  });
});

describe("remainingMines", () => {
  test("counts down as cells are flagged, and can go negative when over-flagged", () => {
    const mines = [
      [true, false],
      [false, false],
    ];
    let state = stateFromMines(mines);
    expect(remainingMines(state)).toBe(1);
    state = toggleFlag(state, 0, 0);
    expect(remainingMines(state)).toBe(0);
    state = toggleFlag(state, 0, 1);
    expect(remainingMines(state)).toBe(-1);
  });
});
