/**
 * Ui — manages all HTML-side DOM interactions.
 *
 * The PixiJS canvas handles only the board.  Everything else (balance,
 * block selection, win-probability buttons, seed input, etc.) lives in HTML
 * and is wired here.
 *
 * Update flow
 * -----------
 *  main.ts calls `ui.update(state)` once per ticker frame to sync the
 *  displayed numbers.  Event listeners call back into `game.*` methods.
 */

import { Game, GamePhase } from './Game';
import { GameState } from './Game';

/** 2 s auto-close delay for round-end popups. */
const POPUP_AUTO_CLOSE_MS = 2000;

export class Ui {
  private game: Game;

  // Cached DOM references — panel
  private elBalance:    HTMLElement;
  private elStatus:     HTMLElement;
  private elBlocks:     HTMLElement;
  private elLines:      HTMLElement;
  private elPayout:     HTMLElement;
  private elNet:        HTMLElement;
  private elBetPreview: HTMLElement;
  private elBtnStart:   HTMLButtonElement;
  private elBtnSpeedup: HTMLButtonElement;
  private elBtnSim:     HTMLButtonElement;
  private elSimResults: HTMLElement;
  private elSimOutput:  HTMLElement;
  private elSeed:       HTMLInputElement;
  private elSeedLock:   HTMLInputElement;
  private elDebug:      HTMLInputElement;

  // Cached DOM references — popup overlay
  private elPopup:    HTMLElement;
  private elPopupCard:HTMLElement;
  private elPopupTitle: HTMLElement;
  private elPopupMsg:   HTMLElement;
  private elPopupBtn:   HTMLButtonElement;

  private currentBoughtBlocks: 30 | 50 | 75 = 30;
  private currentProb = 0.5;
  /** Whether the speedup is currently active. Reset when round ends. */
  private isSpeedUp = false;

  /** Used to detect phase transitions in update(). */
  private lastPhase: GamePhase = 'IDLE';
  /** Active auto-close timer handle, or null when popup is closed. */
  private popupTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(game: Game) {
    this.game = game;

    this.elBalance    = this.must('ui-balance');
    this.elStatus     = this.must('ui-status');
    this.elBlocks     = this.must('ui-blocks');
    this.elLines      = this.must('ui-lines');
    this.elPayout     = this.must('ui-payout');
    this.elNet        = this.must('ui-net');
    this.elBetPreview = this.must('ui-bet-preview');
    this.elBtnStart   = this.must<HTMLButtonElement>('btn-start');
    this.elBtnSpeedup = this.must<HTMLButtonElement>('btn-speedup');
    this.elBtnSim     = this.must<HTMLButtonElement>('btn-simulate');
    this.elSimResults = this.must('sim-results');
    this.elSimOutput  = this.must('sim-output');
    this.elSeed       = this.must<HTMLInputElement>('ui-seed');
    this.elSeedLock   = this.must<HTMLInputElement>('ui-seed-lock');
    this.elDebug      = this.must<HTMLInputElement>('ui-debug');

    this.elPopup     = this.must('round-popup');
    this.elPopupCard = this.elPopup.querySelector('.popup-card') as HTMLElement;
    this.elPopupTitle = this.must('popup-title');
    this.elPopupMsg   = this.must('popup-message');
    this.elPopupBtn   = this.must<HTMLButtonElement>('popup-btn');

    this.bindEvents();
  }

  // ---------------------------------------------------------------------------
  // Binding
  // ---------------------------------------------------------------------------

