import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DataTexture, PerspectiveCamera, Scene, Vector3 } from 'three/webgpu'
import { uniform } from 'three/tsl'
import type { PawnState, SimState } from '../../../sim/types'
import { S } from '../../coords'
import { TIERS } from '../../quality'
import { Billboards } from '../../scene/Billboards'
import { spellVfxModules, type VfxCtx } from '../registry'
import './scourge'

const scourge = spellVfxModules().find((m) => m.spell === 'scourge')!
const streak = vi.spyOn(Billboards.prototype, 'addStreak')
let ctx: VfxCtx
let pawn: PawnState
let hand: Vector3

function fixture(owner = 0, localPlayer = 0, level = 1): VfxCtx {
  pawn = { id: 1, owner, alive: true, slots: ['scourge'], levels: [level], cast: { spell: 'scourge', slot: 0, ticksLeft: 30, x: 0, y: 0, started: true } } as PawnState
  hand = new Vector3(0.2, 1.4, -0.1)
  const info = { x: 0, y: 0, h: 0, owner, alive: true, onLava: false, color: 0xffffff, castOrigin: hand, tip: hand }
  const camera = new PerspectiveCamera()
  camera.updateMatrixWorld()
  ctx = {
    now: 1, dt: 1 / 60, alpha: 0, fx: 1, quality: 'low', tier: TIERS.low, localPlayer,
    state: { pawns: [pawn], slots: [], settings: { teamMode: 'ffa' } } as unknown as SimState,
    scene: new Scene(), camera, pawn: () => info, floorAt: () => 0, isLava: () => false,
    world: { noise: new DataTexture(new Uint8Array(4), 1, 1), field: null, uTime: uniform(1), uFx: uniform(1) },
    particles: { budget: vi.fn((n: number) => n), spawn: vi.fn() },
    smoke: { budget: vi.fn((n: number) => n), spawn: vi.fn() },
    ground: { spawn: vi.fn() }, glow: { add: vi.fn() }, shakeNear: vi.fn(),
  } as unknown as VfxCtx
  scourge.init!(ctx)
  scourge.onEvent!({ type: 'castStart', pawn: 1, spell: 'scourge', ticks: 54, level }, ctx)
  return ctx
}

function frame(): void {
  streak.mockClear()
  scourge.beginFrame!(ctx)
  scourge.frame!(ctx)
}

function targetingCount(): number {
  return (ctx.scene.getObjectByName('scourge-windup') as unknown as { count: number }).count
}

beforeEach(() => { scourge.dispose!(); streak.mockClear() })
afterEach(() => { scourge.dispose!() })

describe('Scourge attached windup', () => {
  it('keeps the local crown on the real hands and never emits charge or cancel debris', () => {
    fixture()
    frame()
    expect(targetingCount()).toBe(1)
    const first = streak.mock.calls.map((c) => c.slice(0, 3) as number[])
    expect(first.length).toBeGreaterThan(0)
    for (const p of first) expect(Math.hypot(p[0] - hand.x, p[1] - hand.y, p[2] - hand.z)).toBeLessThan(30 * S)
    hand.x += 2
    frame()
    streak.mock.calls.forEach((c, i) => expect(c[0] - first[i][0]).toBeCloseTo(2))
    scourge.onEvent!({ type: 'castCancel', pawn: 1, spell: 'scourge', slot: 0, started: true }, ctx)
    pawn.cast = null
    frame()
    expect(streak).not.toHaveBeenCalled()
    expect(ctx.particles.spawn).not.toHaveBeenCalled()
    expect(ctx.smoke.spawn).not.toHaveBeenCalled()
    expect(ctx.ground.spawn).not.toHaveBeenCalled()
    Object.assign(ctx, { now: 1.2 })
    frame()
    expect(targetingCount()).toBe(0)
  })

  it.each([[1, 0], [0, -1], [-1, -1]])('keeps radius and hand crown hidden for owner %s / viewer %s', (owner, viewer) => {
    fixture(owner, viewer)
    frame()
    expect(targetingCount()).toBe(0)
    expect(scourge.windupStyle!('scourge', pawn)?.hide).toContain('light')
    // Only two immediate body-aura sprites, no free embers or ground ripples.
    expect(streak).toHaveBeenCalledTimes(2)
    expect(ctx.particles.spawn).not.toHaveBeenCalled()
    expect(ctx.ground.spawn).not.toHaveBeenCalled()
    scourge.onEvent!({ type: 'castCancel', pawn: 1, spell: 'scourge', slot: 0, started: true }, ctx)
    pawn.cast = null
    frame()
    expect(streak).not.toHaveBeenCalled()
    expect(targetingCount()).toBe(0)
  })

  it('removes stale charge immediately when its cast state changes without a cancel event', () => {
    fixture()
    frame()
    pawn.cast = { ...pawn.cast!, spell: 'fireball' }
    frame()
    expect(streak).not.toHaveBeenCalled()
    expect(targetingCount()).toBe(0)
  })

  it('does not reveal a cancelled local radius after switching to spectator', () => {
    fixture()
    frame()
    scourge.onEvent!({ type: 'castCancel', pawn: 1, spell: 'scourge', slot: 0, started: true }, ctx)
    pawn.cast = null
    Object.assign(ctx, { localPlayer: -1 })
    frame()
    expect(targetingCount()).toBe(0)
    expect(streak).not.toHaveBeenCalled()
  })
})
