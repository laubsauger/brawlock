import { describe, expect, it } from 'vitest'
import { ROUND_END_SECONDS, ticks } from '../sim/config'
import { FB_DELAY, RESULTS_HOLD_MAX, ROUND_GRACE, createResultsHold, planClock, planFinalBlow, type FinalBlowPlan } from './finalBlow'
import type { Moment } from './moments'

/**
 * The Final Blow replays the round's deciding hit (docs/moonshot/specs/final-blow.md): slow enough
 * to follow (the first cut inside the 3 s round end was "way too rushed", playtest 2026-11-02),
 * ending within the grace it may take of the next shop, showing the hit itself slowed down, and
 * never running past what the ring holds.
 */
const HIT = 10_000
const decider = (deathAfter: number): Moment => ({
  id: 0, kind: 'knockout', traits: ['roundDecider'], round: 1, tick: HIT, end: HIT + ticks(deathAfter), from: HIT - ticks(0.5), to: HIT + ticks(deathAfter + 0.5),
  actors: [0], victims: [1], cause: 'fireball', count: 1, score: 1.5, camera: { subject: 101, other: 100, x: 0, y: 0, dirX: 1, dirY: 0 }, final: true,
})
const DELAYS = [0, 0.4, 0.9, 1.0, 1.1, 1.6, 1.7, 2.6, 5.5, 10.7]
const slow = (p: FinalBlowPlan) => p.segments.find((s) => s.speed < 1)!

describe('Final Blow plans', () => {
  it('a round plan takes 2-3.4 s, the hit at a third of speed, and ends 0.5 s inside its grace into the shop', () => {
    for (const d of DELAYS) {
      const plan = planFinalBlow(decider(d), -Infinity, 'round', false)!
      // the shortest when the hit kills at once (the slow hit shows the death)
      expect(plan.seconds, `${d} s`).toBeGreaterThanOrEqual(2)
      expect(plan.seconds, `${d} s`).toBeLessThanOrEqual(3.4)
      expect(FB_DELAY + plan.seconds, `${d} s`).toBeLessThanOrEqual(ROUND_END_SECONDS + ROUND_GRACE - 0.5 + 1e-9)
      expect(slow(plan).speed).toBeLessThanOrEqual(0.35)
      // the slow segment contains the hit
      expect(slow(plan).from).toBeLessThan(HIT)
      expect(slow(plan).to).toBeGreaterThan(HIT)
      // and the death is shown
      expect(plan.segments.some((s) => s.from <= plan.death && plan.death <= s.to), `${d} s`).toBe(true)
    }
  })

  it('a death soon after the hit joins on; a later one is a cut to the death', () => {
    const joined = planFinalBlow(decider(0.9), -Infinity, 'round', false)!
    expect(joined.segments.map((s) => s.shot)).toEqual(['push', 'push', 'push'])
    expect(joined.segments[2].from).toBe(joined.segments[1].to)
    const cut = planFinalBlow(decider(2.6), -Infinity, 'round', false)!
    expect(cut.segments.map((s) => s.shot)).toEqual(['push', 'push', 'death'])
    expect(cut.segments[2].from).toBeGreaterThan(cut.segments[1].to)
  })

  it('a match plan takes its time: a quarter-speed hit, a freeze on the impact, a 3 s hero shot, the results held through it', () => {
    for (const d of DELAYS) {
      const plan = planFinalBlow(decider(d), -Infinity, 'match', false)!
      expect(plan.seconds, `${d} s`).toBeGreaterThanOrEqual(7.5)
      expect(plan.seconds, `${d} s`).toBeLessThanOrEqual(10.5)
      expect(slow(plan).speed).toBeLessThanOrEqual(0.25)
      expect(plan.freeze).toEqual({ tick: HIT, seconds: 0.35 })
      expect(plan.hero).toBeGreaterThanOrEqual(3)
      expect(plan.seconds).toBeLessThanOrEqual(RESULTS_HOLD_MAX - FB_DELAY)
    }
  })

  it('reduced motion: real time, no freeze, static cameras', () => {
    for (const kind of ['round', 'match'] as const) {
      const plan = planFinalBlow(decider(2.6), -Infinity, kind, true)!
      expect(plan.segments.every((s) => s.speed === 1)).toBe(true)
      expect(plan.freeze).toBeNull()
      expect(plan.reduced).toBe(true)
    }
  })

  it('a ring that starts after the hit gives the death alone; one that misses the death too, or no decider, gives nothing', () => {
    const d = decider(5.5)
    const partial = planFinalBlow(d, HIT + ticks(1), 'round', false)!
    expect(partial.partial).toBe(true)
    expect(partial.segments).toHaveLength(1)
    expect(partial.segments[0].from).toBeGreaterThanOrEqual(HIT + ticks(1))
    expect(planFinalBlow(d, d.end, 'round', false)).toBeNull()
    expect(planFinalBlow(null, -Infinity, 'round', false)).toBeNull()
  })

  it('the plan clock walks the segments at their speed, holds still through the freeze, and ends with the replay', () => {
    const plan = planFinalBlow(decider(0.9), -Infinity, 'match', false)!
    expect(planClock(plan, 0)).toMatchObject({ tick: plan.segments[0].from, speed: 1 })
    // run-up (0.95 s at 1x) then the slow segment to the hit
    const toHit = 0.95 + 0.25 / 0.25
    expect(planClock(plan, toHit + 0.05)).toMatchObject({ tick: HIT, speed: 0 })
    expect(planClock(plan, toHit + 0.45)!.tick).toBeGreaterThan(HIT)
    expect(planClock(plan, plan.seconds - plan.hero + 0.01)).toBeNull()
    // recorded time never runs backwards (a cut jumps forward)
    let prev = -Infinity
    let backwards = 0
    for (let t = 0; t < plan.seconds - plan.hero; t += 1 / 60) {
      const c = planClock(plan, t)!
      if (c.tick < prev - 1e-6) backwards++
      prev = c.tick
    }
    expect(backwards).toBe(0)
  })
})

