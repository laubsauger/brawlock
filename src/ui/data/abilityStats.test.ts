import { describe, expect, it } from 'vitest'
import { attr, cooldownSeconds, masteryFactor, spellDef } from '../../sim'
import { abilityDelta, abilityStats, maxLevelOf } from './abilityStats'
import type { AbilityStatContext } from './abilityStats'
import { buffDuration, debuffDuration, debuffFactor, rangeFactor } from '../../sim/stats'
import { fight, grant, place } from '../../sim/testkit'
import { fireSpell } from '../../sim/pawn'
import { addModifier, tickModifiers } from '../../sim/modifiers'
import { inspectedLoadout, rememberRevealedLoadouts, resetRevealedLoadouts } from '../../game/inspect'
import { levelStats } from './catalog'
import { secondsOf, ticks } from '../../sim/config'
import { snowballProjectile } from '../../sim/spells/snowball'

function ownerContext(s: ReturnType<typeof fight>, player = 0): AbilityStatContext {
  const pawn = s.pawns[player]
  return { masteries: s.scores[player].masteries, loadout: pawn, modifiers: pawn.modifiers,
    damageMultiplier: s.settings.dmgMultiplier, knockbackMultiplier: s.settings.kbMultiplier }
}
const seconds = (stats: ReturnType<typeof abilityStats>, label: string) => Number(val(stats, label)?.replace(/s$/, ''))

const val = (stats: { label: string; value: string }[], label: string) => stats.find((s) => s.label === label)?.value

describe('ability card numbers come from the sim table, so the card can never disagree with the spell', () => {
  it('shows damage and cooldown for the level asked', () => {
    const def = spellDef('boomerang')!
    const s = abilityStats('boomerang', 3)
    expect(val(s, 'Damage')).toBe(String(attr(def, 'damage', 3)))
    expect(val(s, 'Cooldown')).toBe(`${cooldownSeconds(def, 3)}s`)
  })

  it('scales projectile range with the Range mastery, as the cast does', () => {
    const def = spellDef('boomerang')!
    const base = attr(def, 'range', 1)
    expect(val(abilityStats('boomerang', 1, 0), 'Range')).toBe(String(base))
    expect(val(abilityStats('boomerang', 1, 2), 'Range')).toBe(String(Math.round(base * masteryFactor('range', 2))))
  })

  it('never scales Teleport range with the mastery (spells.md §8.9)', () => {
    expect(val(abilityStats('teleport', 2, 3), 'Range')).toBe(String(attr(spellDef('teleport')!, 'range', 2)))
  })

  it('shows the special values a spell has, like the HP Scourge costs you', () => {
    expect(val(abilityStats('scourge', 1), 'Costs you')).toBe(`${spellDef('scourge')!.consts.self_cost} HP`)
  })

  it('shows the damage falloff of an area spell instead of leaving damage out (Meteor)', () => {
    const def = spellDef('meteor')!
    expect(val(abilityStats('meteor', 2), 'Damage')).toBe(`${attr(def, 'damage_min', 2)}–${attr(def, 'damage_max', 2)}`)
  })

  it('treats level 0 (not owned) as what buying gives you', () => {
    expect(abilityStats('lightning', 0)).toEqual(abilityStats('lightning', 1))
  })

  it('gives passive items their stat lines', () => {
    expect(val(abilityStats('boots', 1), 'Move speed')).toMatch(/^\+\d+/)
  })
})

describe('shop delta: what the next level changes', () => {
  it('marks the values the next level raises, and leaves constants alone', () => {
    const d = abilityDelta('boomerang', 2, maxLevelOf('boomerang'))
    const dmg = d.find((s) => s.label === 'Damage')!
    expect(dmg.next).toBe(String(attr(spellDef('boomerang')!, 'damage', 3)))
    expect(d.find((s) => s.label === 'Knockback')?.next).toBeUndefined()
  })

  it('shows no next values at max level', () => {
    const max = maxLevelOf('boomerang')
    expect(abilityDelta('boomerang', max, max).every((s) => s.next === undefined)).toBe(true)
  })
})

