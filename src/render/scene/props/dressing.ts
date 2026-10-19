import * as THREE from 'three/webgpu'
import {
  abs,
  attribute,
  bumpMap,
  dot,
  exp,
  float,
  fract,
  max,
  mix,
  normalView,
  normalWorld,
  positionGeometry,
  positionLocal,
  positionView,
  positionWorld,
  pow,
  saturate,
  sin,
  smoothstep,
  step,
  texture,
  time,
  uniform,
  uv,
  vec2,
  vec3,
} from 'three/tsl'
import type { Node } from 'three/webgpu'
import { layerRadius } from '../../arenaGeom'
import { S } from '../../coords'
import { getNoiseTexture } from '../noiseTexture'
import { loadSurface, type SurfaceMaps } from '../textures'
import { staticInstancedMesh, type WorldCtx } from '../world'
import { MAT_STONE, Part, lathe, mergeParts, polyAngles, polyRadius, rock, shard, superRadius, sweep, uniformAngles } from './geo'
import { fbm3, rng } from './rng'

/**
 * Caldera rim around the platform (art: art/archive/env/rim_a, the splash):
 * a ring of basalt cliffs with columnar jointing rising out of the lava,
 * mossy plateau tops, jagged spires (in the lava band, at the cliff foot and
 * on the plateau), broken temple arches on the rim, clusters of glowing green
 * crystals, lava falls pouring down the inner faces, a distant volcano and a
 * moonlit sky dome. Everything is static geometry built once per platform
 * radius; animation is shader time. Themes only swap uniforms.
 *
 * Gameplay camera (60 degrees, ~2000 across) only sees ~940 units past its
 * focus, so the rim hugs the platform: open lava band of LAVA_GAP, then the
 * cliff foot. Nothing tall stands inside the band (pawns knocked into lava
 * stay visible); band spires are low and sparse.
 */

const LAVA_GAP = 620
const SEG = 384
const COL = 3 // segments per basalt column
const DRESSING_SECTORS = 8

interface ThemePal {
  rock: [number, number, number]
  moss: [number, number, number]
  mossAmt: number
  crystal: [number, number, number]
  fall: number
}

const PALS: ThemePal[] = [
  // temple: warm grey stone, moderate moss
  { rock: [0.95, 0.88, 0.8], moss: [0.75, 0.9, 0.55], mossAmt: 0.55, crystal: [0.12, 1.9, 0.6], fall: 1 },
  // volcanic: black basalt, scorched tops, hotter falls
  { rock: [0.55, 0.52, 0.55], moss: [0.45, 0.5, 0.35], mossAmt: 0.18, crystal: [0.15, 2.1, 0.55], fall: 1.35 },
  // overgrown: mossier, greener
  { rock: [0.85, 0.86, 0.8], moss: [0.8, 1.0, 0.55], mossAmt: 0.9, crystal: [0.1, 2.0, 0.65], fall: 0.85 },
]

export interface ArenaDressing {
  readonly object3d: THREE.Group
  update(dt: number): void
  setTheme(theme: number): void
  /** rebuild the rim for a new platform radius (game units) */
  setPlatformRadius(r: number): void
  dispose(): void
}

export interface ArenaDressingOpts {
  theme: 0 | 1 | 2
  /** largest platform radius this match (game units), e.g. layerRadius(shop layer) */
  platformRadius: number
  /** texture anisotropy (default 4) */
  anisotropy?: number
}

// ------------------------------------------------------------------ cliff profile

interface Rim {
  Rc: number
  /** cliff top height per segment */
  H: Float32Array
  /** set-back of the upper wall behind the mossy ledge */
  ledge: Float32Array
  /** columnar radial offset per segment */
  off: Float32Array
  /** column top jitter per segment */
  topJ: Float32Array
}

function rimShape(R: number, seed: number): Rim {
  const Rc = R + LAVA_GAP
  const H = new Float32Array(SEG + 1)
  const ledge = new Float32Array(SEG + 1)
  const off = new Float32Array(SEG + 1)
  const topJ = new Float32Array(SEG + 1)
  const rnd = rng(seed)
  const cols = SEG / COL
  const colOff = Array.from({ length: cols }, () => (rnd() - 0.5) * 84)
  const colTop = Array.from({ length: cols }, () => (rnd() - 0.5) * 60)
  for (let j = 0; j <= SEG; j++) {
    const jj = j % SEG
    const a = (jj / SEG) * Math.PI * 2
    const ca = Math.cos(a)
    const sa = Math.sin(a)
    // big rhythm of high crags and low saddles, never a flat ring
    const crag = Math.pow(Math.max(0, fbm3(ca * 3.3, sa * 3.3, 2.1, seed + 3, 2) * 2 + 0.25), 1.6) * 900
    const h = 520 + fbm3(ca * 1.4, sa * 1.4, 0.3, seed, 3) * 900 + crag
    H[j] = Math.max(240, h)
    ledge[j] = Math.max(0, fbm3(ca * 5, sa * 5, 8.8, seed + 21, 2) * 2 + 0.35) * 75
    const c = Math.floor(jj / COL)
    // outcrops: low-frequency bulges on top of the per-column steps
    off[j] = colOff[c] + fbm3(ca * 4, sa * 4, 5.5, seed + 9, 2) * 90
    topJ[j] = colTop[c]
  }
  return { Rc, H, ledge, off, topJ }
}

