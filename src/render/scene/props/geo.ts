import * as THREE from 'three/webgpu'
import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js'
import { fbm3, rng } from './rng'

/**
 * Tiny procedural mesh kit for props. Parts are built indexed (shared
 * vertices so displacement stays watertight), then converted to creased
 * normals (crisp edges above the crease angle, smooth below) and merged.
 *
 * Per-vertex data (attribute `aInfo`, vec3):
 *   x = baked cavity / occlusion (1 = open, 0 = deep crevice)
 *   y = material channel (MAT_*)
 *   z = detachable chunk id (0 = core; k > 0 breaks off at damage stage k)
 * Attribute `aBand` (vec2): carving coordinates (u along the surface,
 * v 0..1 across a carved band; v < 0 = no carving).
 * Attribute `aUV` (vec3): xy = surface texture coordinates in game units
 * (arc length around a lathe, height up it; caps planar), z = 1 when set,
 * 0 = use triplanar (rocks, shards, roots).
 */

export const MAT_STONE = 0
export const MAT_RUBBLE = 1
export const MAT_WOOD = 2
export const MAT_GLASS = 3
export const MAT_MOSS = 4

export class Part {
  readonly p: number[] = []
  readonly info: number[] = []
  readonly band: number[] = []
  readonly uv: number[] = []
  readonly idx: number[] = []
  constructor(
    public crease = (40 * Math.PI) / 180,
    public mat = MAT_STONE,
    public chunk = 0,
  ) {}

  get count(): number {
    return this.p.length / 3
  }

  v(x: number, y: number, z: number, ao = 1, bu = 0, bv = -1, tu = 0, tv = 0, hasUV = 0): number {
    this.p.push(x, y, z)
    this.info.push(ao, this.mat, this.chunk)
    this.band.push(bu, bv)
    this.uv.push(tu, tv, hasUV)
    return this.p.length / 3 - 1
  }

  tri(a: number, b: number, c: number): void {
    this.idx.push(a, b, c)
  }

  /** Side quad: a, b along the bottom edge (angle increasing), c above b, d above a. Faces outward. */
  quad(a: number, b: number, c: number, d: number): void {
    this.idx.push(a, c, b, a, d, c)
  }

  geometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3))
    g.setAttribute('aInfo', new THREE.Float32BufferAttribute(this.info, 3))
    g.setAttribute('aBand', new THREE.Float32BufferAttribute(this.band, 2))
    g.setAttribute('aUV', new THREE.Float32BufferAttribute(this.uv, 3))
    g.setIndex(this.idx)
    const out = toCreasedNormals(g, this.crease)
    g.dispose()
    return out
  }
}

/** Merge parts (each creased) into one non-indexed geometry. */
export function mergeParts(parts: Part[]): THREE.BufferGeometry {
  const geos = parts.filter((p) => p.idx.length > 0).map((p) => p.geometry())
  let n = 0
  for (const g of geos) n += g.getAttribute('position').count
  const pos = new Float32Array(n * 3)
  const nrm = new Float32Array(n * 3)
  const info = new Float32Array(n * 3)
  const band = new Float32Array(n * 2)
  const uv = new Float32Array(n * 3)
  let o = 0
  for (const g of geos) {
    const c = g.getAttribute('position').count
    pos.set(g.getAttribute('position').array as Float32Array, o * 3)
    nrm.set(g.getAttribute('normal').array as Float32Array, o * 3)
    info.set(g.getAttribute('aInfo').array as Float32Array, o * 3)
    band.set(g.getAttribute('aBand').array as Float32Array, o * 2)
    uv.set(g.getAttribute('aUV').array as Float32Array, o * 3)
    o += c
    g.dispose()
  }
  const out = new THREE.BufferGeometry()
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3))
  out.setAttribute('aInfo', new THREE.BufferAttribute(info, 3))
  out.setAttribute('aBand', new THREE.BufferAttribute(band, 2))
  out.setAttribute('aUV', new THREE.BufferAttribute(uv, 3))
  out.computeBoundingSphere()
  out.computeBoundingBox()
  return out
}

// ---------------------------------------------------------------- lathe

export interface Ring {
  y: number
  /** radius (game units) */
  r: number
  /** centre offset */
  ox?: number
  oz?: number
  /** per-ring cavity value */
  ao?: number
  /** carving band v for this ring (omit = none) */
  bv?: number
}

