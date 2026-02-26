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
