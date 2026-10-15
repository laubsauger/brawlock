import * as THREE from 'three/webgpu'
import { MAT_GLASS, MAT_RUBBLE, MAT_STONE, MAT_WOOD, Part, lathe, mergeParts, polyAngles, polyRadius, rock, shard, superRadius, sweep, uniformAngles, type Ring } from './geo'
import { fbm3, rng, smooth } from './rng'

/**
 * Seeded procedural pillar shapes (art: art/archive/env/INDEX.md).
 *
 *  theme 0 temple    - broken fluted columns on stepped plinths, carved rune friezes, rubble
 *  theme 1 volcanic  - sculpted hexagonal basalt columns / obsidian shards, ember veins
 *  theme 2 overgrown - mossy standing stones, root-wrapped ruins, green crystal growth
 *  variant -1        - Rockpillar: a basalt column cluster burst out of the floor
 *
 * Geometry is in game units, base at y = 0 (the tile top), footprint = the
 * collision radius: nothing reaches past ~1.1 r at the base so hits read
 * where they land. Detachable chunks (aInfo.z = 1, 2) break off at the
 * damage stages; each is a closed piece sitting on a broken core.
 */

export interface PillarShape {
  geometry: THREE.BufferGeometry
  crystals: THREE.BufferGeometry | null
  /** top of the intact pillar (game units) */
  height: number
  /** detachable chunk k (index k - 1): centre and size, for debris */
  chunks: { x: number; y: number; z: number; size: number }[]
  /** which glow the material shows in the cracks */
  kind: 'temple' | 'volcanic' | 'overgrown'
}

export const VARIANTS_PER_THEME = [5, 4, 5] as const
const SINK = -14
const TAU = Math.PI * 2

// ------------------------------------------------------------------ shared bits

/** Rubble ring around the base: half-buried faceted chunks. */
function skirt(part: Part, R: () => number, r: number, n: number, dMin: number, dMax: number, sMin: number, sMax: number, seed: number): void {
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU + (R() - 0.5) * (TAU / n) * 0.9
    const d = r * (dMin + R() * (dMax - dMin))
    const s = sMin + R() * (sMax - sMin)
    rock(part, Math.cos(a) * d, s * 0.12, Math.sin(a) * d, s, seed + i * 31, { squash: 0.55 + R() * 0.25, rough: 0.32, ao: 0.85 })
  }
}

/** Jagged break profile around a ring (game units above the ring's y). */
function breakProfile(seed: number, rr: number, tilt: number, jag: number) {
  const dir = rng(seed)() * TAU
  const edge = (a: number) => tilt * rr * Math.cos(a - dir) + jag * fbm3(Math.cos(a) * 1.6 + seed, Math.sin(a) * 1.6, seed * 0.1, seed, 3) * 2.2
  const cap = (a: number, rho: number) => edge(a) * (0.35 + 0.65 * rho) + jag * 0.5 * fbm3(Math.cos(a) * rho * 3, Math.sin(a) * rho * 3, seed + 3, seed + 7, 2) - (1 - rho) * jag * 0.25
  const span = Math.abs(tilt * rr) + jag * 1.2
  return { edge, cap, span }
}

/** Rounded-square stepped plinth with optional carved frieze on the first step. */
function plinth(part: Part, steps: { w: number; y0: number; y1: number; n?: number; frieze?: boolean }[], seed: number): void {
  const A = uniformAngles(36, Math.PI / 4 / 9)
  steps.forEach((s, k) => {
    const n = s.n ?? 4.5
    const shape = superRadius(n)
    const b = Math.min(4, (s.y1 - s.y0) * 0.2)
    const rings: Ring[] = [
      { y: s.y0, r: s.w, ao: k === 0 ? 0.35 : 0.55 },
      ...(s.frieze
        ? [
            { y: s.y0 + (s.y1 - s.y0) * 0.22, r: s.w, ao: 0.85, bv: 0 },
            { y: s.y0 + (s.y1 - s.y0) * 0.78, r: s.w, ao: 0.95, bv: 1 },
          ]
        : []),
      { y: s.y1 - b, r: s.w, ao: 1, bv: s.frieze ? 2 : -1 },
      { y: s.y1, r: s.w - b, ao: 1, bv: s.frieze ? 2 : -1 },
    ]
    // a chipped corner and soft weathering on the edges
    const chipA = rng(seed + k)() * TAU
    lathe(part, rings, {
      angles: A,
      shape,
      disp: (a, y) => {
        const chip = Math.max(0, Math.cos(a - chipA) - 0.93) * 60 * smooth(s.y0 + 4, s.y1, y)
        return fbm3(Math.cos(a) * 2.5, y / 22, Math.sin(a) * 2.5, seed + k, 2) * 2.2 - chip
      },
      cap: { rings: 1, h: (a, rho) => fbm3(Math.cos(a) * 3 * rho, Math.sin(a) * 3 * rho, seed, seed + k, 2) * 1.5 },
      bandCell: s.frieze ? 15 : undefined,
    })
  })
}