export interface LatheOpts {
  /** angles (radians) of the ring vertices, increasing, within [0, 2pi) */
  angles: number[]
  /** cross-section radius multiplier for angle index j at angle a */
  shape?: (a: number, j: number) => number
  /** extra radial displacement (game units) */
  disp?: (a: number, y: number, ring: number, j: number) => number
  /** vertical displacement of a ring vertex (game units) */
  ydisp?: (a: number, ring: number, j: number) => number
  /** close the top with a cap; height function over (angle, rho 0..1) relative to the last ring's y */
  cap?: { rings: number; h?: (a: number, rho: number) => number; ao?: number }
  /** close the bottom (needed for detachable chunks) */
  bottom?: boolean
  /**
   * carving cell size (game units): u = arc length in cells, rounded to a
   * whole number of cells around the ring (seam-free; adds a seam column)
   */
  bandCell?: number
}

export const uniformAngles = (n: number, rot = 0): number[] => Array.from({ length: n }, (_, j) => rot + (j / n) * Math.PI * 2)

/** Angles for a chamfered regular polygon (corners at rot + k * 2pi / sides, split by +-chamfer). */
export function polyAngles(sides: number, chamfer: number, rot = 0): number[] {
  const out: number[] = []
  for (let k = 0; k < sides; k++) {
    const c = rot + (k / sides) * Math.PI * 2
    out.push(c - chamfer, c + chamfer)
  }
  return out
}

/** Radius multiplier of a regular polygon (corner radius 1) at angle a. */
export function polyRadius(sides: number, rot = 0): (a: number) => number {
  const half = Math.PI / sides
  const flat = Math.cos(half)
  return (a: number) => {
    let d = (((a - rot) % (2 * half)) + 2 * half) % (2 * half)
    d -= half
    return flat / Math.cos(d)
  }
}

/** Superellipse radius multiplier (n = 2 circle, larger = squarer). */
export function superRadius(n: number, sx = 1, sz = 1): (a: number) => number {
  return (a: number) => {
    const c = Math.abs(Math.cos(a)) / sx
    const s = Math.abs(Math.sin(a)) / sz
    return 1 / Math.pow(Math.pow(c, n) + Math.pow(s, n), 1 / n)
  }
}

/** Ring stack around +y. Returns the vertex indices of each ring. */
export function lathe(part: Part, rings: Ring[], o: LatheOpts): number[][] {
  const A = o.angles
  const N = A.length
  const banded = o.bandCell !== undefined
  const ids: number[][] = []
  const xs = new Float64Array(N + 1)
  const zs = new Float64Array(N + 1)
  const ysR = new Float64Array(N + 1)
  for (let i = 0; i < rings.length; i++) {
    const R = rings[i]
    const row: number[] = []
    for (let j = 0; j < N; j++) {
      const a = A[j]
      const m = o.shape ? o.shape(a, j) : 1
      const r = R.r * m + (o.disp ? o.disp(a, R.y, i, j) : 0)
      xs[j] = (R.ox ?? 0) + Math.cos(a) * r
      zs[j] = (R.oz ?? 0) + Math.sin(a) * r
      ysR[j] = R.y + (o.ydisp ? o.ydisp(a, i, j) : 0)
    }
    // carving u: arc length, scaled to a whole number of cells around the ring
    let total = 0
    const cum = new Float64Array(N + 1)
    for (let j = 0; j < N; j++) {
      const k = (j + 1) % N
      total += Math.hypot(xs[k] - xs[j], zs[k] - zs[j])
      cum[j + 1] = total
    }
    const cells = banded ? Math.max(1, Math.round(total / (o.bandCell as number))) : 0
    // texture u: arc length around a mean-radius circle so stacked rings line up
    const uk = (Math.PI * 2 * R.r) / Math.max(1e-3, total)
    for (let j = 0; j < N; j++) row.push(part.v(xs[j], ysR[j], zs[j], R.ao ?? 1, banded ? (cum[j] / total) * cells : 0, R.bv ?? -1, cum[j] * uk, ysR[j], 1))
    // seam column (same position, u continues) so u never wraps inside a quad
    row.push(part.v(xs[0], ysR[0], zs[0], R.ao ?? 1, cells, R.bv ?? -1, total * uk, ysR[0], 1))
    ids.push(row)
  }
  for (let i = 0; i + 1 < rings.length; i++) {
    for (let j = 0; j < N; j++) {
      part.quad(ids[i][j], ids[i][j + 1], ids[i + 1][j + 1], ids[i + 1][j])
    }
  }
  // caps re-emit their rim vertices with planar uv (side uv would smear across the cap)
  const planarCopy = (row: number[]) =>
    row.slice(0, N).map((id) => {
      const x = part.p[id * 3]
      const y = part.p[id * 3 + 1]
      const z = part.p[id * 3 + 2]
      return part.v(x, y, z, part.info[id * 3], 0, -1, x, z, 1)
    })
  const top = ids[ids.length - 1]
  if (o.cap) {
    const K = Math.max(0, o.cap.rings)
    const R = rings[rings.length - 1]
    const cx = R.ox ?? 0
    const cz = R.oz ?? 0
    let prev = planarCopy(top)
    for (let k = 1; k <= K + 1; k++) {
      const rho = 1 - k / (K + 1)
      if (rho <= 1e-4) {
        const ch = o.cap.h ? o.cap.h(0, 0) : 0
        const c = part.v(cx, R.y + ch, cz, o.cap.ao ?? 1, 0, -1, cx, cz, 1)
        for (let j = 0; j < N; j++) part.tri(c, prev[(j + 1) % N], prev[j])
        break
      }
      const row: number[] = []
      for (let j = 0; j < N; j++) {
        const px = part.p[top[j] * 3] - cx
        const pz = part.p[top[j] * 3 + 2] - cz
        const ch = o.cap.h ? o.cap.h(A[j], rho) : 0
        row.push(part.v(cx + px * rho, R.y + ch, cz + pz * rho, o.cap.ao ?? 1, 0, -1, cx + px * rho, cz + pz * rho, 1))
      }
      for (let j = 0; j < N; j++) {
        const j1 = (j + 1) % N
        // inward ring: prev is outer
        part.idx.push(prev[j], row[j1], prev[j1], prev[j], row[j], row[j1])
      }
      prev = row
    }
  }
  if (o.bottom) {
    const b = planarCopy(ids[0])
    const R = rings[0]
    const c = part.v(R.ox ?? 0, R.y, R.oz ?? 0, 0.5, 0, -1, R.ox ?? 0, R.oz ?? 0, 1)
    for (let j = 0; j < N; j++) part.tri(c, b[j], b[(j + 1) % N])
  }
  return ids
}