/** Radial profile: [radius offset from Rc, height] for ring i at segment j. */
function profile(rim: Rim, j: number, i: number): [number, number] {
  const H = rim.H[j]
  const o = rim.off[j]
  const t = rim.topJ[j]
  const a = ((j % SEG) / SEG) * Math.PI * 2
  const n = (k: number) => fbm3(Math.cos(a) * 2.5, Math.sin(a) * 2.5, k, 77, 2)
  const L = rim.ledge[j]
  const yl = Math.min(H * 0.45, 320) + n(0) * 40
  switch (i) {
    case 0:
      return [-70 + o, -90]
    case 1:
      return [-40 + o, 0]
    case 2:
      return [-24 + o + n(1) * 30, yl * 0.55]
    case 3:
      return [-12 + o + n(2) * 20, yl]
    case 4:
      // mossy ledge: the upper wall stands back
      return [-8 + L + o * 0.8, yl + 6 + L * 0.1]
    case 5:
      return [L + o * 0.9 + n(3) * 24, yl + (H - yl) * 0.6 + t * 0.4]
    case 6:
      return [14 + L + o * 0.6, H + t]
    case 7:
      return [70 + L + o * 0.3, H + t * 0.4 + 6]
    case 8:
      return [300 + L, H + 30 + n(4) * 60]
    case 9:
      return [650, H + 70 + n(5) * 140]
    case 10:
      return [1000, H + 260 + n(6) * 240]
    case 11:
      return [1550, H + 800 + n(7) * 520]
    case 12:
      return [2300, H + 1350 + n(8) * 800]
    case 13:
      return [3200, H + 1100 + n(9) * 700]
    default:
      return [4600, H + 300]
  }
}
const RINGS = 15

function cliffGeometry(rim: Rim): THREE.BufferGeometry {
  const part = new Part((38 * Math.PI) / 180, MAT_STONE, 0)
  const ids: number[][] = []
  for (let i = 0; i < RINGS; i++) {
    const row: number[] = []
    for (let j = 0; j <= SEG; j++) {
      const a = (j / SEG) * Math.PI * 2
      const [dr, y] = profile(rim, j, i)
      const r = rim.Rc + dr
      // cavity: the joints between columns and the waterline are dark
      const ao = i <= 1 ? 0.45 : i === 3 ? 0.55 : i <= 6 ? ((j % COL) === 0 ? 0.35 : 0.9) : 1
      row.push(part.v(Math.cos(a) * r, y, -Math.sin(a) * r, ao))
    }
    ids.push(row)
  }
  // the inner wall faces the centre, the plateau faces up (z = -sin a winds clockwise)
  for (let i = 0; i + 1 < RINGS; i++) {
    for (let j = 0; j < SEG; j++) {
      const a = ids[i][j]
      const b = ids[i][j + 1]
      const c = ids[i + 1][j + 1]
      const d = ids[i + 1][j]
      part.idx.push(a, c, b, a, d, c)
    }
  }
  return mergeParts([part])
}

// ------------------------------------------------------------------ spires, arches

function spireGeometry(seed: number): THREE.BufferGeometry {
  const part = new Part((34 * Math.PI) / 180)
  const R = rng(seed)
  const sides = 5 + Math.floor(R() * 3)
  const rot = R() * Math.PI
  const angles = polyAngles(sides, 0.12, rot)
  const poly = polyRadius(sides, rot)
  const jit = Array.from({ length: sides }, () => 0.75 + R() * 0.45)
  // unit spire: base radius 1 at y = 0, height 1 (scaled per instance)
  const prof: [number, number][] = [
    [-0.08, 1.05],
    [0, 1],
    [0.18, 0.86],
    [0.36, 0.7],
    [0.52, 0.55],
    [0.66, 0.4],
    [0.78, 0.27],
    [0.88, 0.15],
    [0.95, 0.07],
  ]
  const lean = (R() - 0.5) * 0.12
  lathe(
    part,
    prof.map(([y, r]) => ({ y, r, ox: lean * y * y, oz: 0, ao: y <= 0 ? 0.4 : 1 })),
    {
      angles,
      shape: (a, j) => poly(a) * jit[Math.floor(j / 2)],
      disp: (a, y) => fbm3(Math.cos(a) * 1.5, y * 3, Math.sin(a) * 1.5, seed, 3) * 0.32,
      ydisp: (_a, i, j) => (i >= prof.length - 2 ? (Math.floor(j / 2) % 2 ? 0.02 : -0.03) : 0),
      cap: { rings: 0, h: () => 0.06 },
    },
  )
  return mergeParts([part])
}

function archGeometry(seed: number): THREE.BufferGeometry {
  const part = new Part((40 * Math.PI) / 180)
  const R = rng(seed)
  const span = 300
  const pierW = 62
  const pierH = 300
  const A = uniformAngles(16, Math.PI / 4 / 4)
  // two piers (one broken lower), square-ish
  for (const s of [-1, 1]) {
    const h = s < 0 ? pierH : pierH * (0.55 + R() * 0.2)
    lathe(
      part,
      [
        { y: -40, r: pierW * 1.15, ox: s * span * 0.5 },
        { y: 20, r: pierW * 1.15, ox: s * span * 0.5 },
        { y: 28, r: pierW, ox: s * span * 0.5 },
        { y: h * 0.5, r: pierW * 0.98, ox: s * span * 0.5 },
        { y: h, r: pierW * 0.96, ox: s * span * 0.5 },
      ],
      { angles: A, shape: superRadius(6), disp: (a, y) => fbm3(Math.cos(a) * 2, y / 40, Math.sin(a) * 2, seed + s, 2) * 7, cap: { rings: 1, h: (a, rho) => fbm3(Math.cos(a) * rho * 2, Math.sin(a) * rho * 2, seed, seed + s, 2) * 26 } },
    )
  }
  // the arch springs from the tall pier and breaks off past the crown
  const pts: THREE.Vector3[] = []
  const end = 0.62 + R() * 0.12
  for (let k = 0; k <= 10; k++) {
    const t = (k / 10) * end
    const a = Math.PI * (1 - t)
    pts.push(new THREE.Vector3(Math.cos(a) * span * 0.5, pierH + Math.sin(a) * span * 0.5 - 6, 0))
  }
  sweep(part, pts, (t) => 44 * (1 - t * 0.12), 4, 0.9)
  // a ruined wall stub behind and rubble
  for (let i = 0; i < 7; i++) rock(part, (R() - 0.5) * span * 1.3, 8, (R() - 0.5) * 120, 22 + R() * 30, seed + i * 7, { squash: 0.6 })
  return mergeParts([part])
}

