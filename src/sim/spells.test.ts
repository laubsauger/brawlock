import { describe, expect, test } from 'vitest'
import { DT, TICK_HZ } from './types'
import type { SimEvent } from './types'
import { FACING_TOLERANCE, FIREBALL_SLOT, SCOURGE_SLOT, TURN_PER_TICK, frictionPerTick, ticks } from './config'
import { step } from './index'
import { cmd, newMatch, pawn, place, run, runUntil, toCombat } from './testkit'

const TELEPORT_SLOT = 1 // column 2
/** ticks a pawn facing away needs to face within 0.2 rad (5 at 60 Hz); it acts on the last one */
const TURN_AROUND = Math.ceil((Math.PI - FACING_TOLERANCE) / TURN_PER_TICK)
const of = <T extends SimEvent['type']>(events: SimEvent[], type: T) =>
  events.filter((e): e is Extract<SimEvent, { type: T }> => e.type === type)

describe('Fireball (spells.md §8.1)', () => {
  test('flies at 1000 u/s, hits the enemy for 70 and pushes 749 u/s away from the impact', () => {
    const s = newMatch()
    toCombat(s)
    const p0 = pawn(s, 0)
    const p1 = pawn(s, 1)
    place(p0, -300, 0, 0)
    place(p1, 0, 0)
    step(s, [cmd(0, { kind: 'cast', slot: FIREBALL_SLOT, x: 0, y: 0 })])
    const events = runUntil(s, () => !p1.alive || p1.hp < 1000, ticks(2))
    const dmg = of([...s.events, ...events], 'damage').find((e) => e.target === p1.id)!
    expect(dmg.amount).toBe(70)
    expect(dmg.source).toBe(0)
    expect(dmg.kb).toBeCloseTo(749, 6)
    expect(p1.vx).toBeGreaterThan(700) // pushed +x, away from the caster
    expect(p1.lastHitter).toBe(0)
    expect(s.projectiles).toHaveLength(0)
    expect(p0.cooldowns[FIREBALL_SLOT]).toBeGreaterThan(0)
  })

  test('range = 1000 x range mastery, then it expires', () => {
    const s = newMatch()
    s.scores[0].masteries.range = 1 // x1.12
    const p0 = pawn(s, 0)
    place(p0, 0, -500, Math.PI / 2)
    run(s, 1, () => [cmd(0, { kind: 'cast', slot: FIREBALL_SLOT, x: 0, y: 2000 })])
    const events = run(s, ticks(4 / 3))
    const exp = of(events, 'projectileExpire')[0]
    expect(exp).toBeDefined()
    // cast point 0.2 s, then 1.12 s of flight (67.2 ticks at 60 Hz) -> 68 moves of 1000 * DT
    expect(exp.y).toBeCloseTo(-500 + Math.ceil(1.12 * TICK_HZ) * (1000 * DT), 6)
  })

  test('enemy fireballs destroy each other; own fireballs never hit the caster', () => {
    const s = newMatch()
    const p0 = pawn(s, 0)
    const p1 = pawn(s, 1)
    place(p0, -400, 0, 0)
    place(p1, 400, 0, Math.PI)
    run(s, 1, () => [cmd(0, { kind: 'cast', slot: FIREBALL_SLOT, x: 400, y: 0 }), cmd(1, { kind: 'cast', slot: FIREBALL_SLOT, x: -400, y: 0 })])
    const events = run(s, ticks(2 / 3))
    const hits = of(events, 'projectileHit')
    expect(hits).toHaveLength(2)
    expect(hits[0].target).toBe(hits[1].id)
    expect(hits[1].target).toBe(hits[0].id)
    expect(s.projectiles).toHaveLength(0)
    expect(p0.hp).toBe(1000)
    expect(p1.hp).toBe(1000)
  })

})

