import { describe, expect, test } from 'vitest'
import { FIREBALL_SLOT, SCOURGE_SLOT, ticks } from './config'
import { knockbackSpeed, receiveDamage } from './combat'
import { step } from './index'
import { spawnProjectile } from './projectiles'
import { RELEASED_SPELLS } from './spells/data'
import { debuffFactor } from './stats'
import { cmd, grant, newMatch, pawn, place, run, toCombat } from './testkit'
import type { SimEvent, SimState } from './types'

const of = <T extends SimEvent['type']>(events: SimEvent[], type: T) =>
  events.filter((e): e is Extract<SimEvent, { type: T }> => e.type === type)
const cast = (player: number, slot: number, x: number, y: number) => cmd(player, { kind: 'cast', slot, x, y })

function fight(n = 2, teams?: number[]): SimState {
  const s = newMatch(teams ? { teamMode: 'teams' } : {}, n, 1, teams)
  toCombat(s)
  return s
}

/** cast and run until the spell fired (turn + cast point) */
function castNow(s: SimState, player: number, slot: number, x: number, y: number): SimEvent[] {
  step(s, [cast(player, slot, x, y)])
  const ev = [...s.events]
  for (let i = 0; i < 90 && !ev.some((e) => e.type === 'cast'); i++) {
    step(s, [])
    ev.push(...s.events)
  }
  return ev
}

// ---------------------------------------------------------------------------
describe('passive items (systems.md §3.1): levels replace, stacking is additive', () => {
  test('Armor + Cursed Ring stack to kb factor 0.63 and really cut knockback', () => {
    const s = fight()
    const p1 = pawn(s, 1)
    grant(s, 1, 'armor', 3)
    grant(s, 1, 'cursed_ring', 1)
    expect(p1.kbFactor).toBeCloseTo(0.63, 12)
    place(p1, 0, 0)
    receiveDamage(s, p1, { amount: 70, source: 0, normal: { x: 1, y: 0 } })
    expect(p1.vx).toBeCloseTo(749 * 0.63, 6)
  })

  test('Ring of Health raises max HP, not current HP; an upgrade replaces the level value', () => {
    const s = fight()
    const p = pawn(s, 0)
    grant(s, 0, 'ring_of_health', 1)
    expect(p.maxHp).toBe(1100)
    expect(p.hp).toBe(1000)
    grant(s, 0, 'ring_of_health', 2)
    expect(p.maxHp).toBe(1190) // not 1290
    grant(s, 0, 'cursed_ring', 2)
    grant(s, 0, 'ring_of_health', 5)
    expect(p.maxHp).toBe(1600)
  })

  test('Boots, Cape and Pocket Watch', () => {
    const s = fight()
    const p = pawn(s, 0)
    grant(s, 0, 'boots', 3)
    grant(s, 0, 'cape', 1)
    expect(p.moveSpeed).toBe(250)
    expect(p.hpRegen).toBe(6.5)
    grant(s, 0, 'pocket_watch', 2)
    grant(s, 0, 'cursed_ring', 2)
    expect(debuffFactor(p)).toBeCloseTo(0.85, 12)
  })

  test('items survive death and the next round', () => {
    const s = newMatch({ shopSeconds: 1 })
    toCombat(s)
    grant(s, 0, 'boots', 1)
    pawn(s, 1).x = 3000
    while (s.phase !== 'shop') step(s, [])
    expect(pawn(s, 0).moveSpeed).toBe(228)
  })

  test('the shop path: buy, upgrade, 4 free item slots, cost per level', () => {
    const released = RELEASED_SPELLS as Set<string>
    released.add('armor')
    released.add('boots')
    try {
      const s = newMatch({ startGold: 100 })
      step(s, [cmd(0, { kind: 'buyItem', item: 'armor' }, { kind: 'buyItem', item: 'armor' }, { kind: 'buyItem', item: 'boots' })])
      const p = pawn(s, 0)
      expect(p.kbFactor).toBeCloseTo(0.82, 12)
      expect(p.moveSpeed).toBe(228)
      expect(s.scores[0].gold).toBe(100 - 12 - 5)
      expect(p.slots.slice(6)).toEqual(['fireball', 'scourge', 'armor', 'boots', null, null])
    } finally {
      released.delete('armor')
      released.delete('boots')
    }
  })
})

