/**
 * Small deterministic RNG (mulberry32) with helpers.
 *
 * Every part of the generator draws from its own forked stream
 * (`rng.fork('roof')`), so changing how much randomness one part consumes
 * never changes the look of another part for the same seed.
 */
export class Rng {
  private state: number;
  private readonly seed: number;

  constructor(seed: number | string) {
    this.seed = typeof seed === 'number' ? seed >>> 0 : hashString(seed);
    if (this.seed === 0) this.seed = 0x9e3779b9;
    this.state = this.seed;
  }

  /** Uniform float in [0, 1). */
  next(): number {
    let t = (this.state = (this.state + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform float in [a, b). */
  range(a: number, b: number): number {
    return a + (b - a) * this.next();
  }

  /** Uniform integer in [a, b] (inclusive). */
  int(a: number, b: number): number {
    return a + Math.floor(this.next() * (b - a + 1));
  }

  /** Symmetric jitter in [-amount, amount). */
  jitter(amount: number): number {
    return (this.next() * 2 - 1) * amount;
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)];
  }

  /** Pick using relative weights. */
  weighted<T>(items: readonly (readonly [T, number])[]): T {
    const total = items.reduce((s, [, w]) => s + w, 0);
    let r = this.next() * total;
    for (const [item, w] of items) {
      r -= w;
      if (r <= 0) return item;
    }
    return items[items.length - 1][0];
  }

  /** Approximately normal (Irwin–Hall, 4 samples), mean 0, std ~1. */
  normal(): number {
    return (this.next() + this.next() + this.next() + this.next() - 2) * 1.732;
  }

  /**
   * Independent child stream derived from this stream's *seed* and a label.
   * It does not depend on how many numbers were already drawn.
   */
  fork(label: string): Rng {
    return new Rng((hashString(label) ^ Math.imul(this.seed, 0x85ebca6b)) >>> 0);
  }
}

export function hashString(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
