import { describe, expect, it } from 'vitest'
import { CAST_CATEGORY, windupHiddenFrom } from './castStyles'

/**
 * In the original game Scourge had no cast animation, so the only warning an
 * opponent got was the blast itself. The remake keeps that: only the local
 * caster sees the summon pose and charge glow. If this regresses, every
 * opponent and spectator can read and dodge a Scourge the original made
 * undodgeable by sight, while the caster loses feedback on their own cast.
 */
describe('caster-only windup (Scourge)', () => {
  it('shows the full Scourge windup to the local caster', () => {
    expect(windupHiddenFrom('scourge', 2, 2)).toBe(false)
    expect(windupHiddenFrom('scourge_3', 0, 0)).toBe(false)
  })

  it('hides a Scourge windup from opponents, including leveled ids', () => {
    expect(windupHiddenFrom('scourge', 1, 0)).toBe(true)
    expect(windupHiddenFrom('scourge_2', 3, 0)).toBe(true)
  })

  it('hides it from spectators (localPlayer -1), even for an unowned pawn', () => {
    expect(windupHiddenFrom('scourge', 0, -1)).toBe(true)
    expect(windupHiddenFrom('scourge', -1, -1)).toBe(true)
  })

  it('keeps every other spell windup visible to everyone (aoe siblings too)', () => {
    for (const spell of Object.keys(CAST_CATEGORY)) {
      if (spell === 'scourge') continue
      expect(windupHiddenFrom(spell, 1, 0), spell).toBe(false)
      expect(windupHiddenFrom(spell, 1, -1), spell).toBe(false)
    }
  })
})
