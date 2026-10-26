import { describe, expect, it, vi } from 'vitest'
import { HAND_MARKS } from './CastMarks'
import { castMarkOf, windupLayers, type WindupLayers } from './castWindupLogic'
import { KitA, palFor } from '../vfx/spells/kitA'
import { PawnView } from './Pawns'

const layers = (spell: string, module = false, motion = true, hide: string[] = []): WindupLayers =>
  windupLayers(spell, module, motion, hide, { rings: false, spiral: false, orb: false, ground: false, light: false })

// Windup is immediate-mode on the character. Nothing may continue flying after
// a cancel, or look like an already released projectile while a cast is pending.
describe('cancellable hand charge', () => {
  it('hand-marked spells charge only on their hand glyph: no arm rings, spiral or palm orb', () => {
    // the glyph is drawn after the final pose and camera update (drawCastMarks), so it cannot lag
    for (const spell of Object.keys(HAND_MARKS)) {
      expect(layers(spell)).toEqual({ rings: false, spiral: false, orb: false, ground: true, light: true })
    }
  })

  it('other spells draw the shared arm layers, unless their VFX module does; styles hide layers', () => {
    expect(layers('lightning')).toEqual({ rings: true, spiral: true, orb: true, ground: true, light: true })
    // the spiral is the moving part
    expect(layers('lightning', false, false)).toMatchObject({ rings: true, spiral: false, orb: true })
    expect(layers('lightning', true)).toEqual({ rings: false, spiral: false, orb: false, ground: true, light: true })
    expect(layers('lightning', false, true, ['orb', 'ground', 'light'])).toEqual({ rings: true, spiral: true, orb: false, ground: false, light: false })
  })

  it('shared spell charge uses only a compact glow at the current hand', () => {
    for (const spell of ['twin', 'cluster', 'boomerang', 'bouncer', 'homing', 'drain']) {
      const k = { glowAt: vi.fn(), particles: { spawn: vi.fn() }, cores: { add: vi.fn() }, trailPoint: vi.fn() }
      for (const progress of [0, 0.5, 1]) {
        KitA.prototype.windupAt.call(k as unknown as KitA, 50, -20, 120, progress, palFor(spell), 3, 1 / 60, 1)
        const glow = k.glowAt.mock.lastCall!
        expect(glow.slice(0, 3)).toEqual([50, -20, 120])
        expect(glow[3]).toBeLessThanOrEqual(44)
      }
      expect(k.particles.spawn).not.toHaveBeenCalled()
      expect(k.cores.add).not.toHaveBeenCalled()
      expect(k.trailPoint).not.toHaveBeenCalled()
    }
  })
})

describe('charge, cancel and release separation', () => {
  it('draws live authored marks, suppresses unstarted/dead charges and respects hidden Scourge cancellation', () => {
    const fading = (spell: string) => ({ castCancelFraction: .3, canceledCastSpell: spell })
    const idle = { castCancelFraction: -1, canceledCastSpell: '' }
    const pawn = (cast: { spell: string; started?: boolean } | null, alive = true) => ({ owner: 0, alive, cast })
    for (const viewer of [-1, 0, 1]) {
      // an enemy's cancelled Scourge stays as hidden as its windup; the caster sees the fade
      expect(castMarkOf(pawn(null), fading('scourge'), viewer)).toBe(viewer === 0 ? 'cancel' : null)
      expect(castMarkOf(pawn(null), fading('twin'), viewer)).toBe('cancel')
      expect(castMarkOf(pawn(null), idle, viewer)).toBeNull()
      expect(castMarkOf(pawn({ spell: 'twin', started: false }), idle, viewer)).toBeNull()
      expect(castMarkOf(pawn({ spell: 'twin', started: true }), fading('twin'), viewer)).toBe('charge')
      expect(castMarkOf(pawn({ spell: 'twin' }), idle, viewer)).toBe('charge')
      // only authored spells have a hand glyph
      expect(castMarkOf(pawn({ spell: 'lightning', started: true }), idle, viewer)).toBeNull()
      expect(castMarkOf(pawn({ spell: 'twin', started: true }, false), idle, viewer)).toBeNull()
      expect(castMarkOf(pawn(null, false), fading('twin'), viewer)).toBeNull()
    }
  })

  it('remembers the canceled spell for the short fade and clears it on a new charge or release', () => {
    const view = Object.create(PawnView.prototype) as PawnView
    const clock = { value: 1 }
    Object.assign(view, { ctx: { uTime: clock }, fizzleAt: -10, fizzleSpell: '', castSpell: '' })
    view.castStart('fireball', 12)
    view.castCancel(1)
    expect(view.canceledCastSpell).toBe('fireball')
    expect(view.castCancelFraction).toBe(0)
    // The old pose can end sooner than the extinguish phase.
    Object.assign(view, { castSpell: '' })
    clock.value = 1.1
    expect(view.canceledCastSpell).toBe('fireball')
    expect(view.castCancelFraction).toBeGreaterThan(.5)
    view.castStart('twin', 12)
    expect(view.castCancelFraction).toBe(-1)
    expect(view.canceledCastSpell).toBe('')
    view.castCancel(1.1)
    view.castRelease(1.11)
    expect(view.castCancelFraction).toBe(-1)
    expect(view.canceledCastSpell).toBe('')
  })
})
