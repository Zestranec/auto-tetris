### package.json
{
  "name": "auto-tetris",
  "version": "1.0.0",
  "description": "Auto-Tetris betting game with controlled win probability",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "pixi.js": "^8.4.0"
  },
  "devDependencies": {
    "typescript": "^5.3.0",
    "vite": "^5.0.0"
  }
}

### tsconfig.json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noImplicitReturns": true,
    "skipLibCheck": true,
    "lib": ["ES2022", "DOM"]
  },
  "include": ["src"]
}

### vite.config.ts
import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 3000,
    open: true,
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
  },
});

### README.md
# Auto-Tetris — Betting Game

A fully automated Tetris-in-a-glass betting game built with **PixiJS v8** and **TypeScript**.
The player never controls the pieces — an AI auto-player places each tetromino optimally
(or deliberately sub-optimally) based on a configurable win-probability target.

---

## Quick Start

```bash
cd auto-tetris
npm install
npm run dev        # opens http://localhost:3000
```

To build for production:

```bash
npm run build      # outputs to dist/
npm run preview    # preview the built bundle
```

---

## Gameplay

| Action | Result |
|--------|--------|
| Choose bet (10 / 20 / 50 FUN) | Deducted when round starts |
| Press **Start Round** | Bet deducted; AI places pieces automatically |
| Each cleared line | Pays `bet × 1.1` immediately |
| Board tops out | Round ends; press **Play Again** |

Starting balance: **1 000 FUN**.

---

## Win Probability Control

The **Win Probability** slider sets the chance that a round will be a
_winning_ round (defined as clearing ≥ 5 lines before game over).

The system steers toward the target through two subtle levers:

1. **Piece distribution bias** — winning rounds receive more flat-friendly
   pieces (I, O, T, L, J); losing rounds receive more awkward pieces (S, Z).

2. **AI heuristic weight bias** — winning rounds use aggressive weights
   (prioritise line completion); losing rounds use passive weights
   (tolerate holes and height).

The influence is probabilistic, not deterministic — there is natural variance
around the configured rate.

---

## RNG Seed

Set any integer seed in the **RNG Seed** field.  The same seed + same
probability produces the same sequence of rounds, useful for reproducible
testing.  Click 🎲 to randomise.

---

## Simulation / Verification

Click **Run 100 Sim** in the UI to run 100 headless rounds (no rendering)
and display observed win rate, average lines per round, average payout, and
overall RTP.  Results also log to the browser console.

You can also call it programmatically from the browser console:

```js
import('/src/Simulation').then(m =>
  m.runSimulation({ rounds: 500, winProbability: 0.7, bet: 10, seed: 1 })
);
```

---

## Project Structure

```
src/
  Rng.ts                  Seeded Mulberry32 PRNG
  Tetromino.ts            All 7 piece shapes, rotations, and colours
  Board.ts                Playfield logic (collision, locking, line clearing)
  AutoPlayer.ts           Heuristic AI (evaluates all rotation × column placements)
  RoundOutcomeController.ts  Win-probability bias system
  Game.ts                 State machine (IDLE → DROPPING → CLEARING → GAME_OVER)
  Renderer.ts             PixiJS drawing (board, pieces, ghost, overlays)
  Ui.ts                   HTML DOM wiring (balance, bet, buttons)
  Simulation.ts           Headless batch-test harness
  main.ts                 Entry point: wires everything together
```

---

## Heuristic Weights

The AI scores each candidate placement by:

| Term | Direction | Meaning |
|------|-----------|---------|
| `completeLines` | ↑ positive | More cleared lines = better |
| `holes` | ↓ negative | Covered empty cells are bad |
| `aggregateHeight` | ↓ negative | Lower total height = better |
| `bumpiness` | ↓ negative | Flat surface = better |
| `maxHeight` | ↓ negative | Tall columns are penalised |

Three weight presets are used:

- **Default** — balanced play quality  
- **Aggressive** (winning rounds) — heavily prioritises line clears and flatness  
- **Passive** (losing rounds) — tolerates holes and height, resulting in earlier top-out  

---

## "Winning Round" Definition

A round is counted as a **win** when the AI clears **≥ 5 lines** before game over.

At that threshold, the net payout is always positive:
`5 × bet × 1.1 − bet = 4.5 × bet`.

This definition is used both by `RoundOutcomeController` (to decide the round's
target outcome) and `Simulation.ts` (to measure observed win rate).

### src tree
src
src/AutoPlayer.ts
src/Board.ts
src/Game.ts
src/Renderer.ts
src/Rng.ts
src/RoundOutcomeController.ts
src/Simulation.ts
src/Tetromino.ts
src/Ui.ts
src/main.ts
src/style.css

### SOURCE FILES


---
FILE: src/AutoPlayer.ts
---
/**
 * AutoPlayer — the AI that decides where to place every tetromino.
 *
 * Algorithm
 * ---------
 * For the current piece, enumerate every legal (rotation × column) combination.
 * Simulate a hard-drop for each candidate, lock the result, and score the
 * resulting board with a weighted heuristic.  Pick the highest-scoring placement.
 *
 * Heuristic terms (all configurable via HeuristicWeights)
 * -------------------------------------------------------
 *  completeLines   — rows that would be cleared (positive)
 *  holes           — empty cells covered by filled cells (negative)
 *  aggregateHeight — sum of all column heights (negative)
 *  bumpiness       — sum of |h[i] − h[i+1]| for adjacent columns (negative)
 *  maxHeight       — height of the tallest column (negative)
 */

import {
  BoardGrid,
  BOARD_WIDTH,
  FallingPiece,
  isValidPlacement,
  lockPiece,
  getColumnHeights,
  countHoles,
  countCompleteLines,
} from './Board';
import { TetrominoType, TETROMINO_SHAPES } from './Tetromino';

// ---------------------------------------------------------------------------
// Weight presets
// ---------------------------------------------------------------------------

export interface HeuristicWeights {
  completeLines: number;
  holes: number;
  aggregateHeight: number;
  bumpiness: number;
  maxHeight: number;
}

/** Balanced default — reasonable play quality. */
export const DEFAULT_WEIGHTS: HeuristicWeights = {
  completeLines: 100,
  holes: -35,
  aggregateHeight: -0.5,
  bumpiness: -3,
  maxHeight: -7,
};

/**
 * Aggressive weights — biased toward clearing lines and keeping the board
 * flat; used when the RoundOutcomeController wants a WINNING round.
 */
export const AGGRESSIVE_WEIGHTS: HeuristicWeights = {
  completeLines: 200,
  holes: -50,
  aggregateHeight: -0.3,
  bumpiness: -2,
  maxHeight: -5,
};

/**
 * Passive weights — tolerates holes and ignores height; the AI plays poorly
 * and the board fills up quickly.  Used for LOSING rounds.
 */
export const PASSIVE_WEIGHTS: HeuristicWeights = {
  completeLines: 50,
  holes: -15,
  aggregateHeight: -2,
  bumpiness: -6,
  maxHeight: -20,
};

// ---------------------------------------------------------------------------
// Board evaluation
// ---------------------------------------------------------------------------

/** Score the board state given a set of weights. Higher = better. */
export function evaluateBoard(board: BoardGrid, weights: HeuristicWeights): number {
  const heights = getColumnHeights(board);
  const aggregateHeight = heights.reduce((a, b) => a + b, 0);
  const maxHeight = Math.max(...heights);
  const holes = countHoles(board);
  const lines = countCompleteLines(board);

  let bumpiness = 0;
  for (let c = 0; c < BOARD_WIDTH - 1; c++) {
    bumpiness += Math.abs(heights[c] - heights[c + 1]);
  }

  return (
    weights.completeLines * lines +
    weights.holes * holes +
    weights.aggregateHeight * aggregateHeight +
    weights.bumpiness * bumpiness +
    weights.maxHeight * maxHeight
  );
}

// ---------------------------------------------------------------------------
// Hard-drop simulation
// ---------------------------------------------------------------------------

/**
 * Returns a copy of `piece` translated down as far as possible without
 * colliding (the position just before it would be locked into the board).
 */
export function hardDrop(board: BoardGrid, piece: FallingPiece): FallingPiece {
  let current = { ...piece };
  while (isValidPlacement(board, { ...current, row: current.row + 1 })) {
    current = { ...current, row: current.row + 1 };
  }
  return current;
}

// ---------------------------------------------------------------------------
// Best placement search
// ---------------------------------------------------------------------------

export interface Placement {
  rotation: number;
  col: number;
  score: number;
}

/**
 * Searches all (rotation × column) combinations for the given piece type
 * and returns the one that maximises the heuristic score.
 *
 * Returns null when NO legal placement exists (board completely blocked).
 */
