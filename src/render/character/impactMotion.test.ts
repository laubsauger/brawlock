import { describe, expect, it } from 'vitest'
import { DeathMotion, LaunchMotion, deathHop } from './impactMotion'

describe('launch response hierarchy', () => {
  it('ordinary hits stay upright and a substantial displacement topples once', () => {
    const small = new LaunchMotion()
    for (let i = 0; i < 90; i++) expect(small.step(750, 1 / 60, true)).toBeNull()
    const launched = new LaunchMotion()
    const transitions = Array.from({ length: 120 }, () => launched.step(1200, 1 / 60, true))
    expect(transitions.filter((t) => t === 'start')).toHaveLength(1)
    expect(transitions).not.toContain('recover')
  })

  it('recovers after the slide settles and allows a genuinely new launch', () => {
    const launch = new LaunchMotion()
    expect(launch.step(1600, 1 / 60, true)).toBe('start')
    for (let i = 0; i < 60; i++) launch.step(1200, 1 / 60, true)
    expect(launch.step(100, 1 / 60, true)).toBe('recover')
    expect(launch.step(1600, 1 / 60, true)).toBe('start')
  })

  it('does not topple for a short velocity correction or interrupt a cast', () => {
    const launch = new LaunchMotion()
    expect(launch.step(1100, 1 / 60, true)).toBeNull()
    expect(launch.step(0, 1 / 60, true)).toBeNull()
    expect(launch.step(1700, 1 / 60, false)).toBeNull()
  })
})

describe('death motion continuity', () => {
  it('a next-round keyframe without shop revives, while same-round alive corrections and older epochs retain the confirmed death', () => {
    const death = new DeathMotion()
    expect(death.beginRound(2)).toBe(false)
    death.begin(true)
    death.advance(0.6)
    for (const round of [2, 2, 1, 2]) {
      expect(death.beginRound(round)).toBe(false)
      expect(death.active).toBe(true)
      expect(death.confirmed).toBe(true)
      expect(death.elapsed).toBe(0.6)
    }
    expect(death.beginRound(3)).toBe(true)
    expect(death.active).toBe(false)
    expect(death.confirmed).toBe(false)
    expect(death.elapsed).toBe(0)
    // The new round's death follows epoch synchronization, even in the same render frame.
    death.begin(true)
    death.advance(0.1)
    expect(death.beginRound(3)).toBe(false)
    expect(death.confirmed).toBe(true)
    expect(death.elapsed).toBe(0.1)
  })

  it('authoritative confirmation and repeated cause overrides preserve elapsed fall time', () => {
    const death = new DeathMotion()
    expect(death.begin(false)).toBe(true)
    death.advance(0.37)
    expect(death.begin(true)).toBe(false)
    expect(death.confirmed).toBe(true)
    expect(death.elapsed).toBe(0.37)
    expect(death.begin(true)).toBe(false)
    death.reset()
    expect(death.begin(true)).toBe(true)
    expect(death.elapsed).toBe(0)
  })

  it('the exaggerated throw lands continuously and remains at rest', () => {
    for (const t of [0, 0.48, 0.68]) expect(Math.abs(deathHop(t + 1e-6) - deathHop(t))).toBeLessThan(0.00001)
    expect(deathHop(0.24)).toBeCloseTo(0.38)
    expect(deathHop(0.8)).toBe(0)
    expect(deathHop(2)).toBe(0)
  })
})
