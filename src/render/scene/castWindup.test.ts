import { describe, expect, it, vi } from 'vitest'
import { Color, Vector3 } from 'three/webgpu'
import { MatchWorld } from './MatchWorld'
import { KitA, palFor } from '../vfx/spells/kitA'
import { S } from '../coords'
import { PawnView } from './Pawns'

// Windup is immediate-mode on the character. Nothing may continue flying after
// a cancel, or look like an already released projectile while a cast is pending.
describe('cancellable hand charge', () => {
  it('keeps Fireball charge on the arm and palm at every progress and facing', () => {
    const draw = MatchWorld.prototype as unknown as { drawWindup(v: unknown, p: unknown): void }
    for (const fraction of [0, 0.5, 0.99]) {
      for (const shift of [0, 500]) {
        const hand = new Vector3((shift + 30) * S, 100 * S, 10 * S)
        const v = {
          castFraction: fraction, setCastRing: vi.fn(), x: shift, y: 0,
          castOrigin: (out: Vector3) => out.copy(hand),
          castArms: (arm: Record<string, Vector3>) => {
            arm.shoulder.set(shift * S, 80 * S, 0)
            arm.elbow.set((shift + 10) * S, 90 * S, 0)
            arm.palm.copy(hand)
            return 1
          },
        }
        const w = {
          modulesOn: false, windCol: new Color(), windHot: new Color(),
          reducedMotion: { matches: false }, ctx: { uFx: { value: 1 }, uTime: { value: 5 }, glow: { add: vi.fn() } },
          wO: new Vector3(), armA: { shoulder: new Vector3(), elbow: new Vector3(), palm: new Vector3() }, armB: {},
          castMarks: { charge: vi.fn() }, billboardsTop: { add: vi.fn() }, particles: { spawn: vi.fn(), budget: vi.fn() }, ringFades: new Map(),
        }
        draw.drawWindup.call(w, v, { cast: { spell: 'fireball' } })
        expect(w.particles.spawn).not.toHaveBeenCalled()
        expect(w.billboardsTop.add).not.toHaveBeenCalled()
        // Hand signatures are drawn after the final pose/camera update.
        expect(w.castMarks.charge).not.toHaveBeenCalled()
      }
    }
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

  it('cancel emits no outward sparks, expanding ring, smoke or release flash', () => {
    const prototype = MatchWorld.prototype as unknown as { fizzleFx(v: unknown): void }
    const v = { setCastRing: vi.fn() }
    const w = {
      windCol: new Color(), ringFades: new Map([[v, 1]]),
      particles: { spawn: vi.fn() }, smoke: { spawn: vi.fn() },
      handRings: [], flashes: [],
    }
    prototype.fizzleFx.call(w, v)
    expect(w.ringFades.has(v)).toBe(false)
    expect(w.particles.spawn).not.toHaveBeenCalled()
    expect(w.smoke.spawn).not.toHaveBeenCalled()
    expect(w.handRings).toHaveLength(0)
    expect(w.flashes).toHaveLength(0)
  })


describe('charge, cancel and release separation', () => {
  it('draws live authored marks, suppresses unstarted/dead charges and respects hidden Scourge cancellation', () => {
    const fn = MatchWorld.prototype as unknown as { drawCastMarks(state: unknown, camera: unknown): void }
    for (const viewer of [-1, 0, 1]) {
      const v = {
        castFraction: .5, castCancelFraction: .3, canceledCastSpell: 'scourge',
        castOrigin: (out: Vector3) => out.set(1, 2, 3),
      }
      const w = {
        views: new Map([[1, v]]), wO: new Vector3(),
        opts: { source: { buf: { localPlayer: viewer } } },
        castMarks: { begin: vi.fn(), charge: vi.fn(), cancel: vi.fn() },
      }
      fn.drawCastMarks.call(w, { pawns: [{ id: 1, owner: 0, alive: true, cast: null }] }, {})
      expect(w.castMarks.cancel).toHaveBeenCalledTimes(viewer === 0 ? 1 : 0)
      w.castMarks.cancel.mockClear()
      for (const cast of [{ spell: 'twin', started: false }, { spell: 'twin', started: true }]) {
        w.castMarks.charge.mockClear()
        fn.drawCastMarks.call(w, { pawns: [{ id: 1, owner: 0, alive: true, cast }] }, {})
        expect(w.castMarks.charge).toHaveBeenCalledTimes(cast.started ? 1 : 0)
        expect(w.castMarks.cancel).not.toHaveBeenCalled()
      }
      w.castMarks.charge.mockClear()
      fn.drawCastMarks.call(w, { pawns: [{ id: 1, owner: 0, alive: false, cast: { spell: 'twin', started: true } }] }, {})
      expect(w.castMarks.charge).not.toHaveBeenCalled()
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
