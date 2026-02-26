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
