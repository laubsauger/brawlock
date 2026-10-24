import { describe, expect, test } from 'vitest'
import { FIREBALL_SLOT, frictionPerTick, ticks } from './config'
import { knockbackSpeed } from './combat'
import { step } from './index'
import { spawnProjectile } from './projectiles'
import { RELEASED_SPELLS, SPELLS } from './spells/data'
import { IMPLEMENTED_SPELLS } from './spells'
import { castNow, cmd, fight, grant, newMatch, pawn, place, run, toCombat } from './testkit'
import { DT, TICK_HZ, type ProjectileState, type SimEvent, type SimState } from './types'

const F = frictionPerTick(0.96)
const of = <T extends SimEvent['type']>(events: SimEvent[], type: T) =>
  events.filter((e): e is Extract<SimEvent, { type: T }> => e.type === type)

function duel(n = 2): SimState {
  const s = newMatch({}, n)
  toCombat(s)
  return s
}

const cast = (player: number, slot: number, x: number, y: number) => cmd(player, { kind: 'cast', slot, x, y })

// ---------------------------------------------------------------------------
describe('Thrust (spells.md §8.10)', () => {
  test('launches at 0.77 x 1300 (replacing knockback) and accelerates 1733 u/s^2', () => {
    const s = duel()
    const p0 = pawn(s, 0)
    place(p0, 0, 0, 0)
    place(pawn(s, 1), 0, 2000)
    p0.vy = 500 // existing knockback is replaced
    const slot = grant(s, 0, 'thrust')
    step(s, [cast(0, slot, 2000, 0)])
    expect(p0.vx).toBeCloseTo(1001 * F + 1733.3333333333333 * DT, 9)
    expect(p0.vy).toBeCloseTo(0, 9)
  })

  test('connects through the r60 thrust CC (90 u), stops dead and hits with knockback 1.2', () => {
    const s = duel()
    const p0 = pawn(s, 0)
    const p1 = pawn(s, 1)
    place(p0, 0, 0, 0)
    place(p1, 400, 0)
    const slot = grant(s, 0, 'thrust')
    step(s, [cast(0, slot, 400, 0)])
    const events = [...s.events, ...run(s, ticks(0.5))]
    const hit = of(events, 'spellHit')[0]
    expect(hit).toMatchObject({ spell: 'thrust', pawn: p0.id, target: p1.id })
    const dmg = of(events, 'damage').find((e) => e.target === p1.id)!
    // ~1000 u/s at contact: damage factor (v^2 / 1300^2) / 0.8 < 1
    expect(dmg.amount).toBeGreaterThan(30)
    expect(dmg.amount).toBeLessThan(50)
    expect(dmg.kb).toBeCloseTo(knockbackSpeed(dmg.amount, dmg.amount, 1, 1.2, 1), 6)
    expect(p0.modifiers.some((m) => m.id === 'thrust')).toBe(false)
    expect(Math.abs(p0.vx)).toBeLessThan(5) // stopped dead (then only friction)
    expect(p1.vx).toBeGreaterThan(300)
  })

  test('a miss brakes to 20% when the thrust runs out (0.09 + min(dist, 900) / 1300 s)', () => {
    const s = duel()
    const p0 = pawn(s, 0)
    place(p0, 0, 0, 0)
    place(pawn(s, 1), 0, 2000)
    const slot = grant(s, 0, 'thrust')
    step(s, [cast(0, slot, 3000, 0)])
    let ticksActive = 1
    let prev = p0.vx
    while (p0.modifiers.some((m) => m.id === 'thrust')) {
      prev = p0.vx
      step(s, [])
      ticksActive++
    }
    expect(ticksActive).toBe(ticks(0.09 + 900 / 1300))
    expect(p0.vx).toBeCloseTo((prev * F + 1733.3333333333333 * DT) * 0.2, 6)
  })

  test('two thrusters colliding hit each other at full factor', () => {
    const s = duel()
    const p0 = pawn(s, 0)
    const p1 = pawn(s, 1)
    place(p0, -300, 0, 0)
    place(p1, 300, 0, Math.PI)
    const a = grant(s, 0, 'thrust')
    const b = grant(s, 1, 'thrust')
    step(s, [cast(0, a, 300, 0), cast(1, b, -300, 0)])
    const dmg = of([...s.events, ...run(s, ticks(0.5))], 'damage')
    expect(dmg.map((d) => d.amount).sort()).toEqual([50, 50])
  })
})

