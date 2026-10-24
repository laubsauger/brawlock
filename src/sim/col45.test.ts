import { describe, expect, test } from 'vitest'
import { knockbackSpeed, receiveDamage } from './combat'
import { ticks } from './config'
import { step } from './index'
import { spawnProjectile } from './projectiles'
import { castNow, cmd, fight, grant, of, pawn, place, run } from './testkit'
import type { SimState } from './types'

const fireball = (s: SimState, owner: number, x: number, y: number, vx: number, vy: number) =>
  spawnProjectile(s, owner, 'fireball', x, y, vx, vy, 25, { lifetime: 2, data: { damage: 70, kb: 1 } })

function shielded(s: SimState, player: number): void {
  castNow(s, player, grant(s, player, 'shield'), 0, 0)
}

// ---------------------------------------------------------------------------
describe('Shield (spells.md §8.20, §7.2)', () => {
  test('reflects an enemy projectile and steals it: it then hits its own caster, credited to the shielder', () => {
    const s = fight()
    const p0 = pawn(s, 0)
    const p1 = pawn(s, 1)
    place(p0, 0, 0)
    place(p1, 700, 0)
    shielded(s, 0)
    const fb = fireball(s, 1, 600, 0, -1000, 0)
    const events = run(s, ticks(1.5))
    expect(of(events, 'shieldReflect')[0]).toMatchObject({ pawn: p0.id, projectile: fb.id, reflected: true, stolen: true })
    expect(fb.data.origOwner).toBe(1)
    const dmg = of(events, 'damage')
    expect(dmg.find((e) => e.target === p0.id)).toBeUndefined()
    expect(dmg.find((e) => e.target === p1.id)).toMatchObject({ amount: 70, source: 0 })
  })

  test('the body refuses enemy std projectiles while shielded (one already inside passes through)', () => {
    const s = fight()
    const p0 = pawn(s, 0)
    place(p0, 0, 0)
    place(pawn(s, 1), 0, 900)
    shielded(s, 0)
    fireball(s, 1, 0, 0, 1000, 0) // inside the bubble, moving away
    const events = run(s, ticks(1 / 6))
    expect(of(events, 'damage')).toHaveLength(0)
  })

  test('Boomerang is reflected but NOT stolen and flies back to its thrower', () => {
    const s = fight()
    place(pawn(s, 0), 0, 0)
    place(pawn(s, 1), 900, 0)
    shielded(s, 0)
    const b = spawnProjectile(s, 1, 'boomerang', 300, 0, -1500, 0, 38, { lifetime: null, data: { damage: 70, kb: 0.95, dx: -1, dy: 0, par: -1406, perpAcc: -562, t: 0, t1: 1, returning: 0 } })
    const events = run(s, ticks(1 / 6))
    expect(of(events, 'shieldReflect')[0]).toMatchObject({ projectile: b.id, stolen: false })
    expect(b.owner).toBe(1)
    expect(b.data.returning).toBe(1)
  })

  test('Swap and Gravity are neither reflected nor stolen; a shielded warlock cannot be swapped', () => {
    const s = fight()
    const p0 = pawn(s, 0)
    const p1 = pawn(s, 1)
    place(p0, 0, 0, 0)
    place(p1, 500, 0)
    shielded(s, 1)
    const slot = grant(s, 0, 'swap')
    const events = [...castNow(s, 0, slot, 900, 0), ...run(s, ticks(2 / 3))]
    expect(of(events, 'shieldReflect')).toHaveLength(0)
    const sw = of(events, 'swap')[0]
    expect(sw.other).toBeNull() // flew through and blinked
    expect(p1.x).toBeGreaterThan(450)
  })

  test('Lightning stops at an enemy bubble without effect', () => {
    const s = fight()
    place(pawn(s, 0), 0, 0, 0)
    const p1 = pawn(s, 1)
    place(p1, 500, 0)
    shielded(s, 1)
    const events = [...castNow(s, 0, grant(s, 0, 'lightning'), 600, 0), ...run(s, 2)]
    const beam = of(events, 'beam')[0]
    expect(beam).toMatchObject({ blocked: true, target: p1.id })
    expect(beam.toX).toBeCloseTo(500, 6)
    expect(of(events, 'damage')).toHaveLength(0)
  })

  test('Thrust bounces off a shielded warlock without damage', () => {
    const s = fight()
    const p0 = pawn(s, 0)
    place(p0, 0, 0, 0)
    place(pawn(s, 1), 500, 0)
    shielded(s, 1)
    const events = [...castNow(s, 0, grant(s, 0, 'thrust'), 500, 0), ...run(s, ticks(1 / 3))]
    expect(of(events, 'damage')).toHaveLength(0)
    expect(p0.vx).toBeLessThan(0)
  })

  test('a stolen Homing re-acquires its original caster', () => {
    const s = fight()
    place(pawn(s, 0), 0, 0)
    const p1 = pawn(s, 1)
    place(p1, 800, 0)
    shielded(s, 0)
    const h = spawnProjectile(s, 1, 'homing', 230, 0, -1000, 0, 30, { lifetime: 4.5, data: { damage: 70, target: pawn(s, 0).id, cruise: 1000 } })
    run(s, 3)
    expect(h.owner).toBe(0)
    expect(h.data.target).toBe(p1.id)
  })
})