function crystalUnit(): THREE.BufferGeometry {
  const part = new Part((20 * Math.PI) / 180)
  shard(part, new THREE.Vector3(0, -0.15, 0), new THREE.Vector3(0, 1, 0), 1, 0.16, 6, 5, { tipLen: 0.26 })
  return mergeParts([part])
}

function fallGeometry(rim: Rim, j: number, width: number): THREE.BufferGeometry {
  // ribbon down the inner face, a hand's width in front of the rock
  const a = (j / SEG) * Math.PI * 2
  const dir = new THREE.Vector3(Math.cos(a), 0, -Math.sin(a))
  const side = new THREE.Vector3(-dir.z, 0, dir.x)
  const pts: [number, number][] = []
  const [r7, y7] = profile(rim, j, 7)
  pts.push([r7 + 120, y7 + 4], [r7 + 30, y7 + 8])
  for (let i = 6; i >= 1; i--) {
    const [dr, y] = profile(rim, j, i)
    pts.push([dr - 18, y + (i === 6 ? 6 : 0)])
  }
  pts.push([-60, -20])
  const pos: number[] = []
  const uvs: number[] = []
  const idx: number[] = []
  let v = 0
  for (let k = 0; k < pts.length; k++) {
    const [dr, y] = pts[k]
    if (k > 0) {
      const [pr, py] = pts[k - 1]
      v += Math.hypot(dr - pr, y - py)
    }
    const r = rim.Rc + dr
    // channel on the plateau, spreading as it falls, a fan where it meets the lava
    const t = k / (pts.length - 1)
    const w = width * (k < 2 ? 0.45 : 0.7 + t * 0.9)
    for (let s = 0; s <= 4; s++) {
      const x = s / 4 - 0.5
      // slightly convex sheet, edges tucked toward the rock
      const bulge = (1 - 4 * x * x) * 10
      pos.push(dir.x * (r - bulge) + side.x * w * x, y, dir.z * (r - bulge) + side.z * w * x)
      uvs.push(s / 4, v / 400)
    }
  }
  for (let k = 0; k + 1 < pts.length; k++) {
    for (let s = 0; s < 4; s++) {
      const i0 = k * 5 + s
      idx.push(i0, i0 + 5, i0 + 1, i0 + 1, i0 + 5, i0 + 6)
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  g.setIndex(idx)
  g.computeVertexNormals()
  return g
}

function volcanoGeometry(): THREE.BufferGeometry {
  const part = new Part((50 * Math.PI) / 180)
  const rings: { y: number; r: number }[] = [
    { y: -200, r: 4200 },
    { y: 400, r: 3400 },
    { y: 1200, r: 2400 },
    { y: 2100, r: 1500 },
    { y: 2900, r: 820 },
    { y: 3350, r: 560 },
    { y: 3300, r: 420 },
    { y: 3000, r: 300 },
  ]
  lathe(part, rings, {
    angles: uniformAngles(40),
    disp: (a, y) => fbm3(Math.cos(a) * 2, y / 900, Math.sin(a) * 2, 31, 3) * 600 * (1 - y / 4000),
    ydisp: (a, i) => (i >= 5 ? fbm3(Math.cos(a) * 3, 0, Math.sin(a) * 3, 32, 2) * 400 : 0),
    cap: { rings: 0, h: () => -150 },
  })
  return mergeParts([part])
}

// ------------------------------------------------------------------ materials

interface DressMats {
  rock: THREE.MeshStandardNodeMaterial
  crystal: THREE.MeshStandardNodeMaterial
  fall: THREE.MeshBasicNodeMaterial
  volcano: THREE.MeshStandardNodeMaterial
  sky: THREE.MeshBasicNodeMaterial
}

function tri(tex: THREE.Texture, p: Node<'vec3'>, n: Node<'vec3'>, scale: number): Node<'vec4'> {
  let w = pow(abs(n), vec3(4))
  w = w.div(w.x.add(w.y).add(w.z))
  const s = float(scale)
  return texture(tex, vec2(p.z, p.y).mul(s))
    .mul(w.x)
    .add(texture(tex, vec2(p.x, p.z).mul(s)).mul(w.y))
    .add(texture(tex, vec2(p.x, p.y).mul(s)).mul(w.z)) as unknown as Node<'vec4'>
}

type U3 = ReturnType<typeof makeU3>
const makeU3 = () => uniform(new THREE.Color())
type U1 = ReturnType<typeof makeU1>
const makeU1 = () => uniform(0)

interface Uniforms {
  rock: U3
  moss: U3
  mossAmt: U1
  crystal: U3
  fall: U1
  /** radial offset (game units) from the build radius to the current platform: vertex stage only */
  shift: U1
}

/**
 * The rim is built once; a different platform radius slides every vertex
 * along its own radial direction (instancing is applied before positionNode,
 * so instanced spires move as wholes). No rebuild, no upload, no hitch.
 */
const radial = (u: Uniforms): Node<'vec3'> => positionLocal.add(vec3(positionLocal.x, 0, positionLocal.z).normalize().mul(u.shift))

function rockMaterial(u: Uniforms, rockMaps: SurfaceMaps | null, mossMaps: SurfaceMaps | null, basalt: SurfaceMaps | null): THREE.MeshStandardNodeMaterial {
  const noise = getNoiseTexture()
  const p = positionWorld.div(S)
  const n = normalWorld
  const info = attribute('aInfo', 'vec3') as unknown as Node<'vec3'>
  const nz = tri(noise, p, n, 1 / 900)
  const nzF = tri(noise, p, n, 1 / 260)
  const up = saturate(n.y)
  const steep = float(1).sub(up)
  let alb: Node<'vec3'>
  let height: Node<'float'>
  let rough: Node<'float'> = float(0.85)
  if (rockMaps) {
    const a1 = tri(rockMaps.albedo, p, n, 1 / 420).rgb
    // steep faces take the basalt column texture (vertical structure), tops the broken rock
    const a2 = basalt ? tri(basalt.albedo, p, n, 1 / 300).rgb.mul(1.35) : a1
    alb = mix(a1, a2, smoothstep(0.45, 0.8, steep).mul(0.7))
    height = tri(rockMaps.height ?? rockMaps.albedo, p, n, 1 / 420).r
    rough = tri(rockMaps.orm, p, n, 1 / 420).g
  } else {
    alb = vec3(0.12, 0.11, 0.1).mul(nzF.r.mul(0.6).add(0.7))
    height = nzF.g
  }
  alb = alb.mul(u.rock).mul(nz.g.mul(0.5).add(0.75))
  // moss on the plateau and ledges
  const mossM = smoothstep(0.55, 0.85, up.add(nz.b.mul(0.3)).sub(float(1).sub(u.mossAmt).mul(0.55))).mul(step(60, p.y))
  const mossC = mossMaps ? tri(mossMaps.albedo, p, n, 1 / 160).rgb.mul(u.moss).mul(0.85) : u.moss.mul(0.08)
  alb = mix(alb, mossC, mossM)
  rough = mix(rough, float(0.95), mossM)
  // heat: molten waterline and hot fissures low on the faces
  // a thin molten band right at the lava contact (rocks are not lava themselves)
  const water = exp(max(p.y, 0).div(-7))
  const fis = float(1).sub(smoothstep(0.008, 0.026, tri(noise, p.add(vec3(91, 7, 13)), n, 1 / 520).b)).mul(exp(p.y.div(-70))).mul(steep)
  // ambient occlusion: joints and the waterline crease
  const ao = saturate(info.x.mul(0.6).add(0.4))
  alb = alb.mul(ao).mul(float(1).sub(fis.mul(0.5)))
  // upper faces see the moon, not the lava: pull the hemisphere's lava red out
  // of the high faces and add a cool fill so the rim reads as dark stone
  const upper = smoothstep(80, 420, p.y)
  alb = alb.mul(mix(vec3(1), vec3(0.45, 0.8, 1.15), upper.mul(steep)))
  const keyDir = vec3(-0.75, 0.0, 0.66)
  const wrap = saturate(dot(n, keyDir).mul(0.5).add(0.5))
  let em: Node<'vec3'> = alb.mul(vec3(0.07, 0.085, 0.14).add(vec3(0.5, 0.6, 0.85).mul(wrap.mul(wrap)).mul(upper).mul(steep)))
  em = em.add(vec3(2.4, 0.55, 0.07).mul(water.mul(0.9).add(fis.mul(0.6))))
  const m = new THREE.MeshStandardNodeMaterial()
  m.name = 'RimRock'
  m.positionNode = radial(u)
  m.colorNode = alb
  m.roughnessNode = saturate(max(rough, float(0.6)))
  m.metalnessNode = float(0)
  m.normalNode = bumpMap(height.sub(fis.mul(0.5)), float(1.6))
  m.emissiveNode = em
  return m
}

function crystalMaterial(u: Uniforms): THREE.MeshStandardNodeMaterial {
  const p = positionWorld.div(S)
  const vdir = positionView.negate().normalize()
  const fres = pow(float(1).sub(saturate(dot(normalView, vdir))), 2)
  const pulse = sin(time.mul(1.3).add(p.x.mul(0.004)).add(p.z.mul(0.006))).mul(0.18).add(0.82)
  const m = new THREE.MeshStandardNodeMaterial()
  m.name = 'RimCrystal'
  m.positionNode = radial(u)
  m.colorNode = u.crystal.mul(0.02)
  m.roughnessNode = float(0.15)
  m.metalnessNode = float(0)
  m.emissiveNode = u.crystal.mul(float(0.4).add(fres.mul(1.1))).mul(pulse)
  return m
}

function fallMaterial(u: Uniforms): THREE.MeshBasicNodeMaterial {
  const noise = getNoiseTexture()
  const q = uv()
  const flow = q.y.mul(3).sub(time.mul(0.55))
  const n1 = texture(noise, vec2(q.x.mul(0.35), flow.mul(0.5))).r
  const n2 = texture(noise, vec2(q.x.mul(0.8).add(0.3), flow.mul(1.3))).b
  // Ragged, cooled banks frame narrower molten threads. A rounded cross-sheet
  // light profile gives the existing shallow ribbon some depth at low camera angles.
  const bank = n1.mul(0.035)
  const edge = smoothstep(bank, bank.add(0.22), q.x)
    .mul(float(1).sub(smoothstep(float(0.78).sub(bank), float(1).sub(bank), q.x)))
  const crust = smoothstep(0.06, 0.22, n2)
  const streaks = sin(q.x.mul(25).add(n1.mul(6)).add(q.y.mul(0.8))).mul(0.5).add(0.5)
  const heat = edge.mul(n1.mul(0.45).add(0.55)).mul(crust.mul(0.5).add(0.5)).mul(streaks.mul(0.5).add(0.5))
  const round = sin(q.x.mul(Math.PI)).mul(0.3).add(0.7)
  const col = mix(vec3(0.16, 0.018, 0.003), vec3(2.0, 0.48, 0.055), heat).mul(round)
  const m = new THREE.MeshBasicNodeMaterial()
  m.name = 'LavaFall'
  m.positionNode = radial(u)
  m.colorNode = col.mul(u.fall)
  // Keep the opaque pass: the tiny cutout removes ruler-straight sheet borders
  // without adding a blended layer or hiding the rock silhouettes behind them.
  m.opacityNode = edge
  m.alphaTest = 0.08
  m.side = THREE.DoubleSide
  return m
}

function volcanoMaterial(): THREE.MeshStandardNodeMaterial {
  const noise = getNoiseTexture()
  const p = positionGeometry
  const h01 = saturate(p.y.div(3300))
  const ang = fract(p.x.mul(0.00011).add(p.z.mul(0.00007)))
  // lava streaks running down from the crater
  const streak = float(1).sub(smoothstep(0.02, 0.07, texture(noise, vec2(ang.mul(3), p.y.mul(0.00012))).b)).mul(smoothstep(0.35, 0.9, h01))
  const crater = smoothstep(0.88, 1, h01)
  const m = new THREE.MeshStandardNodeMaterial()
  m.name = 'Volcano'
  m.colorNode = vec3(0.03, 0.025, 0.028)
  m.roughnessNode = float(0.9)
  m.emissiveNode = vec3(2.6, 0.55, 0.06).mul(streak.mul(0.9).add(crater.mul(1.6))).add(vec3(0.03, 0.012, 0.012).mul(float(1).sub(h01)))
  // own haze instead of the scene fog (it would swallow the silhouette)
  m.fog = false
  return m
}

function skyMaterial(): THREE.MeshBasicNodeMaterial {
  const noise = getNoiseTexture()
  const dir = positionWorld.normalize()
  const el = saturate(dir.y)
  const moonDir = vec3(-0.55, 0.42, -0.72).normalize()
  const md = dot(dir, moonDir)
  const moon = smoothstep(0.9988, 0.9993, md)
  const halo = pow(saturate(md), 400).mul(0.6).add(pow(saturate(md), 18).mul(0.08))
  const sp = texture(noise, dir.xz.div(dir.y.add(0.25)).mul(5.3))
  const stars = float(1).sub(smoothstep(0.0, 0.035, sp.a)).mul(sp.r.mul(1.5)).mul(smoothstep(0.1, 0.5, el))
  const cloud = smoothstep(0.45, 0.8, texture(noise, dir.xz.div(dir.y.add(0.3)).mul(0.6).add(vec2(time.mul(0.002), 0))).r)
  const base = mix(vec3(0.05, 0.02, 0.016), vec3(0.006, 0.008, 0.02), pow(el, 0.45))
  let col: Node<'vec3'> = base.add(vec3(0.9, 0.95, 1.1).mul(moon.mul(1.6).add(halo)))
  col = col.add(vec3(stars)).mul(float(1).sub(cloud.mul(0.7)))
  col = col.add(vec3(0.06, 0.02, 0.012).mul(cloud).mul(float(1).sub(el)))
  const m = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false })
  m.name = 'NightSky'
  m.colorNode = col
  m.fog = false
  return m
}