export function findBestPlacement(
  board: BoardGrid,
  type: TetrominoType,
  weights: HeuristicWeights,
): Placement | null {
  const rotations = TETROMINO_SHAPES[type];
  let bestScore = -Infinity;
  let best: Placement | null = null;

  for (let rotation = 0; rotation < rotations.length; rotation++) {
    const shapeWidth = rotations[rotation][0].length;

    // Slide the piece across every possible column position.
    // Allow negative columns — the shape's empty left columns might extend beyond border.
    for (let col = -(shapeWidth - 1); col < BOARD_WIDTH; col++) {
      const candidate: FallingPiece = { type, rotation, row: 0, col };

      // Skip column positions that are immediately illegal (piece out of board bounds)
      if (!couldFitHorizontally(shapeWidth, col)) continue;

      // Find the lowest row this piece can settle at
      const dropped = hardDrop(board, candidate);

      // After hard-drop the position must still be valid (no overlap, in bounds)
      if (!isValidPlacement(board, dropped)) continue;

      const resultBoard = lockPiece(board, dropped);
      const score = evaluateBoard(resultBoard, weights);

      if (score > bestScore) {
        bestScore = score;
        best = { rotation, col, score };
      }
    }
  }

  return best;
}

/**
 * Quick pre-filter: returns false only when the piece's leftmost possible
 * cell is entirely beyond the right edge — obviously impossible regardless
 * of the shape's internal empty columns.
 * isValidPlacement does the precise bounds check for all other cases.
 */
function couldFitHorizontally(shapeWidth: number, col: number): boolean {
  // If the leftmost column of the bounding box is already past the right edge,
  // no cell can be in bounds.
  if (col >= BOARD_WIDTH) return false;
  // If the rightmost column of the bounding box is entirely left of column 0,
  // no cell can be in bounds.
  if (col + shapeWidth - 1 < 0) return false;
  return true;
}


---
FILE: src/Board.ts
---
/**
 * Board — pure-logic module for the Tetris playfield.
 *
 * The board is a 10×20 grid (BOARD_WIDTH × BOARD_HEIGHT).
 * Rows are indexed 0 (top) … 19 (bottom).
 * Columns are indexed 0 (left) … 9 (right).
 *
 * Cell value: null = empty; TetrominoType string = locked piece.
 */

import { TetrominoType, TETROMINO_SHAPES, RotationMatrix, getCells } from './Tetromino';

export const BOARD_WIDTH = 10;
export const BOARD_HEIGHT = 20;

/** A single cell: empty or locked with a piece colour-key. */
export type BoardCell = TetrominoType | null;

/** The full playfield grid. Immutable by convention — always return new copies. */
export type BoardGrid = BoardCell[][];

/** State of the currently falling (unlocked) piece. */
export interface FallingPiece {
  type: TetrominoType;
  rotation: number; // index into TETROMINO_SHAPES[type]
  row: number;      // top-left corner row on the board
  col: number;      // top-left corner column on the board
}

// ---------------------------------------------------------------------------
// Board construction
// ---------------------------------------------------------------------------

export function createEmptyBoard(): BoardGrid {
  return Array.from({ length: BOARD_HEIGHT }, () =>
    new Array<BoardCell>(BOARD_WIDTH).fill(null),
  );
}

/** Deep-clone a board so mutations don't affect the original. */
export function cloneBoard(board: BoardGrid): BoardGrid {
  return board.map(row => [...row]);
}

// ---------------------------------------------------------------------------
// Piece geometry helpers
// ---------------------------------------------------------------------------

/** Returns the rotation matrix for the given piece state. */
export function getShape(piece: FallingPiece): RotationMatrix {
  const rotations = TETROMINO_SHAPES[piece.type];
  return rotations[piece.rotation % rotations.length];
}

/**
 * Returns absolute [row, col] board positions for every filled cell
 * of the given piece in its current position.
 */
export function getPieceCells(piece: FallingPiece): [number, number][] {
  return getCells(getShape(piece)).map(([r, c]) => [r + piece.row, c + piece.col]);
}

// ---------------------------------------------------------------------------
// Collision detection
// ---------------------------------------------------------------------------

/**
 * Returns true when the piece fits on the board at its current position
 * without overlapping locked cells or going out of the horizontal bounds.
 * Cells above row 0 (negative row) are allowed during spawn/drop animation.
 */
