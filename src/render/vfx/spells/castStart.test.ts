import { describe, expect, it, vi } from 'vitest'
import { Vector3 } from 'three/webgpu'
import { spellVfxModules, type VfxCtx } from '../registry'
import './gravity'
import './grip'
import './meteor'
import './snowball'

describe('Cancellable spell charge starts', () => {
  it.each(['gravity', 'grip', 'meteor', 'snowball'])('%s leaves charge drawing to its attached per-frame marks', (spell) => {
    const origin = new Vector3(0, 1.3, 0)
    const ctx = {
      now: 1, tier: { particles: 1 }, pawn: () => ({ castOrigin: origin, tip: origin }),
      particles: { budget: vi.fn((n: number) => n), spawn: vi.fn() },
      smoke: { budget: vi.fn((n: number) => n), spawn: vi.fn() },
      ground: { spawn: vi.fn() },
    } as unknown as VfxCtx
    const mod = spellVfxModules().find((m) => m.spell === spell)!
    mod.onEvent!({ type: 'castStart', pawn: 1, spell, ticks: 12, level: 1 }, ctx)
    expect(ctx.particles.spawn).not.toHaveBeenCalled()
    expect(ctx.smoke.spawn).not.toHaveBeenCalled()
    expect(ctx.ground.spawn).not.toHaveBeenCalled()
  })
})
