import { describe, expect, it } from 'vitest'
import { damageArea, killPawn } from './combat'
import { ROUND_END_SECONDS, ticks } from './config'
import { cloneState, hashState, knockbackSpeed } from './index'
import { endRound, startRound } from './mode'
import { spawnProjectile } from './projectiles'
import { castNow, cmd, fight, grant, newMatch, of, pawn, place, run } from './testkit'
import { step } from './index'
import type { SimState } from './types'
import { ALL_OMENS, BOMB_FUSE, BOMB_RADIUS, CATACLYSM_OMENS, GALE_DRIFT, OMEN_IDS, PILLAR_WARN, SHUFFLE_WARN, WILD_FRICTION, drawOmen, frictionOf, kbMultiplierOf, type OmenId } from './wild'
import { SPIRIT_RISE, spiritBand } from './spirits'
import { MOD_SPAWN_INVULNERABLE, addModifier, removeModifiers } from './modifiers'
import { NEUTRAL_OWNER } from './teams'
import { MOD_ALTERATION } from './spells/alteration'
import { MOD_SHIELD } from './spells/shield'

/**
 * Wild (docs/moonshot/specs/wild.md): an omen over every round from the second, each one rule for
 * that round, plus spell reactions. Off, the classic game must be exactly the classic game.
 */
/** finish the current round and open the next one's shop */
function nextShop(s: SimState): void {
  if (s.phase === 'shop') startRound(s)
  for (const p of s.pawns) if (p.owner !== 0 && p.alive) killPawn(s, p, null, 'lava')
  run(s, ticks(ROUND_END_SECONDS))
}
/** a fight under a given omen */
function underOmen(omen: OmenId, n = 2): SimState {
  const s = fight(n, undefined, { wild: true })
  s.omens = [omen]
  return s
}
/** the same, with nobody's spawn shield up */
function exposed(omen: OmenId, n = 2): SimState {
  const s = underOmen(omen, n)
  for (const q of s.pawns) removeModifiers(s, q, MOD_SPAWN_INVULNERABLE)
  return s
}