// ---------------------------------------------------------------------------
describe('Swap (spells.md §8.11)', () => {
  test('trades places with the first warlock it touches; velocities are untouched', () => {
    const s = duel()
    const p0 = pawn(s, 0)
    const p1 = pawn(s, 1)
    place(p0, 0, 0, 0)
    place(p1, 400, 0)
    p1.vy = 200
    const slot = grant(s, 0, 'swap')
    step(s, [cast(0, slot, 900, 0)])
    const events = [...s.events, ...run(s, ticks(1 / 3))]
    const sw = of(events, 'swap')[0]
    expect(sw).toMatchObject({ spell: 'swap', pawn: p0.id, other: p1.id, fromX: 0 })
    expect(p0.x).toBeGreaterThan(395)
    expect(Math.abs(p1.x)).toBeLessThan(5)
    expect(p1.vy).toBeGreaterThan(100)
  })

  test('with nothing in the way it is a blink to where the bolt stopped (~cursor)', () => {
    const s = duel()
    const p0 = pawn(s, 0)
    place(p0, 0, 0, 0)
    place(pawn(s, 1), 0, 2000)
    const slot = grant(s, 0, 'swap')
    step(s, [cast(0, slot, 500, 500)])
    const events = [...s.events, ...run(s, ticks(2 / 3))]
    expect(of(events, 'swap')[0]).toMatchObject({ other: null })
    expect(Math.hypot(p0.x - 500, p0.y - 500)).toBeLessThan(40)
  })

  test('max range 0.4706 s x 1983 (~933) times range mastery', () => {
    const s = duel()
    const p0 = pawn(s, 0)
    place(p0, 0, 0, 0)
    place(pawn(s, 1), 0, 2000)
    const slot = grant(s, 0, 'swap')
    step(s, [cast(0, slot, 5000, 0)])
    run(s, ticks(1))
    expect(p0.x).toBeGreaterThan(933)
    expect(p0.x).toBeLessThan(933 + 40)
  })

  test('swaps with pillars only if combat was on at cast time; ignores projectiles', () => {
    const shop = newMatch()
    const a = pawn(shop, 0)
    place(a, 0, 0, 0)
    place(pawn(shop, 1), 0, 2000)
    shop.obstacles.push({ id: shop.nextEntityId++, x: 300, y: 0, radius: 60, hp: 400, variant: 0 })
    step(shop, [cast(0, grant(shop, 0, 'swap'), 600, 0)])
    run(shop, ticks(2 / 3))
    expect(a.x).toBeGreaterThan(560) // flew past the pillar and blinked
    expect(shop.obstacles[0].x).toBe(300)

    const s = duel()
    const p0 = pawn(s, 0)
    place(p0, 0, 0, 0)
    place(pawn(s, 1), 0, 2000)
    s.obstacles.push({ id: s.nextEntityId++, x: 300, y: 0, radius: 60, hp: 400, variant: 0 })
    // an enemy fireball in the path does not stop it
    s.projectiles.push({ id: s.nextEntityId++, owner: 1, spell: 'fireball', x: 150, y: 0, vx: 0, vy: 0, radius: 25, ticksLeft: ticks(1), data: { damage: 70, kb: 1 } })
    step(s, [cast(0, grant(s, 0, 'swap'), 600, 0)])
    const events = [...s.events, ...run(s, ticks(2 / 3))]
    expect(of(events, 'swap')[0].other).toBe(s.obstacles[0].id)
    expect(s.obstacles[0].x).toBe(0) // the pillar now stands where the caster was
  })
})

