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
import { findAllPlacements, hardDrop, HeuristicWeights } from './AutoPlayer';
import { PAYOUT_COEFF_A, computeEffectiveR } from './Game';
import { PieceWeights } from './RoundOutcomeController';
import { TetrominoType } from './Tetromino';

export interface SimulationConfig {
  rounds: number;
  winProbability: number;
  bet: number;
  /** Number of blocks per round (round ends when this many pieces are placed). Defaults to bet. */
  boughtBlocks?: number;
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
  boughtBlocks: number,
  debugLog: boolean,
): RoundResult {
  let lines = 0;
  let payout = 0;
  let currentBoard = board;
  let playedBlocks = 0;
  let clearEventIndex = 0;

  for (; playedBlocks < boughtBlocks;) {
    // Pick and place next piece
    const type: TetrominoType = controller.pickPiece(pieceWeights);
    const spawn = spawnPosition(type);
    const allPlacements = findAllPlacements(currentBoard, type, weights);

    if (allPlacements.length === 0) {
      if (debugLog) console.log(`[Sim] No placement for ${type} — game over`);
      break;
    }

    // Use pickPlacement so lose-mode degradation is applied identically to live game
    const placement = controller.pickPlacement(allPlacements);
    const piece = { type, rotation: placement.rotation, row: spawn.row, col: placement.col };

    if (!isValidPlacement(currentBoard, piece)) {
      if (debugLog) console.log(`[Sim] Spawn blocked for ${type} — game over`);
      break;
    }

    // Simulate hard drop
    const dropped = hardDrop(currentBoard, piece);
    const newBoard = lockPiece(currentBoard, dropped);

    playedBlocks++;

    if (isTopOut(newBoard)) {
      if (debugLog) console.log(`[Sim] Top-out after ${type} — game over (block ${playedBlocks})`);
      break;
    }

    // Clear completed lines
    const complete = findCompleteRows(newBoard);
    if (complete.length > 0) {
      // Same formula as Game.ts lockCurrentPiece (soft cap via computeEffectiveR)
      const effectiveR = computeEffectiveR(clearEventIndex);
      const linePayout = bet * PAYOUT_COEFF_A * Math.pow(effectiveR, clearEventIndex) * complete.length;
      lines   += complete.length;
      payout  += linePayout;
      clearEventIndex++;
      currentBoard = clearRows(newBoard, new Set(complete));
      if (debugLog) console.log(`[Sim] Cleared ${complete.length} lines (event ${clearEventIndex}), payout ${linePayout.toFixed(2)}`);
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
    boughtBlocks = bet, // default: boughtBlocks === bet (since bet = boughtBlocks * 1)
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
      boughtBlocks,
      debugLog,
    );

    // Feed result back so the RTP controller can adjust future win probability
    controller.recordRoundResult(bet, result.payout);

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
