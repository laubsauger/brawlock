import { describe, expect, test } from 'vitest'
import { frictionPerTick } from './config'
import { step } from './index'
import { timeOfImpact } from './physics'
import { cmd, newMatch, pawn, place, run, toCombat } from './testkit'

const F = frictionPerTick(0.96)

describe('swept time of impact', () => {
  test('finds the first touch inside the tick, 0 when overlapping, none when separating', () => {
    const a = { x: 0, y: 0, vx: 0, vy: 0 }
    // gap of 40 closing at 1200 u/s touches after 1/30 s
    expect(timeOfImpact(a, { x: 100, y: 0, vx: -1200, vy: 0 }, 60, 1 / 20)).toBeCloseTo(1 / 30, 12)
    // the same pair one tick (1/60 s) is not enough
    expect(timeOfImpact(a, { x: 100, y: 0, vx: -1200, vy: 0 }, 60, 1 / 60)).toBe(-1)
    expect(timeOfImpact(a, { x: 50, y: 0, vx: 0, vy: 0 }, 60, 1 / 60)).toBe(0)
    expect(timeOfImpact(a, { x: 70, y: 0, vx: 500, vy: 0 }, 60, 1 / 60)).toBe(-1)
  })

  test('fast projectiles do not tunnel through a pawn within one tick', () => {
    const s = newMatch()
    const p1 = pawn(s, 1)
    place(pawn(s, 0), -2000, 0)
    place(p1, 0, 0)
    // a 25-radius bolt moving 3000 u/s jumps 50 u per tick, more than the 30 u pawn radius
    s.projectiles.push({ id: s.nextEntityId++, owner: 0, spell: 'fireball', x: -80, y: 0, vx: 3000, vy: 0, radius: 25, ticksLeft: 60, data: { damage: 70, kb: 1 } })
    step(s, [])
    expect(s.events.some((e) => e.type === 'projectileHit' && e.target === p1.id)).toBe(true)
  })
})

describe('elastic response (spells.md §3.2)', () => {
  test('two warlocks colliding bounce with restitution 0.5 (elasticity 0.5 each)', () => {
    const s = newMatch()
    const a = pawn(s, 0)
    const b = pawn(s, 1)
    place(a, -100, 0)
    place(b, 100, 0)
    a.vx = 600
    b.vx = -600
    let before = 0
    for (let i = 0; i < 30 && a.vx > 0; i++) {
      before = a.vx
      step(s, [])
    }
    // closing speed 2*v*F after friction; afterwards -0.5 of it, split evenly
    expect(a.vx).toBeCloseTo(-0.5 * before * F, 9)
    expect(b.vx).toBeCloseTo(0.5 * before * F, 9)
  })

  test('warlocks that already overlap are pushed apart gently, not bounced', () => {
    const s = newMatch()
    const a = pawn(s, 0)
    const b = pawn(s, 1)
    place(a, -20, 0)
    place(b, 20, 0)
    step(s, [])
    // dif 40, r = 40^2 - 60^2 = -2000, s = sqrt(2000); push dif/s per original 0.035 s tick
    const push = (40 / Math.sqrt(2000)) * ((1 / 60) / 0.035)
    expect(a.x).toBeCloseTo(-20 - push, 9)
    expect(b.x).toBeCloseTo(20 + push, 9)
    expect(a.vx).toBe(0)
  })

  test('a warlock overlapping a pillar is placed on its surface', () => {
    const s = newMatch()
    const a = pawn(s, 0)
    place(pawn(s, 1), -2000, 0)
    place(a, 50, 10)
    s.obstacles.push({ id: s.nextEntityId++, x: 0, y: 0, radius: 60, hp: 400, variant: 0 })
    step(s, [cmd(0, { kind: 'stop' })])
    expect(Math.hypot(a.x, a.y)).toBeCloseTo(90, 9)
    expect(a.y / a.x).toBeCloseTo(10 / 50, 9)
    expect(s.obstacles[0]).toMatchObject({ x: 0, y: 0 }) // static
  })

  test('fireballs damage pillars; a pillar at 0 HP explodes (combat only)', () => {
    const s = newMatch()
    const ob = { id: s.nextEntityId++, x: 0, y: 0, radius: 60, hp: 400, variant: 0 }
    s.obstacles.push(ob)
    s.projectiles.push({ id: s.nextEntityId++, owner: 0, spell: 'fireball', x: -100, y: 0, vx: 1000, vy: 0, radius: 25, ticksLeft: 60, data: { damage: 70, kb: 1 } })
    run(s, 5)
    expect(s.projectiles).toHaveLength(0) // the bolt died on the pillar
    expect(ob.hp).toBe(400) // shop phase: obstacles take no damage

    toCombat(s)
    s.obstacles = [ob]
    const near = pawn(s, 1)
    place(near, 150, 0) // explosion: 5 + 5 * (1 - 150/300) = 7.5, pushed away from the pillar
    place(pawn(s, 0), -1000, 0)
    for (let i = 0; i < 6; i++) {
      s.projectiles.push({ id: s.nextEntityId++, owner: 0, spell: 'fireball', x: -100, y: 0, vx: 1000, vy: 0, radius: 25, ticksLeft: 60, data: { damage: 70, kb: 1 } })
      run(s, 4)
    }
    expect(s.obstacles).toHaveLength(0)
    expect(near.hp).toBeCloseTo(1000 - 7.5, 0)
    expect(near.vx).toBeGreaterThan(0)
  })
})

describe('arena wall (5910)', () => {
  test('clamps onto the circle and removes the radial velocity (slide, not bounce)', () => {
    const s = newMatch()
    const a = pawn(s, 0)
    place(a, 5900, 0)
    a.vx = 3000
    a.vy = 600
    step(s, [])
    expect(Math.hypot(a.x, a.y)).toBeCloseTo(5910, 6)
    const radial = (a.vx * a.x + a.vy * a.y) / 5910
    expect(Math.abs(radial)).toBeLessThan(1e-9)
    expect(Math.hypot(a.vx, a.vy)).toBeGreaterThan(500) // tangential part kept
  })
})

describe('collision matrix by alliance', () => {
  test('fireballs pass through allies (teams mode) and the caster', () => {
    const s = newMatch({ teamMode: 'teams' }, 2, 1, [5, 5])
    const ally = pawn(s, 1)
    place(pawn(s, 0), -300, 0, 0)
    place(ally, 0, 0)
    step(s, [cmd(0, { kind: 'cast', slot: 6, x: 300, y: 0 })])
    const events = run(s, 60)
    expect(events.some((e) => e.type === 'projectileHit')).toBe(false)
    expect(ally.vx).toBe(0)
  })
})
