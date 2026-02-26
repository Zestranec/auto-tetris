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
  findAllPlacements,
  hardDrop,
} from './AutoPlayer';
import { PieceWeights, RoundBiasConfig, RoundOutcomeController, WIN_THRESHOLD } from './RoundOutcomeController';
import { Rng } from './Rng';
import { TetrominoType } from './Tetromino';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GamePhase = 'IDLE' | 'DROPPING' | 'CLEARING' | 'GAME_OVER' | 'FINISHED';

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
  /** Number of blocks (tetrominoes) purchased for this round. Bet = boughtBlocks * 1 FUN. */
  boughtBlocks: number;
  /** Derived cost: boughtBlocks × 1 FUN. Used for payout calculation. */
  bet: number;
  /** Number of tetrominoes locked so far this round. */
  playedBlocks: number;
  /** 0-based index of the next clear event; increments each time lines are cleared. */
  clearEventIndex: number;
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
// Payout progression constants
// ---------------------------------------------------------------------------

/** Base geometric ratio for the payout progression. */
const PROGRESSION_R = 1.08;

/**
 * After this many clear events the ratio is softly reduced toward
 * PROGRESSION_R_FLOOR to prevent runaway payouts in rare long runs.
 */
const PAYOUT_CAP_START = 8;

/**
 * Floor value of the geometric ratio after the soft cap kicks in.
 * Lerps from PROGRESSION_R down to this value over the next 10 events.
 */
const PROGRESSION_R_FLOOR = 1.02;

/**
 * Base payout coefficient.
 * Formula: payout = bet * PAYOUT_COEFF_A * effectiveR^eventIndex * clearedLines
 * Reduced from 0.32 to account for the softer win-mode clearing fewer lines.
 * The global RTP controller in RoundOutcomeController handles fine-tuning.
 */
export const PAYOUT_COEFF_A = 0.24;

/**
 * Compute the effective geometric ratio for a given clear-event index,
 * applying a soft cap for high-index events to prevent runaway payouts.
 * Exported so Simulation.ts uses the exact same formula.
 */
