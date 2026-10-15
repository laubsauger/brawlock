import * as THREE from 'three/webgpu'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'

/**
 * Procedural parts built on top of the CC0 rig, in the rig's rest (bind)
 * space: metres, +Y up, +Z forward, +X = the character's left.
 *
 * Cloth (one skinned mesh, one draw): long front-split coat, front tabard,
 * long trailing cape, shoulder mantle, bell sleeves and the two medallions.
 * Per-vertex `aCloth` = (w, L, kind, side):
 *   w     0 at the attachment .. 1 at the free hem (how much the spring moves it)
 *   L     pendulum length to the attachment (m), keeps the hem length when it swings
 *   kind  0 coat, 1 tabard, 2 cape, 3 mantle, 4 sleeve, 5 medallion (rigid), 6 chest panel (rigid)
 *   side  +1 left, -1 right, 0 centre (casting-arm sleeve glow)
 * `aDim` = (row width m, piece length m) lets the shader place trims and runes
 * in metres from normalized uv (u across, v from the attachment to the hem).
 */

export const KIND = { coat: 0, tabard: 1, cape: 2, mantle: 3, sleeve: 4, medallion: 5, panel: 6 } as const

export interface RigRest {
  /** rest-pose position of a bone (model space) */
  pos(name: string): THREE.Vector3
  /** skeleton bone index */
  index(name: string): number
  /** horizontal extents of the body (outfit) vertices between two heights */
  slice(y0: number, y1: number): { minX: number; maxX: number; minZ: number; maxZ: number }
}

interface Vtx {
  p: THREE.Vector3
  u: number
  v: number
  w: number
  L: number
  side: number
  rowW: number
  len: number
  /** [boneIndex, weight] x up to 4 */
  skin: [number, number][]
}

class Builder {
  pos: number[] = []
  uv: number[] = []
  cloth: number[] = []
  dim: number[] = []
  si: number[] = []
  sw: number[] = []
  idx: number[] = []

  add(v: Vtx, kind: number): number {
    const i = this.pos.length / 3
    this.pos.push(v.p.x, v.p.y, v.p.z)
    this.uv.push(v.u, v.v)
    this.cloth.push(v.w, v.L, kind, v.side)
    this.dim.push(v.rowW, v.len)
    const s = v.skin.filter((e) => e[1] > 1e-4).sort((a, b) => b[1] - a[1]).slice(0, 4)
    const tot = s.reduce((a, e) => a + e[1], 0) || 1
    for (let k = 0; k < 4; k++) {
      this.si.push(s[k] ? s[k][0] : 0)
      this.sw.push(s[k] ? s[k][1] / tot : 0)
    }
    return i
  }

  /** rows x cols grid, f(i/rows, j/cols) -> vertex; quads split along the shorter diagonal */
  grid(rows: number, cols: number, kind: number, f: (t: number, s: number) => Vtx): void {
    const base = this.pos.length / 3
    for (let i = 0; i <= rows; i++) for (let j = 0; j <= cols; j++) this.add(f(i / rows, j / cols), kind)
    const W = cols + 1
    for (let i = 0; i < rows; i++)
      for (let j = 0; j < cols; j++) {
        const a = base + i * W + j
        const b = a + 1
        const c = a + W
        const d = c + 1
        this.idx.push(a, c, b, b, c, d)
      }
  }

  geometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3))
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2))
    g.setAttribute('aCloth', new THREE.Float32BufferAttribute(this.cloth, 4))
    g.setAttribute('aDim', new THREE.Float32BufferAttribute(this.dim, 2))
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(this.si, 4))
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(this.sw, 4))
    g.setIndex(this.idx)
    g.computeVertexNormals()
    return g
  }
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}
const lerp = (a: number, b: number, t: number) => a + (b - a) * t

