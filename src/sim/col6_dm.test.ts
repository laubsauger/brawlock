import { describe, expect, test } from 'vitest'
import { frictionPerTick, ticks } from './config'
import { receiveDamage } from './combat'
import { step } from './index'
import { spawnProjectile } from './projectiles'
import { castNow, cmd, fight, grant, newMatch, of, pawn, place, run, runUntil } from './testkit'
import { DT, type SimState } from './types'

const F = frictionPerTick(0.96)
const fireball = (s: SimState, owner: number, x: number, y: number, vx: number, vy: number, lifetime = 2) =>
  spawnProjectile(s, owner, 'fireball', x, y, vx, vy, 25, { lifetime, data: { damage: 70, kb: 1 } })
const gravityOrb = (s: SimState, owner: number, x: number, y: number) =>
  spawnProjectile(s, owner, 'gravity', x, y, 0, 0, 25, {
    lifetime: 2,
    data: { strength: 500, dps: 20, pawnRadius: 550, projRadius: 600, projPull: 1650, dpsRadius: 250, dpsPeriod: ticks(0.2), dpsTimer: ticks(0.2) },
  })

// ---------------------------------------------------------------------------
describe('Gravity (spells.md §8.23)', () => {
  test('pulls enemy warlocks within 550 with strength (1 - d^2/550^2), never the caster', () => {
    const s = fight()
    const p0 = pawn(s, 0)
    const p1 = pawn(s, 1)
    place(p0, -200, 0)
    place(p1, 300, 0)
    gravityOrb(s, 0, 0, 0)
    step(s, [])
    expect(p1.vx).toBeCloseTo(-500 * (1 - 300 ** 2 / 550 ** 2) * DT, 9)
    expect(p0.vx).toBe(0)
  })

  test('pulls every projectile within 600, the caster’s own included', () => {
    const s = fight()
    place(pawn(s, 0), -2000, 0)
    place(pawn(s, 1), 2000, 0)
    gravityOrb(s, 0, 0, 0)
    const own = fireball(s, 0, 0, 300, 1000, 0)
    step(s, [])
    expect(own.vy).toBeCloseTo(-1650 * (1.5 - 300 ** 2 / 600 ** 2) * DT, 9)
  })

  test('burns enemies within 250 for damage x 0.2 every 0.2 s, without knockback', () => {
    const s = fight()
    place(pawn(s, 0), -2000, 0)
    const p1 = pawn(s, 1)
    place(p1, 0, 200)
    gravityOrb(s, 0, 0, 0)
    const events = run(s, ticks(0.5))
    const dps = of(events, 'damage').filter((e) => e.source === 0)
    expect(dps.map((d) => d.amount)).toEqual([4, 4])
    expect(dps.every((d) => d.kb === 0)).toBe(true)
  })

  test('a Shield neither reflects nor steals it', () => {
    const s = fight()
    place(pawn(s, 0), 0, 0)
    place(pawn(s, 1), 0, 900)
    castNow(s, 0, grant(s, 0, 'shield'), 0, 0)
    const orb = spawnProjectile(s, 1, 'gravity', 300, 0, -450, 0, 25, { lifetime: 2, data: { strength: 500, dps: 20, pawnRadius: 550, projRadius: 600, projPull: 1650, dpsRadius: 250, dpsPeriod: ticks(0.2), dpsTimer: ticks(0.2) } })
    const events = run(s, ticks(1 / 6))
    expect(of(events, 'shieldReflect')).toHaveLength(0)
    expect(orb.owner).toBe(1)
  })
})