describe('effective ability stats follow the actual cast and explicit owner context', () => {
  it('labels Snowball chill as DPS matching its expiry damage, independently of the final burst', () => {
    for (const level of [1, 3, 7]) {
      const s = fight(2, undefined, { dmgMultiplier: 1.5 })
      const caster = s.pawns[0]
      const target = s.pawns[1]
      place(caster, 0, 0)
      place(target, 90, 0)
      const slot = grant(s, 0, 'snowball', level)
      const stats = abilityStats('snowball', level, ownerContext(s))
      const dps = Number(val(stats, 'Damage / second'))
      expect(val(stats, 'Damage')).toBeUndefined()
      fireSpell(s, caster, slot, 1000, 0)
      const projectile = s.projectiles.at(-1)!
      snowballProjectile.onCollide!(s, projectile, {
        other: { kind: 'pawn', pawn: target, cc: 'body', mod: null }, otherId: target.id,
        nx: 1, ny: 0, x: 45, y: 0, distance: 90, overlapping: true,
        radius: projectile.radius, otherRadius: 30,
      })
      const chill = target.modifiers.find((m) => m.id === 'snowball')!
      expect(chill.ticksLeft).toBe(ticks(projectile.data.dotPeriod))
      s.events.length = 0
      for (let i = 0; i < ticks(projectile.data.dotPeriod) - 1; i++) tickModifiers(s)
      expect(s.events.some((e) => e.type === 'damage')).toBe(false)
      tickModifiers(s)
      const damage = s.events.find((e) => e.type === 'damage')!
      expect(damage).toMatchObject({ amount: dps * projectile.data.dotPeriod, kb: 0, cause: 'snowball' })
      // The expiry explosion is a separate area hit, not part of the DPS row.
      s.events.length = 0
      place(target, projectile.x, projectile.y)
      snowballProjectile.onDestroy!(s, projectile, true)
      const burst = s.events.find((e) => e.type === 'damage')!
      expect(burst.type === 'damage' && burst.amount).toBe(projectile.data.damageMax * s.settings.dmgMultiplier)
      expect(val(stats, 'Burst damage')).toBe(`0–${projectile.data.damageMax * s.settings.dmgMultiplier}`)
    }
  })

  it('scales self buffs with Duration mastery exactly once, including current-to-next levels', () => {
    for (const id of ['shield', 'rush', 'windwalk', 'alteration', 'pact']) {
      const s = fight()
      s.scores[0].masteries.duration = 3
      const level = Math.min(2, maxLevelOf(id))
      const slot = grant(s, 0, id, level)
      const stats = abilityStats(id, level, ownerContext(s))
      const duration = buffDuration(s, s.pawns[0], 0, attr(spellDef(id)!, 'duration', level))
      expect(seconds(stats, 'Duration')).toBeCloseTo(duration, 2)
      fireSpell(s, s.pawns[0], slot, 500, 0)
      expect(s.pawns[0].modifiers.find((m) => m.id === id)!.ticksLeft).toBe(ticks(duration))
    }
    const context = { masteries: { duration: 3 } }
    const delta = abilityDelta('rush', 2, 7, context).find((s) => s.label === 'Duration')!
    expect(delta.value).toBe('8.13s')
    expect(delta.next).toBe('8.75s')
  })

  it('keeps fixed placement/dash ranges fixed while matching real projectile travel caps', () => {
    const s = fight()
    s.scores[0].masteries.range = 4
    place(s.pawns[0], 0, 0)
    for (const id of ['teleport', 'meteor', 'warpzone', 'rockpillar', 'thrust']) {
      expect(val(abilityStats(id, 3, ownerContext(s)), 'Range')).toBe(String(attr(spellDef(id)!, 'range', 3)))
    }
    for (const id of ['fireball', 'splitter', 'swap', 'grip', 'magnetize', 'recharge', 'bouncer']) {
      const slot = grant(s, 0, id, 3)
      fireSpell(s, s.pawns[0], slot, 10000, 0)
      const projectile = s.projectiles.at(-1)!
      const actualTravel = Math.hypot(projectile.vx, projectile.vy) * secondsOf(projectile.ticksLeft)
      expect(val(abilityStats(id, 3, ownerContext(s)), 'Range'), id).toBe(String(Math.round(actualTravel)))
    }
    expect(val(abilityStats('boomerang', 3, ownerContext(s)), 'Range')).toBe(String(Math.round(attr(spellDef('boomerang')!, 'range', 3) * rangeFactor(s, 0))))
  })

  it('matches duration-scaled placed objects, without scaling Meteor real-time timers', () => {
    const s = fight()
    s.scores[0].masteries.duration = 3
    s.scores[0].masteries.range = 4
    for (const id of ['warpzone', 'rockpillar']) {
      const slot = grant(s, 0, id, 2)
      fireSpell(s, s.pawns[0], slot, 10000, 0)
      const created = id === 'warpzone' ? s.projectiles.at(-1)! : s.obstacles.at(-1)!
      expect(created.ticksLeft).toBeDefined()
      expect(seconds(abilityStats(id, 2, ownerContext(s)), 'Duration')).toBeCloseTo(secondsOf(created.ticksLeft!), 2)
    }
    expect(abilityStats('meteor', 2, ownerContext(s)).some((v) => v.label === 'Duration')).toBe(false)
  })

  it('uses combined item/modifier debuff changes for self penalties, without applying Duration mastery', () => {
    const s = fight()
    s.scores[0].masteries.duration = 6
    grant(s, 0, 'cursed_ring', 2)
    grant(s, 0, 'pocket_watch', 1)
    addModifier(s, s.pawns[0], 'fixture', ticks(1), 0, { debuff: 0.1 })
    const context = ownerContext(s)
    expect(seconds(abilityStats('pact', 1, context), 'Slow lasts')).toBeCloseTo(6 * debuffFactor(s.pawns[0]), 2)
    expect(seconds(abilityStats('redirector', 1, context), 'Penalty lasts')).toBeCloseTo(8 * debuffFactor(s.pawns[0]), 2)
    const delta = abilityDelta('pocket_watch', 1, 2, context).find((x) => x.label === 'Total debuff duration')!
    expect(delta.value).toBe('×1.05')
    expect(delta.next).toBe('×0.95')
  })

  it('shows target-dependent durations honestly, without applying the caster’s own resistance to enemies', () => {
    const s = fight()
    s.scores[0].masteries.duration = 3
    grant(s, 0, 'pocket_watch', 2)
    const stats = abilityStats('grip', 2, ownerContext(s))
    const duration = attr(spellDef('grip')!, 'duration', 2)
    expect(seconds(stats, 'Duration')).toBeCloseTo(debuffDuration(s, s.pawns[1], 0, duration), 2)
    expect(stats.find((v) => v.label === 'Duration')?.note).toContain('target')
    const magnet = abilityStats('magnetize', 2, ownerContext(s))
    expect(magnet.find((v) => v.label === 'Enemy duration')?.note).toContain('target')
    expect(magnet.find((v) => v.label === 'Ally duration')?.note).toContain('own Duration')
  })

  it('matches Pact then Recharge streak ordering and public match damage multipliers', () => {
    const s = fight(2, undefined, { dmgMultiplier: 1.5, kbMultiplier: 1.2 })
    place(s.pawns[0], 0, 0)
    place(s.pawns[1], 5000, 5000)
    const slot = grant(s, 0, 'recharge', 3)
    addModifier(s, s.pawns[0], 'pact', 300, 0, { mult: 1.5, slowTime: 6, slow: 66 })
    addModifier(s, s.pawns[0], 'rechargeStreak', -1, 0, { streak: 4 })
    const stats = abilityStats('recharge', 3, ownerContext(s))
    fireSpell(s, s.pawns[0], slot, 1000, 0)
    expect(Number(val(stats, 'Damage'))).toBe(s.projectiles.at(-1)!.data.damage * s.settings.dmgMultiplier)
    expect(val(stats, 'Knockback')).toBe('×1.2')
    expect(s.pawns[0].modifiers.some((m) => m.id === 'pact')).toBe(false)
  })

  it('scales Scourge level-one self cost with Pact but keeps its fixed higher-level HP cost', () => {
    const s = fight()
    place(s.pawns[1], 5000, 5000)
    const slot = grant(s, 0, 'scourge', 1)
    addModifier(s, s.pawns[0], 'pact', 300, 0, { mult: 1.5, slowTime: 6, slow: 66 })
    const stats = abilityStats('scourge', 1, ownerContext(s))
    expect(val(stats, 'Costs you')).toBe('150 HP')
    expect(val(abilityStats('scourge', 2, ownerContext(s)), 'Costs you')).toBe('100 HP')
    const hp = s.pawns[0].hp
    fireSpell(s, s.pawns[0], slot, 0, 0)
    expect(hp - s.pawns[0].hp).toBe(150)
  })

  it('keeps inspection tied to committed masteries, unaffected by private next-shop purchases or live modifiers', () => {
    resetRevealedLoadouts()
    const s = fight()
    s.round = 1
    grant(s, 1, 'shield', 3)
    s.scores[1].masteries.duration = 2
    rememberRevealedLoadouts(s)
    s.phase = 'shop'
    s.scores[1].masteries.duration = 6
    addModifier(s, s.pawns[1], 'pact', 300, 1, { mult: 1.5 })
    const kit = inspectedLoadout(s, 0, 1)!.kit!
    const frozen = abilityStats('shield', 3, { masteries: kit.masteries, loadout: kit })
    expect(seconds(frozen, 'Duration')).toBeCloseTo(1.2 * masteryFactor('duration', 2), 2)
    expect(frozen).not.toEqual(abilityStats('shield', 3, ownerContext(s, 1)))
    expect(levelStats('shield', 3, { masteries: kit.masteries, loadout: kit }).find(([k]) => k === 'Duration')?.[1]).toBe(val(frozen, 'Duration'))
    resetRevealedLoadouts()
  })
})