// ---------------------------------------------------------------------------
describe('Lightning (spells.md §8.6)', () => {
  function zap(s: SimState, x: number, y: number, level = 1): SimEvent[] {
    const slot = grant(s, 0, 'lightning', level)
    step(s, [cast(0, slot, x, y)])
    return [...s.events, ...run(s, ticks(0.2) + 2)] // cast point, then the beam
  }

  test('instantly strikes the first enemy on the line, pushing along the beam (kb 0.92)', () => {
    const s = duel()
    place(pawn(s, 0), 0, 0, 0)
    const p1 = pawn(s, 1)
    place(p1, 400, 40)
    const events = zap(s, 600, 0)
    const dmg = of(events, 'damage')[0]
    expect(dmg).toMatchObject({ target: p1.id, amount: 70 })
    expect(dmg.kb).toBeCloseTo(knockbackSpeed(70, 70, 1, 0.92, 1), 9)
    expect(p1.vy).toBeCloseTo(0, 6) // beam direction (+x), not centre-to-centre
    expect(of(events, 'beam')[0]).toMatchObject({ target: p1.id, blocked: false, toX: 400 })
  })

  test('hit test: centre within 600 x rm and within 25 + radius of the line', () => {
    for (const [x, y, hit] of [[300, 54, true], [300, 56, false], [599, 0, true], [601, 0, false]] as const) {
      const s = duel()
      place(pawn(s, 0), 0, 0, 0)
      place(pawn(s, 1), x, y)
      expect(of(zap(s, 1000, 0), 'damage').length > 0).toBe(hit)
    }
    const s = duel()
    s.scores[0].masteries.range = 1 // 672
    place(pawn(s, 0), 0, 0, 0)
    place(pawn(s, 1), 650, 0)
    expect(of(zap(s, 1000, 0), 'damage')).toHaveLength(1)
  })

  test('detonates a level-one Fireball with the original peak damage and radius, reachable within the full-damage core', () => {
    const s = duel()
    const p0 = pawn(s, 0)
    const p1 = pawn(s, 1)
    place(p0, 0, 0, 0)
    place(p1, 2000, 0)
    spawnProjectile(s, 0, 'fireball', 300, 0, 0, 0, 25, { lifetime: 5, data: { damage: 70, kb: 1 } })
    place(p1, 300, 100) // 100 from the fireball, off the beam line
    const events = zap(s, 1000, 0)
    expect(of(events, 'explosion')[0]).toMatchObject({ spell: 'lightning', radius: 225 })
    const dmg = of(events, 'damage')[0]
    expect(dmg.amount).toBeCloseTo((2 / 3) * 140, 9)
    expect(s.projectiles).toHaveLength(0)
  })

  function launchAndParkFireball(s: SimState, owner: number, level: number): void {
    const slot = grant(s, owner, 'fireball', level)
    const caster = pawn(s, owner)
    castNow(s, owner, slot, caster.x + 1000, caster.y)
    const fb = s.projectiles.find((projectile) => projectile.spell === 'fireball' && projectile.owner === owner)!
    expect(fb).toBeDefined()
    // Keep the real launched projectile's level and damage; fix only the test geometry.
    fb.x = 300; fb.y = 0; fb.vx = 0; fb.vy = 0
  }

  test.each([
    [1, 1, 140], [2, 1, 147], [3, 1, 154], [4, 1, 161],
    [5, 1, 168], [6, 1, 175], [7, 1, 182],
    [1, 7, 188], [4, 3, 177], [7, 7, 230],
  ])('detonation scales with Fireball level %i and Lightning level %i (combined base %i)', (fireballLevel, lightningLevel, combinedDamage) => {
    const s = duel()
    place(pawn(s, 0), 0, 0, 0)
    const target = pawn(s, 1)
    place(target, -600, 600)
    launchAndParkFireball(s, 0, fireballLevel)
    place(target, 300, 100) // Off the beam; 100 units from the explosion centre.
    const events = zap(s, 1000, 0, lightningLevel)
    const expected = (2 / 3) * combinedDamage
    const damage = of(events, 'damage')
    expect(damage).toHaveLength(1)
    expect(damage[0]).toMatchObject({ target: target.id, source: 0, cause: 'lightning' })
    expect(damage[0].amount).toBeCloseTo(expected, 9)
    expect(damage[0].kb).toBeCloseTo(knockbackSpeed(expected, expected, 1, 1.35, 1), 9)
    expect(of(events, 'explosion')[0]).toMatchObject({ radius: 225 })
    expect(target.vx).toBeCloseTo(0, 9)
    expect(target.vy).toBeGreaterThan(0)
    expect(s.projectiles).toHaveLength(0)
  })

  test('an allied Fireball contributes its own launch damage, not the Lightning caster’s Fireball level', () => {
    const s = fight(3, [0, 0, 1])
    place(pawn(s, 0), 0, 0, 0)
    place(pawn(s, 1), -600, 600, 0)
    place(pawn(s, 2), 800, 800)
    launchAndParkFireball(s, 1, 7)
    expect(pawn(s, 0).levels[FIREBALL_SLOT]).toBe(1)
    place(pawn(s, 2), 300, 100)
    const events = zap(s, 1000, 0)
    const damage = of(events, 'damage')
    expect(damage).toHaveLength(1)
    expect(damage[0]).toMatchObject({ target: pawn(s, 2).id, source: 0, cause: 'lightning' })
    expect(damage[0].amount).toBeCloseTo((2 / 3) * (70 + 112), 9)
    expect(s.projectiles).toHaveLength(0)
  })

  test.each([
    [60, 1], [75, 1], [100, 1], [150, 0.6], [200, 0.2], [224, 0.008], [225, 0], [226, 0],
  ])('Fireball detonation at distance %i gets damage fraction %f', (distance, fraction) => {
    const s = duel()
    place(pawn(s, 0), 0, 0, 0)
    place(pawn(s, 1), -600, 600)
    launchAndParkFireball(s, 0, 7)
    place(pawn(s, 1), 300, distance)
    const events = zap(s, 1000, 0, 7)
    expect(of(events, 'explosion')[0]).toMatchObject({ radius: 225 })
    const damage = of(events, 'damage')
    if (fraction === 0) expect(damage).toHaveLength(0)
    else {
      expect(damage).toHaveLength(1)
      expect(damage[0].amount).toBeCloseTo((2 / 3) * 230 * fraction, 9)
    }
    expect(s.projectiles).toHaveLength(0)
  })

  test.each([[300, 50, true], [300, 51, false], [599, 0, true], [600, 0, false]])(
    'Lightning triggers a Fireball at forward distance %i and lateral offset %i: %s', (x, y, detonates) => {
      const s = duel()
      place(pawn(s, 0), 0, 0, 0)
      place(pawn(s, 1), -600, 600)
      const fb = spawnProjectile(s, 0, 'fireball', x, y, 0, 0, 25, { lifetime: 5, data: { damage: 70, kb: 1 } })
      const events = zap(s, 1000, 0)
      expect(of(events, 'explosion')).toHaveLength(detonates ? 1 : 0)
      expect(of(events, 'beam')[0].target).toBe(detonates ? fb.id : null)
    },
  )

  test('destroys an enemy projectile in its path and stops there; passes through a Boomerang', () => {
    const s = duel()
    place(pawn(s, 0), 0, 0, 0)
    place(pawn(s, 1), 500, 0)
    spawnProjectile(s, 1, 'boomerang', 150, 0, 0, 0, 38, { lifetime: null, data: { returning: 1 } })
    spawnProjectile(s, 1, 'fireball', 300, 0, 0, 0, 25, { lifetime: 5, data: { damage: 70, kb: 1 } })
    const events = zap(s, 1000, 0)
    const beam = of(events, 'beam')[0]
    expect(beam.toX).toBeCloseTo(300, 6)
    expect(of(events, 'damage')).toHaveLength(0)
    expect(s.projectiles.map((p) => p.spell)).toEqual(['boomerang'])
  })
})