export function computeEffectiveR(clearEventIndex: number): number {
  if (clearEventIndex <= PAYOUT_CAP_START) return PROGRESSION_R;
  const t = Math.min((clearEventIndex - PAYOUT_CAP_START) / 10, 1);
  return PROGRESSION_R + (PROGRESSION_R_FLOOR - PROGRESSION_R) * t;
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
  /** Set to true when the block limit is reached during a line-clear animation. */
  private _finishAfterClear = false;
  /** Multiplier applied to deltaMs each tick — 1 = normal, 10 = fast-forward. */
  private speedMultiplier = 1;

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

  setBoughtBlocks(n: 30 | 50 | 75): void {
    if (this.state.phase === 'IDLE' || this.state.phase === 'GAME_OVER' || this.state.phase === 'FINISHED') {
      this.state = { ...this.state, boughtBlocks: n, bet: n };
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
    const restartPhases: GamePhase[] = ['IDLE', 'GAME_OVER', 'FINISHED'];
    if (!restartPhases.includes(this.state.phase)) return;
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
      playedBlocks: 0,
      clearEventIndex: 0,
      roundLines: 0,
      roundPayout: 0,
      roundIsDesignatedWin: bias.isWinningRound,
      weights: bias.heuristicWeights,
      pieceWeights: bias.pieceWeights,
    };

    this.dropAccumMs = 0;
    this.clearAccumMs = 0;

    this.log(
      `Round started — boughtBlocks=${this.state.boughtBlocks}, bet=${this.state.bet}, ` +
      `designatedWin=${bias.isWinningRound}`,
    );

    this.onRoundStart?.(this.state);
    this.spawnNextPiece();
  }

  /** Set tick-rate multiplier. 1 = normal, 10 = 10× fast-forward. */
  setSpeedMultiplier(m: number): void {
    this.speedMultiplier = Math.max(1, m);
  }

  get currentSpeedMultiplier(): number {
    return this.speedMultiplier;
  }

  /** Main update tick — call once per animation frame with elapsed ms. */
  update(deltaMs: number): void {
    // Scale real-time delta so more logic ticks fit per frame at higher speeds
    const effective = deltaMs * this.speedMultiplier;
    switch (this.state.phase) {
      case 'DROPPING':
        this.tickDrop(effective);
        break;
      case 'CLEARING':
        this.tickClear(effective);
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

    // Collect all legal placements scored by the active heuristic weights.
    // RoundOutcomeController then picks the best (win mode) or one of the
    // worst K (lose mode), implementing placement degradation without touching
    // board logic.
    const allPlacements = findAllPlacements(
      this.state.board,
      type,
      this.state.weights,
    );

    if (allPlacements.length === 0) {
      // No legal placement exists — game over
      this.triggerGameOver();
      return;
    }

    const placement: Placement = this.outcomeController.pickPlacement(allPlacements);

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
    const newPlayedBlocks = this.state.playedBlocks + 1;

    this.log(`Locked ${piece.type} at row=${piece.row}, col=${piece.col} (block ${newPlayedBlocks}/${this.state.boughtBlocks})`);

    // Check top-out AFTER locking
    if (isTopOut(newBoard)) {
      this.state = { ...this.state, board: newBoard, currentPiece: null, playedBlocks: newPlayedBlocks };
      this.triggerGameOver();
      return;
    }

    const completeRows = findCompleteRows(newBoard);
    const blockLimitReached = newPlayedBlocks >= this.state.boughtBlocks;

    if (completeRows.length > 0) {
      // Geometric progression with soft cap: each clear event pays more than the
      // last, but the ratio is gently reduced after PAYOUT_CAP_START events.
      const effectiveR = computeEffectiveR(this.state.clearEventIndex);
      const payout = this.state.bet * PAYOUT_COEFF_A
        * Math.pow(effectiveR, this.state.clearEventIndex)
        * completeRows.length;
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
        playedBlocks: newPlayedBlocks,
        clearEventIndex: this.state.clearEventIndex + 1,
        roundLines: newRoundLines,
        roundPayout: newRoundPayout,
      };

      // Store whether we should finish after the clear animation
      this._finishAfterClear = blockLimitReached;

      this.clearAccumMs = 0;

      this.log(`Lines cleared: ${completeRows.length} — payout: ${payout.toFixed(2)}`);
      this.onLinesCleared?.(completeRows.length, payout, newBalance);
    } else {
      this.state = { ...this.state, board: newBoard, currentPiece: null, playedBlocks: newPlayedBlocks };
      if (blockLimitReached) {
        this.triggerFinished();
        return;
      }
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

  /** Animation done — remove rows, then either spawn next piece or end round. */
  private finishLineClear(): void {
    const rows = new Set(this.state.clearingRows);
    const newBoard = clearRows(this.state.board, rows);
    const shouldFinish = this._finishAfterClear;
    this._finishAfterClear = false;

    this.state = {
      ...this.state,
      board: newBoard,
      clearingRows: [],
      phase: 'DROPPING',
    };

    this.clearAccumMs = 0;

    if (shouldFinish) {
      this.triggerFinished();
    } else {
      this.spawnNextPiece();
    }
  }

  // ---------------------------------------------------------------------------
  // Game over
  // ---------------------------------------------------------------------------

  private triggerGameOver(): void {
    const won = this.state.roundLines >= WIN_THRESHOLD;
    this.speedMultiplier = 1;
    // Record result for global RTP correction before state transition
    this.outcomeController.recordRoundResult(this.state.bet, this.state.roundPayout);
    this.state = { ...this.state, phase: 'GAME_OVER', currentPiece: null };

    this.log(
      `Game over — lines=${this.state.roundLines}, ` +
      `payout=${this.state.roundPayout.toFixed(2)}, ` +
      `won=${won} (designatedWin=${this.state.roundIsDesignatedWin})`,
    );

    this.onGameOver?.(this.state);
    this.notify();
  }

  /** Block limit reached cleanly — round is "Finished" (not a top-out). */
  private triggerFinished(): void {
    const won = this.state.roundLines >= WIN_THRESHOLD;
    this.speedMultiplier = 1;
    // Record result for global RTP correction before state transition
    this.outcomeController.recordRoundResult(this.state.bet, this.state.roundPayout);
    this.state = { ...this.state, phase: 'FINISHED', currentPiece: null };

    this.log(
      `Round finished — blocks=${this.state.playedBlocks}/${this.state.boughtBlocks}, ` +
      `lines=${this.state.roundLines}, payout=${this.state.roundPayout.toFixed(2)}, ` +
      `won=${won}`,
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
      boughtBlocks: 30,
      bet: 30,           // bet = boughtBlocks * 1 FUN
      playedBlocks: 0,
      clearEventIndex: 0,
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