/**
 * Fluted column shaft between ys[0] and ys[last], optional jagged break on
 * top (cap) and a closed bottom (detachable chunks).
 */
function shaft(
  part: Part,
  rs: number,
  ys: number[],
  seed: number,
  o: { flutes?: number; taper?: number; brk?: ReturnType<typeof breakProfile> | null; bottom?: boolean; ox?: (y: number) => number; oz?: (y: number) => number; flat?: boolean } = {},
): void {
  const F = o.flutes ?? 14
  const A = uniformAngles(F * 4, seed * 0.13)
  const y0 = ys[0]
  const yN = ys[ys.length - 1]
  const taper = o.taper ?? 0.08
  const rings: Ring[] = ys.map((y, i) => {
    const t = (y - 0) / 300
    const last = i === ys.length - 1
    return { y, r: rs * (1 - taper * t * t - (i === 0 && y0 < 5 ? -0.02 : 0)), ox: o.ox?.(y), oz: o.oz?.(y), ao: last ? 1 : 0.95 }
  })
  const brk = o.brk
  lathe(part, rings, {
    angles: A,
    shape: (a) => {
      const ph = ((a - seed * 0.13) * F) / TAU
      const f = ph - Math.floor(ph)
      return 1 - 0.065 * Math.pow(Math.sin(Math.PI * f), 0.8)
    },
    disp: (a, y) => {
      const w = fbm3(Math.cos(a) * 2.2, y / 35, Math.sin(a) * 2.2, seed, 3) * 3.2
      // erosion bites, more toward the top and at the break
      const bite = Math.max(0, fbm3(Math.cos(a) * 3.5, y / 18, Math.sin(a) * 3.5, seed + 9, 2) - 0.12) * 18 * smooth(y0, yN + 40, y)
      return w - bite
    },
    ydisp: brk ? (a, i) => (i === rings.length - 1 ? brk.edge(a) : 0) : undefined,
    cap: brk ? { rings: 2, h: brk.cap, ao: 0.9 } : o.flat ? { rings: 1, h: (a, rho) => fbm3(Math.cos(a) * rho * 2, Math.sin(a) * rho * 2, seed, seed, 2) * 3 } : undefined,
    bottom: o.bottom,
  })
}

/** Torus-like base moulding between plinth and shaft. */
function moulding(part: Part, rs: number, y: number, seed: number): void {
  lathe(
    part,
    [
      { y: y - 1, r: rs * 1.2, ao: 0.6 },
      { y: y + 4, r: rs * 1.24 },
      { y: y + 8, r: rs * 1.16 },
      { y: y + 11, r: rs * 1.06 },
      { y: y + 14, r: rs * 1.02 },
    ],
    { angles: uniformAngles(40), disp: (a, yy) => fbm3(Math.cos(a) * 3, yy / 10, Math.sin(a) * 3, seed, 2) * 2.4, cap: { rings: 0 } },
  )
}

// ------------------------------------------------------------------ temple