describe('Wild omens', () => {
  it('off, nothing changes: no omen, and the random stream is untouched', () => {
    const a = newMatch({ shopSeconds: 1 }, 3, 7)
    const b = newMatch({ shopSeconds: 1, wild: false }, 3, 7)
    for (const s of [a, b]) for (let r = 0; r < 3; r++) nextShop(s)
    expect(a.omens).toBeUndefined()
    expect(hashState({ ...cloneState(a), events: [] })).toBe(hashState({ ...cloneState(b), events: [] }))
  })

  it('no omen in the first round; one in the second and third, two from the fourth, none of the last round\'s', () => {
    const s = newMatch({ shopSeconds: 1, wild: true, winScore: 99 }, 3, 3)
    expect(s.omens).toBeUndefined()
    const rounds: OmenId[][] = []
    for (let r = 0; r < 30; r++) {
      nextShop(s)
      rounds.push([...s.omens!])
    }
    // the shop of round r + 2 drew rounds[r]
    expect(rounds.map((o) => o.length)).toEqual(rounds.map((_, r) => (r + 2 >= 4 ? 2 : 1)))
    for (let i = 1; i < rounds.length; i++) expect(rounds[i].filter((o) => rounds[i - 1].includes(o))).toEqual([])
    expect(new Set(rounds.flat()).size).toBe(OMEN_IDS.length)
    // the lobby's deck limits the draw
    const two = newMatch({ shopSeconds: 1, wild: true, winScore: 99, wildOmens: 0b000011 }, 3, 3)
    for (let r = 0; r < 6; r++) {
      nextShop(two)
      for (const o of two.omens!) expect(['bloodMoon', 'slickStone']).toContain(o)
    }
    expect(newMatch({ wildOmens: ALL_OMENS + 1 }).settings.wildOmens).toBe(ALL_OMENS)
  })

  /** Why: a round that can win the match should feel like the finale (Cataclysm). */
  it('a round that can decide the match gets three omens at once', () => {
    const first = newMatch({ shopSeconds: 1, wild: true, winScore: 3 }, 3, 5)
    drawOmen(first, 2)
    expect(first.omens).toHaveLength(1)
    first.scores[1].score = 2
    drawOmen(first, 3)
    expect(first.omens).toHaveLength(CATACLYSM_OMENS)
    // five scheduled rounds: the last one always, an earlier one once a win there clinches it
    const sched = newMatch({ shopSeconds: 1, wild: true, winScore: 99, scheduledRounds: 5 }, 4, 5)
    drawOmen(sched, 4)
    expect(sched.omens).toHaveLength(2)
    drawOmen(sched, 5)
    expect(sched.omens).toHaveLength(CATACLYSM_OMENS)
    sched.scores[0].score = 3
    drawOmen(sched, 4)
    expect(sched.omens).toHaveLength(CATACLYSM_OMENS)
  })

  it('only in classic Rounds outside ranked', () => {
    for (const over of [{ gameMode: 'deathmatch' as const }, { rankedRounds: 5 as const }]) {
      const s = newMatch({ shopSeconds: 1, wild: true, winScore: 99, ...over }, 3, 3)
      for (let r = 0; r < 3; r++) {
        if (s.phase === 'shop') startRound(s)
        endRound(s)
      }
      expect(s.omens).toBeUndefined()
    }
  })

  it('Blood Moon pushes 1.5x, Slick Stone slides further, Overcharge halves cooldowns, Sudden Collapse rings every 4 s', () => {
    expect(kbMultiplierOf(underOmen('bloodMoon'))).toBe(1.5)
    expect(knockbackSpeed(100, 0, 1, 1, kbMultiplierOf(underOmen('bloodMoon')))).toBeCloseTo(1.5 * knockbackSpeed(100, 0, 1, 1, 1), 9)
    expect(frictionOf(underOmen('slickStone'))).toBe(WILD_FRICTION)
    const slide = (omen: OmenId | null) => {
      const s = fight(2, undefined, { wild: true })
      if (omen) s.omens = [omen]
      const p = pawn(s, 0)
      place(p, 0, 0)
      p.vx = 1200
      run(s, ticks(1))
      return p.x
    }
    expect(slide('slickStone')).toBeGreaterThan(slide(null) * 1.1)
    const s = underOmen('overcharge')
    const p = pawn(s, 0)
    p.cooldowns[0] = ticks(4)
    run(s, ticks(2))
    expect(p.cooldowns[0]).toBe(0)
    const c = newMatch({ shopSeconds: 1, wild: true }, 2)
    c.omens = ['suddenCollapse']
    startRound(c)
    expect(c.arena.nextShrinkTick - c.tick).toBe(ticks(4))
  })

  it('Meteor Shower drops neutral meteors near warlocks; Pillar Storm warns, then a pillar bursts out there', () => {
    const m = underOmen('meteorShower')
    for (const q of m.pawns) removeModifiers(m, q, MOD_SPAWN_INVULNERABLE)
    const events = run(m, ticks(10))
    const meteors = of(events, 'projectileSpawn').filter((e) => e.spell === 'meteor')
    expect(meteors.length).toBeGreaterThanOrEqual(2)
    expect(of(events, 'explosion').some((e) => e.spell === 'meteor')).toBe(true)

    // a meteor credits nobody (NEUTRAL_OWNER is -1, a spectator's id): its kill goes to the last
    // warlock who hit, as a pillar's blast does
    const k = underOmen('meteorShower', 3)
    for (const q of k.pawns) removeModifiers(k, q, MOD_SPAWN_INVULNERABLE)
    const victim = pawn(k, 1)
    victim.hp = 5
    victim.lastHitter = 2
    k.events = []
    damageArea(k, NEUTRAL_OWNER, victim.x, victim.y, 200, { amountMin: 50, amountMax: 50, cause: 'meteor' })
    expect(of(k.events, 'damage').map((e) => e.source)).toEqual([null])
    expect(of(k.events, 'death')).toMatchObject([{ owner: 1, killer: 2 }])

    const p = underOmen('pillarStorm')
    const before = p.obstacles.length
    const warned = run(p, ticks(5))
    const w = of(warned, 'omenWarning')[0]
    expect(w).toMatchObject({ omen: 'pillarStorm' })
    run(p, ticks(PILLAR_WARN) + 1)
    expect(p.obstacles.length).toBe(before + 1)
    expect(p.obstacles.at(-1)).toMatchObject({ x: w.x, y: w.y })
  })
})