export function isValidPlacement(board: BoardGrid, piece: FallingPiece): boolean {
  for (const [r, c] of getPieceCells(piece)) {
    if (c < 0 || c >= BOARD_WIDTH) return false;
    if (r >= BOARD_HEIGHT) return false;
    if (r >= 0 && board[r][c] !== null) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Locking
// ---------------------------------------------------------------------------

/**
 * Burns the piece into a new copy of the board and returns it.
 * Cells above the visible area (r < 0) are silently discarded.
 */
export function lockPiece(board: BoardGrid, piece: FallingPiece): BoardGrid {
  const next = cloneBoard(board);
  for (const [r, c] of getPieceCells(piece)) {
    if (r >= 0 && r < BOARD_HEIGHT) {
      next[r][c] = piece.type;
    }
  }
  return next;
}

// ---------------------------------------------------------------------------
// Line clearing
// ---------------------------------------------------------------------------

/** Returns the row indices of every completely filled row. */
export function findCompleteRows(board: BoardGrid): number[] {
  const complete: number[] = [];
  for (let r = 0; r < BOARD_HEIGHT; r++) {
    if (board[r].every(cell => cell !== null)) complete.push(r);
  }
  return complete;
}

/**
 * Removes the given rows from the board and prepends the same number of
 * blank rows at the top. Returns a new board.
 */
export function clearRows(board: BoardGrid, rows: Set<number>): BoardGrid {
  const remaining = board.filter((_, r) => !rows.has(r));
  const blanks = Array.from({ length: rows.size }, () =>
    new Array<BoardCell>(BOARD_WIDTH).fill(null),
  );
  return [...blanks, ...remaining];
}

// ---------------------------------------------------------------------------
// Game-over detection
// ---------------------------------------------------------------------------

/**
 * After locking a piece, check whether any locked cell sits in the top
 * two rows — the conventional "top-out" zone.
 */
export function isTopOut(board: BoardGrid): boolean {
  for (let c = 0; c < BOARD_WIDTH; c++) {
    if (board[0][c] !== null || board[1][c] !== null) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Spawn position
// ---------------------------------------------------------------------------

/**
 * Returns the starting [row, col] for a freshly spawned piece so it
 * appears centred at the top of the board.
 *
 * We start at row = -1 so that the topmost VISIBLE cells of the shape
 * emerge at row 0 on the first tick (pieces with empty top rows will
 * appear higher initially — that is intentional and standard).
 */
export function spawnPosition(type: TetrominoType): { row: number; col: number } {
  const shape = TETROMINO_SHAPES[type][0];
  const shapeWidth = shape[0].length;
  return {
    row: 0,
    col: Math.floor((BOARD_WIDTH - shapeWidth) / 2),
  };
}

// ---------------------------------------------------------------------------
// Board analysis helpers (used by AutoPlayer)
// ---------------------------------------------------------------------------

/** Returns the height of each column (number of filled cells counting from the bottom). */
export function getColumnHeights(board: BoardGrid): number[] {
  const heights = new Array<number>(BOARD_WIDTH).fill(0);
  for (let c = 0; c < BOARD_WIDTH; c++) {
    for (let r = 0; r < BOARD_HEIGHT; r++) {
      if (board[r][c] !== null) {
        heights[c] = BOARD_HEIGHT - r;
        break;
      }
    }
  }
  return heights;
}

/** Counts holes: empty cells that are covered by at least one filled cell above them. */
export function countHoles(board: BoardGrid): number {
  let holes = 0;
  for (let c = 0; c < BOARD_WIDTH; c++) {
    let hasFilledAbove = false;
    for (let r = 0; r < BOARD_HEIGHT; r++) {
      if (board[r][c] !== null) {
        hasFilledAbove = true;
      } else if (hasFilledAbove) {
        holes++;
      }
    }
  }
  return holes;
}

/** Counts fully-filled rows (used in heuristic evaluation before clearing). */
export function countCompleteLines(board: BoardGrid): number {
  return board.filter(row => row.every(cell => cell !== null)).length;
}


---
FILE: src/Game.ts
---
/**
 * Game — the central state machine.
 *
 * Phases
 * ------
 *  IDLE       — waiting for the player to press "Start Round"
 *  DROPPING   — a piece is animating downward toward its target row
 *  CLEARING   — completed rows flash before being removed
 *  GAME_OVER  — the board topped out; waiting for "Play Again"
 *
 * Timing is driven by an external caller (Renderer ticker) invoking
 * `game.update(deltaMs)` each frame.  No PixiJS imports live here.
 */

import {
  BoardGrid,
  FallingPiece,
  createEmptyBoard,
  isValidPlacement,
  lockPiece,
  findCompleteRows,
  clearRows,
  isTopOut,
  spawnPosition,
} from './Board';
import {
  HeuristicWeights,
  DEFAULT_WEIGHTS,
  Placement,
  findBestPlacement,
  hardDrop,
} from './AutoPlayer';
import { PieceWeights, RoundBiasConfig, RoundOutcomeController, WIN_THRESHOLD } from './RoundOutcomeController';
import { Rng } from './Rng';
import { TetrominoType } from './Tetromino';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GamePhase = 'IDLE' | 'DROPPING' | 'CLEARING' | 'GAME_OVER';

export interface GameState {
  phase: GamePhase;
  board: BoardGrid;

  /** The piece currently animating downward (null in IDLE / between pieces). */
  currentPiece: FallingPiece | null;
  /** The row the current piece is heading toward (hard-drop target). */
  targetRow: number;

  /** Rows currently being cleared (for flash animation). */
  clearingRows: number[];

  // --- Economy ---
  balance: number;
  bet: number;
  roundLines: number;
  roundPayout: number;
  /** True if the current round has been designated a "winning" round by the controller. */
  roundIsDesignatedWin: boolean;

  // --- AI config active this round ---
  weights: HeuristicWeights;
  pieceWeights: PieceWeights;

  debug: boolean;
}

// ---------------------------------------------------------------------------
// Timing constants
// ---------------------------------------------------------------------------

/** Milliseconds between each row-step of the animated hard-drop. */
const DROP_ROW_INTERVAL_MS = 45;

/** Total duration of the line-clear flash animation. */
const CLEAR_ANIM_DURATION_MS = 450;

/** Flash toggle interval during line-clear animation. */
const CLEAR_FLASH_INTERVAL_MS = 90;

// ---------------------------------------------------------------------------
// Game class
// ---------------------------------------------------------------------------

export class Game {
  private state: GameState;
  private rng: Rng;
  private outcomeController: RoundOutcomeController;

  // Internal timers
  private dropAccumMs = 0;
  private clearAccumMs = 0;

  // Exposed callbacks so external systems can react without polling
  onStateChange?: (state: GameState) => void;
  onLinesCleared?: (count: number, payout: number, newBalance: number) => void;
  onGameOver?: (state: GameState) => void;
  onRoundStart?: (state: GameState) => void;

  constructor(seed = Date.now()) {
    this.rng = new Rng(seed >>> 0);
    this.outcomeController = new RoundOutcomeController(this.rng);
    this.state = this.buildIdleState();
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  getState(): Readonly<GameState> {
    return this.state;
  }

  setBet(bet: 10 | 20 | 50): void {
    if (this.state.phase === 'IDLE' || this.state.phase === 'GAME_OVER') {
      this.state = { ...this.state, bet };
      this.notify();
    }
  }

  setWinProbability(p: number): void {
    this.outcomeController.setWinProbability(p);
  }

  setDebug(on: boolean): void {
    this.state = { ...this.state, debug: on };
    this.outcomeController.setDebug(on);
  }

  /**
   * Change the RNG seed.  Effective from the next round.
   * If `seed` is not provided, a random one is picked via Math.random.
   */
  setSeed(seed?: number): void {
    const s = seed !== undefined ? seed : Math.floor(Math.random() * 1e9);
    this.rng = new Rng(s >>> 0);
    this.outcomeController = new RoundOutcomeController(this.rng);
    this.outcomeController.setDebug(this.state.debug);
    this.log(`RNG seed set to ${s}`);
  }

  startRound(): void {
    if (this.state.phase !== 'IDLE' && this.state.phase !== 'GAME_OVER') return;
    if (this.state.balance < this.state.bet) {
      console.warn('[Game] Insufficient balance to place bet');
      return;
    }

    const bias: RoundBiasConfig = this.outcomeController.startRound();

    this.state = {
      ...this.state,
      phase: 'DROPPING',
      board: createEmptyBoard(),
      currentPiece: null,
      targetRow: 0,
      clearingRows: [],
      balance: this.state.balance - this.state.bet,
      roundLines: 0,
      roundPayout: 0,
      roundIsDesignatedWin: bias.isWinningRound,
      weights: bias.heuristicWeights,
      pieceWeights: bias.pieceWeights,
    };

    this.dropAccumMs = 0;
    this.clearAccumMs = 0;

    this.log(
      `Round started — bet=${this.state.bet}, ` +
      `designatedWin=${bias.isWinningRound}`,
    );

    this.onRoundStart?.(this.state);
    this.spawnNextPiece();
  }

  /** Main update tick — call once per animation frame with elapsed ms. */
  update(deltaMs: number): void {
    switch (this.state.phase) {
      case 'DROPPING':
        this.tickDrop(deltaMs);
        break;
      case 'CLEARING':
        this.tickClear(deltaMs);
        break;
      default:
        break;
    }
  }

  // ---------------------------------------------------------------------------
  // Piece spawning
  // ---------------------------------------------------------------------------

  private spawnNextPiece(): void {
    const type = this.outcomeController.pickPiece(this.state.pieceWeights);
    const spawn = spawnPosition(type);

    // Find best placement via AI
    const placement: Placement | null = findBestPlacement(
      this.state.board,
      type,
      this.state.weights,
    );

    if (!placement) {
      // No legal placement exists — game over
      this.triggerGameOver();
      return;
    }

    // Piece starts at row=0 with the target rotation and column already applied
    const piece: FallingPiece = {
      type,
      rotation: placement.rotation,
      row: spawn.row,
      col: placement.col,
    };

    // If the spawn position itself is blocked, top-out
    if (!isValidPlacement(this.state.board, piece)) {
      this.triggerGameOver();
      return;
    }

    // Compute target row (hard-drop destination)
    const dropped = hardDrop(this.state.board, piece);
    const targetRow = dropped.row;

    this.state = {
      ...this.state,
      currentPiece: piece,
      targetRow,
    };

    this.dropAccumMs = 0;

    this.log(
      `Spawned ${type} → col=${placement.col}, rot=${placement.rotation}, ` +
      `targetRow=${targetRow}, score=${placement.score.toFixed(1)}`,
    );

    this.notify();
  }

  // ---------------------------------------------------------------------------
  // Drop animation tick
  // ---------------------------------------------------------------------------

  private tickDrop(deltaMs: number): void {
    this.dropAccumMs += deltaMs;

    while (this.dropAccumMs >= DROP_ROW_INTERVAL_MS && this.state.currentPiece) {
      this.dropAccumMs -= DROP_ROW_INTERVAL_MS;

      const piece = this.state.currentPiece;

      if (piece.row < this.state.targetRow) {
        // Advance one row
        this.state = { ...this.state, currentPiece: { ...piece, row: piece.row + 1 } };
      } else {
        // Reached target — lock and process
        this.lockCurrentPiece();
        return;
      }
    }

    this.notify();
  }

  // ---------------------------------------------------------------------------
  // Locking
  // ---------------------------------------------------------------------------

  private lockCurrentPiece(): void {
    const piece = this.state.currentPiece!;
    const newBoard = lockPiece(this.state.board, piece);

    this.log(`Locked ${piece.type} at row=${piece.row}, col=${piece.col}`);

    // Check top-out AFTER locking
    if (isTopOut(newBoard)) {
      this.state = { ...this.state, board: newBoard, currentPiece: null };
      this.triggerGameOver();
      return;
    }

    const completeRows = findCompleteRows(newBoard);

    if (completeRows.length > 0) {
      const payout = completeRows.length * this.state.bet * 1.1;
      const newBalance = this.state.balance + payout;
      const newRoundLines = this.state.roundLines + completeRows.length;
      const newRoundPayout = this.state.roundPayout + payout;

      this.state = {
        ...this.state,
        board: newBoard,
        currentPiece: null,
        phase: 'CLEARING',
        clearingRows: completeRows,
        balance: newBalance,
        roundLines: newRoundLines,
        roundPayout: newRoundPayout,
      };

      this.clearAccumMs = 0;

      this.log(`Lines cleared: ${completeRows.length} — payout: ${payout.toFixed(2)}`);
      this.onLinesCleared?.(completeRows.length, payout, newBalance);
    } else {
      this.state = { ...this.state, board: newBoard, currentPiece: null };
      this.spawnNextPiece();
    }

    this.notify();
  }

  // ---------------------------------------------------------------------------
  // Line-clear animation tick
  // ---------------------------------------------------------------------------

  private tickClear(deltaMs: number): void {
    this.clearAccumMs += deltaMs;

    if (this.clearAccumMs >= CLEAR_ANIM_DURATION_MS) {
      this.finishLineClear();
    } else {
      // Notify each frame so the renderer can read clearFlashPhase for the flash effect
      this.notify();
    }
  }

  /** Animation done — remove rows and spawn the next piece. */
  private finishLineClear(): void {
    const rows = new Set(this.state.clearingRows);
    const newBoard = clearRows(this.state.board, rows);

    this.state = {
      ...this.state,
      board: newBoard,
      clearingRows: [],
      phase: 'DROPPING',
    };

    this.clearAccumMs = 0;
    this.spawnNextPiece();
  }

  // ---------------------------------------------------------------------------
  // Game over
  // ---------------------------------------------------------------------------

  private triggerGameOver(): void {
    const won = this.state.roundLines >= WIN_THRESHOLD;
    this.state = { ...this.state, phase: 'GAME_OVER', currentPiece: null };

    this.log(
      `Game over — lines=${this.state.roundLines}, ` +
      `payout=${this.state.roundPayout.toFixed(2)}, ` +
      `won=${won} (designatedWin=${this.state.roundIsDesignatedWin})`,
    );

    this.onGameOver?.(this.state);
    this.notify();
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private buildIdleState(): GameState {
    return {
      phase: 'IDLE',
      board: createEmptyBoard(),
      currentPiece: null,
      targetRow: 0,
      clearingRows: [],
      balance: 1000,
      bet: 10,
      roundLines: 0,
      roundPayout: 0,
      roundIsDesignatedWin: false,
      weights: DEFAULT_WEIGHTS,
      pieceWeights: { I: 1, O: 1, T: 1, S: 1, Z: 1, J: 1, L: 1 },
      debug: false,
    };
  }

  /** Returns the flash phase (0 or 1) for the line-clear animation. */
  get clearFlashPhase(): number {
    return Math.floor(this.clearAccumMs / CLEAR_FLASH_INTERVAL_MS) % 2;
  }

  private notify(): void {
    this.onStateChange?.(this.state);
  }

  private log(msg: string): void {
    if (this.state.debug) console.log(`[Game] ${msg}`);
  }
}


---
FILE: src/Renderer.ts
---
/**
 * Renderer — all PixiJS drawing lives here.
 *
 * Layout (inside the canvas)
 * --------------------------
 *  A board region: BOARD_WIDTH×BOARD_HEIGHT cells, each CELL_SIZE px.
 *  A 2-pixel wall on left, right, and bottom.
 *  A thin top boundary line.
 *
 * Rendering strategy: a single Graphics object is cleared and redrawn
 * every frame — simple and fast enough for a 10×20 grid at 60 fps.
 * Text overlays use persistent PixiJS Text nodes whose visibility and
 * content are toggled each frame.
 */

import { Application, Container, Graphics, Text, TextStyle } from 'pixi.js';
import { GameState } from './Game';
import { BOARD_WIDTH, BOARD_HEIGHT } from './Board';
import {
  TetrominoType,
  TETROMINO_SHAPES,
  TETROMINO_COLORS,
  TETROMINO_BORDER_COLORS,
  getCells,
} from './Tetromino';
import { WIN_THRESHOLD } from './RoundOutcomeController';

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

/** Pixel size of each grid cell. */
const CELL = 30;

/** Wall/border thickness in pixels. */
const WALL = 3;

/** Outer padding. */
const PAD = 16;

/** Canvas dimensions. */
export const CANVAS_WIDTH  = PAD + WALL + BOARD_WIDTH  * CELL + WALL + PAD;
export const CANVAS_HEIGHT = PAD + BOARD_HEIGHT * CELL + WALL + PAD;

/** Board top-left in canvas coordinates. */
const BX = PAD + WALL;
const BY = PAD;

// Colours
const CLR_BG          = 0x0d0d1a;
const CLR_BOARD_BG    = 0x111122;
const CLR_WALL        = 0x3355aa;
const CLR_GRID        = 0x1a1a33;
const CLR_GHOST       = 0x334466;
const CLR_CLEAR_FLASH = 0xffffff;
const CLR_SHINE       = 0xffffff;

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

export class Renderer {
  private app: Application;
  private root: Container;
  private gfx: Graphics;

  // Overlay Text nodes (toggled visible per phase)
  private overlayBig: Text;
  private overlaySub: Text;

  constructor(app: Application) {
    this.app = app;
    this.root = new Container();
    this.app.stage.addChild(this.root);

    this.gfx = new Graphics();
    this.root.addChild(this.gfx);

    // Pre-create overlay text nodes; position them over the board centre
    const cx = BX + (BOARD_WIDTH * CELL) / 2;
    const bigStyle = new TextStyle({
      fontFamily: 'Arial Black, Arial, sans-serif',
      fontSize: 24,
      fontWeight: 'bold',
      fill: '#ffffff',
      align: 'center',
      dropShadow: { color: '#000044', blur: 6, distance: 2, angle: 0.5 },
    });
    const subStyle = new TextStyle({
      fontFamily: 'Arial, sans-serif',
      fontSize: 16,
      fill: '#aaccff',
      align: 'center',
    });

    this.overlayBig = new Text({ text: '', style: bigStyle });
    this.overlayBig.anchor.set(0.5, 0.5);
    this.overlayBig.x = cx;
    this.overlayBig.y = BY + (BOARD_HEIGHT * CELL) / 2 - 14;
    this.overlayBig.visible = false;
    this.root.addChild(this.overlayBig);

    this.overlaySub = new Text({ text: '', style: subStyle });
    this.overlaySub.anchor.set(0.5, 0.5);
    this.overlaySub.x = cx;
    this.overlaySub.y = BY + (BOARD_HEIGHT * CELL) / 2 + 16;
    this.overlaySub.visible = false;
    this.root.addChild(this.overlaySub);
  }

  // ---------------------------------------------------------------------------
  // Public render entry point
  // ---------------------------------------------------------------------------

  /** Called once per animation frame. `flashPhase` alternates 0/1 during line-clear. */
  render(state: GameState, flashPhase: number): void {
    const g = this.gfx;
    g.clear();

    this.drawBackground(g);
    this.drawBoardCells(g, state, flashPhase);
    this.drawGhostPiece(g, state);
    this.drawCurrentPiece(g, state);
    this.drawGrid(g);
    this.drawWalls(g);
    this.updateOverlay(state);
  }

  // ---------------------------------------------------------------------------
  // Background
  // ---------------------------------------------------------------------------

  private drawBackground(g: Graphics): void {
    g.rect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    g.fill(CLR_BG);

    g.rect(BX, BY, BOARD_WIDTH * CELL, BOARD_HEIGHT * CELL);
    g.fill(CLR_BOARD_BG);
  }

  // ---------------------------------------------------------------------------
  // Locked board cells
  // ---------------------------------------------------------------------------

  private drawBoardCells(g: Graphics, state: GameState, flashPhase: number): void {
    const flashSet = new Set(state.clearingRows);

    for (let r = 0; r < BOARD_HEIGHT; r++) {
      for (let c = 0; c < BOARD_WIDTH; c++) {
        const cell = state.board[r][c];
        if (!cell) continue;

        const x = BX + c * CELL;
        const y = BY + r * CELL;

        if (flashSet.has(r)) {
          const color = flashPhase === 0 ? CLR_CLEAR_FLASH : TETROMINO_COLORS[cell];
          this.drawCell(g, x, y, color, TETROMINO_BORDER_COLORS[cell]);
        } else {
          this.drawCell(g, x, y, TETROMINO_COLORS[cell], TETROMINO_BORDER_COLORS[cell]);
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Ghost piece (shows landing position)
  // ---------------------------------------------------------------------------

  private drawGhostPiece(g: Graphics, state: GameState): void {
    if (!state.currentPiece || state.phase !== 'DROPPING') return;

    const ghost = { ...state.currentPiece, row: state.targetRow };
    for (const [r, c] of this.pieceCells(ghost)) {
      if (r < 0 || r >= BOARD_HEIGHT) continue;
      const x = BX + c * CELL;
      const y = BY + r * CELL;
      g.rect(x + 1, y + 1, CELL - 2, CELL - 2);
      g.fill({ color: CLR_GHOST, alpha: 0.6 });
    }
  }

  // ---------------------------------------------------------------------------
  // Falling / active piece
  // ---------------------------------------------------------------------------

  private drawCurrentPiece(g: Graphics, state: GameState): void {
    if (!state.currentPiece) return;
    const piece = state.currentPiece;
    const color  = TETROMINO_COLORS[piece.type];
    const border = TETROMINO_BORDER_COLORS[piece.type];

    for (const [r, c] of this.pieceCells(piece)) {
      if (r >= BOARD_HEIGHT) continue;
      const x = BX + c * CELL;
      const y = BY + r * CELL;

      if (r >= 0) {
        this.drawCell(g, x, y, color, border);
      } else {
        // Partially above visible area — clip to board top
        const cellBottom = y + CELL;
        if (cellBottom > BY) {
          g.rect(x + 1, BY, CELL - 2, cellBottom - BY - 1);
          g.fill(color);
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Grid lines
  // ---------------------------------------------------------------------------

  private drawGrid(g: Graphics): void {
    for (let r = 0; r <= BOARD_HEIGHT; r++) {
      g.moveTo(BX, BY + r * CELL);
      g.lineTo(BX + BOARD_WIDTH * CELL, BY + r * CELL);
    }
    for (let c = 0; c <= BOARD_WIDTH; c++) {
      g.moveTo(BX + c * CELL, BY);
      g.lineTo(BX + c * CELL, BY + BOARD_HEIGHT * CELL);
    }
    g.stroke({ color: CLR_GRID, width: 0.5, alpha: 0.5 });
  }

  // ---------------------------------------------------------------------------
  // Walls & border
  // ---------------------------------------------------------------------------

  private drawWalls(g: Graphics): void {
    const bw = BOARD_WIDTH * CELL;
    const bh = BOARD_HEIGHT * CELL;

    // Left
    g.rect(BX - WALL, BY, WALL, bh + WALL);
    g.fill(CLR_WALL);
    // Right
    g.rect(BX + bw, BY, WALL, bh + WALL);
    g.fill(CLR_WALL);
    // Bottom
    g.rect(BX - WALL, BY + bh, bw + WALL * 2, WALL);
    g.fill(CLR_WALL);
    // Top boundary (subtle)
    g.rect(BX, BY - 1, bw, 1);
    g.fill({ color: CLR_WALL, alpha: 0.4 });
  }

  // ---------------------------------------------------------------------------
  // Overlay text (IDLE / GAME OVER)
  // ---------------------------------------------------------------------------

  private updateOverlay(state: GameState): void {
    if (state.phase === 'IDLE') {
      this.showOverlay('PRESS START', 'Choose bet and hit Start Round', 0x4488ff, 0x99bbff);
    } else if (state.phase === 'GAME_OVER') {
      const won = state.roundLines >= WIN_THRESHOLD;
      this.showOverlay(
        'GAME  OVER',
        won
          ? `WIN!  ${state.roundLines} lines cleared`
          : `${state.roundLines} line${state.roundLines !== 1 ? 's' : ''} cleared`,
        won ? 0x44ff88 : 0xff4444,
        won ? 0xaaffcc : 0xaaaaaa,
      );
    } else {
      this.overlayBig.visible = false;
      this.overlaySub.visible = false;
    }
  }

  private showOverlay(big: string, sub: string, bigColor: number, subColor: number): void {
    // Semi-transparent backdrop over the board centre
    const cx = BX + (BOARD_WIDTH * CELL) / 2;
    const cy = BY + (BOARD_HEIGHT * CELL) / 2;
    this.gfx.rect(cx - 130, cy - 40, 260, 70);
    this.gfx.fill({ color: 0x000022, alpha: 0.82 });

    this.overlayBig.text = big;
    this.overlayBig.style.fill = bigColor;
    this.overlayBig.visible = true;

    this.overlaySub.text = sub;
    this.overlaySub.style.fill = subColor;
    this.overlaySub.visible = true;
  }

  // ---------------------------------------------------------------------------
  // Cell drawing helper
  // ---------------------------------------------------------------------------

  /** Draws a single tetromino cell with a subtle 3D-bevel effect. */
  private drawCell(g: Graphics, x: number, y: number, fill: number, border: number): void {
    // Main face
    g.rect(x + 1, y + 1, CELL - 2, CELL - 2);
    g.fill(fill);

    // Right/bottom shadow (darker border)
    g.rect(x + CELL - 3, y + 1, 2, CELL - 2);
    g.fill(border);
    g.rect(x + 1, y + CELL - 3, CELL - 2, 2);
    g.fill(border);

    // Top-left highlight
    g.rect(x + 1, y + 1, CELL - 4, 2);
    g.fill({ color: CLR_SHINE, alpha: 0.18 });
    g.rect(x + 1, y + 1, 2, CELL - 4);
    g.fill({ color: CLR_SHINE, alpha: 0.18 });
  }

  // ---------------------------------------------------------------------------
  // Geometry helper
  // ---------------------------------------------------------------------------

  private pieceCells(
    piece: { type: TetrominoType; rotation: number; row: number; col: number },
  ): [number, number][] {
    const rotations = TETROMINO_SHAPES[piece.type];
    const shape = rotations[piece.rotation % rotations.length];
    return getCells(shape).map(([r, c]) => [r + piece.row, c + piece.col]);
  }
}


---
FILE: src/Rng.ts
---
/**
 * Seeded pseudo-random number generator using the Mulberry32 algorithm.
 * Deterministic: same seed always produces the same sequence.
 */
export class Rng {
  private state: number;

  constructor(seed: number) {
    // Coerce to unsigned 32-bit integer
    this.state = seed >>> 0;
  }

  /** Returns a float in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) >>> 0;
    return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
  }

  /** Returns an integer in [0, n). */
  nextInt(n: number): number {
    return Math.floor(this.next() * n);
  }

  /** Returns an integer in [min, max] (inclusive). */
  nextIntRange(min: number, max: number): number {
    return min + this.nextInt(max - min + 1);
  }

  /** Shuffles an array in-place using Fisher-Yates and returns it. */
  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.nextInt(i + 1);
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  /** Clone the current state so we can branch the RNG without advancing the original. */
  clone(): Rng {
    const r = new Rng(0);
    r.state = this.state;
    return r;
  }
}


---
FILE: src/RoundOutcomeController.ts
---
/**
 * RoundOutcomeController
 * ======================
 * Controls the expected win probability for each round WITHOUT blatantly
 * forcing outcomes.  The influence is applied through two subtle levers:
 *
 *  1. **Piece distribution bias** — adjusting the per-type spawn weight so
 *     that "winning" rounds receive more flat/line-friendly pieces (I, O, T)
 *     and "losing" rounds receive more awkward pieces (S, Z).
 *
 *  2. **Heuristic weight bias** — aggressive weights make the AI play
 *     near-optimally; passive weights make it pick mediocre placements.
 *
 * A "winning round" is defined as clearing at least WIN_THRESHOLD lines
 * before game-over.  At 50 % win probability, roughly half of all rounds
 * will clear ≥ WIN_THRESHOLD lines.
 *
 * The bias is NOT 100 % guaranteed to achieve the target — it steers toward
 * it probabilistically, which is intentional (would be obviously fake otherwise).
 */

import { Rng } from './Rng';
import {
  HeuristicWeights,
  DEFAULT_WEIGHTS,
  AGGRESSIVE_WEIGHTS,
  PASSIVE_WEIGHTS,
} from './AutoPlayer';
import { TetrominoType, ALL_TYPES } from './Tetromino';

/** Number of lines needed to consider a round a "win". */
export const WIN_THRESHOLD = 5;

export type PieceWeights = Record<TetrominoType, number>;

export interface RoundBiasConfig {
  heuristicWeights: HeuristicWeights;
  pieceWeights: PieceWeights;
  isWinningRound: boolean;
}

// ---------------------------------------------------------------------------
// Piece weight presets
// ---------------------------------------------------------------------------

/** Equal probability for every piece type (baseline). */
const NEUTRAL_WEIGHTS: PieceWeights = {
  I: 1, O: 1, T: 1, S: 1, Z: 1, J: 1, L: 1,
};

/**
 * Winning bias: more I/O/T pieces, fewer S/Z.
 * Ratio roughly 3:1 favourable vs unfavourable.
 */
const WIN_PIECE_WEIGHTS: PieceWeights = {
  I: 3.0,
  O: 2.0,
  T: 2.0,
  S: 0.25,
  Z: 0.25,
  J: 1.5,
  L: 1.5,
};

/**
 * Losing bias: heavier S/Z, lighter I/O.
 * Ratio roughly 3:1 unfavourable vs favourable.
 */
const LOSE_PIECE_WEIGHTS: PieceWeights = {
  I: 0.25,
  O: 0.5,
  T: 0.75,
  S: 3.0,
  Z: 3.0,
  J: 0.5,
  L: 0.5,
};

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

export class RoundOutcomeController {
  private rng: Rng;
  private winProbability = 0.5;
  private debugEnabled = false;

  // Bias settings computed at the start of each round
  private currentBias: RoundBiasConfig = {
    heuristicWeights: DEFAULT_WEIGHTS,
    pieceWeights: NEUTRAL_WEIGHTS,
    isWinningRound: false,
  };

  constructor(rng: Rng) {
    this.rng = rng;
  }

  setWinProbability(p: number): void {
    this.winProbability = Math.max(0, Math.min(1, p));
  }

  setDebug(enabled: boolean): void {
    this.debugEnabled = enabled;
  }

  /**
   * Must be called once at the start of each round.
   * Rolls to decide win vs loss and builds the bias config.
   */
  startRound(): RoundBiasConfig {
    const roll = this.rng.next();
    const isWinningRound = roll < this.winProbability;

    this.log(
      `Round start — roll=${roll.toFixed(3)}, threshold=${this.winProbability.toFixed(2)}, ` +
      `outcome=${isWinningRound ? 'WIN' : 'LOSE'}`,
    );

    this.currentBias = {
      isWinningRound,
      heuristicWeights: isWinningRound ? AGGRESSIVE_WEIGHTS : PASSIVE_WEIGHTS,
      pieceWeights: isWinningRound ? WIN_PIECE_WEIGHTS : LOSE_PIECE_WEIGHTS,
    };

    return this.currentBias;
  }

  get currentRoundIsWinning(): boolean {
    return this.currentBias.isWinningRound;
  }

  /**
   * Sample the next piece type according to the active weight distribution.
   * A weighted-random draw over the 7 piece types.
   */
  pickPiece(weights: PieceWeights): TetrominoType {
    const total = ALL_TYPES.reduce((sum, t) => sum + weights[t], 0);
    let draw = this.rng.next() * total;
    for (const type of ALL_TYPES) {
      draw -= weights[type];
      if (draw <= 0) return type;
    }
    // Fallback (floating-point edge case)
    return ALL_TYPES[ALL_TYPES.length - 1];
  }

  private log(msg: string): void {
    if (this.debugEnabled) console.log(`[RoundOutcomeController] ${msg}`);
  }
}


---
FILE: src/Simulation.ts
---
/**
 * Simulation — headless (no rendering) test harness.
 *
 * Runs N complete game rounds using the same Game logic as the live game
 * and reports observed win rates vs the configured probability.
 *
 * Usage (called from Ui.ts or the browser console):
 *
 *   import { runSimulation } from './Simulation';
 *   const result = runSimulation({ rounds: 100, winProbability: 0.5, bet: 10 });
 *   console.table(result);
 *
 * A "win" is defined as clearing ≥ WIN_THRESHOLD lines in a single round
 * (same definition used by RoundOutcomeController).
 */

import { Rng } from './Rng';
import { RoundOutcomeController, WIN_THRESHOLD } from './RoundOutcomeController';
import {
  BoardGrid,
  createEmptyBoard,
  isValidPlacement,
  lockPiece,
  findCompleteRows,
  clearRows,
  isTopOut,
  spawnPosition,
} from './Board';
import { findBestPlacement, hardDrop, HeuristicWeights } from './AutoPlayer';
import { PieceWeights } from './RoundOutcomeController';
import { TetrominoType } from './Tetromino';

export interface SimulationConfig {
  rounds: number;
  winProbability: number;
  bet: number;
  seed?: number;
  debugLog?: boolean;
}

export interface SimulationResult {
  totalRounds: number;
  wins: number;
  winRate: number;
  avgLines: number;
  avgPayout: number;
  avgNet: number;
  /** Return-to-player ratio: totalPayout / totalBet */
  rtp: number;
}

// ---------------------------------------------------------------------------
// Headless round runner
// ---------------------------------------------------------------------------

interface RoundResult {
  lines: number;
  payout: number;
}

/** Runs a single game round to completion without any rendering. */
function runOneRound(
  board: BoardGrid,
  weights: HeuristicWeights,
  pieceWeights: PieceWeights,
  controller: RoundOutcomeController,
  bet: number,
  debugLog: boolean,
): RoundResult {
  let lines = 0;
  let payout = 0;
  let currentBoard = board;

  // Safety cap: prevent infinite loops on pathological inputs
  const MAX_PIECES = 500;

  for (let i = 0; i < MAX_PIECES; i++) {
    // Pick and place next piece
    const type: TetrominoType = controller.pickPiece(pieceWeights);
    const spawn = spawnPosition(type);
    const placement = findBestPlacement(currentBoard, type, weights);

    if (!placement) {
      if (debugLog) console.log(`[Sim] No placement for ${type} — game over`);
      break;
    }

    const piece = { type, rotation: placement.rotation, row: spawn.row, col: placement.col };

    if (!isValidPlacement(currentBoard, piece)) {
      if (debugLog) console.log(`[Sim] Spawn blocked for ${type} — game over`);
      break;
    }

    // Simulate hard drop
    const dropped = hardDrop(currentBoard, piece);
    const newBoard = lockPiece(currentBoard, dropped);

    if (isTopOut(newBoard)) {
      if (debugLog) console.log(`[Sim] Top-out after ${type} — game over`);
      break;
    }

    // Clear completed lines
    const complete = findCompleteRows(newBoard);
    if (complete.length > 0) {
      const linePayout = complete.length * bet * 1.1;
      lines   += complete.length;
      payout  += linePayout;
      currentBoard = clearRows(newBoard, new Set(complete));
      if (debugLog) console.log(`[Sim] Cleared ${complete.length} lines, payout ${linePayout.toFixed(2)}`);
    } else {
      currentBoard = newBoard;
    }
  }

  return { lines, payout };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export function runSimulation(cfg: SimulationConfig): SimulationResult {
  const {
    rounds,
    winProbability,
    bet,
    seed = 42,
    debugLog = false,
  } = cfg;

  const rng = new Rng(seed);
  const controller = new RoundOutcomeController(rng);
  controller.setWinProbability(winProbability);
  controller.setDebug(debugLog);

  let wins = 0;
  let totalLines = 0;
  let totalPayout = 0;

  for (let r = 0; r < rounds; r++) {
    const bias = controller.startRound();

    const result = runOneRound(
      createEmptyBoard(),
      bias.heuristicWeights,
      bias.pieceWeights,
      controller,
      bet,
      debugLog,
    );

    if (result.lines >= WIN_THRESHOLD) wins++;
    totalLines  += result.lines;
    totalPayout += result.payout;

    if (debugLog) {
      console.log(
        `[Sim] Round ${r + 1}: lines=${result.lines}, payout=${result.payout.toFixed(2)}, ` +
        `win=${result.lines >= WIN_THRESHOLD}`,
      );
    }
  }

  const totalBet = rounds * bet;
  const avgLines  = totalLines  / rounds;
  const avgPayout = totalPayout / rounds;
  const avgNet    = avgPayout - bet;
  const rtp       = totalBet > 0 ? totalPayout / totalBet : 0;

  const result: SimulationResult = {
    totalRounds: rounds,
    wins,
    winRate: wins / rounds,
    avgLines,
    avgPayout,
    avgNet,
    rtp,
  };

  console.log(
    `[Simulation] P(win) configured=${(winProbability * 100).toFixed(0)}%  ` +
    `observed=${(result.winRate * 100).toFixed(1)}%  ` +
    `avgLines=${avgLines.toFixed(2)}  RTP=${(rtp * 100).toFixed(1)}%`,
  );

  return result;
}


---
FILE: src/Tetromino.ts
---
/**
 * Tetromino definitions: all 7 standard pieces, their rotation states,
 * and display colours.
 *
 * Each rotation is a 2-D grid (rows × cols) where 1 = filled cell.
 * Rotations follow the Super Rotation System (SRS) ordering:
 *   0 = spawn, 1 = clockwise, 2 = 180°, 3 = counter-clockwise.
 */

export type TetrominoType = 'I' | 'O' | 'T' | 'S' | 'Z' | 'J' | 'L';

/** A 2-D bitmask representing one rotation state of a piece. */
export type RotationMatrix = number[][];

// ---------------------------------------------------------------------------
// Shape definitions
// ---------------------------------------------------------------------------

export const TETROMINO_SHAPES: Record<TetrominoType, RotationMatrix[]> = {
  // I — 4×4 bounding box
  I: [
    [[0, 0, 0, 0], [1, 1, 1, 1], [0, 0, 0, 0], [0, 0, 0, 0]],
    [[0, 0, 1, 0], [0, 0, 1, 0], [0, 0, 1, 0], [0, 0, 1, 0]],
    [[0, 0, 0, 0], [0, 0, 0, 0], [1, 1, 1, 1], [0, 0, 0, 0]],
    [[0, 1, 0, 0], [0, 1, 0, 0], [0, 1, 0, 0], [0, 1, 0, 0]],
  ],

  // O — 3×3 bounding box (single rotation; all four states are identical)
  O: [
    [[0, 1, 1, 0], [0, 1, 1, 0], [0, 0, 0, 0], [0, 0, 0, 0]],
  ],

  // T — 3×3 bounding box
  T: [
    [[0, 1, 0], [1, 1, 1], [0, 0, 0]],
    [[0, 1, 0], [0, 1, 1], [0, 1, 0]],
    [[0, 0, 0], [1, 1, 1], [0, 1, 0]],
    [[0, 1, 0], [1, 1, 0], [0, 1, 0]],
  ],

  // S — 3×3 bounding box
  S: [
    [[0, 1, 1], [1, 1, 0], [0, 0, 0]],
    [[0, 1, 0], [0, 1, 1], [0, 0, 1]],
    [[0, 0, 0], [0, 1, 1], [1, 1, 0]],
    [[1, 0, 0], [1, 1, 0], [0, 1, 0]],
  ],

  // Z — 3×3 bounding box
  Z: [
    [[1, 1, 0], [0, 1, 1], [0, 0, 0]],
    [[0, 0, 1], [0, 1, 1], [0, 1, 0]],
    [[0, 0, 0], [1, 1, 0], [0, 1, 1]],
    [[0, 1, 0], [1, 1, 0], [1, 0, 0]],
  ],

  // J — 3×3 bounding box
  J: [
    [[1, 0, 0], [1, 1, 1], [0, 0, 0]],
    [[0, 1, 1], [0, 1, 0], [0, 1, 0]],
    [[0, 0, 0], [1, 1, 1], [0, 0, 1]],
    [[0, 1, 0], [0, 1, 0], [1, 1, 0]],
  ],

  // L — 3×3 bounding box
  L: [
    [[0, 0, 1], [1, 1, 1], [0, 0, 0]],
    [[0, 1, 0], [0, 1, 0], [0, 1, 1]],
    [[0, 0, 0], [1, 1, 1], [1, 0, 0]],
    [[1, 1, 0], [0, 1, 0], [0, 1, 0]],
  ],
};

// ---------------------------------------------------------------------------
// Colours  (standard Tetris guideline palette)
// ---------------------------------------------------------------------------

export const TETROMINO_COLORS: Record<TetrominoType, number> = {
  I: 0x00f0f0, // Cyan
  O: 0xf0f000, // Yellow
  T: 0xa000f0, // Purple
  S: 0x00f000, // Green
  Z: 0xf00000, // Red
  J: 0x0000f0, // Blue
  L: 0xf0a000, // Orange
};

/** Dimmer border shade for each piece (used for cell outline). */
export const TETROMINO_BORDER_COLORS: Record<TetrominoType, number> = {
  I: 0x008888,
  O: 0x888800,
  T: 0x580088,
  S: 0x008800,
  Z: 0x880000,
  J: 0x000088,
  L: 0x885800,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns every [row, col] offset occupied by a shape. */
export function getCells(shape: RotationMatrix): [number, number][] {
  const cells: [number, number][] = [];
  for (let r = 0; r < shape.length; r++) {
    for (let c = 0; c < shape[r].length; c++) {
      if (shape[r][c]) cells.push([r, c]);
    }
  }
  return cells;
}

/** All seven piece types in spawn-probability order. */
export const ALL_TYPES: TetrominoType[] = ['I', 'O', 'T', 'S', 'Z', 'J', 'L'];

/** "Good" pieces — tend to be easier to place and help clear lines. */
export const GOOD_PIECES: TetrominoType[] = ['I', 'O', 'T', 'L', 'J'];

/** "Bad" pieces — tend to create awkward overhangs and holes. */
export const BAD_PIECES: TetrominoType[] = ['S', 'Z'];


---
FILE: src/Ui.ts
---
/**
 * Ui — manages all HTML-side DOM interactions.
 *
 * The PixiJS canvas handles only the board.  Everything else (balance,
 * bet selection, win-probability buttons, seed input, etc.) lives in HTML
 * and is wired here.
 *
 * Update flow
 * -----------
 *  main.ts calls `ui.update(state)` once per ticker frame to sync the
 *  displayed numbers.  Event listeners call back into `game.*` methods.
 */

import { Game } from './Game';
import { GameState } from './Game';

export class Ui {
  private game: Game;

  // Cached DOM references
  private elBalance:    HTMLElement;
  private elStatus:     HTMLElement;
  private elLines:      HTMLElement;
  private elPayout:     HTMLElement;
  private elNet:        HTMLElement;
  private elBtnStart:   HTMLButtonElement;
  private elBtnSim:     HTMLButtonElement;
  private elSimResults: HTMLElement;
  private elSimOutput:  HTMLElement;
  private elSeed:       HTMLInputElement;
  private elDebug:      HTMLInputElement;

  private currentBet = 10;
  private currentProb = 0.5;

  constructor(game: Game) {
    this.game = game;

    this.elBalance    = this.must('ui-balance');
    this.elStatus     = this.must('ui-status');
    this.elLines      = this.must('ui-lines');
    this.elPayout     = this.must('ui-payout');
    this.elNet        = this.must('ui-net');
    this.elBtnStart   = this.must<HTMLButtonElement>('btn-start');
    this.elBtnSim     = this.must<HTMLButtonElement>('btn-simulate');
    this.elSimResults = this.must('sim-results');
    this.elSimOutput  = this.must('sim-output');
    this.elSeed       = this.must<HTMLInputElement>('ui-seed');
    this.elDebug      = this.must<HTMLInputElement>('ui-debug');

    this.bindEvents();
  }

  // ---------------------------------------------------------------------------
  // Binding
  // ---------------------------------------------------------------------------

  private bindEvents(): void {
    // Bet amount buttons
    document.querySelectorAll<HTMLButtonElement>('.bet-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const bet = parseInt(btn.dataset.bet ?? '10', 10) as 10 | 20 | 50;
        this.currentBet = bet;
        this.game.setBet(bet);

        document.querySelectorAll('.bet-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });

    // Win-probability buttons
    document.querySelectorAll<HTMLButtonElement>('.prob-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const prob = parseFloat(btn.dataset.prob ?? '0.5');
        this.currentProb = prob;
        this.game.setWinProbability(prob);

        document.querySelectorAll('.prob-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });

    // Start / Play Again button
    this.elBtnStart.addEventListener('click', () => {
      this.game.startRound();
    });

    // Simulation button
    this.elBtnSim.addEventListener('click', () => this.runSimulation());

    // Seed input
    this.elSeed.addEventListener('change', () => {
      const seed = parseInt(this.elSeed.value, 10);
      if (!isNaN(seed)) this.game.setSeed(seed);
    });

    // Random seed button
    document.getElementById('btn-random-seed')?.addEventListener('click', () => {
      const seed = Math.floor(Math.random() * 1e8);
      this.elSeed.value = String(seed);
      this.game.setSeed(seed);
    });

    // Debug toggle
    this.elDebug.addEventListener('change', () => {
      this.game.setDebug(this.elDebug.checked);
    });
  }

  // ---------------------------------------------------------------------------
  // Per-frame update (called from ticker)
  // ---------------------------------------------------------------------------

  update(state: GameState): void {
    this.elBalance.textContent = `${state.balance.toFixed(0)} FUN`;
    this.elLines.textContent   = String(state.roundLines);
    this.elPayout.textContent  = `${state.roundPayout.toFixed(2)} FUN`;

    const net = state.roundPayout - this.currentBet;
    this.elNet.textContent = `${net >= 0 ? '+' : ''}${net.toFixed(2)} FUN`;
    this.elNet.className = 'stat-value ' + (net > 0 ? 'positive' : net < 0 ? 'negative' : '');

    this.updateStatus(state);
    this.updateStartButton(state);
  }

  private updateStatus(state: GameState): void {
    const labels: Record<string, string> = {
      IDLE:      'Ready',
      DROPPING:  'Running',
      CLEARING:  'Running',
      GAME_OVER: 'Game Over',
    };
    const classes: Record<string, string> = {
      IDLE:      'status-ready',
      DROPPING:  'status-running',
      CLEARING:  'status-running',
      GAME_OVER: 'status-gameover',
    };
    this.elStatus.textContent = labels[state.phase] ?? state.phase;
    this.elStatus.className = 'stat-value status-badge ' + (classes[state.phase] ?? '');
  }

  private updateStartButton(state: GameState): void {
    const isGameOver = state.phase === 'GAME_OVER';
    const isIdle     = state.phase === 'IDLE';

    this.elBtnStart.disabled = !isIdle && !isGameOver;
    this.elBtnStart.textContent = isGameOver ? '↺ PLAY AGAIN' : '▶ START ROUND';
  }

  // ---------------------------------------------------------------------------
  // Simulation
  // ---------------------------------------------------------------------------

  private runSimulation(): void {
    // Import lazily to avoid circular deps — Simulation uses Game internally
    import('./Simulation').then(({ runSimulation }) => {
      const seed = parseInt(this.elSeed.value, 10) || 42;
      const result = runSimulation({
        rounds: 100,
        winProbability: this.currentProb,
        bet: this.currentBet,
        seed,
      });

      this.elSimResults.style.display = 'block';
      this.elSimOutput.innerHTML = [
        `<b>Rounds:</b> ${result.totalRounds}`,
        `<b>Configured P(win):</b> ${(this.currentProb * 100).toFixed(0)}%`,
        `<b>Observed wins:</b> ${result.wins} (${(result.winRate * 100).toFixed(1)}%)`,
        `<b>Avg lines/round:</b> ${result.avgLines.toFixed(2)}`,
        `<b>Avg payout/round:</b> ${result.avgPayout.toFixed(2)} FUN`,
        `<b>Avg net/round:</b> ${result.avgNet.toFixed(2)} FUN`,
        `<b>RTP:</b> ${(result.rtp * 100).toFixed(1)}%`,
      ].join('<br>');
    });
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private must<T extends HTMLElement>(id: string): T {
    const el = document.getElementById(id) as T | null;
    if (!el) throw new Error(`[Ui] Element #${id} not found`);
    return el;
  }
}


---
FILE: src/main.ts
---
/**
 * main.ts — application entry point.
 *
 * 1. Creates the PixiJS Application and mounts the canvas.
 * 2. Instantiates Game, Renderer, and Ui.
 * 3. Wires the ticker to drive game updates and rendering.
 */

import { Application } from 'pixi.js';
import { Game } from './Game';
import { Renderer, CANVAS_WIDTH, CANVAS_HEIGHT } from './Renderer';
import { Ui } from './Ui';

async function main(): Promise<void> {
  // -------------------------------------------------------------------------
  // PixiJS initialisation
  // -------------------------------------------------------------------------
  const app = new Application();

  await app.init({
    width:           CANVAS_WIDTH,
    height:          CANVAS_HEIGHT,
    backgroundColor: 0x0d0d1a,
    antialias:       false, // pixel-perfect grid looks better without AA
    resolution:      window.devicePixelRatio || 1,
    autoDensity:     true,
  });

  const container = document.getElementById('canvas-container');
  if (!container) throw new Error('Missing #canvas-container element');
  container.appendChild(app.canvas);

  // -------------------------------------------------------------------------
  // Game subsystems
  // -------------------------------------------------------------------------
  const initialSeed = 42;
  const game    = new Game(initialSeed);
  const renderer = new Renderer(app);
  const ui       = new Ui(game);

  // -------------------------------------------------------------------------
  // Game ticker — fixed-time-step logic + rendering
  // -------------------------------------------------------------------------
  app.ticker.maxFPS = 60;

  app.ticker.add((ticker) => {
    const deltaMs = ticker.deltaMS;

    // Advance game logic
    game.update(deltaMs);

    // Render current state
    const state = game.getState();
    renderer.render(state, game.clearFlashPhase);

    // Sync HTML panel
    ui.update(state);
  });

  // -------------------------------------------------------------------------
  // Responsive canvas scaling
  // -------------------------------------------------------------------------
  function resizeCanvas(): void {
    const panelWidth = 280; // matches CSS --panel-width
    const availW = window.innerWidth  - panelWidth - 32;
    const availH = window.innerHeight - 32;
    const scale  = Math.min(availW / CANVAS_WIDTH, availH / CANVAS_HEIGHT, 1.5);

    app.canvas.style.width  = `${Math.floor(CANVAS_WIDTH  * scale)}px`;
    app.canvas.style.height = `${Math.floor(CANVAS_HEIGHT * scale)}px`;
  }

  window.addEventListener('resize', resizeCanvas);
  resizeCanvas();

  // Expose to browser console for quick experiments
  (window as Record<string, unknown>)['game'] = game;
}

main().catch(err => {
  console.error('[AutoTetris] Fatal error:', err);
});


---
FILE: src/style.css
---
/* ============================================================
   Auto-Tetris — Global styles
   ============================================================ */

:root {
  --bg:          #0a0a18;
  --panel-bg:    #10101e;
  --border:      #1e2a4a;
  --accent:      #3366cc;
  --accent-hot:  #5588ff;
  --text:        #c8d4f0;
  --text-dim:    #556688;
  --win:         #44cc88;
  --lose:        #cc4444;
  --panel-width: 280px;
  --gap:         12px;
}

*, *::before, *::after {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

html, body {
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: var(--bg);
  font-family: 'Segoe UI', Arial, sans-serif;
  color: var(--text);
  font-size: 14px;
}

/* ── Layout ────────────────────────────────────────────────── */

#app {
  display: flex;
  flex-direction: row;
  align-items: flex-start;
  justify-content: center;
  gap: var(--gap);
  padding: 16px;
  height: 100vh;
}

#canvas-container {
  flex-shrink: 0;
  display: flex;
  align-items: flex-start;
}

#canvas-container canvas {
  display: block;
  image-rendering: pixelated;
  border: 2px solid var(--border);
  border-radius: 4px;
}

/* ── Side panel ─────────────────────────────────────────────── */

#ui-panel {
  width: var(--panel-width);
  min-width: var(--panel-width);
  max-height: calc(100vh - 32px);
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: var(--gap);
  scrollbar-width: thin;
  scrollbar-color: var(--border) transparent;
}

.game-title {
  font-size: 22px;
  font-weight: 900;
  letter-spacing: 4px;
  text-align: center;
  color: var(--accent-hot);
  text-shadow: 0 0 18px #3366cc88;
  padding: 4px 0 8px;
  border-bottom: 1px solid var(--border);
}

/* ── Section card ───────────────────────────────────────────── */

.ui-section {
  background: var(--panel-bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.section-title {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 2px;
  color: var(--text-dim);
  text-transform: uppercase;
}

/* ── Stat rows ──────────────────────────────────────────────── */

.stat-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.stat-label {
  color: var(--text-dim);
  font-size: 13px;
}

.stat-value {
  font-size: 15px;
  font-weight: 700;
  color: var(--text);
}

.stat-value.positive { color: var(--win); }
.stat-value.negative { color: var(--lose); }

/* ── Status badge ───────────────────────────────────────────── */

.status-badge {
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 12px;
  letter-spacing: 1px;
}

.status-ready    { background: #223; color: #88aaff; }
.status-running  { background: #132813; color: #66ee88; }
.status-gameover { background: #2a1010; color: #ff6666; }

/* ── Bet buttons ────────────────────────────────────────────── */

.bet-buttons,
.win-prob-buttons {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.bet-btn,
.prob-btn {
  flex: 1;
  padding: 7px 4px;
  background: #181830;
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--text-dim);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s;
}

.bet-btn:hover,
.prob-btn:hover {
  border-color: var(--accent);
  color: var(--text);
}

.bet-btn.active,
.prob-btn.active {
  background: var(--accent);
  border-color: var(--accent-hot);
  color: #fff;
  box-shadow: 0 0 10px #3366cc55;
}

.prob-note {
  font-size: 11px;
  color: var(--text-dim);
  text-align: center;
  margin-top: -2px;
}

/* ── Seed input ─────────────────────────────────────────────── */

.seed-row {
  display: flex;
  gap: 6px;
  align-items: center;
}

.seed-row input {
  flex: 1;
  padding: 6px 8px;
  background: #181830;
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--text);
  font-size: 13px;
  outline: none;
}

.seed-row input:focus {
  border-color: var(--accent);
}

.seed-row button {
  padding: 6px 10px;
  background: #181830;
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--text);
  cursor: pointer;
  font-size: 16px;
  transition: border-color 0.15s;
}

.seed-row button:hover {
  border-color: var(--accent);
}

/* ── Control buttons ────────────────────────────────────────── */

.control-btn {
  width: 100%;
  padding: 10px;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 700;
  letter-spacing: 1px;
  cursor: pointer;
  transition: all 0.15s;
  border: none;
}

.control-btn.primary {
  background: var(--accent);
  color: #fff;
  box-shadow: 0 0 14px #3366cc44;
}

.control-btn.primary:hover:not(:disabled) {
  background: var(--accent-hot);
  box-shadow: 0 0 20px #5588ff66;
}

.control-btn.primary:disabled {
  background: #1a2040;
  color: var(--text-dim);
  cursor: not-allowed;
  box-shadow: none;
}

.control-btn.secondary {
  background: #181830;
  color: var(--text-dim);
  border: 1px solid var(--border);
  font-size: 12px;
  padding: 8px;
}

.control-btn.secondary:hover {
  border-color: var(--accent);
  color: var(--text);
}

/* ── Simulation output ──────────────────────────────────────── */

.sim-output {
  font-size: 12px;
  line-height: 1.8;
  color: var(--text-dim);
}

.sim-output b {
  color: var(--text);
}

/* ── Debug toggle ───────────────────────────────────────────── */

.debug-row {
  padding: 6px 12px;
}

.debug-row label {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  color: var(--text-dim);
  font-size: 12px;
}

.debug-row input[type='checkbox'] {
  accent-color: var(--accent);
  width: 14px;
  height: 14px;
}

/* ── Scrollbar ──────────────────────────────────────────────── */

#ui-panel::-webkit-scrollbar {
  width: 4px;
}
#ui-panel::-webkit-scrollbar-thumb {
  background: var(--border);
  border-radius: 2px;
}