// ---------------------------------------------------------------- rocks

/**
 * Faceted rubble chunk / boulder: displaced icosahedron, flattened base.
 * Center (x, y, z), size (radius), squash y.
 */
export function rock(part: Part, x: number, y: number, z: number, size: number, seed: number, opts: { detail?: number; squash?: number; flat?: number; rotY?: number; ao?: number; rough?: number } = {}): void {
  const ico = new THREE.IcosahedronGeometry(1, opts.detail ?? 0)
  const pos = ico.getAttribute('position') as THREE.BufferAttribute
  // weld the non-indexed icosahedron
  const map = new Map<string, number>()
  const local: number[] = []
  const R = rng(seed)
  const sx = 0.8 + R() * 0.45
  const sz = 0.8 + R() * 0.45
  const sq = opts.squash ?? 0.7
  const rough = opts.rough ?? 0.28
  const ry = opts.rotY ?? R() * Math.PI * 2
  const cr = Math.cos(ry)
  const sr = Math.sin(ry)
  const flat = opts.flat ?? -0.35
  for (let i = 0; i < pos.count; i++) {
    const vx = pos.getX(i)
    const vy = pos.getY(i)
    const vz = pos.getZ(i)
    const key = `${vx.toFixed(4)},${vy.toFixed(4)},${vz.toFixed(4)}`
    let id = map.get(key)
    if (id === undefined) {
      const d = 1 + fbm3(vx * 1.7 + seed * 0.37, vy * 1.7, vz * 1.7, seed, 2) * rough * 2
      let px = vx * d * sx
      let py = vy * d * sq
      let pz = vz * d * sz
      if (py < flat * sq) py = flat * sq + (py - flat * sq) * 0.25
      const rx = px * cr - pz * sr
      pz = px * sr + pz * cr
      px = rx
      // occlusion: darker underside
      const ao = (opts.ao ?? 1) * (0.55 + 0.45 * Math.min(1, Math.max(0, vy * 0.8 + 0.6)))
      id = part.v(x + px * size, y + py * size, z + pz * size, ao)
      map.set(key, id)
    }
    local.push(id)
  }
  for (let i = 0; i < local.length; i += 3) part.tri(local[i], local[i + 1], local[i + 2])
  ico.dispose()
}

// ---------------------------------------------------------------- sweep

