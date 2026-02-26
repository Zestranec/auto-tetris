/**
 * Seeded pseudo-random number generator using the Mulberry32 algorithm.
 * Deterministic: same seed always produces the same sequence.
 */
export class Rng {
  private state: number;

  constructor(seed: number) {
    // Coerce to unsigned 32-bit integer
    this.state = seed >>> 0;
  }

  /** Returns a float in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) >>> 0;
    return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
  }

  /** Returns an integer in [0, n). */
  nextInt(n: number): number {
    return Math.floor(this.next() * n);
  }

  /** Returns an integer in [min, max] (inclusive). */
  nextIntRange(min: number, max: number): number {
    return min + this.nextInt(max - min + 1);
  }

  /** Shuffles an array in-place using Fisher-Yates and returns it. */
  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.nextInt(i + 1);
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  /** Clone the current state so we can branch the RNG without advancing the original. */
  clone(): Rng {
    const r = new Rng(0);
    r.state = this.state;
    return r;
  }
}