describe('turning and walking (Dota unit model)', () => {
  test('a pawn walks only once it faces within 0.2 rad, then at 210 u/s', () => {
    const s = newMatch()
    const p0 = pawn(s, 0)
    place(p0, 0, 0, 0)
    step(s, [cmd(0, { kind: 'move', x: -1000, y: 0 })])
    const walk: number[] = [p0.walkVx]
    for (let i = 0; i < 6; i++) {
      step(s, [])
      walk.push(p0.walkVx)
    }
    // ticks 1-4 turning in place (pi rad at 40 rad/s), tick 5 walking (at 60 Hz)
    expect(walk.slice(0, TURN_AROUND - 1)).toEqual(Array(TURN_AROUND - 1).fill(0))
    expect(walk[TURN_AROUND - 1]).toBeCloseTo(-210, 9)
    expect(walk[6]).toBeCloseTo(-210, 9)
  })

  test('walking stops exactly at the target', () => {
    const s = newMatch()
    const p0 = pawn(s, 0)
    place(p0, 0, 0, 0)
    step(s, [cmd(0, { kind: 'move', x: 100, y: 0 })])
    run(s, ticks(1)) // 100 u at 210 u/s ~ 0.48 s
    expect(p0.x).toBeCloseTo(100, 6)
    expect(p0.moveTarget).toBeNull()
    expect(p0.walkVx).toBe(0)
  })

  test(`the cast point exactly follows the turn: fire = turn ticks + ${ticks(0.2)}`, () => {
    const s = newMatch()
    const p0 = pawn(s, 0)
    place(p0, 0, 0, 0)
    const t0 = s.tick
    step(s, [cmd(0, { kind: 'cast', slot: FIREBALL_SLOT, x: -500, y: 0 })])
    let startAt = -1
    let fireAt = -1
    for (let i = 0; i < 40 && fireAt < 0; i++) {
      if (i > 0) step(s, [])
      for (const e of s.events) {
        if (e.type === 'castStart') startAt = s.tick - 1 - t0
        if (e.type === 'cast') fireAt = s.tick - 1 - t0
      }
    }
    expect(startAt).toBe(TURN_AROUND - 1) // facing reached on the 5th tick (index 4) at 60 Hz
    expect(fireAt).toBe(startAt + ticks(0.2))
  })
})

describe('Scourge (spells.md §8.2)', () => {
  test('stop during the 0.9 s windup cancels it: no blast, no HP cost, no cooldown', () => {
    const s = newMatch()
    toCombat(s)
    const p0 = pawn(s, 0)
    const p1 = pawn(s, 1)
    place(p0, 0, 0)
    place(p1, 100, 0)
    step(s, [cmd(0, { kind: 'cast', slot: SCOURGE_SLOT, x: 0, y: 0 })])
    const events = [...s.events, ...run(s, ticks(0.5))]
    step(s, [cmd(0, { kind: 'stop' })])
    events.push(...s.events, ...run(s, ticks(1)))
    expect(of(events, 'castStart')).toHaveLength(1)
    expect(of(events, 'cast')).toHaveLength(0)
    expect(of(events, 'explosion')).toHaveLength(0)
    expect(p0.hp).toBe(1000)
    expect(p1.hp).toBe(1000)
    expect(p0.cooldowns[SCOURGE_SLOT]).toBe(0)
  })

  test('a move order also cancels the windup', () => {
    const s = newMatch()
    const p0 = pawn(s, 0)
    step(s, [cmd(0, { kind: 'cast', slot: SCOURGE_SLOT, x: 0, y: 0 })])
    step(s, [cmd(0, { kind: 'move', x: 0, y: 0 })])
    expect(p0.cast).toBeNull()
    expect(of(run(s, ticks(1)), 'cast')).toHaveLength(0)
  })

  test('fires after 0.9 s: hits enemies in 250 with 0.75..1.0 knockback, costs 100 HP but never kills', () => {
    const s = newMatch()
    toCombat(s)
    const p0 = pawn(s, 0)
    const p1 = pawn(s, 1)
    place(p0, 0, 0)
    place(p1, 125, 0) // half radius: kb factor 0.875
    p0.hp = 50
    step(s, [cmd(0, { kind: 'cast', slot: SCOURGE_SLOT, x: 0, y: 0 })])
    const early = [...s.events, ...run(s, ticks(0.9) - 1)]
    expect(of(early, 'cast')).toHaveLength(0) // still winding up one tick before 0.9 s
    const events = [...early, ...run(s, 1)] // fires 0.9 s after the windup started
    const blast = of(events, 'damage').find((e) => e.target === p1.id)!
    expect(blast).toBeDefined()
    expect(blast.amount).toBe(100)
    expect(blast.kb).toBeCloseTo(1100 * 0.875, 6)
    expect(p0.alive).toBe(true)
    expect(p0.hp).toBeGreaterThanOrEqual(1)
    expect(p0.hp).toBeLessThan(2)
    expect(p0.kbPoints).toBe(0) // the self cost adds no DP
    expect(of(events, 'explosion')[0]).toMatchObject({ spell: 'scourge', radius: 250 })
  })

  test('levels 2/3 refund 20/30 DP per enemy hit and cost a fixed 100 HP', () => {
    const s = newMatch()
    toCombat(s)
    const p0 = pawn(s, 0)
    place(p0, 0, 0)
    place(pawn(s, 1), 100, 0)
    p0.levels[SCOURGE_SLOT] = 3 // bought in the shop phase
    p0.kbPoints = 50
    step(s, [cmd(0, { kind: 'cast', slot: SCOURGE_SLOT, x: 0, y: 0 })])
    const events = [...s.events, ...run(s, ticks(0.9))]
    expect(of(events, 'damage').find((e) => e.target === pawn(s, 1).id)!.amount).toBe(120)
    // 50 - 30 refund, minus 0.9 s + 1 tick of the -0.04/s DP decay
    expect(p0.kbPoints).toBeCloseTo(20 - 0.04 * (ticks(0.9) + 1) * DT, 9)
    // full HP during the windup, then -100 and one tick of regen
    expect(p0.hp).toBeCloseTo(900 + 5 * DT, 9)
  })
})

