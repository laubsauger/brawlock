import { describe, expect, test } from 'vitest'
import { CAST_TURN_LIMIT_TICKS, FIREBALL_SLOT } from './config'
import { step } from './index'
import { cmd, fight, newMatch, of, pawn, place } from './testkit'
import type { SimState } from './types'

const CP = 12 // Fireball cast point, ticks

/** ticks from the cast order until the spell fires (the order tick counts as 1) */
function fireDelay(s: SimState, before: (tick: number) => void = () => {}): number {
  for (let t = 1; t <= 200; t++) {
    before(t)
    step(s, t === 1 ? [cmd(0, { kind: 'cast', slot: FIREBALL_SLOT, x: 500, y: 0 })] : [])
    if (of(s.events, 'cast').length) return t
  }
  return -1
}

// A cast must never get stuck in its windup: the player would be locked out of the spell
// until they issue another order.
describe('a cast windup always completes', () => {
  test('any start facing: turn (<= 5 ticks) + cast point, never more', () => {
    for (let k = 0; k < 32; k++) {
      const s = newMatch()
      place(pawn(s, 0), 0, 0, (k / 32) * 2 * Math.PI - Math.PI)
      const d = fireDelay(s)
      expect(d).toBeGreaterThan(CP)
      expect(d).toBeLessThanOrEqual(5 + CP + 1)
    }
  })

  test('a corrupted (NaN) facing snaps to the target instead of turning forever', () => {
    const s = newMatch()
    const p0 = pawn(s, 0)
    place(p0, 0, 0)
    p0.facing = NaN
    expect(fireDelay(s)).toBe(CP + 1)
    expect(Number.isFinite(p0.facing)).toBe(true)
  })

  test('a corrupted facing does not stop walking either', () => {
    const s = newMatch()
    const p0 = pawn(s, 0)
    place(p0, 0, 0)
    p0.facing = NaN
    step(s, [cmd(0, { kind: 'move', x: 500, y: 0 })])
    expect(p0.walkVx).toBeCloseTo(210, 9)
  })

  test(`a pawn shoved back and forth across its target point starts the cast after ${CAST_TURN_LIMIT_TICKS} turn ticks`, () => {
    const s = newMatch()
    const p0 = pawn(s, 0)
    place(p0, 0, 0, Math.PI / 2)
    let delay = -1
    for (let t = 1; t <= 200 && delay < 0; t++) {
      // the desired direction flips by pi every tick: an unbounded turn would never settle
      p0.x = 500 + (t % 2 === 0 ? 3 : -3)
      p0.y = 0
      step(s, t === 1 ? [cmd(0, { kind: 'cast', slot: FIREBALL_SLOT, x: 500, y: 0 })] : [])
      if (of(s.events, 'cast').length) delay = t
    }
    expect(delay).toBe(CAST_TURN_LIMIT_TICKS + CP)
  })

  test('render hits2 scenario: the shot fires on time; inside spawn invulnerability it just deals no damage', () => {
    const s = fight()
    const me = pawn(s, 0)
    const foe = pawn(s, 1)
    place(me, -250, 0, Math.PI) // still facing its spawn direction: a 180 degree turn first
    place(foe, 250, 0)
    foe.invulnerable = true // what the script hit: 1 s into the round, 2 s invulnerability
    const d = fireDelay(s)
    expect(d).toBe(4 + 1 + CP) // 4 turning ticks, start tick, 12-tick cast point
  })
})
