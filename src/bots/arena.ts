/**
 * Arena geometry the bots need: which points are lava. The rule itself comes from the
 * sim (src/sim arena helpers, docs/research/assets.md §6.3) so bots and sim can never disagree;
 * this file adds the planning helpers (margins, nearest tile).
 */
import { isLocationSafeAtLayer, isTileAt, layerRadius, TILE_SIZE } from '../sim'
import type { Vec2 } from '../sim/types'

export { layerRadius, TILE_SIZE }
export const tileExists = isTileAt

/** True iff (x, y) stands on a tile of `layer`. */
export function isSafe(layer: number, x: number, y: number): boolean {
  return isLocationSafeAtLayer(layer, x, y)
}

const RING = [
  [1, 0],
  [0.7071, 0.7071],
  [0, 1],
  [-0.7071, 0.7071],
  [-1, 0],
  [-0.7071, -0.7071],
  [0, -1],
  [0.7071, -0.7071],
] as const

/** Safe here and at 8 points `margin` away (so a small push does not land in lava). */
export function isSafeWithMargin(layer: number, x: number, y: number, margin: number): boolean {
  if (!isSafe(layer, x, y)) return false
  if (margin <= 0) return true
  for (const [dx, dy] of RING) {
    if (!isSafe(layer, x + dx * margin, y + dy * margin)) return false
  }
  return true
}

/**
 * Nearest tile centre that exists in `layer`, preferring interior tiles (all four
 * neighbours exist) when `preferInterior`. Null when the layer has no tiles.
 */
export function nearestTileCentre(layer: number, x: number, y: number, preferInterior: boolean): Vec2 | null {
  const n = Math.ceil(layerRadius(layer) / TILE_SIZE)
  let best: Vec2 | null = null
  let bestD = Infinity
  for (let gx = -n; gx <= n; gx++) {
    for (let gy = -n; gy <= n; gy++) {
      if (!tileExists(layer, gx, gy)) continue
      let d = (gx * TILE_SIZE - x) ** 2 + (gy * TILE_SIZE - y) ** 2
      if (
        preferInterior &&
        !(
          tileExists(layer, gx + 1, gy) &&
          tileExists(layer, gx - 1, gy) &&
          tileExists(layer, gx, gy + 1) &&
          tileExists(layer, gx, gy - 1)
        )
      ) {
        // edge tile: usable, but only if nothing interior is close
        d += (TILE_SIZE * 1.5) ** 2
      }
      if (d < bestD) {
        bestD = d
        best = { x: gx * TILE_SIZE, y: gy * TILE_SIZE }
      }
    }
  }
  return best
}