describe('results hold', () => {
  const fakeTimers = () => {
    const due: { fn: () => void; at: number; id: number }[] = []
    let now = 0
    let next = 1
    return {
      timers: { set: (fn: () => void, ms: number) => (due.push({ fn, at: now + ms, id: next }), next++), clear: (id: unknown) => void due.splice(due.findIndex((d) => d.id === id), 1) },
      advance(ms: number) {
        now += ms
        for (const d of due.filter((x) => x.at <= now)) {
          due.splice(due.indexOf(d), 1)
          d.fn()
        }
      },
    }
  }

  it("the results wait while a match Final Blow plays, and appear when it ends, is skipped or hits the cap; another screen cancels at once", () => {
    const shown: string[] = []
    const route = (h: ReturnType<typeof createResultsHold>, screen: string) => h.route(screen, () => shown.push(screen))

    const ends = fakeTimers()
    const h = createResultsHold(ends.timers)
    h.hold(6500)
    route(h, 'results')
    expect(shown).toEqual([])
    h.release()
    expect(shown).toEqual(['results'])

    const cap = fakeTimers()
    const h2 = createResultsHold(cap.timers)
    h2.hold(6500)
    route(h2, 'results')
    cap.advance(6499)
    expect(shown).toEqual(['results'])
    cap.advance(1)
    expect(shown).toEqual(['results', 'results'])

    const leave = fakeTimers()
    const h3 = createResultsHold(leave.timers)
    h3.hold(6500)
    route(h3, 'results')
    route(h3, 'lobby')
    expect(shown.at(-1)).toBe('lobby')
    expect(h3.holding).toBe(false)
    leave.advance(7000)
    expect(shown.filter((s) => s === 'results')).toHaveLength(2)

    // without a hold everything goes straight through
    route(createResultsHold(fakeTimers().timers), 'results')
    expect(shown.at(-1)).toBe('results')
  })
})
