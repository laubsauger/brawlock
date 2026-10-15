import * as THREE from 'three/webgpu'

/**
 * Procedural tileable noise texture, generated once on the CPU (~20 ms) and
 * shared by every shader. Sampling a texture is far cheaper than evaluating
 * gradient noise per pixel on a laptop iGPU.
 *
 *   R: fbm gradient noise (4 octaves, period 4..32)
 *   G: fbm gradient noise, other seed
 *   B: worley F2 - F1 (cell edges; small = crack), 8x8 cells
 *   A: worley F1 (distance to cell centre)
 */
const SIZE = 256

let cached: THREE.DataTexture | null = null

function hash2(ix: number, iy: number, seed: number): number {
  let h = (ix * 374761393 + iy * 668265263 + seed * 2246822519) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}

function gradNoise(x: number, y: number, period: number, seed: number): number {
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const fx = x - x0
  const fy = y - y0
  const g = (ix: number, iy: number, dx: number, dy: number) => {
    const a = hash2(((ix % period) + period) % period, ((iy % period) + period) % period, seed) * Math.PI * 2
    return Math.cos(a) * dx + Math.sin(a) * dy
  }
  const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10)
  const v = fy * fy * fy * (fy * (fy * 6 - 15) + 10)
  const n00 = g(x0, y0, fx, fy)
  const n10 = g(x0 + 1, y0, fx - 1, fy)
  const n01 = g(x0, y0 + 1, fx, fy - 1)
  const n11 = g(x0 + 1, y0 + 1, fx - 1, fy - 1)
  const nx0 = n00 + (n10 - n00) * u
  const nx1 = n01 + (n11 - n01) * u
  return nx0 + (nx1 - nx0) * v // ~[-0.7, 0.7]
}

function fbm(u: number, v: number, basePeriod: number, seed: number): number {
  let sum = 0
  let amp = 0.5
  let norm = 0
  let period = basePeriod
  for (let o = 0; o < 4; o++) {
    sum += gradNoise(u * period, v * period, period, seed + o * 17) * amp
    norm += amp
    amp *= 0.5
    period *= 2
  }
  return Math.max(0, Math.min(1, (sum / norm) * 0.85 + 0.5))
}

export function getNoiseTexture(): THREE.DataTexture {
  if (cached) return cached
  const data = new Uint8Array(SIZE * SIZE * 4)
  const CELLS = 8
  const pts = new Float32Array(CELLS * CELLS * 2)
  for (let j = 0; j < CELLS; j++) {
    for (let i = 0; i < CELLS; i++) {
      const k = (j * CELLS + i) * 2
      pts[k] = i + 0.15 + hash2(i, j, 91) * 0.7
      pts[k + 1] = j + 0.15 + hash2(i, j, 173) * 0.7
    }
  }
  for (let y = 0; y < SIZE; y++) {
    const v = y / SIZE
    for (let x = 0; x < SIZE; x++) {
      const u = x / SIZE
      const r = fbm(u, v, 4, 1)
      const g = fbm(u, v, 4, 59)
      // worley, wrapped
      const cx = u * CELLS
      const cy = v * CELLS
      const ci = Math.floor(cx)
      const cj = Math.floor(cy)
      let f1 = 1e9
      let f2 = 1e9
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          const ii = ci + di
          const jj = cj + dj
          const wi = ((ii % CELLS) + CELLS) % CELLS
          const wj = ((jj % CELLS) + CELLS) % CELLS
          const k = (wj * CELLS + wi) * 2
          const px = pts[k] + (ii - wi)
          const py = pts[k + 1] + (jj - wj)
          const dx = px - cx
          const dy = py - cy
          const d = Math.sqrt(dx * dx + dy * dy)
          if (d < f1) {
            f2 = f1
            f1 = d
          } else if (d < f2) f2 = d
        }
      }
      const p = (y * SIZE + x) * 4
      data[p] = Math.round(r * 255)
      data[p + 1] = Math.round(g * 255)
      data[p + 2] = Math.round(Math.min(1, (f2 - f1) * 1.6) * 255)
      data[p + 3] = Math.round(Math.min(1, f1 * 1.1) * 255)
    }
  }
  const tex = new THREE.DataTexture(data, SIZE, SIZE, THREE.RGBAFormat, THREE.UnsignedByteType)
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.RepeatWrapping
  tex.magFilter = THREE.LinearFilter
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.generateMipmaps = true
  tex.colorSpace = THREE.NoColorSpace
  tex.needsUpdate = true
  cached = tex
  return tex
}