/** Tapered tube along a polyline (roots, vines). radius(t) with t 0..1 along the path. */
export function sweep(part: Part, pts: THREE.Vector3[], radius: (t: number) => number, sides = 5, ao = 1): void {
  const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal')
  const segs = Math.max(4, pts.length * 4)
  const frames = curve.computeFrenetFrames(segs, false)
  const rows: number[][] = []
  const p = new THREE.Vector3()
  for (let i = 0; i <= segs; i++) {
    const t = i / segs
    curve.getPointAt(t, p)
    const N = frames.normals[i]
    const B = frames.binormals[i]
    const r = radius(t)
    const row: number[] = []
    for (let j = 0; j < sides; j++) {
      const a = (j / sides) * Math.PI * 2
      const c = Math.cos(a) * r
      const s = Math.sin(a) * r
      row.push(part.v(p.x + N.x * c + B.x * s, p.y + N.y * c + B.y * s, p.z + N.z * c + B.z * s, ao))
    }
    rows.push(row)
  }
  for (let i = 0; i < segs; i++) {
    for (let j = 0; j < sides; j++) {
      const j1 = (j + 1) % sides
      // frames: B = T x N, so the ring winds opposite to lathe()
      part.idx.push(rows[i][j], rows[i][j1], rows[i + 1][j1], rows[i][j], rows[i + 1][j1], rows[i + 1][j])
    }
  }
}

/** Long pointed shard (obstacle obsidian, crystals): n-gon prism to a tip. */
export function shard(part: Part, base: THREE.Vector3, dir: THREE.Vector3, len: number, width: number, sides: number, seed: number, opts: { tipLen?: number; bottomY?: number; ao?: number; twist?: number } = {}): void {
  const R = rng(seed)
  const up = dir.clone().normalize()
  const ref = Math.abs(up.y) < 0.95 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)
  const ax = new THREE.Vector3().crossVectors(up, ref).normalize()
  const az = new THREE.Vector3().crossVectors(ax, up).normalize()
  const tipLen = opts.tipLen ?? 0.3
  const rot = R() * Math.PI * 2 + (opts.twist ?? 0)
  const jit = Array.from({ length: sides }, () => 0.75 + R() * 0.45)
  const levels = [
    { t: 0, w: 1 },
    { t: 1 - tipLen, w: 0.86 + R() * 0.1 },
  ]
  const rows: number[][] = []
  const q = new THREE.Vector3()
  for (const L of levels) {
    const row: number[] = []
    for (let j = 0; j < sides; j++) {
      const a = rot + (j / sides) * Math.PI * 2
      const r = width * L.w * jit[j]
      q.copy(base)
        .addScaledVector(up, len * L.t)
        .addScaledVector(ax, Math.cos(a) * r)
        .addScaledVector(az, Math.sin(a) * r)
      if (L.t === 0 && opts.bottomY !== undefined) q.y = Math.min(q.y, opts.bottomY)
      row.push(part.v(q.x, q.y, q.z, (opts.ao ?? 1) * (L.t === 0 ? 0.55 : 1)))
    }
    rows.push(row)
  }
  const tipOff = new THREE.Vector3().addScaledVector(ax, (R() - 0.5) * width * 0.5).addScaledVector(az, (R() - 0.5) * width * 0.5)
  const tip = base.clone().addScaledVector(up, len).add(tipOff)
  const ti = part.v(tip.x, tip.y, tip.z, opts.ao ?? 1)
  // sides: ring orientation follows (ax, az) which is right-handed around `up`
  for (let j = 0; j < sides; j++) {
    const j1 = (j + 1) % sides
    part.idx.push(rows[0][j], rows[1][j], rows[0][j1], rows[0][j1], rows[1][j], rows[1][j1])
    part.idx.push(rows[1][j], ti, rows[1][j1])
  }
}

/**
 * Fix winding so every triangle faces away from `center` (+ optional axis):
 * cheap insurance for generators whose frame handedness varies.
 */
export function orientOutward(part: Part, from: number, cx: number, cy: number, cz: number, axisY = false): void {
  const P = part.p
  const I = part.idx
  for (let t = from; t < I.length; t += 3) {
    const a = I[t] * 3
    const b = I[t + 1] * 3
    const c = I[t + 2] * 3
    const e1x = P[b] - P[a]
    const e1y = P[b + 1] - P[a + 1]
    const e1z = P[b + 2] - P[a + 2]
    const e2x = P[c] - P[a]
    const e2y = P[c + 1] - P[a + 1]
    const e2z = P[c + 2] - P[a + 2]
    const nx = e1y * e2z - e1z * e2y
    const ny = e1z * e2x - e1x * e2z
    const nz = e1x * e2y - e1y * e2x
    const mx = (P[a] + P[b] + P[c]) / 3 - cx
    const my = axisY ? 0 : (P[a + 1] + P[b + 1] + P[c + 1]) / 3 - cy
    const mz = (P[a + 2] + P[b + 2] + P[c + 2]) / 3 - cz
    if (nx * mx + ny * my + nz * mz < 0) {
      I[t + 1] = c / 3
      I[t + 2] = b / 3
    }
  }
}
