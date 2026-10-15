/**
 * Render-side seeded randomness and CPU noise for procedural props.
 * Never used by the sim (render may be non-deterministic across machines;
 * these are only for stable per-seed shapes).
 */

/** mulberry32: small, fast, good enough for placement and shape jitter. */
export function rng(seed: number): () => number {
  let a = (seed | 0) ^ 0x9e3779b9
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function hash1(n: number): number {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453
  return s - Math.floor(s)
}

function hash3(x: number, y: number, z: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + z * 1440662683 + seed * 2246822519) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}

/** Smooth value noise in [0, 1]. */
export function vnoise3(x: number, y: number, z: number, seed = 0): number {
  const xi = Math.floor(x)
  const yi = Math.floor(y)
  const zi = Math.floor(z)
  const xf = x - xi
  const yf = y - yi
  const zf = z - zi
  const u = xf * xf * (3 - 2 * xf)
  const v = yf * yf * (3 - 2 * yf)
  const w = zf * zf * (3 - 2 * zf)
  let acc = 0
  for (let dz = 0; dz <= 1; dz++)
    for (let dy = 0; dy <= 1; dy++)
      for (let dx = 0; dx <= 1; dx++) {
        const h = hash3(xi + dx, yi + dy, zi + dz, seed)
        acc += h * (dx ? u : 1 - u) * (dy ? v : 1 - v) * (dz ? w : 1 - w)
      }
  return acc
}

/** Fractal value noise, roughly in [-0.5, 0.5]. */
export function fbm3(x: number, y: number, z: number, seed = 0, oct = 3): number {
  let a = 0.5
  let f = 1
  let s = 0
  let n = 0
  for (let i = 0; i < oct; i++) {
    s += (vnoise3(x * f, y * f, z * f, seed + i * 17) - 0.5) * a
    n += a
    a *= 0.5
    f *= 2.03
  }
  return s / n
}

/** Ridged noise in [0, 1] (sharp creases at 1): good for chipped stone. */
export function ridge3(x: number, y: number, z: number, seed = 0): number {
  return 1 - Math.abs(vnoise3(x, y, z, seed) * 2 - 1)
}

export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)
export const smooth = (a: number, b: number, v: number) => {
  const t = clamp01((v - a) / (b - a))
  return t * t * (3 - 2 * t)
}
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t
