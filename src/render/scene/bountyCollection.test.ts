import { describe, expect, it } from 'vitest'
import { planBountyCollection } from './bountyCollectionLogic'

const victim = { x: -200, y: 50, h: 20 }
const collector = { x: 300, y: -100, h: 20 }
const all = (n: number) => n

describe('bounty collection presentation', () => {
  it('sends a fixed gold handful from victim to collector and labels the exact authoritative payout', () => {
    const plan = planBountyCollection(victim, collector, 3, 1, false, all)
    expect(plan.label).toMatchObject({ text: '+3 bounty', x: collector.x, y: collector.y })
    expect(plan.label.h).toBeGreaterThan(collector.h)
    expect(plan.animate).toBe(true)
    expect(plan.facets.length).toBeGreaterThan(0)
    for (const f of plan.facets) {
      // thrown from the defeated holder...
      expect(Math.hypot(f.x - victim.x, f.y - victim.y)).toBeLessThan(Math.hypot(f.x - collector.x, f.y - collector.y))
      // ...and the GPU particle integration lands every facet on the collector, above its feet
      expect(f.x + f.vx * f.life).toBeCloseTo(collector.x, 6)
      expect(f.y + f.vy * f.life).toBeCloseTo(collector.y, 6)
      const landing = f.h + f.vh * f.life + f.gravity * f.life * f.life * 0.5
      expect(landing).toBeGreaterThan(collector.h)
      expect(Object.values(f).every(Number.isFinite)).toBe(true)
    }
    // payout size changes the label, never the particle cost
    const large = planBountyCollection(victim, collector, 1000, 1, false, all)
    expect(large.facets).toEqual(plan.facets)
    expect(large.label.text).toBe('+1000 bounty')
    // a richer quality tier adds facets on the same paths
    const rich = planBountyCollection(victim, collector, 3, 1, false, (n) => n + 2).facets
    expect(rich.slice(0, plan.facets.length)).toEqual(plan.facets)
    expect(rich).toHaveLength(plan.facets.length + 2)
  })

  it('keeps the payout readable with motion/FX disabled without emitting animated extras', () => {
    for (const [fx, reducedMotion] of [[0, false], [1, true]] as const) {
      const asked: number[] = []
      const plan = planBountyCollection(victim, collector, 2, fx, reducedMotion, (n) => { asked.push(n); return n })
      expect(plan.label.text).toBe('+2 bounty')
      expect(plan.animate).toBe(false)
      expect(plan.facets).toEqual([])
      // no particle budget is spent either
      expect(asked).toEqual([])
    }
  })
})
