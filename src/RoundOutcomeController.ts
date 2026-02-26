/**
 * RoundOutcomeController
 * ======================
 * Controls the expected win probability for each round WITHOUT blatantly
 * forcing outcomes.  Influence levers:
 *
 *  1. Piece distribution bias
 *  2. Heuristic weight bias (win → WIN_WEIGHTS; lose → SABOTAGE_WEIGHTS)
 *  3. Placement selection (win → top-K random; lose → worst-K random)
 *  4. Global RTP correction (small nudge to win probability so long-run
 *     return-to-player converges toward TARGET_RTP = 0.95)
 *
 * Win probability is always [0, 1].  0.10 = 10 % win rate.
 */

import { Rng } from './Rng';
import {
  HeuristicWeights,
  WIN_WEIGHTS,
  SABOTAGE_WEIGHTS,
  Placement,
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
// Constants
// ---------------------------------------------------------------------------

/**
 * Win mode: pick randomly from the top K placements so win-rounds feel
 * natural rather than robotic.  Larger K → more imperfections.
 */
const WIN_TOP_K = 3;

/**
 * Lose mode: pick randomly from the worst K placements to introduce errors.
 */
const LOSE_WORST_K = 4;

/**
 * Target return-to-player ratio for the RTP correction system.
 * Long-run payout / long-run bet converges toward this value.
 */
const TARGET_RTP = 0.95;

/**
 * How strongly the RTP error feeds back into win-probability adjustment.
 * Small value → slow, smooth correction.  Range: (0, 1].
 */
const RTP_CORRECTION_FACTOR = 0.15;

// ---------------------------------------------------------------------------
// Piece weight presets
// ---------------------------------------------------------------------------

/**
 * Slight win bias: I/O/T moderately favoured; S/Z slightly reduced.
 * Kept close to neutral so gameplay looks natural.
 */
const WIN_PIECE_WEIGHTS: PieceWeights = {
  I: 2.0,
  O: 1.6,
  T: 1.6,
  S: 0.45,
  Z: 0.45,
  J: 1.2,
  L: 1.2,
};

/**
 * Lose bias: S/Z dominate (~55 % of all pieces); I/O/T are rare.
 */
const LOSE_PIECE_WEIGHTS: PieceWeights = {
  I: 0.15,
  O: 0.25,
  T: 0.50,
  S: 3.50,
  Z: 3.50,
  J: 2.00,
  L: 2.00,
};

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

export class RoundOutcomeController {
  private rng: Rng;
  /** Base win probability in [0, 1] set by the operator. */
  private winProbability = 0.5;
  private debugEnabled = false;

  // --- Global RTP tracking ---
  private totalBet    = 0;
  private totalPayout = 0;

  private currentBias: RoundBiasConfig = {
    heuristicWeights: WIN_WEIGHTS,
    pieceWeights: WIN_PIECE_WEIGHTS,
    isWinningRound: false,
  };

  constructor(rng: Rng) {
    this.rng = rng;
  }

  /**
   * Set base win probability.  Must be in [0, 1].
   * Do NOT pass percentages (e.g. 50) — pass fractions (e.g. 0.50).
   */
  setWinProbability(p: number): void {
    this.winProbability = Math.max(0, Math.min(1, p));
  }

  setDebug(enabled: boolean): void {
    this.debugEnabled = enabled;
  }

  /**
   * Record the outcome of a completed round so the RTP correction system
   * can adjust future win probability.  Call once per round end.
   */
  recordRoundResult(bet: number, payout: number): void {
    this.totalBet    += bet;
    this.totalPayout += payout;
  }

  /**
   * Must be called once at the start of each round.
   * Rolls the RNG and builds the full bias config.
   *
   * Applies a small RTP correction: if we have been paying out more than
   * TARGET_RTP, the effective win probability is reduced slightly (and vice
   * versa).  The correction is always small — no sudden jumps.
   */
  startRound(): RoundBiasConfig {
    // --- RTP correction ---
    let effectiveWinProb = this.winProbability;
    if (this.totalBet > 0) {
      const currentRtp = this.totalPayout / this.totalBet;
      const error = TARGET_RTP - currentRtp;          // positive → underpaying
      const correction = error * RTP_CORRECTION_FACTOR;
      effectiveWinProb = Math.max(0.01, Math.min(0.99, this.winProbability + correction));

      this.log(
        `RTP correction — currentRtp=${(currentRtp * 100).toFixed(1)}%, ` +
        `error=${error.toFixed(3)}, ` +
        `winProb ${this.winProbability.toFixed(3)} → ${effectiveWinProb.toFixed(3)}`,
      );
    }

    const roll = this.rng.next();
    const isWinningRound = roll < effectiveWinProb;

    this.log(
      `Round start — roll=${roll.toFixed(3)}, threshold=${effectiveWinProb.toFixed(3)}, ` +
      `outcome=${isWinningRound ? 'WIN' : 'LOSE'}`,
    );

    this.currentBias = {
      isWinningRound,
      heuristicWeights: isWinningRound ? WIN_WEIGHTS : SABOTAGE_WEIGHTS,
      pieceWeights:     isWinningRound ? WIN_PIECE_WEIGHTS : LOSE_PIECE_WEIGHTS,
    };

    return this.currentBias;
  }

  get currentRoundIsWinning(): boolean {
    return this.currentBias.isWinningRound;
  }

  /**
   * Sample the next piece type according to the active weight distribution.
   */
  pickPiece(weights: PieceWeights): TetrominoType {
    const total = ALL_TYPES.reduce((sum, t) => sum + weights[t], 0);
    let draw = this.rng.next() * total;
    for (const type of ALL_TYPES) {
      draw -= weights[type];
      if (draw <= 0) return type;
    }
    return ALL_TYPES[ALL_TYPES.length - 1];
  }

  /**
   * Given all valid placements sorted descending by score (best first):
   *
   * - Win mode  → pick randomly from the top K (imperfect but good play).
   * - Lose mode → pick randomly from the worst K (deliberate mistakes).
   */
  pickPlacement(placements: Placement[]): Placement {
    if (placements.length === 0) {
      throw new Error('[RoundOutcomeController] pickPlacement called with empty array');
    }
    if (placements.length === 1) return placements[0];

    if (this.currentBias.isWinningRound) {
      // Top-K random: introduce small natural imperfections
      const k   = Math.min(WIN_TOP_K, placements.length);
      const idx = this.rng.nextInt(k);
      this.log(`Win-mode placement: chose rank ${idx + 1}/${placements.length} (top-${k} pool)`);
      return placements[idx];
    } else {
      // Worst-K random: deliberate errors
      const k          = Math.min(LOSE_WORST_K, placements.length);
      const worstStart = placements.length - k;
      const idx        = worstStart + this.rng.nextInt(k);
      this.log(`Lose-mode placement: chose rank ${idx + 1}/${placements.length} (worst-${k} pool)`);
      return placements[idx];
    }
  }

  private log(msg: string): void {
    if (this.debugEnabled) console.log(`[RoundOutcomeController] ${msg}`);
  }
}