describe('Rush (spells.md §8.21)', () => {
  test('absorbs 50% of player damage after knockback, up to the cap, and turns it into speed', () => {
    const s = fight()
    const p1 = pawn(s, 1)
    place(p1, 0, 0)
    castNow(s, 1, grant(s, 1, 'rush'), 0, 0)
    expect(p1.moveSpeed).toBe(245)
    receiveDamage(s, p1, { cause: 'test', amount: 70, source: 0, normal: { x: 1, y: 0 } })
    const dmg = of(s.events, 'damage').at(-1)!
    expect(dmg.amount).toBe(35)
    expect(dmg.absorbed).toBe(35)
    expect(dmg.kb).toBeCloseTo(knockbackSpeed(70, 70, 1, 1, 1), 9) // knockback from the full 70
    expect(p1.kbPoints).toBe(70) // DP gain not reduced
    expect(p1.moveSpeed).toBeCloseTo(245 + 1.5 * 35, 9)
    receiveDamage(s, p1, { cause: 'test', amount: 70, source: 0 })
    expect(of(s.events, 'damage').at(-1)!.absorbed).toBe(15) // cap 50 at Lv1
  })

  test('lava (no source) is not absorbed', () => {
    const s = fight()
    const p1 = pawn(s, 1)
    castNow(s, 1, grant(s, 1, 'rush'), 0, 0)
    receiveDamage(s, p1, { cause: 'test', amount: 25, source: null })
    expect(of(s.events, 'damage').at(-1)).toMatchObject({ amount: 25 })
  })
})

