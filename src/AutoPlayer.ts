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
 * Win weights — good but imperfect play.  Rewards line clears without
 * hyper-optimising, leaving room for natural variance and moderate payouts.
 * Used instead of AGGRESSIVE_WEIGHTS for soft win-mode.
 */
export const WIN_WEIGHTS: HeuristicWeights = {
  completeLines: 120,
  holes: -38,
  aggregateHeight: -0.5,
  bumpiness: -2.5,
  maxHeight: -6,
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

/**
 * Sabotage weights — actively penalises line clears so the AI deliberately
 * stacks pieces WITHOUT completing rows.  Used for hard-lose rounds.
 * A strongly negative completeLines score means the AI chooses placements
 * that leave rows incomplete.
 */
export const SABOTAGE_WEIGHTS: HeuristicWeights = {
  completeLines: -500, // avoid completing rows at all costs
  holes: -3,           // tolerate holes
  aggregateHeight: -0.4,
  bumpiness: -0.5,     // tolerate jagged surface
  maxHeight: -1.5,
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
 * Collects ALL legal (rotation × column) placements for the given piece type,
 * scored with the provided weights, and returns them sorted descending
 * (best score first).
 *
 * Returns an empty array when no legal placement exists (board completely blocked).
 */
export function findAllPlacements(
  board: BoardGrid,
  type: TetrominoType,
  weights: HeuristicWeights,
): Placement[] {
  const rotations = TETROMINO_SHAPES[type];
  const results: Placement[] = [];

  for (let rotation = 0; rotation < rotations.length; rotation++) {
    const shapeWidth = rotations[rotation][0].length;

    for (let col = -(shapeWidth - 1); col < BOARD_WIDTH; col++) {
      const candidate: FallingPiece = { type, rotation, row: 0, col };

      if (!couldFitHorizontally(shapeWidth, col)) continue;

      const dropped = hardDrop(board, candidate);
      if (!isValidPlacement(board, dropped)) continue;

      const resultBoard = lockPiece(board, dropped);
      const score = evaluateBoard(resultBoard, weights);
      results.push({ rotation, col, score });
    }
  }

  // Sort descending: best placement at index 0
  results.sort((a, b) => b.score - a.score);
  return results;
}

/**
 * Convenience wrapper: returns the single best placement or null.
 * Kept for any callers that only need the top result.
 */
export function findBestPlacement(
  board: BoardGrid,
  type: TetrominoType,
  weights: HeuristicWeights,
): Placement | null {
  const all = findAllPlacements(board, type, weights);
  return all.length > 0 ? all[0] : null;
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
