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