/** Coarse spatial batches keep every authored face while letting the normal renderer
 * reject the far side of the caldera. Stone is static, so baking its instance transforms
 * also offsets the draw-call cost of splitting the crystal instances and lava falls. */
function sectorize(sources: THREE.Object3D[], stone: THREE.Material, crystal: THREE.Material, owned: THREE.BufferGeometry[]): THREE.Mesh[] {
  const sectorAt = (x: number, z: number) => Math.floor(((Math.atan2(-z, x) + Math.PI * 2) % (Math.PI * 2)) / (Math.PI * 2) * DRESSING_SECTORS)
  // RimRock uses triplanar surfaces and cavity only; pillar-specific UV/band
  // channels are unnecessary in these static batches.
  const attributes = ['position', 'normal', 'aInfo'] as const
  const bins = Array.from({ length: DRESSING_SECTORS }, () => attributes.map(() => [] as number[]))
  const crystals = Array.from({ length: DRESSING_SECTORS }, () => [] as THREE.Matrix4[])
  const out: THREE.Mesh[] = []
  let crystalGeometry: THREE.BufferGeometry | null = null
  const matrix = new THREE.Matrix4()
  for (const source of sources as THREE.Mesh[]) {
    if (source.material === crystal && source instanceof THREE.InstancedMesh) {
      crystalGeometry = source.geometry
      for (let instance = 0; instance < source.count; instance++) {
        source.getMatrixAt(instance, matrix)
        crystals[sectorAt(matrix.elements[12], matrix.elements[14])].push(matrix.clone())
      }
      source.dispose()
      continue
    }
    if (source.material !== stone) {
      out.push(source)
      continue
    }
    const count = source instanceof THREE.InstancedMesh ? source.count : 1
    for (let instance = 0; instance < count; instance++) {
      if (source instanceof THREE.InstancedMesh) source.getMatrixAt(instance, matrix)
      else matrix.copy(source.matrix)
      const geometry = source.geometry.clone().applyMatrix4(matrix)
      const position = geometry.getAttribute('position')
      const index = geometry.getIndex()
      const vertices = index ? index.count : position.count
      for (let offset = 0; offset < vertices; offset += 3) {
        const ids = [0, 1, 2].map((corner) => index ? index.getX(offset + corner) : offset + corner)
        const x = ids.reduce((sum, id) => sum + position.getX(id), 0) / 3
        const z = ids.reduce((sum, id) => sum + position.getZ(id), 0) / 3
        const target = bins[sectorAt(x, z)]
        for (let slot = 0; slot < attributes.length; slot++) {
          const attribute = geometry.getAttribute(attributes[slot])
          for (const id of ids) for (let component = 0; component < attribute.itemSize; component++) {
            target[slot].push(attribute.array[id * attribute.itemSize + component])
          }
        }
      }
      geometry.dispose()
    }
    if (source instanceof THREE.InstancedMesh) source.dispose()
  }
  for (let sector = 0; sector < DRESSING_SECTORS; sector++) {
    if (bins[sector][0].length) {
      const geometry = new THREE.BufferGeometry()
      attributes.forEach((name, slot) => geometry.setAttribute(name, new THREE.Float32BufferAttribute(bins[sector][slot], 3)))
      geometry.computeBoundingBox()
      geometry.computeBoundingSphere()
      owned.push(geometry)
      const mesh = new THREE.Mesh(geometry, stone)
      mesh.name = `rim-stone-${sector}`
      out.push(mesh)
    }
    const transforms = crystals[sector]
    if (transforms.length && crystalGeometry) {
      const mesh = staticInstancedMesh(crystalGeometry, crystal, transforms.length)
      transforms.forEach((transform, index) => mesh.setMatrixAt(index, transform))
      mesh.computeBoundingBox()
      mesh.computeBoundingSphere()
      mesh.name = `rim-crystals-${sector}`
      out.push(mesh)
    }
  }
  for (const mesh of out) {
    mesh.frustumCulled = true
    const bounds = mesh instanceof THREE.InstancedMesh ? mesh.boundingSphere : mesh.geometry.boundingSphere
    if (!bounds) throw new Error(`Missing dressing bounds for ${mesh.name}`)
    mesh.userData.radialBounds = bounds.clone()
  }
  return out
}