describe('Teleport (spells.md §8.9)', () => {
  test('is bought into column 2 and blinks instantly, clamped to the level range', () => {
    const s = newMatch()
    const p0 = pawn(s, 0)
    place(p0, 0, 0, 0)
    step(s, [cmd(0, { kind: 'buySpell', spell: 'teleport' })])
    expect(p0.slots[TELEPORT_SLOT]).toBe('teleport')
    step(s, [cmd(0, { kind: 'cast', slot: TELEPORT_SLOT, x: 3000, y: 4000 })])
    // 770 along (0.6, 0.8), no turn, no cast point
    expect(p0.x).toBeCloseTo(462, 9)
    expect(p0.y).toBeCloseTo(616, 9)
    expect(of(s.events, 'teleport')[0]).toMatchObject({ fromX: 0, fromY: 0 })
    // level 1 cooldown 16 s: refused until the tick before, castable exactly 16 s after the blink
    run(s, ticks(16) - 1, () => [cmd(0, { kind: 'cast', slot: TELEPORT_SLOT, x: 0, y: 0 })])
    expect(p0.x).toBeCloseTo(462, 6)
    step(s, [cmd(0, { kind: 'cast', slot: TELEPORT_SLOT, x: 0, y: 0 })])
    expect(p0.x).toBeCloseTo(0, 6)
  })

  test('short casts land on the cursor', () => {
    const s = newMatch()
    const p0 = pawn(s, 0)
    place(p0, 0, 0)
    step(s, [cmd(0, { kind: 'buySpell', spell: 'teleport' }, { kind: 'cast', slot: TELEPORT_SLOT, x: -300, y: 100 })])
    expect(p0.x).toBeCloseTo(-300, 9)
    expect(p0.y).toBeCloseTo(100, 9)
  })

  test('keeps 80% of the knockback velocity and drops the walk order', () => {
    const run1 = (teleport: boolean) => {
      const s = newMatch()
      const p0 = pawn(s, 0)
      step(s, [cmd(0, { kind: 'buySpell', spell: 'teleport' })])
      place(p0, 0, 0)
      p0.vx = 500
      p0.vy = -200
      p0.moveTarget = { x: 0, y: 900 }
      step(s, teleport ? [cmd(0, { kind: 'cast', slot: TELEPORT_SLOT, x: 0, y: 2000 })] : [cmd(0, { kind: 'stop' })])
      return p0
    }
    const blink = run1(true)
    const control = run1(false)
    expect(blink.vx / control.vx).toBeCloseTo(0.8, 12)
    expect(blink.vy / control.vy).toBeCloseTo(0.8, 12)
    expect(blink.moveTarget).toBeNull()
    expect(blink.vx).toBeCloseTo(500 * 0.8 * frictionPerTick(0.96), 9)
    expect(blink.y).toBeCloseTo(770 + blink.vy * DT, 9)
  })

  test('also cancels a pending windup (Stop)', () => {
    const s = newMatch()
    const p0 = pawn(s, 0)
    step(s, [cmd(0, { kind: 'buySpell', spell: 'teleport' }, { kind: 'cast', slot: SCOURGE_SLOT, x: 0, y: 0 })])
    step(s, [cmd(0, { kind: 'cast', slot: TELEPORT_SLOT, x: 0, y: 300 })])
    expect(p0.cast).toBeNull()
    expect(of(run(s, ticks(1)), 'cast')).toHaveLength(0)
  })
})