function temple(variant: number, r: number, seed: number): PillarShape {
  const R = rng(seed * 7 + variant)
  const core = new Part((52 * Math.PI) / 180, MAT_STONE, 0)
  const c1 = new Part((52 * Math.PI) / 180, MAT_STONE, 1)
  const c2 = new Part((52 * Math.PI) / 180, MAT_STONE, 2)
  const rub = new Part((30 * Math.PI) / 180, MAT_RUBBLE, 0)
  const rs = r * 0.55
  const chunks: PillarShape['chunks'] = []
  let height = 0
  const v = ((variant % 5) + 5) % 5
  const jitter = 0.92 + R() * 0.16
  if (v === 0) {
    // broken stump on a two-step plinth, rune frieze, a fallen piece on top
    plinth(core, [
      { w: r * 0.9, y0: SINK, y1: 26, frieze: true },
      { w: r * 0.76, y0: 24, y1: 40 },
    ], seed)
    moulding(core, rs, 40, seed)
    const yb = 150 * jitter
    const b0 = breakProfile(seed + 1, rs, 0.32, 9)
    shaft(core, rs, [44, 80, 115, yb - b0.span - 4, yb], seed, { brk: b0 })
    const b1 = breakProfile(seed + 2, rs, -0.5, 12)
    shaft(c1, rs * 0.995, [yb - b0.span - 2, yb + 10, yb + 52], seed, { brk: b1, bottom: true })
    chunks.push({ x: 0, y: yb + 30, z: 0, size: rs })
    height = yb + 52 + b1.span * 0.5
    skirt(rub, R, r, 11, 0.86, 1.12, 5, 13, seed)
  } else if (v === 1) {
    // tall column with a capital; capital falls first, then the upper drum
    plinth(core, [
      { w: r * 0.88, y0: SINK, y1: 30, frieze: true },
    ], seed)
    moulding(core, rs * 0.95, 30, seed)
    const yTop = 245 * jitter
    const ySplit = yTop - 62
    const bc = breakProfile(seed + 3, rs, 0.2, 7)
    shaft(core, rs * 0.95, [34, 90, 140, ySplit - bc.span - 3, ySplit], seed, { brk: bc })
    shaft(c2, rs * 0.94, [ySplit - bc.span - 1, ySplit + 30, yTop], seed + 1, { bottom: true, flat: false })
    chunks.push({ x: 0, y: yTop + 14, z: 0, size: rs * 1.3 })
    chunks.push({ x: 0, y: ySplit + 30, z: 0, size: rs })
    // capital: echinus flare + square abacus (chipped corner)
    lathe(
      c1,
      [
        { y: yTop - 2, r: rs * 0.86, ao: 0.7 },
        { y: yTop + 4, r: rs * 0.98 },
        { y: yTop + 10, r: rs * 1.16 },
        { y: yTop + 14, r: rs * 1.26 },
      ],
      { angles: uniformAngles(32), disp: (a, y) => fbm3(Math.cos(a) * 3, y / 8, Math.sin(a) * 3, seed, 2) * 2, bottom: true, cap: { rings: 0 } },
    )
    const chipA = R() * TAU
    lathe(
      c1,
      [
        { y: yTop + 13, r: r * 0.74, ao: 0.6 },
        { y: yTop + 16, r: r * 0.78 },
        { y: yTop + 31, r: r * 0.78 },
        { y: yTop + 34, r: r * 0.74 },
      ],
      {
        angles: uniformAngles(36, Math.PI / 4 / 9),
        shape: superRadius(5),
        disp: (a, y) => fbm3(Math.cos(a) * 3, y / 9, Math.sin(a) * 3, seed + 5, 2) * 2.5 - Math.max(0, Math.cos(a - chipA) - 0.9) * 90,
        ydisp: (a, i) => (i >= 2 ? -Math.max(0, Math.cos(a - chipA) - 0.85) * 70 : 0),
        bottom: true,
        cap: { rings: 1, h: (a, rho) => fbm3(Math.cos(a) * 2 * rho, Math.sin(a) * 2 * rho, seed, seed + 2, 2) * 3 },
      },
    )
    height = yTop + 34
    skirt(rub, R, r, 8, 0.88, 1.1, 4, 10, seed)
  } else if (v === 2) {
    // tall carved pedestal block with a column stub
    const yb = 112 * jitter
    plinth(core, [
      { w: r * 0.92, y0: SINK, y1: 16, n: 6 },
      { w: r * 0.82, y0: 14, y1: yb, n: 6, frieze: true },
      { w: r * 0.87, y0: yb - 2, y1: yb + 12, n: 6 },
    ], seed)
    const rsS = rs * 0.82
    moulding(core, rsS, yb + 12, seed)
    const yt = yb + 78 * jitter
    const b0 = breakProfile(seed + 4, rsS, 0.25, 7)
    shaft(core, rsS, [yb + 16, yb + 40, yt - b0.span - 3, yt], seed, { brk: b0 })
    const b1 = breakProfile(seed + 6, rsS, 0.55, 10)
    shaft(c1, rsS * 0.99, [yt - b0.span - 1, yt + 14, yt + 46], seed, { brk: b1, bottom: true })
    chunks.push({ x: 0, y: yt + 26, z: 0, size: rsS })
    height = yt + 46
    skirt(rub, R, r, 9, 0.9, 1.12, 4, 10, seed)
  } else if (v === 3) {
    // steep diagonal break, mossy
    plinth(core, [
      { w: r * 0.9, y0: SINK, y1: 22 },
      { w: r * 0.78, y0: 20, y1: 36, frieze: true },
    ], seed)
    moulding(core, rs, 36, seed)
    const yb = 175 * jitter
    const b0 = breakProfile(seed + 7, rs, 0.45, 10)
    shaft(core, rs, [40, 90, 130, yb - b0.span - 3, yb], seed, { brk: b0 })
    const b1 = breakProfile(seed + 8, rs, 1.05, 8)
    shaft(c1, rs * 0.995, [yb - b0.span - 1, yb + 8, yb + 30], seed, { brk: b1, bottom: true })
    chunks.push({ x: 0, y: yb + 30, z: 0, size: rs })
    height = yb + 30 + b1.span * 0.6
    skirt(rub, R, r, 13, 0.84, 1.14, 5, 15, seed)
  } else {
    // two stacked drums, the upper one slipped off-centre
    plinth(core, [
      { w: r * 0.9, y0: SINK, y1: 24, frieze: true },
      { w: r * 0.78, y0: 22, y1: 38 },
    ], seed)
    moulding(core, rs, 38, seed)
    const y1 = 128 * jitter
    shaft(core, rs, [42, 85, y1], seed, { flat: true })
    const ox = (R() - 0.5) * r * 0.14
    const oz = (R() - 0.5) * r * 0.14
    const b1 = breakProfile(seed + 9, rs, 0.3, 9)
    const yt = y1 + 88 * jitter
    shaft(c1, rs * 0.98, [y1 + 1, y1 + 40, yt - b1.span - 3, yt], seed + 2, {
      brk: b1,
      bottom: true,
      ox: (y) => ox * smooth(y1, y1 + 4, y) + (y - y1) * 0.04 * Math.sign(ox),
      oz: (y) => oz * smooth(y1, y1 + 4, y),
    })
    chunks.push({ x: ox, y: y1 + 45, z: oz, size: rs })
    height = yt
    skirt(rub, R, r, 10, 0.86, 1.12, 5, 12, seed)
  }
  return { geometry: mergeParts([core, c1, c2, rub]), crystals: null, height, chunks, kind: 'temple' }
}