/** A radial shader shift can move any vertex by at most |shift|. Inflate the original
 * sphere rather than accumulating padding, so repeated radius changes remain bounded. */
function padRadialBounds(mesh: THREE.Mesh, shift: number): void {
  const original = mesh.userData.radialBounds as THREE.Sphere
  const sphere = mesh instanceof THREE.InstancedMesh ? mesh.boundingSphere! : mesh.geometry.boundingSphere!
  sphere.copy(original)
  sphere.radius += shift
}

// ------------------------------------------------------------------ build

export function createArenaDressing(opts: ArenaDressingOpts): ArenaDressing {
  const object3d = new THREE.Group()
  object3d.name = 'ArenaDressing'
  const world = new THREE.Group()
  world.scale.setScalar(S)
  object3d.add(world)

  const u: Uniforms = { rock: makeU3(), moss: makeU3(), mossAmt: makeU1(), crystal: makeU3(), fall: makeU1(), shift: makeU1() }
  const mats: DressMats = { rock: rockMaterial(u, null, null, null), crystal: crystalMaterial(u), fall: fallMaterial(u), volcano: volcanoMaterial(), sky: skyMaterial() }
  const spireGeos = [spireGeometry(3), spireGeometry(11), spireGeometry(29)]
  const archGeo = archGeometry(5)
  const crystalGeo = crystalUnit()
  const boulderGeo = (() => {
    const pt = new Part((30 * Math.PI) / 180)
    rock(pt, 0, 0, 0, 1, 17, { detail: 1, squash: 0.8, rough: 0.3, flat: -0.9 })
    return mergeParts([pt])
  })()
  const volcanoGeo = volcanoGeometry()
  const skyGeo = new THREE.SphereGeometry(14000, 32, 16)
  let disposed = false

  // static pieces that do not depend on the platform radius
  const volcano = new THREE.Mesh(volcanoGeo, mats.volcano)
  volcano.position.set(Math.cos(0.95) * 10500, -100, -Math.sin(0.95) * 10500)
  volcano.name = 'volcano'
  const sky = new THREE.Mesh(skyGeo, mats.sky)
  sky.renderOrder = -20
  sky.frustumCulled = false
  sky.name = 'sky'
  world.add(volcano, sky)

  const built: THREE.Object3D[] = []
  const builtGeos: THREE.BufferGeometry[] = []
  const buildRadius = opts.platformRadius

  const build = (R: number) => {
    const rim = rimShape(R, 1234)
    const Rc = rim.Rc
    const cliffGeo = cliffGeometry(rim)
    const cliff = new THREE.Mesh(cliffGeo, mats.rock)
    cliff.name = 'cliffs'
    built.push(cliff)

    const rnd = rng(77)
    const m4 = new THREE.Matrix4()
    const q = new THREE.Quaternion()
    const e = new THREE.Euler()
    const sc = new THREE.Vector3()
    const tp = new THREE.Vector3()
    const plateauAt = (j: number, dr: number): number => {
      // interpolate the profile height at radius offset dr
      let prev = profile(rim, j, 6)
      for (let i = 7; i < RINGS; i++) {
        const cur = profile(rim, j, i)
        if (dr <= cur[0]) {
          const t = (dr - prev[0]) / Math.max(1, cur[0] - prev[0])
          return prev[1] + (cur[1] - prev[1]) * Math.max(0, Math.min(1, t))
        }
        prev = cur
      }
      return prev[1]
    }

    // lava falls at a few high crags
    const fallJ: number[] = []
    const cand = Array.from({ length: SEG }, (_, j) => j).sort((a, b) => rim.H[b] - rim.H[a])
    for (const j of cand) {
      if (fallJ.length >= 6) break
      if (fallJ.every((k) => Math.min(Math.abs(k - j), SEG - Math.abs(k - j)) > SEG / 9)) fallJ.push(j)
    }
    for (const [index, j] of fallJ.entries()) {
      const geometry = fallGeometry(rim, j, 42 + rnd() * 36)
      geometry.computeBoundingBox()
      geometry.computeBoundingSphere()
      builtGeos.push(geometry)
      const fall = new THREE.Mesh(geometry, mats.fall)
      fall.name = `lava-fall-${index}`
      built.push(fall)
    }
    const nearFall = (a: number) => fallJ.some((j) => Math.abs(Math.atan2(Math.sin(a - (j / SEG) * Math.PI * 2), Math.cos(a - (j / SEG) * Math.PI * 2))) < 0.06)

    // spires: [count, radius offset range from Rc, height range, base width ratio, base y]
    type Sp = { a: number; r: number; y: number; h: number; w: number; k: number; rot: number }
    const spires: Sp[] = []
    const addSpires = (n: number, dr0: number, dr1: number, h0: number, h1: number, wr: number, onPlateau: boolean) => {
      let tries = 0
      while (n > 0 && tries++ < n * 8) {
        const a = rnd() * Math.PI * 2
        if (nearFall(a)) continue
        const dr = dr0 + rnd() * (dr1 - dr0)
        const j = Math.round((a / (Math.PI * 2)) * SEG) % SEG
        const y = onPlateau ? plateauAt(j, dr) - 30 : -60
        const h = h0 + rnd() * (h1 - h0)
        spires.push({ a, r: Rc + dr, y, h, w: h * wr * (0.8 + rnd() * 0.4), k: Math.floor(rnd() * 3), rot: rnd() * Math.PI * 2 })
        n--
      }
    }
    // low and sparse in the lava band (never tall inside the play view)
    addSpires(26, -LAVA_GAP + 240, -140, 80, 260, 0.34, false)
    // the cliff foot: taller, leaning on the wall
    addSpires(34, -110, -30, 280, 720, 0.24, false)
    // on the plateau: the jagged skyline
    addSpires(56, 140, 1500, 500, 1700, 0.2, true)
    // talus: half-sunk boulders along the cliff foot
    const talus: Sp[] = []
    for (let i = 0; i < 70; i++) {
      const a = rnd() * Math.PI * 2
      if (nearFall(a)) continue
      const sz = 40 + rnd() * 90
      talus.push({ a, r: Rc - 150 + rnd() * 120, y: -sz * 0.35, h: sz, w: sz, k: 0, rot: rnd() * Math.PI * 2 })
    }
    {
      const mesh = new THREE.InstancedMesh(boulderGeo, mats.rock, talus.length)
      talus.forEach((s, i) => {
        e.set(rnd() * 0.5, s.rot, rnd() * 0.5)
        q.setFromEuler(e)
        sc.set(s.w * (0.9 + rnd() * 0.5), s.h * (0.6 + rnd() * 0.4), s.w * (0.9 + rnd() * 0.5))
        tp.set(Math.cos(s.a) * s.r, s.y, -Math.sin(s.a) * s.r)
        m4.compose(tp, q, sc)
        mesh.setMatrixAt(i, m4)
      })
      mesh.name = 'talus'
      built.push(mesh)
    }
    const groups: Sp[][] = [[], [], []]
    for (const s of spires) groups[s.k].push(s)
    groups.forEach((list, k) => {
      if (!list.length) return
      const mesh = new THREE.InstancedMesh(spireGeos[k], mats.rock, list.length)
      list.forEach((s, i) => {
        e.set((rnd() - 0.5) * 0.08, s.rot, (rnd() - 0.5) * 0.08)
        q.setFromEuler(e)
        sc.set(s.w, s.h, s.w)
        tp.set(Math.cos(s.a) * s.r, s.y, -Math.sin(s.a) * s.r)
        m4.compose(tp, q, sc)
        mesh.setMatrixAt(i, m4)
      })
      mesh.name = `spires-${k}`
      built.push(mesh)
    })

    // arches on the rim edge in the lowest saddles, so their silhouettes rise
    // above the wall from inside the caldera
    const saddles: number[] = []
    const low = Array.from({ length: SEG }, (_, j) => j).sort((a, b) => rim.H[a] - rim.H[b])
    for (const j of low) {
      if (saddles.length >= 4) break
      const a = (j / SEG) * Math.PI * 2
      if (nearFall(a)) continue
      if (saddles.every((k) => Math.min(Math.abs(k - j), SEG - Math.abs(k - j)) > SEG / 7)) saddles.push(j)
    }
    const arches = new THREE.InstancedMesh(archGeo, mats.rock, saddles.length)
    saddles.forEach((j, i) => {
      const a = (j / SEG) * Math.PI * 2
      const dr = 120 + rim.ledge[j] + (i % 2) * 60
      const y = plateauAt(j, dr) - 10
      const s = 1.0 + (i % 2) * 0.3
      // arch plane tangent to the ring (seen face-on from the centre)
      e.set(0, a + Math.PI / 2 + (rnd() - 0.5) * 0.3, 0)
      q.setFromEuler(e)
      sc.setScalar(s)
      tp.set(Math.cos(a) * (Rc + dr), y, -Math.sin(a) * (Rc + dr))
      m4.compose(tp, q, sc)
      arches.setMatrixAt(i, m4)
    })
    arches.name = 'arches'
    built.push(arches)

    // crystal clusters along the rim edge and at spire feet
    const cr: { x: number; y: number; z: number; s: number; rx: number; rz: number; ry: number }[] = []
    const cluster = (x: number, y: number, z: number, size: number, n: number) => {
      for (let i = 0; i < n; i++) {
        const big = i === 0
        cr.push({
          x: x + (rnd() - 0.5) * size * 0.6,
          y,
          z: z + (rnd() - 0.5) * size * 0.6,
          s: size * (big ? 1 : 0.4 + rnd() * 0.45),
          rx: (rnd() - 0.5) * (big ? 0.3 : 1.1),
          rz: (rnd() - 0.5) * (big ? 0.3 : 1.1),
          ry: rnd() * Math.PI,
        })
      }
    }
    for (let c = 0; c < 34; c++) {
      const a = rnd() * Math.PI * 2
      const dr = 40 + rnd() * 160
      const j = Math.round((a / (Math.PI * 2)) * SEG) % SEG
      const y = plateauAt(j, dr)
      cluster(Math.cos(a) * (Rc + dr), y - 6, -Math.sin(a) * (Rc + dr), 70 + rnd() * 90, 4 + Math.floor(rnd() * 4))
    }
    // on the mossy ledges, part way up the wall (seen from the play area)
    for (let c = 0, tries = 0; c < 16 && tries < 200; tries++) {
      const j = Math.floor(rnd() * SEG)
      if (rim.ledge[j] < 35) continue
      const [dr, y] = profile(rim, j, 4)
      const a = (j / SEG) * Math.PI * 2
      const rr = Rc + dr - rim.ledge[j] * 0.45
      cluster(Math.cos(a) * rr, y - 4, -Math.sin(a) * rr, 45 + rnd() * 45, 3 + Math.floor(rnd() * 3))
      c++
    }
    for (let c = 0; c < 10; c++) {
      const s = spires[Math.floor(rnd() * spires.length)]
      cluster(Math.cos(s.a) * (s.r + s.w * 1.1), s.y + 30, -Math.sin(s.a) * (s.r + s.w * 1.1), 50 + rnd() * 50, 3 + Math.floor(rnd() * 3))
    }
    const cm = new THREE.InstancedMesh(crystalGeo, mats.crystal, cr.length)
    cr.forEach((c, i) => {
      e.set(c.rx, c.ry, c.rz)
      q.setFromEuler(e)
      sc.set(c.s * 0.9, c.s, c.s * 0.9)
      tp.set(c.x, c.y, c.z)
      m4.compose(tp, q, sc)
      cm.setMatrixAt(i, m4)
    })
    cm.name = 'rim-crystals'
    built.push(cm)

    const sectors = sectorize(built, mats.rock, mats.crystal, builtGeos)
    cliffGeo.dispose()
    built.length = 0
    built.push(...sectors)
    for (const object of built) world.add(object)
  }

  const setTheme = (theme: number) => {
    const p = PALS[((theme % 3) + 3) % 3]
    u.rock.value.setRGB(...p.rock)
    u.moss.value.setRGB(...p.moss)
    u.mossAmt.value = p.mossAmt
    u.crystal.value.setRGB(...p.crystal)
    u.fall.value = p.fall
  }
  setTheme(opts.theme)
  build(opts.platformRadius)

  const aniso = opts.anisotropy ?? 4
  void Promise.all([loadSurface('shared', 'cliff_rock', aniso), loadSurface('shared', 'ground_moss', aniso), loadSurface('volcanic', 'tile_side', aniso)]).then(([rk, ms, bs]) => {
    if (disposed || !rk) return
    const old = mats.rock
    mats.rock = rockMaterial(u, rk, ms, bs)
    world.traverse((o) => {
      const mm = o as THREE.Mesh
      if (mm.isMesh && mm.material === old) mm.material = mats.rock
    })
    old.dispose()
  })

  return {
    object3d,
    update() {
      // all motion is shader time; nothing per frame on the CPU
    },
    setTheme,
    setPlatformRadius(r: number) {
      u.shift.value = r - buildRadius
      for (const object of built) padRadialBounds(object as THREE.Mesh, Math.abs(u.shift.value))
    },
    dispose() {
      disposed = true
      for (const object of built) if (object instanceof THREE.InstancedMesh) object.dispose()
      for (const g of builtGeos) g.dispose()
      for (const g of [...spireGeos, archGeo, crystalGeo, boulderGeo, volcanoGeo, skyGeo]) g.dispose()
      for (const m of Object.values(mats)) m.dispose()
      object3d.removeFromParent()
    },
  }
}

// ------------------------------------------------------------------ drop-in

/**
 * Drop-in replacement for scene/Environment (same public surface: group,
 * setTheme, dispose). The rim follows the largest platform seen this match
 * (ctx.field.layer), checked on the per-frame setTheme call; following it is a
 * uniform change (radial shift), never a rebuild.
 */
export class PropEnvironment {
  readonly group = new THREE.Group()
  private dress: ArenaDressing
  private maxLayer = 0

  constructor(private ctx: WorldCtx) {
    this.group.name = 'Environment'
    this.maxLayer = Math.max(1, ctx.field.layer)
    this.dress = createArenaDressing({ theme: 0, platformRadius: Math.max(1300, layerRadius(this.maxLayer)), anisotropy: ctx.tier.anisotropy })
    this.group.add(this.dress.object3d)
  }

  setTheme(theme: number): void {
    this.dress.setTheme(theme)
    const L = this.ctx.field.layer
    if (L > this.maxLayer) {
      this.maxLayer = L
      this.dress.setPlatformRadius(Math.max(1300, layerRadius(L)))
    }
  }

  dispose(): void {
    this.dress.dispose()
    this.group.removeFromParent()
  }
}