// ---------------------------------------------------------------------------
describe('Redirector (spells.md §8.3)', () => {
  test('re-aims your projectile nearest the cursor (speed kept), +0.5 s x rm, +30% knockback taken for 8 s', () => {
    const s = fight()
    const p0 = pawn(s, 0)
    place(p0, 0, 0, 0)
    place(pawn(s, 1), 0, 3000)
    s.scores[0].masteries.range = 1
    const fb = spawnProjectile(s, 0, 'fireball', 300, 0, 1000, 0, 25, { lifetime: 1, data: { damage: 70, kb: 1 } })
    const before = fb.ticksLeft
    const t0 = s.tick
    const slot = grant(s, 0, 'redirector')
    castNow(s, 0, slot, 300, 500)
    expect(Math.hypot(fb.vx, fb.vy)).toBeCloseTo(1000, 9)
    expect(fb.vy).toBeGreaterThan(900)
    // +0.5 x 1.12 s once (the original re-scaled the remaining lifetime by rm as well)
    expect(fb.ticksLeft).toBeCloseTo(before - (s.tick - t0) + 0.5 * 1.12 * 60, 6)
    expect(p0.kbFactor).toBeCloseTo(1.3, 12)
    const pen = p0.modifiers.find((m) => m.id === 'redirectorPenalty')!
    expect(pen.ticksLeft).toBeGreaterThan(ticks(8) - 3)
  })

  test('the penalty applies even with nothing to redirect, scaled by own debuff factor', () => {
    const s = fight()
    const p0 = pawn(s, 0)
    grant(s, 0, 'pocket_watch', 1)
    castNow(s, 0, grant(s, 0, 'redirector'), 0, 0)
    // added during this tick's pre-tick, then counted down once at the end of the tick
    expect(p0.modifiers.find((m) => m.id === 'redirectorPenalty')!.ticksLeft).toBe(ticks(8 * 0.65) - 1)
  })
})

describe('Pact (spells.md §8.4)', () => {
  test('the next damaging spell deals x1.5, then Pact turns into a 66 slow for 6 s', () => {
    const s = fight()
    const p0 = pawn(s, 0)
    const p1 = pawn(s, 1)
    place(p0, 0, 0, 0)
    place(p1, 300, 0)
    castNow(s, 0, grant(s, 0, 'pact'), 0, 0)
    expect(p0.modifiers.some((m) => m.id === 'pact')).toBe(true)
    // Teleport has no damage: does not consume
    castNow(s, 0, grant(s, 0, 'teleport'), 0, 100)
    expect(p0.modifiers.some((m) => m.id === 'pact')).toBe(true)
    place(p0, 0, 0, 0)
    const events = [...castNow(s, 0, FIREBALL_SLOT, 300, 0), ...run(s, 20)]
    expect(of(events, 'damage').find((e) => e.target === p1.id)!.amount).toBe(105)
    expect(p0.modifiers.some((m) => m.id === 'pact')).toBe(false)
    expect(p0.moveSpeed).toBe(210 - 66)
  })

  test('Pact makes the Lv1 Scourge self cost 150 (original quirk)', () => {
    const s = fight()
    const p0 = pawn(s, 0)
    place(p0, 0, 0)
    castNow(s, 0, grant(s, 0, 'pact'), 0, 0)
    castNow(s, 0, SCOURGE_SLOT, 0, 0)
    expect(p0.hp).toBeCloseTo(850, 0)
  })
})

