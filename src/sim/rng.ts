/**
 * Seeded mulberry32 stepping `state.rng`. The only randomness source in the sim.
 */
import type { SimState } from './types'

/** Uniform float in [0, 1). Advances state.rng. */
export function random(state: SimState): number {
  const a = (state.rng + 0x6d2b79f5) | 0
  state.rng = a >>> 0
  let t = Math.imul(a ^ (a >>> 15), 1 | a)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

/** Uniform integer in [lo, hi] (inclusive). */
export function randomInt(state: SimState, lo: number, hi: number): number {
  return lo + Math.floor(random(state) * (hi - lo + 1))
}

/** Uniform float in [lo, hi). */
export function randomRange(state: SimState, lo: number, hi: number): number {
  return lo + random(state) * (hi - lo)
}
