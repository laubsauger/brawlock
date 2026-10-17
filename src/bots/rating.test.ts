/**
 * The ladder's Elo numbers are only as good as the fit behind them: these check that the
 * Bradley–Terry solver returns the maximum-likelihood ratings, anchored, independent of the
 * order games were played in, and finite for a sweep.
 */
import { describe, expect, it } from 'vitest'
import { bradleyTerry, expectedScore, wilson, type PairRecord } from './rating'

/** records whose win shares match `elo` exactly (n games per pair) */
function synthetic(elo: Record<string, number>, n: number): PairRecord[] {
  const names = Object.keys(elo)
  const out: PairRecord[] = []
  for (let i = 0; i < names.length; i++)
    for (let j = i + 1; j < names.length; j++) {
      const p = expectedScore(elo[names[i]], elo[names[j]])
      out.push({ a: names[i], b: names[j], winsA: p * n, winsB: (1 - p) * n, draws: 0 })
    }
  return out
}

describe('bots: Bradley–Terry ratings', () => {
  it('recovers the ratings that generated the results, anchored at Medium = 1000', () => {
    const truth = { easy: 600, medium: 1000, hard: 1300, brutal: 1500 }
    const r = bradleyTerry(Object.keys(truth), synthetic(truth, 1000), 'medium', 1000, 0)
    for (const [k, v] of Object.entries(truth)) expect(r[k].elo).toBeCloseTo(v, 3)
    expect(r.medium.ci95).toBe(0)
    expect(r.hard.ci95).toBeGreaterThan(0)
  })

  it('a 75% win rate is about 190 Elo, and more games narrow the interval', () => {
    const rec = (n: number): PairRecord[] => [{ a: 'x', b: 'y', winsA: 0.75 * n, winsB: 0.25 * n, draws: 0 }]
    const small = bradleyTerry(['x', 'y'], rec(100), 'y', 1000, 0)
    const big = bradleyTerry(['x', 'y'], rec(1600), 'y', 1000, 0)
    expect(small.x.elo - 1000).toBeCloseTo(400 * Math.log10(3), 6)
    expect(big.x.ci95).toBeCloseTo(small.x.ci95 / 4, 1)
  })

  it('order of the records does not matter (one fit, not sequential updates)', () => {
    const recs = synthetic({ a: 900, b: 1000, c: 1250 }, 50)
    const fwd = bradleyTerry(['a', 'b', 'c'], recs, 'b')
    const rev = bradleyTerry(['c', 'b', 'a'], [...recs].reverse(), 'b')
    for (const k of ['a', 'b', 'c']) expect(fwd[k].elo).toBeCloseTo(rev[k].elo, 6)
  })

  it('a 40-0 sweep stays finite with the virtual-draw prior and reads as a big gap', () => {
    const r = bradleyTerry(['x', 'y'], [{ a: 'x', b: 'y', winsA: 40, winsB: 0, draws: 0 }], 'y')
    expect(Number.isFinite(r.x.elo)).toBe(true)
    expect(r.x.elo - 1000).toBeGreaterThan(600)
  })

  it('wilson interval brackets the observed share', () => {
    const [lo, hi] = wilson(75, 100)
    expect(lo).toBeLessThan(0.75)
    expect(hi).toBeGreaterThan(0.75)
    expect(wilson(0, 0)).toEqual([0, 1])
  })
})