/** Builds the cloth geometry (coat, tabard, cape, mantle, sleeves, medallions). */
export function buildCloth(rig: RigRest): THREE.BufferGeometry {
  const B = new Builder()
  const pelvis = rig.pos('pelvis')
  const chest = rig.pos('spine_03')
  const neck = rig.pos('neck_01')
  const iP = rig.index('pelvis')
  const iTL = rig.index('thigh_l')
  const iTR = rig.index('thigh_r')
  const iS3 = rig.index('spine_03')
  const iS1 = rig.index('spine_01')
  const iCL = rig.index('clavicle_l')
  const iCR = rig.index('clavicle_r')

  // ---------------------------------------------------------------- coat
  // waist at the belt, fitted to the body slices so nothing pokes through at
  // rest, flaring to a wide hem at the ankles; open at the front from just
  // under the belt (the tabard fills the gap), back tails slightly longer
  const yTop = pelvis.y + 0.075
  const cz = pelvis.z + 0.015
  const ROWS = 16
  const fit: { rx: number; rz: number }[] = []
  for (let i = 0; i <= ROWS; i++) {
    const y = lerp(yTop, 0.06, i / ROWS)
    if (y < 0.72) {
      fit.push({ rx: 0, rz: 0 })
      continue
    }
    const s = rig.slice(y - 0.04, y + 0.04)
    fit.push({ rx: Math.max(-s.minX, s.maxX) + 0.035, rz: Math.max(s.maxZ - cz, cz - s.minZ) + 0.035 })
  }
  const rx0 = fit[0].rx
  const rz0 = fit[0].rz
  const coatLen = yTop - 0.05
  const HEM_RX = 0.4
  const HEM_RZ = 0.33
  const HEM_RZ_BACK = 0.42
  /** coat radius at (t, theta), shared by the tabard and the cape fit */
  const coatR = (t: number, th: number) => {
    const back = (1 - Math.cos(th)) / 2
    const flare = Math.pow(t, 1.25)
    const f = fit[Math.round(t * ROWS)]
    return {
      rx: Math.max(lerp(rx0, HEM_RX, flare), f.rx),
      rz: Math.max(lerp(rz0, lerp(HEM_RZ, HEM_RZ_BACK, back), flare), f.rz),
    }
  }
  // two halves: open at the front (tabard fills it) and split at the back into tails
  for (const half of [1, -1]) {
    B.grid(ROWS, 18, KIND.coat, (t, s) => {
      const open = 0.5 * Math.pow(smooth(0.06, 1, t), 0.7)
      const vent = 0.2 * smooth(0.42, 1, t)
      // s 0..1 runs from the front edge to the back vent on this side
      const a = lerp(open, Math.PI - vent, s)
      const th = half > 0 ? a : Math.PI * 2 - a
      const { rx, rz } = coatR(t, th)
      const back = (1 - Math.cos(th)) / 2
      const y = lerp(yTop, 0.075 - 0.05 * back, t) + 0.012 * Math.sin(th * 5 + 1) * t
      const fold = 1 + smooth(0.1, 1, t) * (0.055 * Math.sin(th * 7 + 0.6) + 0.025 * Math.sin(th * 13 + 2))
      const p = new THREE.Vector3(Math.sin(th) * rx * fold, y, cz + Math.cos(th) * rz * fold)
      const legShare = 0.55 * smooth(0.12, 0.9, t) * (0.35 + 0.65 * Math.pow(Math.abs(Math.cos(th)), 0.7))
      const sL = smooth(-0.3, 0.3, Math.sin(th))
      return {
        p,
        u: s,
        v: t,
        w: Math.pow(smooth(0.02, 1, t), 1.25),
        L: Math.max(0.001, yTop - y),
        side: 0,
        rowW: (Math.PI - vent - open) * (rx + rz) * 0.5,
        len: coatLen,
        skin: [
          [iP, 1 - legShare],
          [iTL, legShare * sL],
          [iTR, legShare * (1 - sL)],
        ],
      }
    })
  }

  // ---------------------------------------------------------------- tabard
  {
    const top = yTop + 0.015
    const bot = 0.12
    B.grid(14, 4, KIND.tabard, (t, s) => {
      const hw = lerp(0.085, 0.1, t)
      const x = (s - 0.5) * 2 * hw
      const y = lerp(top, bot, t)
      const z = cz + coatR(t, 0).rz * lerp(1.0, 0.9, t) + 0.012 - x * x * 1.2
      const legShare = 0.5 * smooth(0.15, 0.9, t)
      return {
        p: new THREE.Vector3(x, y, z),
        u: s,
        v: t,
        w: Math.pow(smooth(0.02, 1, t), 1.2),
        L: Math.max(0.001, top - y),
        side: 0,
        rowW: hw * 2,
        len: top - bot,
        skin: [
          [iP, 1 - legShare],
          [iTL, legShare * 0.5],
          [iTR, legShare * 0.5],
        ],
      }
    })
  }

  // ---------------------------------------------------------------- cape
  // hangs from across the shoulders (wrapping over them), drapes back over
  // the coat and trails to the floor
  {
    const top = rig.pos('upperarm_l').y + 0.02
    const bot = 0.07
    const sBack = rig.slice(top - 0.06, top)
    const zTop = Math.min(sBack.minZ, -0.12) - 0.02
    const zBot = cz - HEM_RZ_BACK - 0.05
    B.grid(20, 12, KIND.cape, (t, s) => {
      const hw = lerp(0.2, 0.4, Math.pow(t, 0.75))
      const x = (s - 0.5) * 2 * hw
      const e = Math.abs(s - 0.5) * 2
      const wrap = lerp(0.17, 0.09, smooth(0, 0.3, t))
      const y = lerp(top, bot, t) - 0.04 * (1 - e * e) * t
      const z = lerp(zTop, zBot, Math.pow(t, 1.35)) + wrap * e * e - 0.014 * Math.sin(x * 26) * t
      const lowW = smooth(0.0, 1, t)
      return {
        p: new THREE.Vector3(x, y, z),
        u: s,
        v: t,
        w: Math.pow(smooth(0.03, 1, t), 1.1),
        L: Math.max(0.001, top - y),
        side: 0,
        rowW: hw * 2,
        len: top - bot,
        skin: [
          [iS3, 1 - lowW * 0.75],
          [iS1, lowW * 0.35],
          [iP, lowW * 0.4],
        ],
      }
    })
  }

  // ---------------------------------------------------------------- chest panel
  // embroidered panel from the belt up to the mantle (rigid on the spine)
  {
    const bot = yTop - 0.01
    const top = chest.y + 0.13
    const iS2 = rig.index('spine_02')
    B.grid(6, 4, KIND.panel, (t, s) => {
      const y = lerp(top, bot, t)
      const sl = rig.slice(y - 0.03, y + 0.03)
      const hw = lerp(0.075, 0.085, t)
      const x = (s - 0.5) * 2 * hw
      const z = sl.maxZ + 0.008 - x * x * 2.2
      const spineW = smooth(0.2, 0.9, t)
      return {
        p: new THREE.Vector3(x, y, z),
        u: s,
        v: t,
        w: 0,
        L: 0.001,
        side: 0,
        rowW: hw * 2,
        len: top - bot,
        skin: [
          [iS3, 1 - spineW],
          [iS2, spineW * 0.6],
          [iS1, spineW * 0.4],
        ],
      }
    })
  }

  // ---------------------------------------------------------------- mantle
  // shoulder cape: starts under the hood, caps the shoulders (wide enough for
  // the deltoids with the arms down) and drapes to mid upper arm / chest
  {
    const sh = rig.pos('upperarm_l')
    const top = sh.y + 0.05
    const bot = chest.y - 0.07
    const nz = neck.z + 0.01
    const sTop = rig.slice(top - 0.03, top + 0.03)
    const r0x = Math.max(0.17, Math.max(-sTop.minX, sTop.maxX) + 0.015)
    B.grid(8, 28, KIND.mantle, (t, s) => {
      const open = lerp(0.38, 0.66, t)
      const th = open + s * (Math.PI * 2 - 2 * open)
      const ease = Math.sin((Math.min(1, t * 1.35) * Math.PI) / 2)
      const side = Math.abs(Math.sin(th))
      const rx = lerp(r0x, sh.x + 0.16, ease)
      const rz = lerp(0.15, 0.225, ease)
      // lower over the arms, a point at the back
      const y = lerp(top, bot, t) - 0.05 * side * side * t - 0.035 * Math.max(0, -Math.cos(th)) * t
      const fold = 1 + 0.035 * t * Math.sin(th * 9)
      const sideW = smooth(0.35, 0.95, side) * t * 0.35
      const sL = Math.sin(th) > 0
      return {
        p: new THREE.Vector3(Math.sin(th) * rx * fold, y, nz + Math.cos(th) * rz * fold),
        u: s,
        v: t,
        w: 0.3 * smooth(0.2, 1, t),
        L: Math.max(0.001, top - y),
        side: 0,
        rowW: (Math.PI * 2 - 2 * open) * (rx + rz) * 0.5,
        len: top - bot,
        skin: [
          [iS3, 1 - sideW],
          [sL ? iCL : iCR, sideW],
        ],
      }
    })
  }

  // ---------------------------------------------------------------- bell sleeves
  for (const side of [1, -1]) {
    const tag = side > 0 ? 'l' : 'r'
    const a = rig.pos(`lowerarm_${tag}`)
    const h = rig.pos(`hand_${tag}`)
    const iLA = rig.index(`lowerarm_${tag}`)
    const iUA = rig.index(`upperarm_${tag}`)
    const axis = new THREE.Vector3().subVectors(h, a)
    const armLen = axis.length()
    axis.normalize()
    const up = new THREE.Vector3(0, 1, 0)
    const n1 = new THREE.Vector3().crossVectors(axis, up).normalize()
    const n2 = new THREE.Vector3().crossVectors(n1, axis).normalize()
    const start = -0.04
    const end = armLen * 0.72
    B.grid(6, 18, KIND.sleeve, (t, s) => {
      const th = s * Math.PI * 2
      const along = lerp(start, end, t)
      const r = lerp(0.062, 0.125, Math.pow(t, 1.4))
      // the opening droops: lower half longer, like a bell sleeve under gravity
      const droop = 0.05 * t * Math.max(0, -Math.sin(th))
      const c = a.clone().addScaledVector(axis, along + droop)
      const p = c.addScaledVector(n1, Math.cos(th) * r).addScaledVector(n2, Math.sin(th) * r * 1.05)
      const wUA = 1 - smooth(-0.06, 0.06, along)
      return {
        p,
        u: s,
        v: t,
        w: 0.55 * smooth(0.25, 1, t),
        L: Math.max(0.001, (end - start) * t),
        side,
        rowW: Math.PI * 2 * r,
        len: end - start,
        skin: [
          [iLA, 1 - wUA],
          [iUA, wUA],
        ],
      }
    })
  }

  const cloth = B.geometry()

  // ---------------------------------------------------------------- medallions (rigid, same draw)
  const discs: THREE.BufferGeometry[] = []
  const disc = (center: THREE.Vector3, r: number, bone: number) => {
    const g = new THREE.CylinderGeometry(r, r * 1.08, 0.012, 20, 1)
    g.rotateX(Math.PI / 2)
    g.translate(center.x, center.y, center.z)
    const n = g.getAttribute('position').count
    const uv = g.getAttribute('uv')
    const cl = new Float32Array(n * 4)
    const dim = new Float32Array(n * 2)
    const si = new Uint16Array(n * 4)
    const sw = new Float32Array(n * 4)
    const pos = g.getAttribute('position')
    for (let i = 0; i < n; i++) {
      cl[i * 4 + 2] = KIND.medallion
      // radial distance from the disc centre (m) in aDim.x for the gem / rim split
      dim[i * 2] = Math.hypot(pos.getX(i) - center.x, pos.getY(i) - center.y)
      dim[i * 2 + 1] = r
      si[i * 4] = bone
      sw[i * 4] = 1
    }
    g.setAttribute('aCloth', new THREE.BufferAttribute(cl, 4))
    g.setAttribute('aDim', new THREE.BufferAttribute(dim, 2))
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4))
    g.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4))
    g.setAttribute('uv', uv)
    discs.push(g.toNonIndexed())
  }
  {
    const s = rig.slice(yTop - 0.05, yTop + 0.02)
    disc(new THREE.Vector3(0, yTop - 0.03, s.maxZ + 0.008), 0.036, iP)
    const c = rig.slice(chest.y + 0.02, chest.y + 0.1)
    disc(new THREE.Vector3(0, chest.y + 0.06, c.maxZ + 0.016), 0.03, iS3)
  }
  const merged = mergeGeometries([cloth.toNonIndexed(), ...discs], false)
  if (!merged) throw new Error('warlock: cloth merge failed')
  merged.computeBoundingSphere()
  return merged
}