// ------------------------------------------------------------------ volcanic

interface HexOpts {
  rot?: number
  lean?: [number, number]
  joints?: number
  /** split height: everything above becomes chunk part `top` */
  split?: number
  topTilt?: number
  ao?: number
}

/** Chamfered, slightly irregular basalt column from below the floor to yTop. */
function hexColumn(core: Part, top: Part | null, cx: number, cz: number, Rc: number, yTop: number, seed: number, o: HexOpts = {}): void {
  const R = rng(seed)
  const rot = o.rot ?? R() * TAU
  const angles = polyAngles(6, 0.1, rot)
  const poly = polyRadius(6, rot)
  const jit = Array.from({ length: 6 }, () => 0.9 + R() * 0.16)
  const shape = (a: number, j: number) => poly(a) * jit[Math.floor(j / 2)]
  const lx = o.lean?.[0] ?? 0
  const lz = o.lean?.[1] ?? 0
  const ring = (y: number, rr: number, ao = 1): Ring => ({ y, r: rr, ox: cx + lx * Math.max(0, y), oz: cz + lz * Math.max(0, y), ao })
  const joints: number[] = []
  const nj = o.joints ?? Math.floor(yTop / 75)
  for (let i = 0; i < nj; i++) joints.push(30 + R() * (yTop - 60))
  if (o.split !== undefined) joints.push(o.split)
  joints.sort((a, b) => a - b)
  const all: Ring[] = [ring(SINK, Rc, 0.3), ring(8, Rc, 0.55)]
  for (const j of joints) {
    if (j < 14 || j > yTop - 12) continue
    all.push(ring(j - 2.5, Rc, 0.9), ring(j, Rc * 0.95, 0.6), ring(j + 2.5, Rc, 0.9))
  }
  const tiltDir = R() * TAU
  const tilt = o.topTilt ?? 0.12 + R() * 0.15
  const capTilt = (a: number, rho: number) => Math.cos(a - tiltDir) * tilt * Rc * rho + fbm3(Math.cos(a) * 2 * rho, Math.sin(a) * 2 * rho, seed, seed, 2) * 3
  const disp = (a: number, y: number) => fbm3(Math.cos(a) * 1.5, y / 50, Math.sin(a) * 1.5, seed, 2) * 1.6
  const chipCorner = Math.floor(R() * 6)
  const ydTop = (a: number, j: number) => Math.cos(a - tiltDir) * tilt * Rc - (Math.floor(j / 2) === chipCorner ? 7 + R() * 5 : 0)
  const finish = (rings: Ring[], part: Part, bottom: boolean) => {
    const last = rings.length - 1
    lathe(part, rings, {
      angles,
      shape,
      disp,
      ydisp: (a, i, j) => (i >= last - 1 ? ydTop(a, j) : 0),
      cap: { rings: 1, h: capTilt, ao: 1 },
      bottom,
    })
  }
  if (o.split !== undefined && top) {
    const s = o.split
    const lower = all.filter((rg) => rg.y <= s - 2.5)
    lower.push(ring(s, Rc * 0.95, 0.6))
    // broken core top under the chunk: rough, slightly domed
    lathe(core, lower, {
      angles,
      shape,
      disp,
      cap: { rings: 1, h: (a, rho) => fbm3(Math.cos(a) * 3 * rho, Math.sin(a) * 3 * rho, seed + 4, seed + 4, 2) * 6 + (1 - rho) * 2 },
    })
    const upper = [ring(s, Rc * 0.95, 0.6), ...all.filter((rg) => rg.y > s + 0.1), ring(yTop - 4, Rc, 1), ring(yTop, Rc * 0.93, 1)]
    finish(upper, top, true)
  } else {
    finish([...all, ring(yTop - 4, Rc, 1), ring(yTop, Rc * 0.93, 1)], core, false)
  }
}

