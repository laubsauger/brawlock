import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PerspectiveCamera } from 'three/webgpu'
import { spellVfxModules, type VfxCtx } from '../registry'
import { glowG } from './kitB'
import './shield'

vi.mock('./kitB', async (original) => ({
  ...await original<typeof import('./kitB')>(),
  kitBegin: vi.fn(), flashT: vi.fn(), glowG: vi.fn(),
}))

const shield = spellVfxModules().find((m) => m.spell === 'shield')!
const motion = { matches: false }
const reflected = { type: 'shieldReflect' as const, pawn: 1, projectile: 9, x: 220, y: 0, stolen: true, reflected: true }

function context(): VfxCtx {
  const camera = new PerspectiveCamera(50, 1, 0.1, 100)
  camera.position.set(0, 5, 8)
  camera.lookAt(0, 0, 0)
  camera.updateMatrixWorld()
  return {
    now: 1, fx: 1, state: null, camera, tier: { bloom: false },
    pawn: () => ({ x: 0, y: 0, h: 0, owner: 0 }), colorOf: () => 0x2fd6c8,
    floorAt: () => 0,
    particles: { budget: (n: number) => n, spawn: vi.fn() },
  } as unknown as VfxCtx
}

beforeEach(() => {
  motion.matches = false
  vi.stubGlobal('window', { matchMedia: () => motion })
  shield.onEvent!({ type: 'phase', phase: 'fight', round: 1 }, context())
  vi.mocked(glowG).mockClear()
})

describe('Shield ownership reversal', () => {
  it('draws capture then outward release from the contact normal even after the projectile is gone', () => {
    const ctx = context()
    shield.onEvent!(reflected, ctx)
    shield.frame!({ ...ctx, now: 1.035 })
    const capture = vi.mocked(glowG).mock.calls
    expect(capture).toHaveLength(3)
    expect(capture.every((c) => c[0] > reflected.x)).toBe(true)
    vi.mocked(glowG).mockClear()
    shield.frame!({ ...ctx, now: 1.17 })
    const release = vi.mocked(glowG).mock.calls
    expect(release).toHaveLength(3)
    expect(release[1][0]).toBeGreaterThan(capture[1][0] + 80)
    expect(release.flat().filter((v) => typeof v === 'number').every(Number.isFinite)).toBe(true)
    vi.mocked(glowG).mockClear()
    shield.frame!({ ...ctx, now: 1.4 })
    expect(glowG).not.toHaveBeenCalled()
  })

  it('requires both real reflection and ownership theft, respects FX/motion, and clears on a new phase', () => {
    for (const flags of [{ stolen: false }, { reflected: false }]) {
      const ctx = context()
      shield.onEvent!({ ...reflected, ...flags }, ctx)
      shield.frame!({ ...ctx, now: 1.1 })
      expect(glowG).not.toHaveBeenCalled()
    }
    const ctx = context()
    shield.onEvent!(reflected, { ...ctx, fx: 0 })
    motion.matches = true
    shield.onEvent!(reflected, ctx)
    motion.matches = false
    shield.frame!({ ...ctx, now: 1.1 })
    expect(glowG).not.toHaveBeenCalled()
    shield.onEvent!(reflected, ctx)
    shield.onEvent!({ type: 'phase', phase: 'shop', round: 2 }, ctx)
    shield.frame!({ ...ctx, now: 1.1 })
    expect(glowG).not.toHaveBeenCalled()
  })

  it('keeps reflection storms bounded to twelve records and three filaments per record', () => {
    const ctx = context()
    for (let i = 0; i < 100; i++) shield.onEvent!({ ...reflected, projectile: i }, ctx)
    shield.frame!({ ...ctx, now: 1.1 })
    expect(glowG).toHaveBeenCalledTimes(36)
  })
})