/**
 * Hood interior: a black void that fills the hood opening plus two eyes
 * (aPart 0 void, 1 eye). Built in model space around the rest head; the
 * caller parents it to the Head bone.
 */
export function buildVoid(head: THREE.Vector3): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = []
  const tag = (g: THREE.BufferGeometry, part: number) => {
    const n = g.getAttribute('position').count
    g.setAttribute('aPart', new THREE.Float32BufferAttribute(new Float32Array(n).fill(part), 1))
    g.deleteAttribute('uv')
    return g.index ? g.toNonIndexed() : g
  }
  // fills the whole hood volume (the hood shell hides all but the opening)
  const v = new THREE.SphereGeometry(1, 16, 12)
  v.scale(0.1, 0.12, 0.105)
  v.translate(head.x, head.y + 0.055, head.z - 0.025)
  parts.push(tag(v, 0))
  const front = head.z - 0.025 + 0.105
  for (const sx of [-1, 1]) {
    const e = new THREE.SphereGeometry(1, 10, 6)
    e.scale(0.016, 0.0075, 0.006)
    e.rotateZ(sx * 0.22)
    e.translate(head.x + sx * 0.031, head.y + 0.068, front - 0.012)
    parts.push(tag(e, 1))
  }
  const g = mergeGeometries(parts, false)
  if (!g) throw new Error('warlock: void merge failed')
  return g
}