/** Honeycomb neighbours (centre + 6 around), each fitting inside radius r. */
function honeycomb(r: number, fill: number): { x: number; z: number; Rc: number }[] {
  const Rc = (r * fill) / 2.732
  const d = 2 * Rc * Math.cos(Math.PI / 6) * 1.02
  const out = [{ x: 0, z: 0, Rc }]
  for (let k = 0; k < 6; k++) {
    const a = Math.PI / 6 + (k / 6) * TAU
    out.push({ x: Math.cos(a) * d, z: Math.sin(a) * d, Rc })
  }
  return out
}

function volcanic(variant: number, r: number, seed: number, rockpillar = false): PillarShape {
  const R = rng(seed * 13 + variant)
  const core = new Part((32 * Math.PI) / 180, MAT_STONE, 0)
  const c1 = new Part((32 * Math.PI) / 180, MAT_STONE, 1)
  const c2 = new Part((32 * Math.PI) / 180, MAT_STONE, 2)
  const rub = new Part((30 * Math.PI) / 180, MAT_RUBBLE, 0)
  const glass = new Part((28 * Math.PI) / 180, MAT_GLASS, 0)
  const chunks: PillarShape['chunks'] = []
  let height = 0
  const v = rockpillar ? -1 : ((variant % 4) + 4) % 4
  const jitter = 0.92 + R() * 0.16
  if (v === 0 || v === -1) {
    // cluster of hex columns; centre tallest
    const cells = honeycomb(r, rockpillar ? 1.02 : 1.0)
    const rot = Math.PI / 6
    const hs = cells.map((_, i) => (i === 0 ? (rockpillar ? 285 : 270) * jitter : (rockpillar ? 120 : 95) + R() * 130))
    // drop one or two outer columns (rubble instead) for a broken silhouette
    const skip = new Set<number>()
    if (!rockpillar) {
      skip.add(1 + Math.floor(R() * 6))
      if (R() < 0.6) skip.add(1 + Math.floor(R() * 6))
    }
    // tallest outer column carries chunk 2
    let tallOuter = 1
    for (let i = 1; i < cells.length; i++) if (!skip.has(i) && hs[i] > hs[tallOuter]) tallOuter = i
    cells.forEach((c, i) => {
      if (skip.has(i)) {
        rock(rub, c.x, 6, c.z, c.Rc * 0.9, seed + i, { squash: 0.6, rough: 0.35 })
        return
      }
      const lean: [number, number] = i === 0 ? [0, 0] : [c.x * 0.0006, c.z * 0.0006]
      const Rc = c.Rc * 0.95
      if (i === 0) {
        const split = hs[0] - 60 - R() * 30
        hexColumn(core, c1, c.x, c.z, Rc, hs[0], seed + i * 7, { rot, lean, split })
        chunks.push({ x: c.x, y: (split + hs[0]) / 2, z: c.z, size: Rc })
      } else if (i === tallOuter) {
        const split = hs[i] * 0.62
        hexColumn(core, c2, c.x, c.z, Rc, hs[i], seed + i * 7, { rot, lean, split })
        chunks.push({ x: c.x, y: (split + hs[i]) / 2, z: c.z, size: Rc })
      } else hexColumn(core, null, c.x, c.z, Rc, hs[i], seed + i * 7, { rot, lean })
    })
    if (chunks.length < 2) chunks.push(chunks[0])
    height = hs[0]
    skirt(rub, R, r, rockpillar ? 16 : 12, 0.84, 1.14, rockpillar ? 7 : 5, rockpillar ? 17 : 13, seed)
    if (rockpillar) {
      // torn-up floor plates tilted outward around the eruption
      for (let i = 0; i < 9; i++) {
        const a = (i / 9) * TAU + R() * 0.5
        const d = r * (0.98 + R() * 0.16)
        rock(rub, Math.cos(a) * d, 2, Math.sin(a) * d, 13 + R() * 8, seed + 100 + i, { squash: 0.28, rough: 0.12, flat: -0.6 })
      }
    }
  } else if (v === 1) {
    // single fat column, slight lean, cracked top
    const yTop = 245 * jitter
    const split = yTop - 70
    hexColumn(core, c1, 0, 0, r * 1.04, yTop, seed, { lean: [(R() - 0.5) * 0.08, (R() - 0.5) * 0.08], split, joints: 3 })
    chunks.push({ x: 0, y: yTop - 35, z: 0, size: r * 0.9 })
    // a short satellite stub fused to the side (inside the footprint)
    const a = R() * TAU
    hexColumn(core, c2, Math.cos(a) * r * 0.42, Math.sin(a) * r * 0.42, r * 0.55, 120 + R() * 40, seed + 3, { split: 70 })
    chunks.push({ x: Math.cos(a) * r * 0.42, y: 100, z: Math.sin(a) * r * 0.42, size: r * 0.5 })
    height = yTop
    skirt(rub, R, r, 10, 0.95, 1.18, 5, 12, seed)
  } else if (v === 2) {
    // obsidian shard cluster on a basalt mound
    rock(core, 0, 6, 0, r * 0.8, seed, { detail: 1, squash: 0.45, rough: 0.3, ao: 0.8 })
    const up = new THREE.Vector3(0, 1, 0)
    shard(glass, new THREE.Vector3(0, SINK, 0), up.clone().add(new THREE.Vector3((R() - 0.5) * 0.08, 0, (R() - 0.5) * 0.08)), 285 * jitter, r * 0.42, 5, seed, { tipLen: 0.32 })
    const n = 6
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU + R() * 0.6
      const d = r * (0.3 + R() * 0.15)
      const lean = 0.1 + R() * 0.12
      const len = 95 + R() * 120
      const dir = new THREE.Vector3(Math.cos(a) * lean, 1, Math.sin(a) * lean).normalize()
      const part = i === 0 ? c1 : i === 3 ? c2 : glass
      shard(part, new THREE.Vector3(Math.cos(a) * d, SINK, Math.sin(a) * d), dir, len, r * (0.2 + R() * 0.08), 4 + (i % 2), seed + i * 5, { tipLen: 0.35 })
      if (i === 0 || i === 3) chunks.push({ x: Math.cos(a) * d, y: len * 0.5, z: Math.sin(a) * d, size: r * 0.22 })
    }
    height = 285 * jitter
    skirt(rub, R, r, 12, 0.8, 1.12, 4, 11, seed)
  } else {
    // stepped causeway stack
    const cells = honeycomb(r, 1.04)
    const rot = Math.PI / 6
    const start = 1 + Math.floor(R() * 6)
    const order = [0, start, 1 + (start % 6), 1 + ((start + 4) % 6), 1 + ((start + 1) % 6)]
    const hs = [250 * jitter, 190 * jitter, 145 * jitter, 110 * jitter, 70 * jitter]
    order.forEach((ci, k) => {
      const c = cells[ci]
      const Rc = c.Rc * 0.95
      if (k === 0) {
        const split = hs[0] - 55
        hexColumn(core, c1, c.x, c.z, Rc, hs[0], seed + k * 9, { rot, split })
        chunks.push({ x: c.x, y: hs[0] - 27, z: c.z, size: Rc })
      } else if (k === 1) {
        const split = hs[1] - 50
        hexColumn(core, c2, c.x, c.z, Rc, hs[1], seed + k * 9, { rot, split })
        chunks.push({ x: c.x, y: hs[1] - 25, z: c.z, size: Rc })
      } else hexColumn(core, null, c.x, c.z, Rc, hs[k], seed + k * 9, { rot })
    })
    height = hs[0]
    skirt(rub, R, r, 9, 0.86, 1.12, 4, 11, seed)
  }
  return { geometry: mergeParts([core, c1, c2, rub, glass]), crystals: null, height, chunks, kind: 'volcanic' }
}

