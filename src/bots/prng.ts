/**
 * Seeded mulberry32 for bots. Bots must be reproducible from (seed, states),
 * so Math.random is not allowed anywhere in src/bots.
 */
export class Rng {
  private s: number

  constructor(seed: number) {
    this.s = seed >>> 0
  }

  /** uniform float in [0, 1) */
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0
    let t = this.s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  /** uniform float in [a, b) */
  range(a: number, b: number): number {
    return a + (b - a) * this.next()
  }

  /** uniform integer in [0, n) */
  int(n: number): number {
    return Math.floor(this.next() * n)
  }

  chance(p: number): boolean {
    return this.next() < p
  }

  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)]
  }
}

/** Mix a bot seed with its player id so two bots with the same seed still differ. */
export function botSeed(seed: number, player: number): number {
  let h = (seed ^ Math.imul(player + 1, 0x9e3779b1)) >>> 0
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0
  return (h ^ (h >>> 16)) >>> 0
}
