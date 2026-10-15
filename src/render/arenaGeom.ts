/**
 * Arena geometry for render. Tile existence, corner rounding and the lava
 * test come from the sim (src/sim arena helpers, docs/research/assets.md
 * §6.3) so visuals can never disagree with gameplay; this module only adapts
 * them and adds the render-only signed distance field.
 */
import { CORNER_NX_NY, CORNER_NX_PY, CORNER_PX_NY, CORNER_PX_PY, TILE_SIZE as SIM_TILE_SIZE, arenaTiles as simArenaTiles, isLocationSafeAtLayer, isTileAt, layerRadius as simLayerRadius, tileCornerMask } from '../sim'

export const TILE_SIZE = SIM_TILE_SIZE
export const MAX_LAYER = 21
/** Grid half-extent covered by layers <= 21 (radius 2000 -> |g| <= 10). */
export const GRID_MAX = 10
export const GRID_N = GRID_MAX * 2 + 1

/** Corner bits (game space): +x+y, -x+y, -x-y, +x-y (same values as the sim's CORNER_*). */
export const CORNER_PP = CORNER_PX_PY
export const CORNER_NP = CORNER_NX_PY
export const CORNER_NN = CORNER_NX_NY
export const CORNER_PN = CORNER_PX_NY

export interface ArenaTile {
  gx: number
  gy: number
  /** rounded-corner mask (CORNER_* bits) */
  mask: number
}

export function clampLayer(layer: number): number {
  return Math.max(1, Math.min(MAX_LAYER, Math.round(layer)))
}

export function layerRadius(layer: number): number {
  return simLayerRadius(clampLayer(layer))
}

export function tileExists(gx: number, gy: number, layer: number): boolean {
  return isTileAt(clampLayer(layer), gx, gy)
}

export function cellIndex(gx: number, gy: number): number {
  return (gx + GRID_MAX) * GRID_N + (gy + GRID_MAX)
}

export function cornerMask(gx: number, gy: number, layer: number): number {
  return tileCornerMask(clampLayer(layer), gx, gy)
}

/** All tiles of a layer with their corner masks. */
export function arenaTiles(layer: number): ArenaTile[] {
  return simArenaTiles(clampLayer(layer)).map((t) => ({ gx: t.gx, gy: t.gy, mask: t.round }))
}

export function isLocationSafe(x: number, y: number, layer: number): boolean {
  return isLocationSafeAtLayer(clampLayer(layer), x, y)
}

// ---------------------------------------------------------------------------
// Signed distance field of the platform (positive over lava), for lava shore
// glow, tile edge heat and heat shimmer. Exact EDT (Felzenszwalb) on a grid.
// ---------------------------------------------------------------------------

/** SDF texture covers [-SDF_EXTENT, SDF_EXTENT]^2 game units. */
export const SDF_EXTENT = 2400
export const SDF_RES = 160
/** Encoding range: stored = clamp(d / SDF_RANGE * 0.5 + 0.5) */
export const SDF_RANGE = 1200

const INF = 1e20

function edt1d(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array): void {
  let k = 0
  v[0] = 0
  z[0] = -INF
  z[1] = INF
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k])
    while (s <= z[k]) {
      k--
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k])
    }
    k++
    v[k] = q
    z[k] = s
    z[k + 1] = INF
  }
  k = 0
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++
    const dq = q - v[k]
    d[q] = dq * dq + f[v[k]]
  }
}

/** Squared EDT in place: grid holds 0 for feature cells, INF elsewhere. */
function edt2d(grid: Float64Array, w: number, h: number): void {
  const n = Math.max(w, h)
  const f = new Float64Array(n)
  const d = new Float64Array(n)
  const v = new Int32Array(n)
  const z = new Float64Array(n + 1)
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = grid[y * w + x]
    edt1d(f, h, d, v, z)
    for (let y = 0; y < h; y++) grid[y * w + x] = d[y]
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = grid[y * w + x]
    edt1d(f, w, d, v, z)
    for (let x = 0; x < w; x++) grid[y * w + x] = d[x]
  }
}

/**
 * Writes the platform SDF for `layer` into `out` (RGBA8, SDF_RES^2, R channel),
 * texel (i, j) centred at game (x, y) = (-E + (i + 0.5) * cell, -E + (j + 0.5) * cell).
 * Row j = 0 is game y = -E.
 */
export function writeArenaSdf(layer: number, out: Uint8Array): void {
  const N = SDF_RES
  const cell = (SDF_EXTENT * 2) / N
  const inside = new Uint8Array(N * N)
  for (let j = 0; j < N; j++) {
    const y = -SDF_EXTENT + (j + 0.5) * cell
    for (let i = 0; i < N; i++) {
      const x = -SDF_EXTENT + (i + 0.5) * cell
      inside[j * N + i] = isLocationSafe(x, y, layer) ? 1 : 0
    }
  }
  let any = 0
  for (let k = 0; k < N * N; k++) any |= inside[k]
  if (!any) {
    // no platform at all: everything is deep lava
    for (let k = 0; k < N * N; k++) {
      out[k * 4] = 255
      out[k * 4 + 3] = 255
    }
    return
  }
  const dOut = new Float64Array(N * N)
  const dIn = new Float64Array(N * N)
  for (let k = 0; k < N * N; k++) {
    dOut[k] = inside[k] ? 0 : INF
    dIn[k] = inside[k] ? INF : 0
  }
  edt2d(dOut, N, N)
  edt2d(dIn, N, N)
  for (let k = 0; k < N * N; k++) {
    // distance between cell centres; subtract half a cell so the zero crossing
    // sits on the boundary rather than on the first outside texel
    const o = Math.sqrt(dOut[k])
    const i = Math.sqrt(dIn[k])
    const dist = (o > 0 ? o - 0.5 : -(i - 0.5)) * cell
    const enc = Math.max(0, Math.min(1, (dist / SDF_RANGE) * 0.5 + 0.5))
    const p = k * 4
    out[p] = Math.round(enc * 255)
    out[p + 1] = 0
    out[p + 2] = 0
    out[p + 3] = 255
  }
}