// ------------------------------------------------------------------ overgrown

/** Weathered standing stone (slab cross-section), optional detachable top. */
function menhir(core: Part, top: Part | null, o: { x: number; z: number; w: number; d: number; h: number; lean?: [number, number]; rot?: number; split?: number; n?: number; seed: number; band?: [number, number] }): void {
  const { seed } = o
  const rot = o.rot ?? 0
  const sh = superRadius(o.n ?? 2.6, 1, o.d / o.w)
  const shape = (a: number) => sh(a - rot)
  const lx = o.lean?.[0] ?? 0
  const lz = o.lean?.[1] ?? 0
  const prof = [
    [SINK, 1.0],
    [0, 1.0],
    [0.2, 0.98],
    [0.42, 0.95],
    [0.62, 0.9],
    [0.78, 0.82],
    [0.88, 0.7],
    [0.95, 0.5],
    [1.0, 0.18],
  ]
  const ring = (t: number, m: number): Ring => {
    const y = t <= 0 ? t : t * o.h
    // carving band: v 0..1 between band[0] and band[1] (fraction of h), outside < 0 or > 1
    const bv = o.band ? (t - o.band[0]) / (o.band[1] - o.band[0]) : -1
    return { y, r: o.w * m, ox: o.x + lx * Math.max(0, y), oz: o.z + lz * Math.max(0, y), ao: t <= 0 ? 0.4 : 1, bv: o.band ? (bv < 0 ? -1 : bv > 1 ? 2 : bv) : -1 }
  }
  const disp = (a: number, y: number) => {
    const ca = Math.cos(a)
    const sa = Math.sin(a)
    const big = fbm3(ca * 1.2 + seed, y / 90, sa * 1.2, seed, 3) * o.w * 0.22
    const chip = (Math.abs(fbm3(ca * 4, y / 28, sa * 4, seed + 5, 2)) - 0.1) * o.w * -0.12
    return big + chip
  }
  const A = uniformAngles(26, rot)
  const rings = prof.map(([t, m]) => ring(t, m))
  if (o.split !== undefined && top) {
    const ts = o.split
    const ms = 0.95 - (ts - 0.42) * 0.6
    const lower = rings.filter((rg) => rg.y < ts * o.h - 2)
    lower.push(ring(ts, ms))
    const brk = breakProfile(seed + 11, o.w, 0.18, 6)
    const bandCell = o.band ? 18 : undefined
    lathe(core, lower, { angles: A, shape, disp, bandCell, ydisp: (a, i) => (i === lower.length - 1 ? brk.edge(a) * 0.5 : 0), cap: { rings: 2, h: (a, rho) => brk.cap(a, rho) * 0.5, ao: 0.95 } })
    const upper = [ring(ts, ms), ...rings.filter((rg) => rg.y > ts * o.h + 2)]
    lathe(top, upper, { angles: A, shape, disp, bandCell, ydisp: (a, i) => (i === 0 ? brk.edge(a) * 0.5 - 1 : 0), cap: { rings: 1 }, bottom: true })
  } else {
    lathe(core, rings, { angles: A, shape, disp, cap: { rings: 1 }, bandCell: o.band ? 18 : undefined })
  }
}

