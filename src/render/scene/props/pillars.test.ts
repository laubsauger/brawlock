import { describe, expect, test } from 'vitest'
import { OBSTACLE_RADII } from '../../../sim/config'
import { MAT_RUBBLE } from './geo'
import { buildPillar } from './pillars'

/**
 * Pillar shapes are gameplay-facing: projectiles and warlocks collide with a
 * circle of the obstacle radius, so the visible base must match it or hits
 * read as landing in thin air / passing through stone. These pin that
 * contract and the per-pillar budget (8 pillars + Rockpillars at 60 fps on
 * an iGPU) for every theme, variant and a spread of seeds.
 */

const SEEDS = [1, 7, 123, 4567, 99999]
const cases: { theme: number; variant: number; radius: number }[] = []
OBSTACLE_RADII.forEach((radii, theme) => radii.forEach((radius, variant) => cases.push({ theme, variant, radius })))
cases.push({ theme: 0, variant: -1, radius: 90 }) // Rockpillar

function stats(theme: number, variant: number, radius: number, seed: number) {
  const s = buildPillar(theme, variant, radius, seed)
  const pos = s.geometry.getAttribute('position')
  const info = s.geometry.getAttribute('aInfo')
  let base = 0
  let all = 0
  for (let i = 0; i < pos.count; i++) {
    const d = Math.hypot(pos.getX(i), pos.getZ(i))
    all = Math.max(all, d)
    // the standing body near the floor (rubble lies on the floor, ankle high)
    if (info.getY(i) !== MAT_RUBBLE && pos.getY(i) < 40) base = Math.max(base, d)
  }
  const tris = pos.count / 3 + (s.crystals ? s.crystals.getAttribute('position').count / 3 : 0)
  return { s, base, all, tris }
}

describe('pillar shapes', () => {
  for (const c of cases) {
    const name = c.variant < 0 ? 'Rockpillar' : `theme ${c.theme} variant ${c.variant} (r ${c.radius})`
    test(`${name}: base footprint matches the collision radius`, () => {
      for (const seed of SEEDS) {
        const { base, all } = stats(c.theme, c.variant, c.radius, seed)
        // no visual overhang past ~1.1 r where shots hit; never visibly smaller either
        expect(base / c.radius).toBeLessThanOrEqual(1.13)
        expect(base / c.radius).toBeGreaterThanOrEqual(0.8)
        // floor rubble may spill a little, never a second footprint
        expect(all / c.radius).toBeLessThanOrEqual(1.55)
      }
    })
    test(`${name}: within the 3k triangle budget`, () => {
      for (const seed of SEEDS) expect(stats(c.theme, c.variant, c.radius, seed).tris).toBeLessThanOrEqual(3000)
    })
    test(`${name}: same seed, same pillar (host and clients see one shape)`, () => {
      const a = buildPillar(c.theme, c.variant, c.radius, 42).geometry.getAttribute('position').array
      const b = buildPillar(c.theme, c.variant, c.radius, 42).geometry.getAttribute('position').array
      expect(Array.from(b)).toEqual(Array.from(a))
    })
    test(`${name}: has a chunk to break off at the first damage stage`, () => {
      const { s } = stats(c.theme, c.variant, c.radius, 3)
      expect(s.chunks.length).toBeGreaterThanOrEqual(1)
      const info = s.geometry.getAttribute('aInfo')
      let chunk1 = 0
      for (let i = 0; i < info.count; i++) if (info.getZ(i) === 1) chunk1++
      expect(chunk1).toBeGreaterThan(0)
    })
  }
})
