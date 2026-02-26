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