describe('Grip (spells.md §8.24)', () => {
  test('roots (no walking), cancels the target’s cast, 33% knockback, +5 DP per cast', () => {
    const s = fight()
    place(pawn(s, 0), 0, 0, 0)
    const p1 = pawn(s, 1)
    place(p1, 300, 0)
    step(s, [cmd(1, { kind: 'cast', slot: 7, x: 0, y: 0 })]) // p1 winds up Scourge
    const events = [...castNow(s, 0, grant(s, 0, 'grip'), 300, 0), ...run(s, ticks(0.4))] // 1000 u/s
    expect(of(events, 'castCancel').find((e) => e.pawn === p1.id)).toBeDefined()
    expect(p1.modifiers.some((m) => m.id === 'grip')).toBe(true)
    expect(p1.kbFactor).toBeCloseTo(0.33, 12)
    step(s, [cmd(1, { kind: 'move', x: 1000, y: 0 })])
    run(s, 5)
    expect(p1.walkVx).toBe(0)
    const dp = p1.kbPoints
    castNow(s, 1, 6, 0, 0)
    expect(p1.kbPoints).toBeCloseTo(dp + 5 - 0.04 * DT * 1, 1)
  })

  test('lasts duration x target debuff factor x caster duration mastery', () => {
    const s = fight()
    place(pawn(s, 0), 0, 0, 0)
    const p1 = pawn(s, 1)
    place(p1, 300, 0)
    grant(s, 1, 'cursed_ring', 1) // x1.25
    s.scores[0].masteries.duration = 1 // x1.10
    castNow(s, 0, grant(s, 0, 'grip'), 300, 0)
    run(s, ticks(1 / 3))
    const grip = p1.modifiers.find((m) => m.id === 'grip')!
    expect(grip.ticksLeft).toBeGreaterThan(ticks(4.5 * 1.25 * 1.1) - ticks(0.4))
    expect(grip.ticksLeft).toBeLessThanOrEqual(ticks(4.5 * 1.25 * 1.1))
  })
})

describe('Warpzone (spells.md §8.25)', () => {
  test('slows enemy projectiles inside to 0.40: same range, 2.5x the time; own projectiles unaffected', () => {
    const s = fight()
    place(pawn(s, 0), 0, -1500)
    place(pawn(s, 1), 0, 1500)
    spawnProjectile(s, 0, 'warpzone', 0, 0, 0, 0, 2000, { lifetime: 10, rangeMastery: false, data: { static: 1, scale: 0.4, check: ticks(0.1) } })
    const enemy = fireball(s, 1, 0, 0, 1000, 0, 1)
    const own = fireball(s, 0, 0, 100, 1000, 0, 1)
    run(s, ticks(1))
    expect(own.x).toBeCloseTo(1000, 6)
    expect(enemy.data.timeScale).toBe(0.4)
    let lived = ticks(1)
    while (s.projectiles.includes(enemy)) {
      step(s, [])
      lived++
    }
    expect(lived).toBeGreaterThanOrEqual(ticks(2.5) - 1)
    expect(lived).toBeLessThanOrEqual(ticks(2.5) + 1)
  })

  test('a projectile that leaves the zone is restored within 0.1 s', () => {
    const s = fight()
    place(pawn(s, 0), 0, -1500)
    place(pawn(s, 1), 0, 1500)
    spawnProjectile(s, 0, 'warpzone', 0, 0, 0, 0, 200, { lifetime: 10, rangeMastery: false, data: { static: 1, scale: 0.4, check: ticks(0.1) } })
    const fb = fireball(s, 1, 150, 0, 1000, 0, 3)
    run(s, 2)
    expect(fb.data.timeScale).toBe(0.4)
    run(s, ticks(2 / 3))
    expect(fb.data.timeScale).toBeUndefined()
  })
})

describe('Magnetize (spells.md §8.26)', () => {
  test('an enemy is magnetized (attract); your projectiles then curve into them', () => {
    const s = fight()
    place(pawn(s, 0), 0, 0, 0)
    const p1 = pawn(s, 1)
    place(p1, 300, 0)
    castNow(s, 0, grant(s, 0, 'magnetize'), 300, 0)
    run(s, ticks(0.5)) // 800 u/s
    expect(p1.modifiers.find((m) => m.id === 'magnetize')?.data.sign).toBe(1)
    place(p1, 500, 150) // 250 from the bolt: inside the 300 field
    const fb = fireball(s, 0, 300, 0, 1000, 0)
    run(s, 3)
    expect(fb.vy).toBeGreaterThan(20) // bends toward the magnetized enemy
  })

  test('magnetizing an ally repels enemy projectiles from them', () => {
    const s = fight(3, [1, 1, 2])
    place(pawn(s, 0), 0, 0, 0)
    const ally = pawn(s, 1)
    place(ally, 300, 0)
    place(pawn(s, 2), 0, 1500)
    castNow(s, 0, grant(s, 0, 'magnetize'), 300, 0)
    run(s, ticks(0.5))
    expect(ally.modifiers.find((m) => m.id === 'magnetize')?.data.sign).toBe(-1)
    place(ally, 500, 200)
    const fb = fireball(s, 2, 300, 100, 1000, 0)
    run(s, 3)
    expect(fb.vy).toBeLessThan(-20)
  })
})