  private bindEvents(): void {
    // Block-count selection buttons
    document.querySelectorAll<HTMLButtonElement>('.bet-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const n = parseInt(btn.dataset.blocks ?? '30', 10) as 30 | 50 | 75;
        this.currentBoughtBlocks = n;
        this.game.setBoughtBlocks(n);

        document.querySelectorAll('.bet-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        this.elBetPreview.textContent = `Bet: ${n} FUN`;
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
    this.elBtnStart.addEventListener('click', () => this.doStartRound());

    // Speedup toggle — available while round is running
    this.elBtnSpeedup.addEventListener('click', () => {
      this.isSpeedUp = !this.isSpeedUp;
      this.game.setSpeedMultiplier(this.isSpeedUp ? 10 : 1);
      this.elBtnSpeedup.textContent = this.isSpeedUp
        ? 'NORMAL SPEED <<<'
        : 'ROUND SPEEDUP >>>';
      this.elBtnSpeedup.classList.toggle('speedup-active', this.isSpeedUp);
    });

    // Simulation button
    this.elBtnSim.addEventListener('click', () => this.runSimulation());

    // Manual seed input — auto-lock so the typed seed survives the next PLAY
    this.elSeed.addEventListener('input', () => {
      this.elSeedLock.checked = true;
    });
    this.elSeed.addEventListener('change', () => {
      const seed = parseInt(this.elSeed.value, 10);
      if (!isNaN(seed)) this.game.setSeed(seed);
    });

    // Random seed button — generates a seed and unlocks (auto-gen on next PLAY)
    document.getElementById('btn-random-seed')?.addEventListener('click', () => {
      const seed = (Math.random() * 2 ** 32) >>> 0;
      this.elSeed.value = String(seed);
      this.elSeedLock.checked = false;
      this.game.setSeed(seed);
    });

    // Debug toggle
    this.elDebug.addEventListener('change', () => {
      this.game.setDebug(this.elDebug.checked);
    });

    // Popup Play button
    this.elPopupBtn.addEventListener('click', () => {
      this.closePopup();
      this.doStartRound();
    });

    // Spacebar global handler
    document.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.code !== 'Space') return;
      // Prevent page scroll
      e.preventDefault();

      if (!this.elPopup.classList.contains('hidden')) {
        // Popup is visible — treat Space as clicking the popup button
        this.closePopup();
        this.doStartRound();
        return;
      }

      const phase = this.game.getState().phase;
      const canStart = phase === 'IDLE' || phase === 'GAME_OVER' || phase === 'FINISHED';
      if (canStart) this.doStartRound();
      // Space does nothing while running
    });
  }

  // ---------------------------------------------------------------------------
  // Per-frame update (called from ticker)
  // ---------------------------------------------------------------------------

  update(state: GameState): void {
    this.elBalance.textContent = `${state.balance.toFixed(0)} FUN`;
    this.elBlocks.textContent  = `${state.playedBlocks} / ${state.boughtBlocks}`;
    this.elLines.textContent   = String(state.roundLines);
    this.elPayout.textContent  = `${state.roundPayout.toFixed(2)} FUN`;

    const net = state.roundPayout - state.bet;
    this.elNet.textContent = `${net >= 0 ? '+' : ''}${net.toFixed(2)} FUN`;
    this.elNet.className = 'stat-value ' + (net > 0 ? 'positive' : net < 0 ? 'negative' : '');

    this.updateStatus(state);
    this.updateStartButton(state);
    this.updateSpeedupButton(state);
    this.detectRoundEnd(state);
  }

  // ---------------------------------------------------------------------------
  // Round-end popup
  // ---------------------------------------------------------------------------

  /**
   * Detects the first frame of GAME_OVER / FINISHED and shows the appropriate
   * popup.  Comparing lastPhase prevents the popup from re-triggering every
   * frame while the phase stays at GAME_OVER / FINISHED.
   */
  private detectRoundEnd(state: GameState): void {
    if (state.phase === this.lastPhase) return;
    this.lastPhase = state.phase;

    if (state.phase === 'GAME_OVER' || state.phase === 'FINISHED') {
      const isWin = state.roundPayout >= state.bet;
      this.showRoundPopup(isWin, state.roundPayout, state.bet);
    }
  }

  private showRoundPopup(isWin: boolean, roundPayout: number, bet: number): void {
    // Clear any existing auto-close timer
    if (this.popupTimer !== null) {
      clearTimeout(this.popupTimer);
      this.popupTimer = null;
    }

    // Set win / lose variant
    this.elPopupCard.classList.toggle('popup-win',  isWin);
    this.elPopupCard.classList.toggle('popup-lose', !isWin);

    if (isWin) {
      const multiplier = bet > 0 ? (roundPayout / bet).toFixed(2) : '0.00';
      this.elPopupTitle.textContent = 'YOU WIN!';
      this.elPopupMsg.textContent =
        `Congrats! You have won ${roundPayout.toFixed(2)} FUNS ` +
        `and this is ${multiplier} from your Bet`;
      this.elPopupBtn.textContent = 'Play';
    } else {
      this.elPopupTitle.textContent = 'YOU LOSE';
      this.elPopupMsg.textContent   = 'Oh No, You Lose';
      this.elPopupBtn.textContent   = 'Play again';
    }

    // Show the overlay
    this.elPopup.classList.remove('hidden');

    // Auto-close after 2 s
    this.popupTimer = setTimeout(() => {
      this.closePopup();
    }, POPUP_AUTO_CLOSE_MS);
  }

  private closePopup(): void {
    if (this.popupTimer !== null) {
      clearTimeout(this.popupTimer);
      this.popupTimer = null;
    }
    this.elPopup.classList.add('hidden');
  }

  // ---------------------------------------------------------------------------
  // Shared start-round action (used by button, popup, spacebar)
  // ---------------------------------------------------------------------------

  private doStartRound(): void {
    if (!this.elSeedLock.checked) {
      const newSeed = (Math.random() * 2 ** 32) >>> 0;
      this.elSeed.value = String(newSeed);
      this.game.setSeed(newSeed);
    }
    this.game.startRound();
  }

  // ---------------------------------------------------------------------------
  // Status / button helpers
  // ---------------------------------------------------------------------------

  private updateStatus(state: GameState): void {
    const labels: Record<string, string> = {
      IDLE:      'Ready',
      DROPPING:  'Running',
      CLEARING:  'Running',
      GAME_OVER: 'Game Over',
      FINISHED:  'Finished',
    };
    const classes: Record<string, string> = {
      IDLE:      'status-ready',
      DROPPING:  'status-running',
      CLEARING:  'status-running',
      GAME_OVER: 'status-gameover',
      FINISHED:  'status-finished',
    };
    this.elStatus.textContent = labels[state.phase] ?? state.phase;
    this.elStatus.className = 'stat-value status-badge ' + (classes[state.phase] ?? '');
  }

  private updateStartButton(state: GameState): void {
    const canRestart = state.phase === 'IDLE' || state.phase === 'GAME_OVER' || state.phase === 'FINISHED';
    this.elBtnStart.disabled = !canRestart;

    this.elBtnStart.textContent =
      (state.phase === 'GAME_OVER' || state.phase === 'FINISHED')
        ? '↺ PLAY AGAIN'
        : '▶ START ROUND';
  }

  private updateSpeedupButton(state: GameState): void {
    const running = state.phase === 'DROPPING' || state.phase === 'CLEARING';
    this.elBtnSpeedup.style.display = running ? 'block' : 'none';

    if (!running && this.isSpeedUp) {
      this.isSpeedUp = false;
      this.elBtnSpeedup.textContent = 'ROUND SPEEDUP >>>';
      this.elBtnSpeedup.classList.remove('speedup-active');
    }
  }

  // ---------------------------------------------------------------------------
  // Simulation
  // ---------------------------------------------------------------------------

  private runSimulation(): void {
    import('./Simulation').then(({ runSimulation }) => {
      const seed = parseInt(this.elSeed.value, 10) || 42;
      const result = runSimulation({
        rounds: 100,
        winProbability: this.currentProb,
        bet: this.currentBoughtBlocks,
        boughtBlocks: this.currentBoughtBlocks,
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
