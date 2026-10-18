import { describe, expect, test } from 'vitest'
import { FIREBALL_SLOT, SCOURGE_SLOT } from './config'
import { step } from './index'
import { receiveDamage } from './combat'
import { cmd, newMatch, pawn, place, run, toCombat } from './testkit'
import type { SimEvent } from './types'

const of = <T extends SimEvent['type']>(events: SimEvent[], type: T) =>
  events.filter((e): e is Extract<SimEvent, { type: T }> => e.type === type)

// Dota-style animation canceling: any new order during the cast point drops the cast for free,
// and render / audio must be told so the windup fizzles instead of silently vanishing.
describe('cast canceling', () => {
  test('stop during the cast point: castCancel (started) and no cooldown spent', () => {
    const s = newMatch()
    const p0 = pawn(s, 0)
    place(p0, 0, 0, 0)
    step(s, [cmd(0, { kind: 'cast', slot: FIREBALL_SLOT, x: 500, y: 0 })])
    const events = [...s.events, ...run(s, 5)]
    expect(of(events, 'castStart')).toHaveLength(1)
    step(s, [cmd(0, { kind: 'stop' })])
    expect(of(s.events, 'castCancel')).toEqual([{ type: 'castCancel', pawn: p0.id, spell: 'fireball', slot: FIREBALL_SLOT, started: true }])
    expect(p0.cooldowns[FIREBALL_SLOT]).toBe(0)
    expect(of(run(s, 30), 'cast')).toHaveLength(0)
  })

  test.each(['fireball', 'snowball', 'twin', 'cluster', 'bouncer', 'boomerang', 'lightning', 'homing', 'drain', 'recharge', 'redirector', 'gravity', 'grip', 'link', 'magnetize', 'meteor', 'rockpillar', 'warpzone', 'pact', 'scourge'])('%s cannot launch when canceled on its final windup tick', (spell) => {
    const s = newMatch()
    const p0 = pawn(s, 0)
    place(p0, 0, 0, 0)
    p0.slots[0] = spell
    p0.levels[0] = 1
    step(s, [cmd(0, { kind: 'cast', slot: 0, x: 1000, y: 0 })])
    while (p0.cast && p0.cast.ticksLeft > 1) {
      expect(s.projectiles).toHaveLength(0)
      step(s, [])
    }
    expect(p0.cast?.ticksLeft).toBe(1)
    step(s, [cmd(0, { kind: 'stop' })])
    expect(of(s.events, 'castCancel')).toHaveLength(1)
    expect(p0.cast).toBeNull()
    expect(p0.cooldowns[0]).toBe(0)
    const later = run(s, 30)
    expect(of(later, 'cast')).toHaveLength(0)
    expect(of(later, 'projectileSpawn')).toHaveLength(0)
    expect(s.projectiles).toHaveLength(0)
  })

  test('a move order while still turning cancels with started = false', () => {
    const s = newMatch()
    const p0 = pawn(s, 0)
    place(p0, 0, 0, 0)
    step(s, [cmd(0, { kind: 'cast', slot: FIREBALL_SLOT, x: -500, y: 0 })]) // behind: turning
    step(s, [cmd(0, { kind: 'move', x: 0, y: 300 })])
    expect(of(s.events, 'castCancel')).toEqual([{ type: 'castCancel', pawn: p0.id, spell: 'fireball', slot: FIREBALL_SLOT, started: false }])
    expect(p0.moveTarget).toEqual({ x: 0, y: 300 })
  })

  test('another cast replaces the pending one and reports the cancel', () => {
    const s = newMatch()
    const p0 = pawn(s, 0)
    place(p0, 0, 0, 0)
    step(s, [cmd(0, { kind: 'cast', slot: SCOURGE_SLOT, x: 0, y: 0 })])
    step(s, [cmd(0, { kind: 'cast', slot: FIREBALL_SLOT, x: 500, y: 0 })])
    expect(of(s.events, 'castCancel')[0]).toMatchObject({ spell: 'scourge', started: true })
    expect(p0.cast?.spell).toBe('fireball')
  })

  test('dying during a windup cancels it', () => {
    const s = newMatch()
    toCombat(s)
    const p0 = pawn(s, 0)
    step(s, [cmd(0, { kind: 'cast', slot: SCOURGE_SLOT, x: 0, y: 0 })])
    p0.hp = 5
    receiveDamage(s, p0, { cause: 'test', amount: 10, source: 1 })
    expect(of(s.events, 'castCancel')).toHaveLength(1)
    expect(p0.cast).toBeNull()
  })

  test('no backswing: a move right after the spell fires walks on the very next tick', () => {
    const s = newMatch()
    const p0 = pawn(s, 0)
    place(p0, 0, 0, 0)
    step(s, [cmd(0, { kind: 'cast', slot: FIREBALL_SLOT, x: 500, y: 0 })])
    while (!s.events.some((e) => e.type === 'cast')) step(s, [])
    step(s, [cmd(0, { kind: 'move', x: 1000, y: 0 })]) // same facing: no turn needed
    expect(p0.walkVx).toBeCloseTo(210, 9)
    expect(of(s.events, 'castCancel')).toHaveLength(0) // nothing was pending
  })

  test('hold = stop: clears the move order too', () => {
    const s = newMatch()
    const p0 = pawn(s, 0)
    place(p0, 0, 0, 0)
    step(s, [cmd(0, { kind: 'move', x: 1000, y: 0 })])
    step(s, [cmd(0, { kind: 'stop' })])
    expect(p0.moveTarget).toBeNull()
    expect(p0.walkVx).toBe(0)
  })
})