// ---------------------------------------------------------------------------
describe('Boomerang (spells.md §8.5)', () => {
  test('flies out about D = 800, curves, and comes back to be caught within 75', () => {
    const s = duel()
    const p0 = pawn(s, 0)
    place(p0, 0, 0, 0)
    place(pawn(s, 1), 0, 3000)
    step(s, [cast(0, grant(s, 0, 'boomerang'), 2000, 0)])
    run(s, ticks(0.2)) // cast point
    let maxX = 0
    let minY = 0
    let maxY = 0
    let alive = 0
    for (let i = 0; i < ticks(7); i++) {
      step(s, [])
      const b = s.projectiles.find((p) => p.spell === 'boomerang')
      if (!b) break
      alive++
      maxX = Math.max(maxX, b.x)
      minY = Math.min(minY, b.y)
      maxY = Math.max(maxY, b.y)
    }
    expect(s.projectiles).toHaveLength(0)
    expect(maxX).toBeGreaterThan(760)
    expect(maxX).toBeLessThan(840)
    // launched with +300 lateral, then curving the other way: a lopsided loop
    expect(maxY).toBeGreaterThan(50)
    expect(alive / TICK_HZ).toBeGreaterThan(2)
  })

  test('hits an enemy (kb 0.95), bounces off at 500 u/s and starts returning', () => {
    const s = duel()
    place(pawn(s, 0), 0, 0, 0)
    const p1 = pawn(s, 1)
    place(p1, 300, 0)
    step(s, [cast(0, grant(s, 0, 'boomerang'), 2000, 0)])
    const events = [...s.events, ...run(s, ticks(0.5))]
    const dmg = of(events, 'damage').find((e) => e.target === p1.id)!
    expect(dmg.amount).toBe(70)
    expect(dmg.kb).toBeCloseTo(knockbackSpeed(70, 70, 1, 0.95, 1), 9)
    expect(of(events, 'projectileBounce')).toHaveLength(1)
  })

  test('never touches projectiles: an enemy Fireball flies straight through it', () => {
    const s = duel()
    place(pawn(s, 0), -1000, 2000)
    place(pawn(s, 1), 1000, 2000)
    const b = spawnProjectile(s, 0, 'boomerang', 0, 0, 0, 0, 38, { lifetime: null, data: { returning: 1 } })
    spawnProjectile(s, 1, 'fireball', 200, 0, -1000, 0, 25, { lifetime: 1, data: { damage: 70, kb: 1 } })
    run(s, ticks(1 / 6))
    expect(s.projectiles.some((p) => p.id === b.id)).toBe(true)
    expect(s.projectiles.some((p) => p.spell === 'fireball')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
describe('Homing (spells.md §8.7, intended behavior)', () => {
  test('curves onto an enemy a straight bolt would miss', () => {
    const s = duel()
    place(pawn(s, 0), 0, 0, 0)
    const p1 = pawn(s, 1)
    place(p1, 500, 90) // 90 off the line: a straight r30 bolt misses the r30 pawn
    step(s, [cast(0, grant(s, 0, 'homing'), 500, 0)])
    const events = [...s.events, ...run(s, ticks(2))]
    expect(of(events, 'damage').find((e) => e.target === p1.id)?.amount).toBe(70)
  })

  test('steers 3% toward 1000 u/s per ORIGINAL 0.035 s tick, whatever our tick rate', () => {
    const s = duel()
    place(pawn(s, 0), -3000, 0)
    place(pawn(s, 1), 4000, 0) // dead ahead: desired velocity stays (1000, 0)
    const h = spawnProjectile(s, 0, 'homing', 0, 0, 800, 0, 30, { lifetime: 4.5, data: { damage: 70, target: -1, cruise: 1000 } })
    run(s, ticks(1)) // one second = 1 / 0.035 original ticks
    // original: v_n = 1000 - 200 * 0.97^n after n ticks of 0.035 s
    expect(h.vx).toBeCloseTo(1000 - 200 * Math.pow(0.97, 1 / 0.035), 6)
    expect(h.vy).toBe(0)
  })

  test('touching its own caster detonates (r292 on enemies) and speeds the caster up', () => {
    const s = duel()
    const p0 = pawn(s, 0)
    const p1 = pawn(s, 1)
    place(p0, 0, 0)
    place(p1, 0, 250)
    spawnProjectile(s, 0, 'homing', 100, 0, -1000, 0, 30, { lifetime: 4.5, data: { damage: 70, target: -1, cruise: 1000, selfRadius: 292, selfKb: 0.9, haste: 50, burnout: 120, hasteTime: 4 } })
    const events = run(s, 3)
    expect(of(events, 'explosion')[0]).toMatchObject({ spell: 'homing', radius: 292 })
    expect(of(events, 'damage').find((e) => e.target === p1.id)).toBeDefined()
    expect(of(events, 'damage').find((e) => e.target === p0.id)).toBeUndefined()
    expect(p0.moveSpeed).toBe(260)
  })

  test('an enemy projectile destroys it (and the Fireball dies on its own reaction)', () => {
    const s = duel()
    place(pawn(s, 0), -2000, 0)
    place(pawn(s, 1), 2000, 0)
    spawnProjectile(s, 0, 'homing', 0, 0, 0, 0, 30, { lifetime: 4.5, data: { damage: 70, target: -1, cruise: 0 } })
    spawnProjectile(s, 1, 'fireball', 40, 0, 0, 0, 25, { lifetime: 4.5, data: { damage: 70, kb: 1 } })
    run(s, 1)
    expect(s.projectiles).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
describe('Twin (spells.md §8.8)', () => {
  function flight(s: SimState): { end: ProjectileState[]; n: number; maxSide: number } {
    let n = 0
    let maxSide = 0
    let last: ProjectileState[] = []
    while (n < 200) {
      step(s, [])
      n++
      const t = s.projectiles.filter((p) => p.spell === 'twin')
      if (t.length === 0) break
      last = t.map((p) => ({ ...p }))
      for (const p of t) maxSide = Math.max(maxSide, Math.abs(p.y))
    }
    return { end: last, n, maxSide }
  }

  test('two mirrored arcs (semi-axes 400 x 161) converge on the target in ~0.92 s', () => {
    const s = duel()
    place(pawn(s, 0), 0, 0, 0)
    place(pawn(s, 1), 0, 3000)
    step(s, [cast(0, grant(s, 0, 'twin'), 800, 0)])
    run(s, ticks(0.2)) // cast point
    const { end, n, maxSide } = flight(s)
    expect(end).toHaveLength(2)
    for (const p of end) expect(Math.hypot(p.x - 800, p.y)).toBeLessThan(25)
    expect(maxSide).toBeGreaterThan(155)
    expect(maxSide).toBeLessThan(165)
    expect(n / TICK_HZ).toBeGreaterThan(0.85)
    expect(n / TICK_HZ).toBeLessThan(1)
  })

  test('both bolts can hit the same warlock (2 x damage)', () => {
    const s = duel()
    place(pawn(s, 0), 0, 0, 0)
    const p1 = pawn(s, 1)
    place(p1, 800, 0)
    step(s, [cast(0, grant(s, 0, 'twin'), 800, 0)])
    const events = run(s, ticks(1.5))
    expect(of(events, 'damage').filter((e) => e.target === p1.id).map((e) => e.amount)).toEqual([44, 44])
  })
})

describe('release gate', () => {
  test('implemented but unreleased spells cannot be bought, and nothing is charged', () => {
    // pick from the live gate so releasing spells never invalidates this test
    const unreleased = [...IMPLEMENTED_SPELLS].filter((id) => !RELEASED_SPELLS.has(id) && SPELLS[id]?.column)
    if (unreleased.length === 0) return // everything released: nothing left to gate
    const s = newMatch({ startGold: 100 })
    step(s, [cmd(0, ...unreleased.map((spell) => ({ kind: 'buySpell' as const, spell })))])
    expect(pawn(s, 0).slots.slice(0, 6)).toEqual([null, null, null, null, null, null])
    expect(s.scores[0].gold).toBe(100)
    void FIREBALL_SLOT
  })
})