// ---------------------------------------------------------------------------
describe('Cluster (spells.md §8.12)', () => {
  test('four bolts in a fan, kb 0.65, all four can hit one close target', () => {
    const s = fight()
    const p0 = pawn(s, 0)
    const p1 = pawn(s, 1)
    place(p0, 0, 0, 0)
    place(p1, 90, 0)
    const events = [...castNow(s, 0, grant(s, 0, 'cluster'), 500, 0), ...run(s, 10)]
    const hits = of(events, 'damage').filter((e) => e.target === p1.id)
    expect(hits.map((h) => h.amount)).toEqual([33, 33, 33, 33])
    expect(hits[0].kb).toBeCloseTo(knockbackSpeed(33, 33, 1, 0.65, 1), 9)
  })

  test('the fan is +-0.06 and +-0.18 rad wide', () => {
    const s = fight()
    place(pawn(s, 0), 0, 0, 0)
    place(pawn(s, 1), 0, 3000)
    castNow(s, 0, grant(s, 0, 'cluster'), 500, 0)
    const angles = s.projectiles.map((p) => Math.atan2(p.vy, p.vx)).sort((a, b) => a - b)
    expect(angles.map((a) => +a.toFixed(6))).toEqual([-0.18, -0.06, 0.06, 0.18])
    expect(s.projectiles.every((p) => Math.abs(Math.hypot(p.vx, p.vy) - 844) < 1e-9)).toBe(true)
  })
})

describe('Drain (spells.md §8.13)', () => {
  test('enemy hit: damage (kb 0.2) + slow 50, and a heal orb flies back and heals the caster', () => {
    const s = fight()
    const p0 = pawn(s, 0)
    const p1 = pawn(s, 1)
    place(p0, 0, 0, 0)
    place(p1, 300, 0)
    p0.hp = 500
    const events = [...castNow(s, 0, grant(s, 0, 'drain'), 300, 0), ...run(s, 60)]
    const dmg = of(events, 'damage').find((e) => e.target === p1.id)!
    expect(dmg.amount).toBe(60)
    expect(dmg.kb).toBeCloseTo(knockbackSpeed(60, 60, 1, 0.2, 1), 9)
    expect(p1.moveSpeed).toBe(160)
    expect(of(events, 'heal').find((e) => e.target === p0.id)?.amount).toBe(60)
  })

  test('ally hit (teams): heal and +50 move speed, no damage', () => {
    const s = fight(2, [1, 1])
    const p0 = pawn(s, 0)
    const p1 = pawn(s, 1)
    place(p0, 0, 0, 0)
    place(p1, 300, 0)
    p1.hp = 400
    const events = [...castNow(s, 0, grant(s, 0, 'drain'), 300, 0), ...run(s, 30)]
    expect(of(events, 'damage')).toHaveLength(0)
    expect(of(events, 'heal')[0]).toMatchObject({ target: p1.id, amount: 60 })
    expect(p1.moveSpeed).toBe(260)
  })

  test('re-aims once at the nearest other warlock when it reaches the cursor distance', () => {
    const s = fight()
    place(pawn(s, 0), 0, 0, 0)
    const p1 = pawn(s, 1)
    place(p1, 300, 400)
    const events = [...castNow(s, 0, grant(s, 0, 'drain'), 300, 0), ...run(s, 90)]
    expect(of(events, 'damage').find((e) => e.target === p1.id)).toBeDefined()
  })

  test('radius 24.5 (v1 fix): a pass 50 u from a warlock centre still connects', () => {
    const s = fight()
    place(pawn(s, 0), 0, 50, 0)
    const p1 = pawn(s, 1)
    place(p1, 400, 0)
    const events = [...castNow(s, 0, grant(s, 0, 'drain'), 2000, 50), ...run(s, 60)]
    expect(of(events, 'damage').find((e) => e.target === p1.id)).toBeDefined()
  })

  test('Drain survives enemy projectiles that do not damage (Homing), dies to ones that do (Fireball)', () => {
    const s = fight()
    place(pawn(s, 0), -2000, 0)
    place(pawn(s, 1), 2000, 0)
    const drain = spawnProjectile(s, 0, 'drain', 0, 0, 0, 0, 24.5, { lifetime: 2, data: { damage: 60, turnAt: 99, t: 0, turned: 1 } })
    spawnProjectile(s, 1, 'homing', 40, 0, 0, 0, 30, { lifetime: 2, data: { damage: 70, target: -1, cruise: 0 } })
    run(s, 1)
    expect(s.projectiles.map((p) => p.id)).toEqual([drain.id])
    spawnProjectile(s, 1, 'fireball', drain.x + 30, 0, 0, 0, 25, { lifetime: 2, data: { damage: 70, kb: 1 } })
    run(s, 1)
    expect(s.projectiles).toHaveLength(0)
  })
})