describe('Wild reactions', () => {
  it('Shatter: Lightning breaks a Snowball into four shards for its caster; off, the beam just stops', () => {
    for (const wild of [true, false]) {
      const s = fight(2, undefined, { wild })
      const slot = grant(s, 0, 'lightning', 3)
      place(pawn(s, 0), 0, 0, 0)
      place(pawn(s, 1), 0, 900)
      spawnProjectile(s, 1, 'snowball', 250, 0, 0, 0, 80, { level: 2, lifetime: 5, data: { damage: 10, damageMin: 0, damageMax: 40, explosion: 200, kb: 0.8, drag: 425, slow: 100, dotPeriod: 0.5 } })
      const events = castNow(s, 0, slot, 600, 0)
      const shards = s.projectiles.filter((p) => p.spell === 'snowball' && p.data.shard)
      expect(shards.length, String(wild)).toBe(wild ? 4 : 0)
      expect(of(events, 'reaction').length).toBe(wild ? 1 : 0)
      if (wild) expect(shards.every((p) => p.owner === 0)).toBe(true)
    }
  })

  it('Nova: a Fireball pulled into a Gravity orb goes off as a ring blast, once', () => {
    const s = fight(3, undefined, { wild: true })
    for (const q of s.pawns) removeModifiers(s, q, MOD_SPAWN_INVULNERABLE)
    place(pawn(s, 0), -800, 0)
    place(pawn(s, 1), 120, 0)
    place(pawn(s, 2), 0, 800)
    const orb = spawnProjectile(s, 0, 'gravity', 0, 0, 0, 0, 25, { level: 3, lifetime: 3, data: { strength: 0, dps: 0, pawnRadius: 0, projRadius: 600, projPull: 1650, dpsRadius: 250, dpsPeriod: 6, dpsTimer: 6 } })
    // cast right beside the orb, inside its ring: no nova until it has left the ring
    const inside = spawnProjectile(s, 0, 'fireball', -60, 30, 0, 0, 30, { level: 3, lifetime: 3, data: { damage: 60 } })
    expect(of(run(s, 1), 'reaction')).toEqual([])
    inside.data.dead = 1
    // from outside the burning ring in (the ring is 250, a warlock 60 across: an easy target)
    spawnProjectile(s, 0, 'fireball', -330, 0, 900, 0, 30, { level: 3, lifetime: 3, data: { damage: 60 } })
    const events = run(s, 6)
    expect(of(events, 'reaction')).toMatchObject([{ reaction: 'nova', owner: 0 }])
    expect(orb.data.nova).toBe(1)
    expect(of(events, 'damage').some((e) => e.target === pawn(s, 1).id && e.kb > 0)).toBe(true)
  })

  /** Why: the reactions were too rare to see (playtest 2026-11-02); every warlock has Fireball, so bolts that meet must pay off. */
  it('Clash: two enemy bolts that meet blow up between them; off, they just cancel', () => {
    for (const wild of [true, false]) {
      const s = fight(3, undefined, { wild })
      for (const q of s.pawns) removeModifiers(s, q, MOD_SPAWN_INVULNERABLE)
      place(pawn(s, 0), -900, 0)
      place(pawn(s, 1), 900, 0)
      place(pawn(s, 2), 0, 110)
      spawnProjectile(s, 0, 'fireball', -120, 0, 1000, 0, 25, { level: 3, lifetime: 2, data: { damage: 80, kb: 1 } })
      spawnProjectile(s, 1, 'fireball', 120, 0, -1000, 0, 25, { level: 3, lifetime: 2, data: { damage: 80, kb: 1 } })
      const events = run(s, ticks(0.3))
      expect(of(events, 'reaction').map((e) => e.reaction), String(wild)).toEqual(wild ? ['clash'] : [])
      const bystander = of(events, 'damage').filter((e) => e.target === pawn(s, 2).id)
      expect(bystander.length > 0, String(wild)).toBe(wild)
      if (wild) expect(bystander[0]).toMatchObject({ cause: 'clash', source: null })
    }
  })

  it('Fork: Lightning stopped by an enemy Shield splits back into two beams from the shield holder', () => {
    const s = fight(3, undefined, { wild: true })
    const slot = grant(s, 0, 'lightning', 3)
    place(pawn(s, 0), 0, 0, 0)
    place(pawn(s, 1), 400, 0)
    place(pawn(s, 2), -300, 120)
    addModifier(s, pawn(s, 1), MOD_SHIELD, ticks(2), 1, { radius: 220 })
    const events = castNow(s, 0, slot, 600, 0)
    const beams = of(events, 'beam')
    expect(beams.length).toBe(3)
    expect(beams.slice(1).every((b) => b.owner === 1)).toBe(true)
    expect(of(events, 'reaction')).toMatchObject([{ reaction: 'fork', owner: 1 }])
    // Alteration blocks Lightning with the same collider, but only a Shield forks
    const a = fight(3, undefined, { wild: true })
    const aslot = grant(a, 0, 'lightning', 3)
    place(pawn(a, 0), 0, 0, 0)
    place(pawn(a, 1), 400, 0)
    addModifier(a, pawn(a, 1), MOD_ALTERATION, ticks(2), 1, { radius: 220 })
    const altered = castNow(a, 0, aslot, 600, 0)
    expect(of(altered, 'beam')).toMatchObject([{ blocked: true }])
    expect(of(altered, 'reaction')).toEqual([])
  })
})

