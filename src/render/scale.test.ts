/**
 * Render scale contract: visuals must be derived from the sim's numbers so a
 * gameplay radius or tile cell always looks exactly as big as it plays.
 * Pure node test (no WebGPU): geometry is built and measured on the CPU.
 */
import { describe, expect, it } from 'vitest'
import { PAWN_RADIUS, SPELLS, TILE_SIZE } from '../sim'
import { WORLD_SCALE } from '../sim/types'
import { CC0_SCALE } from './character/config'
import { AOE_RING_INSET, AOE_RING_THICK, COLLISION_RING_R, PROJECTILE_CORE_SCALE, TILE_GAP, aoeRingEdge, projectileCoreRadius } from './scale'
import { S, toGame, toWorld } from './coords'
import { buildTileGeometry } from './scene/tileGeometry'

describe('tile footprint', () => {
  it('is the sim cell minus the documented grout, for every corner mask', () => {
    // Why: tiles are the lava test (isLocationSafe uses the full 192 cell). A
    // slab that is wider or narrower than the cell lies about where lava is.
    for (let mask = 0; mask < 16; mask++) {
      const g = buildTileGeometry(mask)
      g.computeBoundingBox()
      const bb = g.boundingBox!
      const w = (bb.max.x - bb.min.x) / S
      const d = (bb.max.z - bb.min.z) / S
      expect(w).toBeCloseTo(TILE_SIZE - TILE_GAP, 3)
      expect(d).toBeCloseTo(TILE_SIZE - TILE_GAP, 3)
    }
    // and the grout stays a hairline relative to the cell
    expect(TILE_GAP / TILE_SIZE).toBeLessThan(0.03)
  })
})

describe('projectile cores', () => {
  it('draw the hitbox at the sim collision radius (+-5 %) for every projectile spell', () => {
    // Why: "VFX never hide a projectile hitbox" (plan 5.2): the readable core
    // must be the thing that actually collides, not a prettier guess.
    const radii: number[] = []
    for (const def of Object.values(SPELLS) as { consts?: Record<string, number> }[]) {
      const r = def.consts?.radius
      if (typeof r === 'number' && r > 0 && r < 100) radii.push(r)
    }
    expect(radii.length).toBeGreaterThan(0)
    for (const r of radii) {
      const core = projectileCoreRadius(r)
      expect(Math.abs(core - r) / r).toBeLessThanOrEqual(0.05 + 1e-9)
    }
    expect(PROJECTILE_CORE_SCALE).toBeGreaterThanOrEqual(0.95)
  })
})

describe('AoE boundary ring', () => {
  it('puts its visible edge exactly at the event radius', () => {
    // Why: players read AoE size from this ring; Scourge overshot by 15-40 %
    // before. The edge may sit at most 1 unit off the hit radius.
    for (const radius of [225, 250, 300]) {
      expect(Math.abs(aoeRingEdge(radius) - radius)).toBeLessThanOrEqual(1)
      expect(radius - AOE_RING_INSET).toBeLessThan(radius)
    }
    expect(AOE_RING_THICK).toBeLessThanOrEqual(4)
  })
})

describe('pawn footprint', () => {
  it('debug collision ring is the sim pawn radius', () => {
    expect(COLLISION_RING_R).toBe(PAWN_RADIUS)
    expect(PAWN_RADIUS).toBe(30)
  })

  it('CC0 warlock: hem 60-72 units across, 120-135 units tall', () => {
    // Why: the silhouette must match the 30-unit collision circle (a fat
    // warlock reads as getting hit by things that missed). Base rig numbers
    // as documented by the character workstream: rig height 1.87 m
    // (character/config.ts), hem half-width 0.44 m (geometry.ts HEM_RX).
    const RIG_HEIGHT_M = 1.87
    const HEM_RX_M = 0.44
    const height = (RIG_HEIGHT_M * CC0_SCALE.y) / WORLD_SCALE
    const hem = (2 * HEM_RX_M * CC0_SCALE.xz) / WORLD_SCALE
    expect(hem).toBeGreaterThanOrEqual(60)
    expect(hem).toBeLessThanOrEqual(72)
    expect(height).toBeGreaterThanOrEqual(120)
    expect(height).toBeLessThanOrEqual(135)
  })
})

describe('coordinates', () => {
  it('render scale is the sim WORLD_SCALE and game <-> world round-trips', () => {
    expect(S).toBe(WORLD_SCALE)
    for (const [x, y] of [
      [0, 0],
      [1400, -870],
      [-5910, 5910],
    ]) {
      const w = toWorld(x, y, 30)
      const g = toGame(w)
      expect(g.x).toBeCloseTo(x, 6)
      expect(g.y).toBeCloseTo(y, 6)
      // game +y is screen up = three -z
      if (y !== 0) expect(Math.sign(w.z)).toBe(-Math.sign(y))
    }
  })
})