describe('Rockpillar (spells.md §8.27)', () => {
  test('raises a neutral r90 / 400 HP pillar clamped to range, gone after 4 s', () => {
    const s = fight()
    place(pawn(s, 0), 0, 0, 0)
    place(pawn(s, 1), 0, 1500)
    castNow(s, 0, grant(s, 0, 'rockpillar'), 2000, 0)
    const pillar = s.obstacles.find((o) => o.variant === -1)!
    expect(pillar).toMatchObject({ x: 650, y: 0, radius: 90, hp: 400, owner: 0 })
    // the caster's own fireball is blocked (pillars are enemies to everyone)
    castNow(s, 0, 6, 1000, 0)
    run(s, ticks(2 / 3))
    expect(pillar.hp).toBe(330)
    run(s, ticks(4))
    expect(s.obstacles.some((o) => o.variant === -1)).toBe(false)
  })
})

describe('Link (spells.md §8.28)', () => {
  test('latches an enemy, pulls them in at 1550 u/s^2 with DPS, and breaks within 100', () => {
    const s = fight()
    const p0 = pawn(s, 0)
    const p1 = pawn(s, 1)
    place(p0, 0, 0, 0)
    place(p1, 600, 0)
    const events = [...castNow(s, 0, grant(s, 0, 'link'), 600, 0), ...run(s, ticks(0.75))] // 950 u/s
    const link = p0.modifiers.find((m) => m.id === 'link')!
    expect(link.data.target).toBe(p1.id)
    expect(p1.vx).toBeLessThan(-100)
    const dps = of(events, 'damage').filter((e) => e.source === 0 && e.kb === 0)
    expect(dps[0]?.amount).toBeCloseTo(2.4, 9)
    run(s, ticks(2))
    expect(p0.modifiers.some((m) => m.id === 'link')).toBe(false) // pulled within 100 -> broke
  })

  test('breaks when the caster teleports with the cursor on lava, and when the target shields', () => {
    const s = fight()
    const p0 = pawn(s, 0)
    const p1 = pawn(s, 1)
    place(p0, 0, 0, 0)
    place(p1, 600, 0)
    castNow(s, 0, grant(s, 0, 'link'), 600, 0)
    run(s, ticks(0.6))
    expect(p0.modifiers.some((m) => m.id === 'link')).toBe(true)
    castNow(s, 0, grant(s, 0, 'teleport'), -5000, 0) // cursor on lava
    expect(p0.modifiers.some((m) => m.id === 'link')).toBe(false)

    const t = fight()
    place(pawn(t, 0), 0, 0, 0)
    place(pawn(t, 1), 600, 0)
    castNow(t, 0, grant(t, 0, 'link'), 600, 0)
    run(t, ticks(0.6))
    castNow(t, 1, grant(t, 1, 'shield'), 0, 0)
    run(t, 1)
    expect(pawn(t, 0).modifiers.some((m) => m.id === 'link')).toBe(false)
  })

  test('latched to a pillar it pulls the caster instead, without damage', () => {
    const s = fight()
    const p0 = pawn(s, 0)
    place(p0, 0, 0, 0)
    place(pawn(s, 1), 0, 1500)
    s.obstacles.push({ id: s.nextEntityId++, x: 500, y: 0, radius: 60, hp: 400, variant: 0 })
    castNow(s, 0, grant(s, 0, 'link'), 500, 0)
    run(s, ticks(0.5))
    expect(p0.modifiers.find((m) => m.id === 'link')?.data.obstacle).toBe(1)
    expect(p0.vx).toBeGreaterThan(100)
  })
})