describe('Alteration (spells.md §8.22)', () => {
  test('trades places with the first enemy projectile coming at you; it flies on from your spot', () => {
    const s = fight()
    const p0 = pawn(s, 0)
    place(p0, 0, 0)
    place(pawn(s, 1), 0, 1500)
    castNow(s, 0, grant(s, 0, 'alteration'), 0, 0)
    const fb = fireball(s, 1, 300, 0, -1000, 0)
    const events = run(s, ticks(1 / 6))
    const sw = of(events, 'swap')[0]
    expect(sw).toMatchObject({ spell: 'alteration', pawn: p0.id, other: fb.id, fromX: 0 })
    expect(p0.x).toBeGreaterThan(100)
    // the bolt that was coming at us never hits us (its caster stands in lava and burns, unrelated)
    expect(of(events, 'damage').filter((e) => e.target === p0.id)).toHaveLength(0)
    expect(p0.modifiers.some((m) => m.id === 'alteration')).toBe(false)
  })

  test('Lightning is blocked by the 120 bubble', () => {
    const s = fight()
    place(pawn(s, 0), 0, 0, 0)
    const p1 = pawn(s, 1)
    place(p1, 500, 0)
    castNow(s, 1, grant(s, 1, 'alteration'), 0, 0)
    const events = [...castNow(s, 0, grant(s, 0, 'lightning'), 600, 0), ...run(s, 2)]
    expect(of(events, 'beam')[0]).toMatchObject({ blocked: true, target: p1.id })
    expect(of(events, 'damage')).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
describe('Windwalk (spells.md §8.16)', () => {
  test('+200 speed, walks through warlocks, charges the first enemy (kb 1.0) and ends', () => {
    const s = fight()
    const p0 = pawn(s, 0)
    const p1 = pawn(s, 1)
    place(p0, 0, 0, 0)
    place(p1, 300, 0)
    castNow(s, 0, grant(s, 0, 'windwalk'), 0, 0)
    expect(p0.moveSpeed).toBe(410)
    step(s, [cmd(0, { kind: 'move', x: 600, y: 0 })])
    const events = run(s, ticks(1))
    const hit = of(events, 'damage').find((e) => e.target === p1.id)!
    expect(hit.amount).toBe(54)
    expect(hit.kb).toBeCloseTo(knockbackSpeed(54, 54, 1, 1, 1), 9)
    expect(of(events, 'spellHit')[0]).toMatchObject({ spell: 'windwalk' })
    expect(p0.modifiers.some((m) => m.id === 'windwalk')).toBe(false)
  })

  test('any spell cast ends it first', () => {
    const s = fight()
    const p0 = pawn(s, 0)
    castNow(s, 0, grant(s, 0, 'windwalk'), 0, 0)
    castNow(s, 0, 6, 500, 0)
    expect(p0.modifiers.some((m) => m.id === 'windwalk')).toBe(false)
  })

  test('Thrust then Windwalk: double hit (thrust at kb 0.84, charge at kb 0.7)', () => {
    const s = fight()
    const p0 = pawn(s, 0)
    const p1 = pawn(s, 1)
    place(p0, 0, 0, 0)
    place(p1, 600, 0)
    const ww = grant(s, 0, 'windwalk')
    castNow(s, 0, grant(s, 0, 'thrust'), 600, 0)
    castNow(s, 0, ww, 0, 0)
    const events = run(s, ticks(2 / 3))
    const dmg = of(events, 'damage').filter((e) => e.target === p1.id)
    expect(dmg.map((d) => d.amount)).toEqual([50, 54])
    expect(dmg[0].kb).toBeCloseTo(knockbackSpeed(50, 50, 1, 0.84, 1), 9)
    expect(dmg[1].kb).toBeCloseTo(knockbackSpeed(54, 104, 1, 0.7, 1), 9)
  })
})

describe('Meteor (spells.md §8.17)', () => {
  test('lands 0.55 + 0.60 s after the cast point at the clamped target: 110 centre, 40 edge, kb 0.66', () => {
    const s = fight(3)
    place(pawn(s, 0), 0, 0, 0)
    const centre = pawn(s, 1)
    const edge = pawn(s, 2)
    place(centre, 1000, 0)
    place(edge, 1000, 200) // r225 at Lv1
    castNow(s, 0, grant(s, 0, 'meteor'), 3000, 0)
    // hover 0.55 s (33 ticks at 60 Hz) + fall 0.60 s (36 ticks), counting the cast tick
    let n = 1
    const more = []
    while (!s.events.some((e) => e.type === 'explosion') && n < 200) {
      step(s, [])
      n++
      more.push(...s.events)
    }
    expect(n).toBe(ticks(0.55) + ticks(0.6))
    const boom = of(more, 'explosion')[0]
    expect(boom).toMatchObject({ spell: 'meteor', x: 1000, y: 0, radius: 225 })
    const dmg = of(more, 'damage')
    expect(dmg.find((e) => e.target === centre.id)!.amount).toBe(110)
    expect(dmg.find((e) => e.target === edge.id)!.amount).toBeCloseTo(40 + (70 / 225) * 25, 9)
  })

  test('cannot be pulled by Gravity (no collision, excluded)', () => {
    const s = fight()
    place(pawn(s, 0), 0, 0, 0)
    place(pawn(s, 1), 0, 1500)
    const m = spawnProjectile(s, 0, 'meteor', 500, 0, 0, 0, 0, { lifetime: null, data: { tx: 500, ty: 0, z: 700, z0: 700, hoverTicks: ticks(0.55), fallTicks: ticks(0.6), fallTime: 0.6, hoverTime: 0.55, elapsed: 0, falling: 0, vz: 0, damageMin: 40, damageMax: 110, radius: 225, kb: 0.66 } })
    spawnProjectile(s, 1, 'gravity', 520, 0, 0, 0, 25, { lifetime: 2, data: { strength: 500, dps: 20, pawnRadius: 550, projRadius: 600, projPull: 1650, dpsRadius: 250, dpsPeriod: ticks(0.2), dpsTimer: ticks(0.2) } })
    run(s, ticks(1 / 6))
    expect(m.x).toBe(500)
  })
})

describe('Splitter (spells.md §8.18)', () => {
  test('main bolt splits into 4 waves of 2 children with the original fan speeds', () => {
    const kids: number[] = []
    const seen = new Set<number>()
    const s2 = fight()
    place(pawn(s2, 0), 0, 0, 0)
    place(pawn(s2, 1), 0, 2000)
    castNow(s2, 0, grant(s2, 0, 'splitter'), 3000, 0)
    for (let i = 0; i < ticks(2); i++) {
      step(s2, [])
      for (const p of s2.projectiles) {
        if (p.kind === 'splitterChild' && !seen.has(p.id)) {
          seen.add(p.id)
          kids.push(+Math.hypot(p.vx, p.vy).toFixed(1))
        }
      }
    }
    expect(kids).toEqual([449.7, 449.7, 468.9, 468.9, 497.6, 497.6, 539.6, 539.6])
  })

  test('hitting a warlock splits it without damage; the children then do the damage', () => {
    const s = fight()
    place(pawn(s, 0), 0, 0, 0)
    const p1 = pawn(s, 1)
    place(p1, 300, 0)
    const events = [...castNow(s, 0, grant(s, 0, 'splitter'), 3000, 0), ...run(s, ticks(1))]
    const dmg = of(events, 'damage').filter((e) => e.target === p1.id)
    expect(dmg.length).toBeGreaterThan(0)
    expect(dmg.every((d) => d.amount === 30)).toBe(true)
  })
})

describe('Snowball (spells.md §8.19)', () => {
  test('drags a touched enemy at >= 425 u/s, chills for damage/2 per 0.5 s, explodes at the end', () => {
    const s = fight()
    place(pawn(s, 0), 0, 0, 0)
    const p1 = pawn(s, 1)
    place(p1, 200, 0)
    const events = [...castNow(s, 0, grant(s, 0, 'snowball'), 2000, 0), ...run(s, ticks(2))]
    const dmg = of(events, 'damage').filter((e) => e.target === p1.id && e.source === 0)
    expect(dmg.some((d) => d.amount === 15 && d.kb === 0)).toBe(true) // chill tick
    expect(of(events, 'explosion').some((e) => e.spell === 'snowball')).toBe(true)
    expect(p1.x).toBeGreaterThan(600) // carried along
  })

  test('projectiles cannot destroy it (the Fireball dies, the Snowball rolls on)', () => {
    const s = fight()
    place(pawn(s, 0), -2000, 0)
    place(pawn(s, 1), 2000, 0)
    const sb = spawnProjectile(s, 0, 'snowball', 0, 0, 0, 0, 75, { lifetime: 1, data: { damage: 30, damageMin: 0, damageMax: 45, explosion: 200, kb: 0.8, drag: 425, slow: 100, dotPeriod: 0.5 } })
    fireball(s, 1, 90, 0, 0, 0)
    run(s, 1)
    expect(s.projectiles.map((p) => p.id)).toEqual([sb.id])
  })
})
