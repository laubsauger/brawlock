import { describe, expect, it } from 'vitest'
import { damageArea, killPawn } from './combat'
import { ROUND_END_SECONDS, ticks } from './config'
import { cloneState, hashState, knockbackSpeed } from './index'
import { endRound, startRound } from './mode'
import { spawnProjectile } from './projectiles'
import { castNow, fight, grant, newMatch, of, pawn, place, run } from './testkit'
import type { SimState } from './types'
import { ALL_OMENS, OMEN_IDS, PILLAR_WARN, WILD_FRICTION, frictionOf, kbMultiplierOf, type OmenId } from './wild'
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
  s.omen = omen
  return s
}

describe('Wild omens', () => {
  it('off, nothing changes: no omen, and the random stream is untouched', () => {
    const a = newMatch({ shopSeconds: 1 }, 3, 7)
    const b = newMatch({ shopSeconds: 1, wild: false }, 3, 7)
    for (const s of [a, b]) for (let r = 0; r < 3; r++) nextShop(s)
    expect(a.omen).toBeUndefined()
    expect(hashState({ ...cloneState(a), events: [] })).toBe(hashState({ ...cloneState(b), events: [] }))
  })

  it('no omen in the first round; then one per round from the deck, never the same twice running', () => {
    const s = newMatch({ shopSeconds: 1, wild: true, winScore: 99 }, 3, 3)
    expect(s.omen).toBeUndefined()
    const seen: OmenId[] = []
    for (let r = 0; r < 30; r++) {
      nextShop(s)
      expect(s.omen).toBeDefined()
      seen.push(s.omen!)
    }
    for (let i = 1; i < seen.length; i++) expect(seen[i]).not.toBe(seen[i - 1])
    expect(new Set(seen).size).toBe(OMEN_IDS.length)
    // the lobby's deck limits the draw
    const two = newMatch({ shopSeconds: 1, wild: true, winScore: 99, wildOmens: 0b000011 }, 3, 3)
    for (let r = 0; r < 6; r++) {
      nextShop(two)
      expect(['bloodMoon', 'slickStone']).toContain(two.omen)
    }
    expect(newMatch({ wildOmens: 999 }).settings.wildOmens).toBe(ALL_OMENS)
  })

  it('only in classic Rounds outside ranked', () => {
    for (const over of [{ gameMode: 'deathmatch' as const }, { rankedRounds: 5 as const }]) {
      const s = newMatch({ shopSeconds: 1, wild: true, winScore: 99, ...over }, 3, 3)
      for (let r = 0; r < 3; r++) {
        if (s.phase === 'shop') startRound(s)
        endRound(s)
      }
      expect(s.omen).toBeUndefined()
    }
  })

  it('Blood Moon pushes 1.5x, Slick Stone slides further, Overcharge halves cooldowns, Sudden Collapse rings every 4 s', () => {
    expect(kbMultiplierOf(underOmen('bloodMoon'))).toBe(1.5)
    expect(knockbackSpeed(100, 0, 1, 1, kbMultiplierOf(underOmen('bloodMoon')))).toBeCloseTo(1.5 * knockbackSpeed(100, 0, 1, 1, 1), 9)
    expect(frictionOf(underOmen('slickStone'))).toBe(WILD_FRICTION)
    const slide = (omen: OmenId | null) => {
      const s = fight(2, undefined, { wild: true })
      if (omen) s.omen = omen
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
    c.omen = 'suddenCollapse'
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
    const orb = spawnProjectile(s, 0, 'gravity', 0, 0, 0, 0, 25, { level: 3, lifetime: 3, data: { strength: 0, dps: 0, pawnRadius: 0, projRadius: 600, projPull: 1650, dpsRadius: 0, dpsPeriod: 6, dpsTimer: 6 } })
    spawnProjectile(s, 0, 'fireball', 40, 0, 0, 0, 30, { level: 3, lifetime: 3, data: { damage: 60 } })
    const events = run(s, 2)
    expect(of(events, 'reaction')).toMatchObject([{ reaction: 'nova', owner: 0 }])
    expect(orb.data.nova).toBe(1)
    expect(of(events, 'damage').some((e) => e.target === pawn(s, 1).id && e.kb > 0)).toBe(true)
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
