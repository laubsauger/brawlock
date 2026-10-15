/**
 * Arena geometry (docs/research/assets.md §6.3). Pure helpers, shared with render and bots.
 *
 * Layer L has tile radius (L - 1) * 100. Tile (gx, gy), |gx|,|gy| <= 20, exists iff its centre
 * (192 gx, 192 gy) is strictly inside that radius. A point is safe iff the tile nearest to it
 * exists (the full square cell counts, not the rounded visual).
 */
import { ARENA_MAX_COORD, ARENA_MAX_LAYER, ARENA_RADIUS_PER_LAYER, ARENA_TILE_SIZE } from './config'
import type { SimState } from './types'

export const TILE_SIZE = ARENA_TILE_SIZE

export function clampLayer(layer: number): number {
  return layer < 1 ? 1 : layer > ARENA_MAX_LAYER ? ARENA_MAX_LAYER : layer
}

/** Tile radius of a layer: (L - 1) * 100, L clamped to 1..21. */
export function layerRadius(layer: number): number {
  return (clampLayer(layer) - 1) * ARENA_RADIUS_PER_LAYER
}

export function isTileAt(layer: number, gx: number, gy: number): boolean {
  if (gx < -ARENA_MAX_COORD || gx > ARENA_MAX_COORD || gy < -ARENA_MAX_COORD || gy > ARENA_MAX_COORD) return false
  const r = layerRadius(layer)
  const cx = gx * TILE_SIZE
  const cy = gy * TILE_SIZE
  return cx * cx + cy * cy < r * r
}

/** Grid cell whose centre is nearest to a world coordinate. */
export function tileCoord(v: number): number {
  return Math.floor(v / TILE_SIZE + 0.5)
}

export function isLocationSafeAtLayer(layer: number, x: number, y: number): boolean {
  return isTileAt(layer, tileCoord(x), tileCoord(y))
}

/** True iff (x, y) stands on a tile of the current arena (not lava). */
export function isLocationSafe(state: SimState, x: number, y: number): boolean {
  return isLocationSafeAtLayer(state.arena.layer, x, y)
}

/** Corner bits for ArenaTile.round (corner named by its offset from the tile centre). */
export const CORNER_PX_PY = 1
export const CORNER_NX_PY = 2
export const CORNER_NX_NY = 4
export const CORNER_PX_NY = 8

export interface ArenaTile {
  gx: number
  gy: number
  /** tile centre, game units */
  x: number
  y: number
  /** rounded corners, bitmask of CORNER_* (visual only) */
  round: number
}

/**
 * Original corner rule: round a corner iff both orthogonal neighbours adjacent to it are
 * missing (diagonals ignored). A fully isolated tile stays square (original style 0).
 */
export function tileCornerMask(layer: number, gx: number, gy: number): number {
  const px = isTileAt(layer, gx + 1, gy)
  const nx = isTileAt(layer, gx - 1, gy)
  const py = isTileAt(layer, gx, gy + 1)
  const ny = isTileAt(layer, gx, gy - 1)
  if (!px && !nx && !py && !ny) return 0
  let m = 0
  if (!px && !py) m |= CORNER_PX_PY
  if (!nx && !py) m |= CORNER_NX_PY
  if (!nx && !ny) m |= CORNER_NX_NY
  if (!px && !ny) m |= CORNER_PX_NY
  return m
}

/** Every tile of a layer with its corner rounding, ordered by gy then gx. */
export function arenaTiles(layer: number): ArenaTile[] {
  const out: ArenaTile[] = []
  for (let gy = -ARENA_MAX_COORD; gy <= ARENA_MAX_COORD; gy++) {
    for (let gx = -ARENA_MAX_COORD; gx <= ARENA_MAX_COORD; gx++) {
      if (!isTileAt(layer, gx, gy)) continue
      out.push({ gx, gy, x: gx * TILE_SIZE, y: gy * TILE_SIZE, round: tileCornerMask(layer, gx, gy) })
    }
  }
  return out
}

export function tileCount(layer: number): number {
  let n = 0
  for (let gy = -ARENA_MAX_COORD; gy <= ARENA_MAX_COORD; gy++)
    for (let gx = -ARENA_MAX_COORD; gx <= ARENA_MAX_COORD; gx++) if (isTileAt(layer, gx, gy)) n++
  return n
}
