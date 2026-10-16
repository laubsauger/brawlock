import { describe, expect, it } from 'vitest'
import { attr, cooldownSeconds, masteryFactor, spellDef } from '../../sim'
import { abilityDelta, abilityStats, maxLevelOf } from './abilityStats'

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