// ------------------------------------------------------------------ staff

export type StaffVariant = 'gnarled' | 'iron' | 'bone'

/** Staff geometry along +Y with the grip at the origin; aPart 0 wood, 1 metal, 2 crystal. */
export interface StaffGeometry {
  geometry: THREE.BufferGeometry
  /** crystal centre (staff space) */
  tip: THREE.Vector3
  /** distance from the grip down to the foot */
  below: number
}

export function buildStaff(variant: StaffVariant): StaffGeometry {
  const parts: THREE.BufferGeometry[] = []
  const tag = (g: THREE.BufferGeometry, part: number) => {
    const ng = g.index ? g.toNonIndexed() : g
    const n = ng.getAttribute('position').count
    ng.setAttribute('aPart', new THREE.Float32BufferAttribute(new Float32Array(n).fill(part), 1))
    if (!ng.getAttribute('uv')) ng.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(n * 2), 2))
    parts.push(ng)
  }
  const below = 0.62
  const above = variant === 'iron' ? 0.62 : 0.58
  // shaft: tapered, slightly bent, gnarled for wood
  {
    const segs = 14
    const pts: THREE.Vector3[] = []
    for (let i = 0; i <= segs; i++) {
      const t = i / segs
      const y = -below + t * (below + above)
      const bend = variant === 'gnarled' ? Math.sin(t * 5.1) * 0.012 : 0
      pts.push(new THREE.Vector3(bend, y, Math.cos(t * 3.3) * (variant === 'gnarled' ? 0.008 : 0)))
    }
    const curve = new THREE.CatmullRomCurve3(pts)
    const tube = new THREE.TubeGeometry(curve, 28, 1, 7, false)
    const pos = tube.getAttribute('position')
    // TubeGeometry has a constant radius: rescale each ring around the curve
    const ring = 8
    for (let i = 0; i <= 28; i++) {
      const t = i / 28
      const c = curve.getPointAt(t)
      let r = lerp(0.017, 0.012, t)
      if (variant === 'gnarled') r *= 1 + 0.18 * Math.sin(t * 37) * Math.sin(t * 11)
      if (variant === 'bone') r *= 1 + 0.35 * Math.pow(Math.abs(Math.sin(t * Math.PI * 4)), 6)
      for (let k = 0; k < ring; k++) {
        const vi = i * ring + k
        const dx = pos.getX(vi) - c.x
        const dy = pos.getY(vi) - c.y
        const dz = pos.getZ(vi) - c.z
        pos.setXYZ(vi, c.x + dx * r, c.y + dy * r, c.z + dz * r)
      }
    }
    tube.computeVertexNormals()
    tag(tube, variant === 'iron' ? 1 : 0)
  }
  // foot cap and bands
  {
    const cap = new THREE.ConeGeometry(0.019, 0.07, 8)
    cap.rotateX(Math.PI)
    cap.translate(0, -below - 0.02, 0)
    tag(cap, 1)
    for (const y of [above - 0.12, above - 0.17, 0.1, -0.1]) {
      const band = new THREE.TorusGeometry(0.0165, 0.005, 5, 12)
      band.rotateX(Math.PI / 2)
      band.translate(0, y, 0)
      tag(band, 1)
    }
  }
  const tip = new THREE.Vector3(0, above + 0.075, 0)
  if (variant === 'iron') {
    // ring head with an orb
    const ringG = new THREE.TorusGeometry(0.075, 0.009, 6, 24)
    ringG.translate(0, above + 0.075, 0)
    tag(ringG, 1)
    const orb = new THREE.IcosahedronGeometry(0.038, 1)
    orb.translate(tip.x, tip.y, tip.z)
    tag(orb, 2)
  } else {
    // prongs curling around a crystal
    const prongs = variant === 'bone' ? 2 : 3
    for (let k = 0; k < prongs; k++) {
      const a = (k / prongs) * Math.PI * 2 + 0.3
      const c = new THREE.CatmullRomCurve3([
        new THREE.Vector3(0, above - 0.1, 0),
        new THREE.Vector3(Math.cos(a) * 0.035, above + 0.0, Math.sin(a) * 0.035),
        new THREE.Vector3(Math.cos(a) * 0.05, above + 0.08, Math.sin(a) * 0.05),
        new THREE.Vector3(Math.cos(a + 0.6) * (variant === 'bone' ? 0.06 : 0.02), above + 0.17, Math.sin(a + 0.6) * 0.02),
      ])
      const tube = new THREE.TubeGeometry(c, 10, variant === 'bone' ? 0.008 : 0.0065, 5, false)
      tag(tube, variant === 'bone' ? 0 : 1)
    }
    const crystal = new THREE.OctahedronGeometry(0.034, 0)
    crystal.scale(1, variant === 'bone' ? 1.9 : 2.2, 1)
    crystal.translate(tip.x, tip.y, tip.z)
    tag(crystal, 2)
  }
  const geometry = mergeGeometries(parts, false)
  if (!geometry) throw new Error('warlock: staff merge failed')
  geometry.computeBoundingSphere()
  return { geometry, tip, below: below + 0.055 }
}