describe('casting rules', () => {
  test('a spell on cooldown is refused and does not cancel the current order', () => {
    const s = newMatch()
    const p0 = pawn(s, 0)
    place(p0, 0, 0, 0)
    step(s, [cmd(0, { kind: 'cast', slot: FIREBALL_SLOT, x: 500, y: 0 })])
    run(s, ticks(0.25))
    expect(p0.cooldowns[FIREBALL_SLOT]).toBeGreaterThan(0)
    step(s, [cmd(0, { kind: 'move', x: 300, y: 0 }), cmd(0, { kind: 'cast', slot: FIREBALL_SLOT, x: 500, y: 0 })])
    expect(p0.moveTarget).toEqual({ x: 300, y: 0 })
    expect(p0.cast).toBeNull()
  })

  test(`a point spell is castable again exactly cooldown ticks after it fired (4.8 s = ${ticks(4.8)})`, () => {
    const s = newMatch()
    const p0 = pawn(s, 0)
    place(p0, 0, 0, 0)
    const fire = cmd(0, { kind: 'cast', slot: FIREBALL_SLOT, x: 500, y: 0 })
    step(s, [fire])
    while (!s.events.some((e) => e.type === 'cast')) step(s, [])
    const firedAt = s.tick - 1 // index of the tick that fired
    run(s, firedAt + ticks(4.8) - 1 - s.tick)
    step(s, [fire]) // tick firedAt + 287 (at 60 Hz)
    expect(p0.cast).toBeNull()
    step(s, [fire]) // tick firedAt + 288
    expect(p0.cast).not.toBeNull()
  })

  test('a resent identical cast order does not restart the windup; a new target does', () => {
    const s = newMatch()
    const p0 = pawn(s, 0)
    place(p0, 0, 0)
    const scourge = cmd(0, { kind: 'cast', slot: SCOURGE_SLOT, x: 10, y: 10 })
    step(s, [scourge])
    run(s, ticks(0.5), () => [scourge]) // e.g. redundant network resends
    expect(p0.cast!.ticksLeft).toBe(ticks(0.9) - ticks(0.5))
    step(s, [cmd(0, { kind: 'cast', slot: SCOURGE_SLOT, x: 20, y: 10 })])
    expect(p0.cast!.ticksLeft).toBe(ticks(0.9)) // a genuinely new order restarts, as in Dota
  })

  test('cooldowns are reset on respawn (next shop phase)', () => {
    const s = newMatch({ shopSeconds: 1 })
    toCombat(s)
    const p0 = pawn(s, 0)
    step(s, [cmd(0, { kind: 'cast', slot: SCOURGE_SLOT, x: 0, y: 0 })])
    run(s, ticks(0.9))
    expect(p0.cooldowns[SCOURGE_SLOT]).toBeGreaterThan(0)
    place(pawn(s, 1), 3000, 0)
    runUntil(s, (st) => st.phase === 'shop')
    expect(p0.cooldowns.every((c) => c === 0)).toBe(true)
  })

  test('empty slots cannot cast; malformed remote input is ignored, not applied', () => {
    const s = newMatch()
    const p0 = pawn(s, 0)
    step(s, [
      cmd(0, { kind: 'cast', slot: 3, x: 0, y: 0 }),
      cmd(0, { kind: 'move', x: NaN, y: 0 }),
      cmd(0, { kind: 'cast', slot: 99, x: 0, y: 0 }),
    ])
    expect(p0.cast).toBeNull()
    expect(p0.moveTarget).toBeNull()
    expect(Number.isFinite(p0.x)).toBe(true)
  })

  test('dead pawns ignore move and cast but can still shop', () => {
    const s = newMatch()
    toCombat(s)
    const p1 = pawn(s, 1)
    p1.alive = false // dead mid-round (combat continues for the others)
    step(s, [cmd(1, { kind: 'move', x: 500, y: 0 }, { kind: 'cast', slot: FIREBALL_SLOT, x: 0, y: 0 }, { kind: 'buySpell', spell: 'teleport' })])
    expect(p1.moveTarget).toBeNull()
    expect(p1.cast).toBeNull()
    expect(p1.slots[TELEPORT_SLOT]).toBe('teleport')
  })
})
