import { describe, expect, test } from 'vitest'
import { knockbackSpeed, receiveDamage } from './combat'
import { cmd, newMatch, pawn, place, run, runUntil, toCombat } from './testkit'
import type { SimEvent } from './types'

// spells.md §4.4: knockback dv at 0 prior DP (this hit's DP gain included), no items.
// [damage, spell knockback factor, expected dv (rounded)]
const TABLE: Record<string, [number, number, number][]> = {
  fireball: [[70, 1, 749], [77, 1, 829], [84, 1, 911], [91, 1, 993], [98, 1, 1076], [105, 1, 1132], [112, 1, 1177]],
  cluster: [[33, 0.65, 222], [36, 0.65, 242], [39, 0.65, 263], [42, 0.65, 284], [45, 0.65, 306], [48, 0.65, 327], [51, 0.65, 348]],
  boomerang: [[70, 0.95, 712], [76, 0.95, 777], [82, 0.95, 843], [88, 0.95, 910], [94, 0.95, 977], [100, 0.95, 1045], [106, 0.95, 1082]],
  lightning: [[70, 0.92, 689], [78, 0.92, 774], [86, 0.92, 859], [94, 0.92, 946], [102, 0.92, 1024], [110, 0.92, 1071], [118, 0.92, 1117]],
  homing: [[70, 1, 749], [80, 1, 864], [90, 1, 981], [100, 1, 1100], [110, 1, 1164], [120, 1, 1227], [130, 1, 1288]],
  twin: [[44, 1, 459], [48, 1, 503], [52, 1, 547], [56, 1, 591], [62, 1, 658], [66, 1, 704], [72, 1, 772]],
  bouncer: [[54, 1.2, 683], [62, 1.2, 790], [70, 1.2, 899], [78, 1.2, 1009], [86, 1.2, 1121], [94, 1.2, 1234], [102, 1.2, 1336]],
  drain: [[60, 0.2, 127], [70, 0.2, 150], [80, 0.2, 173], [90, 0.2, 196], [100, 0.2, 220], [110, 0.2, 233], [120, 0.2, 245]],
  recharge: [[60, 1, 636], [67, 1, 715], [74, 1, 795], [81, 1, 876], [88, 1, 957], [95, 1, 1040], [102, 1, 1113]],
  thrust: [[50, 1.2, 630], [55, 1.2, 696], [60, 1.2, 763], [65, 1.2, 831], [70, 1.2, 899], [75, 1.2, 968], [80, 1.2, 1037]],
  windwalk: [[54, 1, 569], [60, 1, 636], [66, 1, 704], [72, 1, 772], [78, 1, 841], [84, 1, 911], [90, 1, 981]],
  splitter: [[30, 1, 309], [35, 1, 362], [40, 1, 416], [45, 1, 470], [50, 1, 525], [55, 1, 580], [60, 1, 636]],
  meteor: [[110, 0.66, 768], [120, 0.66, 810], [130, 0.66, 850], [140, 0.66, 890], [150, 0.66, 930], [160, 0.66, 968], [170, 0.66, 1007]],
  snowball: [[45, 0.8, 376], [60, 0.8, 509], [75, 0.8, 645], [90, 0.8, 785], [105, 0.8, 906], [120, 0.8, 982], [135, 0.8, 1055]],
  scourgeCentre: [[100, 1, 1100], [110, 1, 1164], [120, 1, 1227]],
  scourgeEdge: [[100, 0.75, 825], [110, 0.75, 873], [120, 0.75, 920]],
  lightningFireball: [[(2 / 3) * 140, 1.35, 1378], [(2 / 3) * 148, 1.35, 1463], [(2 / 3) * 156, 1.35, 1520], [(2 / 3) * 164, 1.35, 1566], [(2 / 3) * 172, 1.35, 1611], [(2 / 3) * 180, 1.35, 1656], [(2 / 3) * 188, 1.35, 1701]],
  homingSelf: [[70, 0.9, 674], [80, 0.9, 778], [90, 0.9, 883], [100, 0.9, 990], [110, 0.9, 1048], [120, 0.9, 1104], [130, 0.9, 1160]],
}

describe('knockback formula reproduces the reference table (spells.md §4.4)', () => {
  for (const [name, rows] of Object.entries(TABLE)) {
    test(name, () => {
      for (const [dmg, kb, dv] of rows) {
        // DP passed in already includes this hit (DP 0 before the hit)
        expect(Math.abs(knockbackSpeed(dmg, dmg, 1, kb, 1) - dv)).toBeLessThanOrEqual(0.5 + 1e-9)
      }
    })
  }

  test('knockback points amplify later hits (Smash-style percent)', () => {
    // same 70 damage hit at 500 prior DP pushes (1 + 570/1000) / (1 + 70/1000) times harder
    expect(knockbackSpeed(70, 570, 1, 1, 1) / knockbackSpeed(70, 70, 1, 1, 1)).toBeCloseTo(1.57 / 1.07, 12)
    // negative kb factor (stacked reductions) can never pull toward the hitter
    expect(knockbackSpeed(70, 70, -0.2, 1, 1)).toBe(0)
  })
})

