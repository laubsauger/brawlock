import { describe, expect, test } from 'vitest'
import {
  CORNER_NX_NY,
  CORNER_NX_PY,
  CORNER_PX_NY,
  CORNER_PX_PY,
  arenaTiles,
  isLocationSafeAtLayer,
  isTileAt,
  layerRadius,
  tileCornerMask,
  tileCount,
} from './arena'

describe('arena layers (assets.md §6.3)', () => {
  // tile counts per layer from the original generator; arena size per player count and the
  // shrink pacing depend on these exact sets
  const EXPECTED: Record<number, number> = {
    1: 0, 2: 1, 3: 5, 4: 9, 5: 13, 6: 21, 7: 29, 8: 45, 9: 57, 10: 69, 11: 89,
    12: 101, 13: 121, 14: 145, 15: 177, 16: 193, 17: 221, 18: 241, 19: 277, 20: 301, 21: 341,
  }

  test('tile count per layer matches the original table (341 at layer 21)', () => {
    for (const [l, n] of Object.entries(EXPECTED)) expect(tileCount(Number(l))).toBe(n)
    expect(arenaTiles(21)).toHaveLength(341)
  })

  test('layer radius is (L - 1) * 100, clamped to 1..21', () => {
    expect(layerRadius(15)).toBe(1400)
    expect(layerRadius(0)).toBe(0)
    expect(layerRadius(40)).toBe(2000)
  })

  test('safe check uses the nearest tile as a full square cell', () => {
    // layer 2 = only the centre tile; its square cell spans +-96
    expect(isLocationSafeAtLayer(2, 95.9, 95.9)).toBe(true) // corner of the square, outside a disc
    expect(isLocationSafeAtLayer(2, 96.1, 0)).toBe(false)
    expect(isLocationSafeAtLayer(1, 0, 0)).toBe(false)
    // tile centre must be strictly inside the radius: tile (5,0) at 960 needs r > 960
    expect(isTileAt(11, 5, 0)).toBe(true) // r 1000
    expect(isTileAt(10, 5, 0)).toBe(false) // r 900
  })
})

describe('corner rounding (visual) follows the original style table', () => {
  test('a corner is rounded only when both orthogonal neighbours are missing', () => {
    for (const layer of [3, 8, 14, 21]) {
      for (const t of arenaTiles(layer)) {
        const px = isTileAt(layer, t.gx + 1, t.gy)
        const nx = isTileAt(layer, t.gx - 1, t.gy)
        const py = isTileAt(layer, t.gx, t.gy + 1)
        const ny = isTileAt(layer, t.gx, t.gy - 1)
        if (!px && !nx && !py && !ny) continue
        expect(!!(t.round & CORNER_PX_PY)).toBe(!px && !py)
        expect(!!(t.round & CORNER_NX_PY)).toBe(!nx && !py)
        expect(!!(t.round & CORNER_NX_NY)).toBe(!nx && !ny)
        expect(!!(t.round & CORNER_PX_NY)).toBe(!px && !ny)
      }
    }
  })

  test('end caps round their two far corners, straight edges stay square', () => {
    // layer 3 = plus shape: centre + 4 arms. The +x arm (1,0) only touches (0,0) on -x,
    // so its two +x corners round (original style 10).
    expect(tileCornerMask(3, 1, 0)).toBe(CORNER_PX_PY | CORNER_PX_NY)
    expect(tileCornerMask(3, 0, 1)).toBe(CORNER_PX_PY | CORNER_NX_PY)
    // the centre has all four neighbours: square
    expect(tileCornerMask(3, 0, 0)).toBe(0)
    // an outer tile of a large disc with neighbours on -x and -y rounds only (+x, +y)
    const outer = arenaTiles(21).find((t) => t.round === CORNER_PX_PY)
    expect(outer).toBeDefined()
  })

  test('an isolated tile stays square (original style 0)', () => {
    expect(arenaTiles(2)).toEqual([{ gx: 0, gy: 0, x: 0, y: 0, round: 0 }])
  })
})