describe('Bouncer (spells.md §8.14)', () => {
  test('bounces between warlocks: damage x0.7 per enemy hit, dies below 10 (Lv1: 5 hits)', () => {
    const s = fight(3)
    place(pawn(s, 0), -600, 0, 0) // within the 1 s x 900 u/s TTL
    place(pawn(s, 1), 0, 0)
    place(pawn(s, 2), 0, 250)
    const events = [...castNow(s, 0, grant(s, 0, 'bouncer'), 0, 0), ...run(s, 400)]
    const amounts = of(events, 'damage').filter((e) => e.source === 0).map((e) => +e.amount.toFixed(4))
    expect(amounts).toEqual([54, 37.8, 26.46, 18.522, 12.9654])
    expect(s.projectiles).toHaveLength(0)
  })

  test('allies are bounced through without damage or decay', () => {
    const s = fight(3, [1, 1, 2])
    place(pawn(s, 0), -600, 0, 0)
    place(pawn(s, 1), 0, 0) // ally first on the path
    place(pawn(s, 2), 0, 300)
    const events = [...castNow(s, 0, grant(s, 0, 'bouncer'), 0, 0), ...run(s, 120)]
    const dmg = of(events, 'damage')
    expect(dmg.find((e) => e.target === pawn(s, 1).id)).toBeUndefined()
    expect(dmg.find((e) => e.target === pawn(s, 2).id)?.amount).toBe(54)
  })

  test('touching an enemy projectile kills the Bouncer but not the other projectile', () => {
    const s = fight()
    place(pawn(s, 0), -2000, 0)
    place(pawn(s, 1), 2000, 0)
    spawnProjectile(s, 0, 'bouncer', 0, 0, 0, 0, 38, { lifetime: 1, data: { damage: 54, prevHit: -1 } })
    const drain = spawnProjectile(s, 1, 'drain', 40, 0, 0, 0, 24.5, { lifetime: 1, data: { damage: 60, turned: 1 } })
    run(s, 1)
    expect(s.projectiles.map((p) => p.id)).toEqual([drain.id])
  })
})

describe('Recharge (spells.md §8.15)', () => {
  test('a hit builds the streak (+10 next cast) and the returning orb resets the cooldown', () => {
    const s = fight()
    const p0 = pawn(s, 0)
    const p1 = pawn(s, 1)
    place(p0, 0, 0, 0)
    place(p1, 300, 0)
    const slot = grant(s, 0, 'recharge')
    const events = [...castNow(s, 0, slot, 300, 0), ...run(s, 60)]
    expect(of(events, 'damage')[0].amount).toBe(60)
    expect(of(events, 'streak')).toEqual([{ type: 'streak', pawn: p0.id, spell: 'recharge', value: 1 }])
    expect(of(events, 'cooldownReset')).toEqual([{ type: 'cooldownReset', pawn: p0.id, slot, spell: 'recharge' }])
    expect(p0.cooldowns[slot]).toBe(0)
    place(p1, 300, 0)
    const again = [...castNow(s, 0, slot, 300, 0), ...run(s, 30)]
    expect(of(again, 'damage')[0].amount).toBe(70)
  })

  test('a miss resets the streak to 0', () => {
    const s = fight()
    const p0 = pawn(s, 0)
    place(p0, 0, 0, 0)
    place(pawn(s, 1), 300, 0)
    const slot = grant(s, 0, 'recharge')
    castNow(s, 0, slot, 300, 0)
    run(s, 60)
    place(pawn(s, 1), 0, 2000)
    const events = [...castNow(s, 0, slot, 300, 0), ...run(s, 80)]
    expect(of(events, 'streak').at(-1)?.value).toBe(0)
  })
})