describe('damage pipeline (spells.md §4.1)', () => {
  test('a hit adds DP, pushes along the normal and credits the source', () => {
    const s = newMatch()
    toCombat(s)
    const p1 = pawn(s, 1)
    place(p1, 0, 0)
    const dealt = receiveDamage(s, p1, { cause: 'test', amount: 70, source: 0, normal: { x: 0, y: 1 } })
    expect(dealt).toBe(70)
    expect(p1.kbPoints).toBe(70)
    expect(p1.vy).toBeCloseTo(749, 6)
    expect(p1.vx).toBe(0)
    expect(p1.hp).toBe(930)
    expect(p1.lastHitter).toBe(0)
    expect(s.scores[0].damageThisRound).toBe(70)
    expect(s.events.some((e) => e.type === 'damage' && e.target === p1.id && e.amount === 70)).toBe(true)
  })

  test('no damage outside combat (shop phase) or during spawn invulnerability', () => {
    const s = newMatch()
    const p1 = pawn(s, 1)
    expect(s.phase).toBe('shop')
    expect(receiveDamage(s, p1, { cause: 'test', amount: 500, source: 0, normal: { x: 1, y: 0 } })).toBe(0)
    runUntil(s, (st) => st.phase === 'fight')
    expect(p1.invulnerable).toBe(true)
    expect(receiveDamage(s, p1, { cause: 'test', amount: 500, source: 0, normal: { x: 1, y: 0 } })).toBe(0)
    expect(p1.hp).toBe(1000)
    run(s, 120) // 2 s
    expect(p1.invulnerable).toBe(false)
    expect(receiveDamage(s, p1, { cause: 'test', amount: 100, source: 0 })).toBe(100)
  })

  test('damage and knockback multipliers come from the lobby settings', () => {
    const s = newMatch({ dmgMultiplier: 2, kbMultiplier: 0.5 })
    toCombat(s)
    const p1 = pawn(s, 1)
    place(p1, 0, 0)
    receiveDamage(s, p1, { cause: 'test', amount: 35, source: 0, normal: { x: 1, y: 0 } })
    expect(p1.hp).toBe(930)
    expect(p1.vx).toBeCloseTo(749 / 2, 6)
  })

  test('lifesteal heals the source and lowers its DP by half the heal', () => {
    const s = newMatch()
    toCombat(s)
    s.scores[0].masteries.lifesteal = 1 // 0.09
    const p0 = pawn(s, 0)
    p0.hp = 500
    p0.kbPoints = 100
    receiveDamage(s, pawn(s, 1), { cause: 'test', amount: 100, source: 0, normal: { x: 1, y: 0 } })
    expect(p0.hp).toBeCloseTo(509, 9)
    expect(p0.kbPoints).toBeCloseTo(95.5, 9)
  })

  test('a pawn dies at <= 1 HP', () => {
    const s = newMatch()
    toCombat(s)
    const p1 = pawn(s, 1)
    p1.hp = 51
    receiveDamage(s, p1, { cause: 'test', amount: 50, source: 0 })
    expect(p1.alive).toBe(false)
  })
})

describe('lava (systems.md §5.2)', () => {
  const deathOf = (events: SimEvent[]) => events.find((e) => e.type === 'death')

  test('burns lavaDps / 4 every 0.25 s with half DP gain and no knockback', () => {
    const s = newMatch()
    toCombat(s)
    const p1 = pawn(s, 1)
    place(p1, 3000, 0)
    const events = run(s, 60)
    const burns = events.filter((e) => e.type === 'damage' && e.target === p1.id)
    expect(burns).toHaveLength(4)
    for (const b of burns) if (b.type === 'damage') expect(b).toMatchObject({ amount: 25, source: null, kb: 0 })
    expect(p1.kbPoints).toBeCloseTo(50 - 0.04, 6) // 4 x 25 x 0.5 minus 1 s of DP decay
    expect(p1.vx).toBe(0)
    expect(p1.lavaTicks).toBe(60)
  })

  test('a lava death credits the last pawn that hit you', () => {
    const s = newMatch({ killGold: 3 })
    toCombat(s)
    const p0 = pawn(s, 0)
    const p1 = pawn(s, 1)
    place(p0, 0, 0)
    place(p1, 2600, 0)
    receiveDamage(s, p1, { cause: 'test', amount: 10, source: 0, normal: { x: 1, y: 0 } })
    const gold = s.scores[0].gold
    const events = runUntil(s, () => !p1.alive)
    expect(deathOf(events)).toMatchObject({ type: 'death', owner: 1, killer: 0 })
    expect(s.scores[0].kills).toBe(1)
    expect(s.scores[1].deaths).toBe(1)
    expect(s.scores[0].gold).toBe(gold + 3)
  })

  test('a lava death nobody caused gives no kill credit', () => {
    const s = newMatch()
    toCombat(s)
    const p1 = pawn(s, 1)
    place(p1, 2600, 0)
    const events = runUntil(s, () => !p1.alive)
    expect(deathOf(events)).toMatchObject({ type: 'death', owner: 1, killer: null })
    expect(s.scores[0].kills).toBe(0)
  })

  test('lava does not burn in the shop phase', () => {
    const s = newMatch()
    const p1 = pawn(s, 1)
    place(p1, 3000, 0)
    run(s, 120, () => [cmd(1, { kind: 'stop' })])
    expect(p1.hp).toBe(1000)
  })
})