// ---------------------------------------------------------------------------
describe('projectile vs projectile outcomes (spells.md §7.1)', () => {
  function clash(a: [string, Record<string, number>, number], b: [string, Record<string, number>, number]): string[] {
    const s = fight()
    place(pawn(s, 0), -2000, 0)
    place(pawn(s, 1), 2000, 0)
    spawnProjectile(s, 0, a[0], 0, 0, 0, 0, a[2], { lifetime: 2, data: a[1] })
    spawnProjectile(s, 1, b[0], 20, 0, 0, 0, b[2], { lifetime: 2, data: b[1] })
    run(s, 1)
    return s.projectiles.map((p) => p.spell).sort()
  }
  const FB: [string, Record<string, number>, number] = ['fireball', { damage: 70, kb: 1 }, 25]
  const GRIP: [string, Record<string, number>, number] = ['grip', { duration: 4.5 }, 39]
  const DRAIN: [string, Record<string, number>, number] = ['drain', { damage: 60, turned: 1 }, 24.5]
  const LINK: [string, Record<string, number>, number] = ['link', { speed: 950, t: 0, retractAt: 9, retracting: 0, returnDist: 75 }, 35]
  const SWAP: [string, Record<string, number>, number] = ['swap', { combat: 1 }, 40]

  test('Fireball vs Grip: both die', () => expect(clash(FB, GRIP)).toEqual([]))
  test('Grip vs Drain: Grip dies, Drain survives', () => expect(clash(GRIP, DRAIN)).toEqual(['drain']))
  test('Drain vs Drain: they pass through each other', () => expect(clash(DRAIN, DRAIN)).toEqual(['drain', 'drain']))
  test('Link and Swap never touch projectiles', () => {
    expect(clash(LINK, FB)).toEqual(['fireball', 'link'])
    expect(clash(SWAP, FB)).toEqual(['fireball', 'swap'])
  })
})

// ---------------------------------------------------------------------------
describe('Deathmatch (systems.md §7.3)', () => {
  test('60 s rounds, +1 per kill to the killer’s team, respawn after 10 s, no shrink', () => {
    const s = newMatch({ gameMode: 'deathmatch', shopSeconds: 1, winScore: 2 })
    runUntil(s, (st) => st.phase === 'fight')
    expect(s.round).toBe(1)
    expect(s.phaseTicksLeft).toBe(ticks(60))
    const p1 = pawn(s, 1)
    run(s, ticks(2)) // spawn invulnerability
    p1.hp = 10
    receiveDamage(s, p1, { cause: 'test', amount: 20, source: 0 })
    expect(p1.alive).toBe(false)
    expect(s.scores.map((x) => x.score)).toEqual([1, 0])
    expect(s.phase).toBe('fight') // a kill does not end the round
    const respawn = runUntil(s, () => p1.alive, ticks(11))
    expect(of(respawn, 'respawn')[0]).toMatchObject({ owner: 1 })
    expect(respawn.length).toBeGreaterThan(0)
    expect(p1.invulnerable).toBe(true)
    expect(of(run(s, ticks(60)), 'arenaShrink')).toHaveLength(0)
  })

  test('a death nobody caused scores for nobody (v1 fix); win is checked at round end', () => {
    const s = newMatch({ gameMode: 'deathmatch', shopSeconds: 1, winScore: 1 })
    runUntil(s, (st) => st.phase === 'fight')
    run(s, ticks(2))
    const p1 = pawn(s, 1)
    place(p1, 3000, 0)
    runUntil(s, () => !p1.alive)
    expect(s.scores.map((x) => x.score)).toEqual([0, 0])
    receiveDamage(s, pawn(s, 0), { cause: 'test', amount: 0.5, source: 1 })
    const p0 = pawn(s, 0)
    p0.hp = 1.5
    receiveDamage(s, p0, { cause: 'test', amount: 1, source: null })
    // p0 died to "lava" with p1 as last hitter: p1 scores
    expect(s.scores.map((x) => x.score)).toEqual([0, 1])
    expect(s.phase).toBe('fight')
    const gold = s.scores[0].gold
    const events = runUntil(s, (st) => st.phase === 'gameOver')
    expect(of(events, 'gameOver')[0].winners).toEqual([1])
    expect(s.scores[0].gold).toBe(gold + 10)
    void F
  })
})