describe('Wild party omens', () => {
  /** Why: the hot potato (playtest 2026-11-02): pass it with any hit or a touch, or be thrown by it. */
  it('Cursed Bomb: arms on a warlock, passes by a hit or a touch (not straight back), and throws its holder at zero', () => {
    const s = exposed('cursedBomb', 3)
    place(pawn(s, 0), 0, 0)
    place(pawn(s, 1), 600, 0)
    place(pawn(s, 2), -600, 0)
    const armed = of(run(s, ticks(3) + 1), 'bomb')
    expect(armed).toMatchObject([{ action: 'arm', fuse: ticks(BOMB_FUSE) }])
    const bomb = s.omenClock!.bomb!
    // a hit passes it on
    bomb.holder = 0
    bomb.lock = 0
    const full = bomb.fuse
    spawnProjectile(s, 0, 'fireball', 480, 0, 1000, 0, 25, { level: 1, lifetime: 1, data: { damage: 40, kb: 1 } })
    const passed = of(run(s, ticks(0.3)), 'bomb')
    expect(passed).toMatchObject([{ action: 'pass', from: 0, holder: 1 }])
    expect(bomb.holder).toBe(1)
    // the fuse runs on through a pass
    expect(bomb.fuse).toBeLessThan(full - ticks(0.25))
    // a touch passes it too, but not within the lock
    bomb.lock = 0
    place(pawn(s, 1), 0, 300)
    place(pawn(s, 0), 0, 300 + 64)
    run(s, 1)
    expect(bomb.holder).toBe(0)
    place(pawn(s, 0), 0, 300 + 64)
    place(pawn(s, 1), 0, 300)
    run(s, 2)
    expect(bomb.holder, 'locked right after a pass').toBe(0)
    // at zero: the holder is thrown, a warlock in the blast is pushed away from it
    place(pawn(s, 0), 0, 0)
    place(pawn(s, 1), 200, 0)
    place(pawn(s, 2), -900, 0)
    bomb.fuse = 1
    const blast = run(s, 1)
    expect(of(blast, 'bomb').map((e) => e.action)).toEqual(['blast'])
    const hits = of(blast, 'damage').filter((e) => e.cause === 'bomb')
    expect(hits.map((e) => e.target).sort()).toEqual([pawn(s, 0).id, pawn(s, 1).id].sort())
    expect(hits.find((e) => e.target === pawn(s, 0).id)!.kb).toBeGreaterThan(1500)
    expect(pawn(s, 1).vx).toBeGreaterThan(0)
    expect(200).toBeLessThan(BOMB_RADIUS)
    // the next one arms after the gap, on a shorter fuse
    const next = of(run(s, ticks(3)), 'bomb').filter((e) => e.action === 'arm')
    expect(next).toHaveLength(1)
    expect(next[0].fuse).toBe(ticks(BOMB_FUSE - 1))
  })

  it('Gale: a warlock left alone drifts downwind; a Fireball curves with the wind', () => {
    const s = underOmen('gale')
    place(pawn(s, 0), 0, 0)
    place(pawn(s, 1), 0, 900)
    run(s, ticks(4))
    const g = s.omenClock!.gale!
    const p = pawn(s, 0)
    const speed = Math.hypot(p.vx, p.vy)
    expect(speed).toBeGreaterThan(GALE_DRIFT * 0.5)
    expect(speed).toBeLessThan(GALE_DRIFT * 1.5)
    // along the wind
    expect((p.vx * Math.cos(g.angle) + p.vy * Math.sin(g.angle)) / speed).toBeGreaterThan(0.9)
    // a bolt across the wind ends up well off its straight line
    const fb = spawnProjectile(s, 0, 'fireball', 0, -500, -Math.sin(g.angle) * 1000, Math.cos(g.angle) * 1000, 25, { level: 1, lifetime: 2, data: { damage: 1, kb: 1 } })
    const x0 = fb.x
    const y0 = fb.y
    run(s, ticks(0.8))
    const side = (fb.x - x0) * Math.cos(g.angle) + (fb.y - y0) * Math.sin(g.angle)
    expect(side).toBeGreaterThan(60)
  })

  it('Shuffle: after a warning, the warlocks trade places in pairs, a slide staying with its spot', () => {
    const s = underOmen('shuffle')
    place(pawn(s, 0), -500, 0)
    place(pawn(s, 1), 500, 0)
    const events = run(s, ticks(5) - 1)
    const warn = of(events, 'omenWarning')
    expect(warn).toMatchObject([{ omen: 'shuffle', ticks: ticks(SHUFFLE_WARN) }])
    // 1 is flying out over the east edge, pushed by 0
    const flying = pawn(s, 1)
    flying.vx = 1400
    flying.lastHitter = 0
    const x1 = flying.x
    const swap = run(s, 1)
    expect(of(swap, 'swap')).toHaveLength(1)
    expect(pawn(s, 0).x).toBeGreaterThan(x1)
    expect(pawn(s, 0).vx).toBeGreaterThan(1000)
    expect(pawn(s, 0).lastHitter).toBe(0)
    expect(pawn(s, 1).x).toBeCloseTo(-500, -1)
    expect(Math.abs(pawn(s, 1).vx)).toBeLessThan(50)
  })

  /** Why: in a full lobby most of a round is spent knocked out; a spirit keeps the fallen playing. */
  it('Vengeful Spirits: the fallen rise over the lava, drift only there, and their bolts hit the living for them', () => {
    const s = exposed('spirits', 3)
    place(pawn(s, 0), 900, 0)
    place(pawn(s, 2), 0, 700)
    const ghost = pawn(s, 1)
    place(ghost, 3000, 0)
    ghost.hp = 1
    run(s, 1)
    expect(ghost.alive).toBe(false)
    expect(ghost.spirit?.rise).toBeGreaterThan(0)
    const rose = run(s, ticks(SPIRIT_RISE))
    expect(of(rose, 'spirit')).toMatchObject([{ owner: 1 }])
    const [inner, outer] = spiritBand(s)
    const r = () => Math.hypot(ghost.spirit!.x, ghost.spirit!.y)
    expect(r()).toBeGreaterThanOrEqual(inner - 1e-6)
    expect(r()).toBeLessThanOrEqual(outer + 1e-6)
    // a move onto the floor stops at the band's inner edge
    step(s, [cmd(1, { kind: 'move', x: 0, y: 0 })])
    run(s, ticks(4))
    expect(r()).toBeCloseTo(inner, 0)
    // any spell key: a bolt at the living, credited to the spirit
    const target = pawn(s, 0)
    step(s, [cmd(1, { kind: 'cast', slot: 3, x: target.x, y: target.y })])
    expect(s.projectiles.filter((q) => q.kind === 'spiritBolt')).toHaveLength(1)
    step(s, [cmd(1, { kind: 'cast', slot: 0, x: target.x, y: target.y })])
    expect(s.projectiles.filter((q) => q.kind === 'spiritBolt'), 'one bolt per cooldown').toHaveLength(1)
    const hit = of(run(s, ticks(2)), 'damage').filter((e) => e.target === target.id)
    expect(hit[0]).toMatchObject({ cause: 'spirit', source: 1 })
    // gone at the next shop
    for (const q of s.pawns) if (q.owner !== 0 && q.alive) killPawn(s, q, null, 'lava')
    run(s, ticks(ROUND_END_SECONDS) + 1)
    expect(s.phase).toBe('shop')
    expect(s.pawns.some((q) => q.spirit)).toBe(false)
  })
})