/** Green crystal cluster (separate emissive mesh). */
function crystalCluster(part: Part, x: number, y: number, z: number, n: number, size: number, seed: number, out = 0.35): void {
  const R = rng(seed)
  for (let i = 0; i < n; i++) {
    const a = R() * TAU
    const lean = (i === 0 ? 0.1 : out) + R() * 0.25
    const dir = new THREE.Vector3(Math.cos(a) * lean, 1, Math.sin(a) * lean).normalize()
    const len = size * (i === 0 ? 1 : 0.45 + R() * 0.45)
    const w = size * (0.13 + R() * 0.06)
    const off = i === 0 ? 0 : size * 0.12
    shard(part, new THREE.Vector3(x + Math.cos(a) * off, y - size * 0.15, z + Math.sin(a) * off), dir, len, w, 6, seed + i * 3, { tipLen: 0.28 })
  }
}

function overgrown(variant: number, r: number, seed: number): PillarShape {
  const R = rng(seed * 17 + variant)
  const crease = (60 * Math.PI) / 180
  const core = new Part(crease, MAT_STONE, 0)
  const c1 = new Part(crease, MAT_STONE, 1)
  const c2 = new Part(crease, MAT_STONE, 2)
  const rub = new Part((30 * Math.PI) / 180, MAT_RUBBLE, 0)
  const wood = new Part((70 * Math.PI) / 180, MAT_WOOD, 0)
  const cry = new Part((20 * Math.PI) / 180, MAT_GLASS, 0)
  const chunks: PillarShape['chunks'] = []
  let height = 0
  const v = ((variant % 5) + 5) % 5
  const jitter = 0.92 + R() * 0.16
  if (v === 0) {
    // big mossy menhir
    const h = 235 * jitter
    menhir(core, c1, { x: 0, z: 0, w: r * 0.9, d: r * 0.66, h, rot: R() * TAU, lean: [(R() - 0.5) * 0.1, (R() - 0.5) * 0.1], split: 0.7, seed })
    chunks.push({ x: 0, y: h * 0.85, z: 0, size: r * 0.6 })
    chunks.push({ x: 0, y: h * 0.85, z: 0, size: r * 0.5 })
    const a = R() * TAU
    crystalCluster(cry, Math.cos(a) * r * 0.8, 4, Math.sin(a) * r * 0.8, 4, 34, seed + 3, 0.5)
    height = h
    skirt(rub, R, r, 10, 0.86, 1.14, 5, 12, seed)
  } else if (v === 1) {
    // pair of leaning stones touching at the top, a small lintel on them
    const rot = R() * TAU
    const ca = Math.cos(rot)
    const sa = Math.sin(rot)
    const h = 205 * jitter
    for (const s of [-1, 1]) {
      const bx = ca * s * r * 0.42
      const bz = sa * s * r * 0.42
      const lean = -0.17
      menhir(core, null, { x: bx, z: bz, w: r * 0.4, d: r * 0.28, h: h * (s > 0 ? 1 : 0.94), rot: rot + Math.PI / 2, lean: [ca * s * lean * 0.9, sa * s * lean * 0.9], seed: seed + s * 7, n: 3 })
    }
    // lintel resting across the touching tops
    rock(c1, 0, h * 0.93, 0, r * 0.42, seed + 21, { detail: 1, squash: 0.42, rough: 0.2, rotY: -rot, flat: -0.6 })
    chunks.push({ x: 0, y: h * 0.92, z: 0, size: r * 0.45 })
    chunks.push({ x: 0, y: h * 0.7, z: 0, size: r * 0.3 })
    height = h + 26
    skirt(rub, R, r, 9, 0.8, 1.12, 4, 11, seed)
  } else if (v === 2) {
    // ruined column gripped by roots
    const rs = r * 0.6
    plinth(core, [{ w: r * 0.88, y0: SINK, y1: 22 }], seed)
    moulding(core, rs, 22, seed)
    const yb = 180 * jitter
    const b0 = breakProfile(seed + 1, rs, 0.3, 8)
    shaft(core, rs, [26, 80, 130, yb - b0.span - 3, yb], seed, { brk: b0, flutes: 12 })
    const b1 = breakProfile(seed + 2, rs, 0.6, 9)
    shaft(c1, rs * 0.99, [yb - b0.span - 1, yb + 12, yb + 40], seed, { brk: b1, bottom: true, flutes: 12 })
    chunks.push({ x: 0, y: yb + 25, z: 0, size: rs })
    chunks.push({ x: 0, y: yb + 25, z: 0, size: rs * 0.7 })
    const nr = 3
    for (let k = 0; k < nr; k++) {
      const a0 = (k / nr) * TAU + R() * 0.8
      const turns = 0.55 + R() * 0.35
      const yTop = yb - 10 - R() * 40
      const pts: THREE.Vector3[] = []
      const steps = 9
      for (let i = 0; i <= steps; i++) {
        const t = i / steps
        const a = a0 + t * turns * TAU
        const y = yTop * (1 - t) + 4 * t
        const rr = rs * 1.08 + 4 + (t > 0.8 ? (t - 0.8) * 5 * r * 0.45 : 0)
        pts.push(new THREE.Vector3(Math.cos(a) * rr, y, Math.sin(a) * rr))
      }
      // flare onto the floor and dive in
      const aEnd = a0 + turns * TAU
      pts.push(new THREE.Vector3(Math.cos(aEnd + 0.25) * r * 1.12, 1, Math.sin(aEnd + 0.25) * r * 1.12))
      pts.push(new THREE.Vector3(Math.cos(aEnd + 0.4) * r * 1.2, -6, Math.sin(aEnd + 0.4) * r * 1.2))
      sweep(wood, pts, (t) => 2 + 5.5 * Math.sin(Math.PI * Math.min(1, t * 1.15 + 0.08)) * (1 - t * 0.45), 5, 0.85)
    }
    height = yb + 40
    skirt(rub, R, r, 7, 0.88, 1.12, 4, 9, seed)
  } else if (v === 3) {
    // squat boulder split by a crystal growth
    rock(core, 0, 22, 0, r * 0.98, seed, { detail: 2, squash: 1.05, rough: 0.22, flat: -0.45 })
    rock(c1, r * 0.12, 82, -r * 0.05, r * 0.52, seed + 1, { detail: 1, squash: 0.8, rough: 0.25 })
    chunks.push({ x: r * 0.12, y: 82, z: -r * 0.05, size: r * 0.5 })
    chunks.push({ x: 0, y: 60, z: 0, size: r * 0.4 })
    const a = R() * TAU
    crystalCluster(cry, Math.cos(a) * r * 0.42, 40, Math.sin(a) * r * 0.42, 6, 70, seed + 5, 0.42)
    height = 115
    skirt(rub, R, r, 8, 0.9, 1.15, 4, 10, seed)
  } else {
    // carved stele with glowing spiral runes
    const h = 245 * jitter
    const rot = R() * TAU
    menhir(core, c1, { x: 0, z: 0, w: r * 0.92, d: r * 0.42, h, rot, n: 4.5, split: 0.76, seed, band: [0.2, 0.62] })
    chunks.push({ x: 0, y: h * 0.88, z: 0, size: r * 0.5 })
    chunks.push({ x: 0, y: h * 0.88, z: 0, size: r * 0.4 })
    height = h
    skirt(rub, R, r, 9, 0.88, 1.14, 4, 11, seed)
  }
  return { geometry: mergeParts([core, c1, c2, rub, wood]), crystals: cry.idx.length ? mergeParts([cry]) : null, height, chunks, kind: 'overgrown' }
}

// ------------------------------------------------------------------ entry

export function buildPillar(theme: number, variant: number, radius: number, seed: number): PillarShape {
  const s = Math.floor(Math.abs(seed)) % 100000
  if (variant < 0) return volcanic(-1, radius, s, true)
  const t = ((theme % 3) + 3) % 3
  if (t === 0) return temple(variant, radius, s)
  if (t === 1) return volcanic(variant, radius, s)
  return overgrown(variant, radius, s)
}
