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
