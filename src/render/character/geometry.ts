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
 *   kind  0 coat, 1 tabard, 2 cape, 3 mantle, 4 sleeve, 5 medallion (rigid), 6 chest panel (rigid),
 *         7 waist sash (rigid), 8 underlayer (hip wrap + loose trouser legs, rigid on the leg bones),
 *         9 hood void + eyes (rigid on the Head bone; side = 1 marks the eyes)
 *   side  +1 left, -1 right, 0 centre (casting-arm sleeve glow)
 * `aDim` = (row width m, piece length m) lets the shader place trims and runes
 * in metres from normalized uv (u across, v from the attachment to the hem).
 */

/** set by the asset loader from the measured boot radius before building the cloth */
export let CALF_R_HINT = 0.085
export function setCalfRadiusHint(r: number): void {
  CALF_R_HINT = r
}

/** coat hem half-width (rig metres, before CC0_SCALE) */
export const HEM_RX_M = 0.44

export const KIND = { coat: 0, tabard: 1, cape: 2, mantle: 3, sleeve: 4, medallion: 5, panel: 6, sash: 7, under: 8, void: 9 } as const

export interface RigRest {
  /** rest-pose position of a bone (model space) */
  pos(name: string): THREE.Vector3
  /** skeleton bone index */
  index(name: string): number
  /** horizontal extents of the body (outfit) vertices between two heights */
  slice(y0: number, y1: number, part?: 'head' | 'body'): { minX: number; maxX: number; minZ: number; maxZ: number }
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

  /**
   * rows x cols grid, f(i/rows, j/cols) -> vertex. `outward(p)` points away from
   * the body at p: the winding is chosen so front faces are the garment's
   * outside (the shader shows the lining on back faces).
   */
  grid(rows: number, cols: number, kind: number, f: (t: number, s: number) => Vtx, outward: (p: THREE.Vector3) => THREE.Vector3): void {
    const base = this.pos.length / 3
    for (let i = 0; i <= rows; i++) for (let j = 0; j <= cols; j++) this.add(f(i / rows, j / cols), kind)
    const W = cols + 1
    // test the winding on a middle quad
    const P = (k: number) => new THREE.Vector3(this.pos[k * 3], this.pos[k * 3 + 1], this.pos[k * 3 + 2])
    const mi = Math.floor(rows / 2)
    const mj = Math.floor(cols / 2)
    const a0 = base + mi * W + mj
    const pa = P(a0)
    const n = new THREE.Vector3().crossVectors(P(a0 + W).sub(pa), P(a0 + 1).sub(pa))
    const flip = n.dot(outward(pa)) < 0
    for (let i = 0; i < rows; i++)
      for (let j = 0; j < cols; j++) {
        const a = base + i * W + j
        const b = a + 1
        const c = a + W
        const d = c + 1
        if (flip) this.idx.push(a, b, c, b, d, c)
        else this.idx.push(a, c, b, b, c, d)
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
    // average normals across seams (coat halves, closed rings) so strips shade as one cloth
    const nrm = g.getAttribute('normal')
    const groups = new Map<string, number[]>()
    for (let i = 0; i < this.pos.length / 3; i++) {
      const key = `${this.cloth[i * 4 + 2]}|${Math.round(this.pos[i * 3] * 2e3)},${Math.round(this.pos[i * 3 + 1] * 2e3)},${Math.round(this.pos[i * 3 + 2] * 2e3)}`
      const list = groups.get(key)
      if (list) list.push(i)
      else groups.set(key, [i])
    }
    const v = new THREE.Vector3()
    for (const list of groups.values()) {
      if (list.length < 2) continue
      v.set(0, 0, 0)
      for (const i of list) v.set(v.x + nrm.getX(i), v.y + nrm.getY(i), v.z + nrm.getZ(i))
      v.normalize()
      for (const i of list) nrm.setXYZ(i, v.x, v.y, v.z)
    }
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
  const iS2 = rig.index('spine_02')
  const iS1 = rig.index('spine_01')
  const iCL = rig.index('clavicle_l')
  const iCR = rig.index('clavicle_r')
  const cz = pelvis.z + 0.015
  /** outward hints for the winding test */
  const fromAxis = (p: THREE.Vector3) => new THREE.Vector3(p.x, 0, p.z - cz)
  const back = () => new THREE.Vector3(0, 0, -1)
  const front = () => new THREE.Vector3(0, 0, 1)

  // ---------------------------------------------------------------- coat
  // waist at the belt line, fitted to the body slices so nothing pokes through
  // at rest, flaring to a wide hem at the ankles; open at the front from just
  // under the sash (the tabard fills the gap), split at the back into tails
  const yTop = pelvis.y + 0.075
  const ROWS = 16
  const fit: { rx: number; rz: number }[] = []
  for (let i = 0; i <= ROWS; i++) {
    const y = lerp(yTop, 0.06, i / ROWS)
    if (y < 0.72) {
      fit.push({ rx: 0, rz: 0 })
      continue
    }
    const s = rig.slice(y - 0.04, y + 0.04, 'body')
    // hug the waist under the sash, more room over the hips and thighs
    const m = lerp(0.012, 0.04, smooth(0, 0.25, i / ROWS))
    fit.push({ rx: Math.max(-s.minX, s.maxX) + m, rz: Math.max(s.maxZ - cz, cz - s.minZ) + m })
  }
  const rx0 = fit[0].rx
  const rz0 = fit[0].rz
  const coatLen = yTop - 0.05
  const HEM_RX = HEM_RX_M
  const HEM_RZ = 0.36
  const HEM_RZ_BACK = 0.42
  /** coat radius at (t, theta), shared by the tabard and the cape fit */
  const coatR = (t: number, th: number) => {
    const bk = (1 - Math.cos(th)) / 2
    const flare = Math.pow(t, 1.05)
    const f = fit[Math.round(t * ROWS)]
    return {
      rx: Math.max(lerp(rx0, HEM_RX, flare), f.rx),
      rz: Math.max(lerp(rz0, lerp(HEM_RZ, HEM_RZ_BACK, bk), flare), f.rz),
    }
  }
  for (const half of [1, -1]) {
    B.grid(
      ROWS,
      18,
      KIND.coat,
      (t, s) => {
        const open = 0.5 * Math.pow(smooth(0.06, 1, t), 0.7)
        const vent = 0.2 * smooth(0.42, 1, t)
        // s 0..1 runs from the front edge to the back vent on this side
        const a = lerp(open, Math.PI - vent, s)
        const th = half > 0 ? a : Math.PI * 2 - a
        const { rx, rz } = coatR(t, th)
        const bk = (1 - Math.cos(th)) / 2
        const y = lerp(yTop, 0.075 - 0.05 * bk, t) + 0.012 * Math.sin(th * 5 + 1) * t
        const fold = 1 + smooth(0.1, 1, t) * (0.05 * Math.sin(th * 6 + 0.6) + 0.02 * Math.sin(th * 11 + 2))
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
      },
      fromAxis,
    )
  }

  // ---------------------------------------------------------------- waist sash
  // covers the coat / tunic join; the belt medallion sits on it
  const sashTop = yTop + 0.05
  const sashBot = yTop - 0.045
  let sashFront = 0
  {
    let rxs = 0
    let rzs = 0
    for (let y = sashBot; y <= sashTop + 1e-6; y += 0.02) {
      const s = rig.slice(y - 0.02, y + 0.02, 'body')
      rxs = Math.max(rxs, Math.max(-s.minX, s.maxX))
      rzs = Math.max(rzs, Math.max(s.maxZ - cz, cz - s.minZ))
    }
    rxs = Math.max(rxs + 0.02, rx0 + 0.012)
    rzs = Math.max(rzs + 0.02, rz0 + 0.012)
    sashFront = cz + rzs
    const top0 = rig.slice(sashTop - 0.01, sashTop + 0.03, 'body')
    const bodyRx = Math.max(-top0.minX, top0.maxX) + 0.006
    const bodyRz = Math.max(top0.maxZ - cz, cz - top0.minZ) + 0.006
    // closed band: tucks in to the tunic at the top and onto the coat at the
    // bottom, so no gap or hollow rim shows from any angle
    B.grid(
      7,
      40,
      KIND.sash,
      (t, s) => {
        const th = s * Math.PI * 2
        let rx: number
        let rz: number
        let y: number
        if (t < 0.2) {
          const c = t / 0.2
          rx = lerp(bodyRx, rxs, c)
          rz = lerp(bodyRz, rzs, c)
          y = sashTop + 0.012 * (1 - c)
        } else if (t > 0.8) {
          const c = (t - 0.8) / 0.2
          rx = lerp(rxs, rx0 + 0.002, c)
          rz = lerp(rzs, rz0 + 0.002, c)
          y = sashBot - 0.012 * c
        } else {
          const c = (t - 0.2) / 0.6
          const bulge = 1 + 0.05 * Math.sin(c * Math.PI)
          rx = rxs * bulge
          rz = rzs * bulge
          y = lerp(sashTop, sashBot, c)
        }
        y -= 0.012 * Math.cos(th) * Math.min(1, t * 5) // dips at the front
        return {
          p: new THREE.Vector3(Math.sin(th) * rx, y, cz + Math.cos(th) * rz),
          // trims use v along the visible band only
          u: s,
          v: Math.min(1, Math.max(0, (t - 0.2) / 0.6)),
          w: 0,
          L: 0.001,
          side: 0,
          rowW: Math.PI * (rxs + rzs),
          len: sashTop - sashBot,
          skin: [
            [iP, 0.7],
            [iS1, 0.3],
          ],
        }
      },
      (p) => new THREE.Vector3(p.x, 0.3, p.z - cz),
    )
  }

  // ---------------------------------------------------------------- underlayer
  // what shows through the coat split instead of legs / the void behind: a hip
  // wrap under the sash and a loose trouser tube around each leg, skinned
  // rigidly to the leg bones so it can never clip them
  {
    const hipTop = sashBot + 0.02
    const hipBot = pelvis.y - 0.1
    B.grid(
      3,
      24,
      KIND.under,
      (t, s) => {
        const th = s * Math.PI * 2
        const y = lerp(hipTop, hipBot, t)
        const r = fit[Math.min(ROWS, Math.round(((yTop - y) / (yTop - 0.06)) * ROWS))]
        const rx = Math.max(0.1, r.rx - 0.01)
        const rz = Math.max(0.09, r.rz - 0.01)
        return {
          p: new THREE.Vector3(Math.sin(th) * rx, y, cz + Math.cos(th) * rz),
          u: s,
          v: t,
          w: 0,
          L: 0.001,
          side: 0,
          rowW: Math.PI * (rx + rz),
          len: hipTop - hipBot,
          skin: [[iP, 1]],
        }
      },
      fromAxis,
    )
    for (const side of [1, -1]) {
      const tag = side > 0 ? 'l' : 'r'
      const hip = rig.pos(`thigh_${tag}`)
      const knee = rig.pos(`calf_${tag}`)
      const foot = rig.pos(`foot_${tag}`)
      const iT = rig.index(`thigh_${tag}`)
      const iC = rig.index(`calf_${tag}`)
      const bootTop = knee.y - 0.12
      B.grid(
        8,
        12,
        KIND.under,
        (t, s) => {
          const th = s * Math.PI * 2
          const y = lerp(hip.y + 0.03, bootTop, t)
          // centre follows the bone line (thigh then shin)
          const above = y > knee.y
          const c = above
            ? new THREE.Vector3().lerpVectors(hip, knee, (hip.y - y) / (hip.y - knee.y))
            : new THREE.Vector3().lerpVectors(knee, foot, (knee.y - y) / (knee.y - foot.y))
          const r = above ? lerp(0.105, 0.088, (hip.y - y) / (hip.y - knee.y)) : Math.max(0.085, CALF_R_HINT)
          const kneeW = smooth(-0.05, 0.05, knee.y - y)
          return {
            p: new THREE.Vector3(c.x + Math.sin(th) * r, y, c.z + Math.cos(th) * r),
            u: s,
            v: t,
            w: 0,
            L: 0.001,
            side: 0,
            rowW: Math.PI * 2 * r,
            len: hip.y - bootTop,
            skin: [
              [iT, 1 - kneeW],
              [iC, kneeW],
            ],
          }
        },
        (p) => new THREE.Vector3(p.x - hip.x, 0, p.z - hip.z),
      )
    }
  }

  // ---------------------------------------------------------------- tabard
  {
    const top = sashTop - 0.02
    const bot = 0.12
    B.grid(
      14,
      4,
      KIND.tabard,
      (t, s) => {
        const hw = lerp(0.068, 0.082, t)
        const x = (s - 0.5) * 2 * hw
        const y = lerp(top, bot, t)
        const z = cz + coatR(t, 0).rz * lerp(1.0, 0.9, t) + 0.024 - x * x * 1.2
        const legShare = 0.5 * smooth(0.2, 0.95, t)
        return {
          p: new THREE.Vector3(x, y, z),
          u: s,
          v: t,
          w: Math.pow(smooth(0.12, 1, t), 1.6),
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
      },
      front,
    )
  }

  // ---------------------------------------------------------------- chest panel
  // embroidered panel from the sash up under the hood (covers the tunic clasps)
  {
    const bot = sashTop - 0.01
    const top = chest.y + 0.2
    B.grid(
      8,
      4,
      KIND.panel,
      (t, s) => {
        const y = lerp(top, bot, t)
        const sl = rig.slice(y - 0.035, y + 0.035, 'body')
        const hw = lerp(0.07, 0.085, t)
        const x = (s - 0.5) * 2 * hw
        const z = sl.maxZ + 0.01 - x * x * 2.2
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
      },
      front,
    )
  }

  // ---------------------------------------------------------------- cape
  // hangs from across the shoulders (wrapping over them), drapes back over
  // the coat and trails to the floor
  {
    const top = rig.pos('upperarm_l').y + 0.02
    const bot = 0.07
    const sBack = rig.slice(top - 0.06, top, 'body')
    const zTop = Math.min(sBack.minZ, -0.12) - 0.02
    const zBot = cz - HEM_RZ_BACK - 0.05
    B.grid(
      20,
      12,
      KIND.cape,
      (t, s) => {
        const hw = lerp(0.21, 0.42, Math.pow(t, 0.75))
        const x = (s - 0.5) * 2 * hw
        const e = Math.abs(s - 0.5) * 2
        const wrap = lerp(0.17, 0.09, smooth(0, 0.3, t))
        const y = lerp(top, bot, t) - 0.04 * (1 - e * e) * t
        const z = lerp(zTop, zBot, Math.pow(t, 1.35)) + wrap * e * e - 0.012 * Math.sin(x * 15 + 0.7) * t
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
      },
      back,
    )
  }

  // ---------------------------------------------------------------- mantle
  // closed shoulder cape: the first rows tuck in under the hood toward the
  // neck (no open rim from any angle), then it caps the shoulders (wide enough
  // for the deltoids with the arms down) and drapes to mid upper arm / chest
  {
    const sh = rig.pos('upperarm_l')
    const nz = neck.z + 0.01
    // the hood's lower edge: the mantle starts hidden inside it
    let hoodBot = neck.y
    for (let y = neck.y - 0.12; y < neck.y + 0.1; y += 0.01) {
      const hs = rig.slice(y, y + 0.01, 'head')
      if (hs.maxX - hs.minX > 0.05) {
        hoodBot = y
        break
      }
    }
    const hs = rig.slice(hoodBot + 0.02, hoodBot + 0.05, 'head')
    const hoodRx = Math.max(0.1, Math.max(-hs.minX, hs.maxX))
    const hoodRz = Math.max(0.09, Math.max(hs.maxZ - nz, nz - hs.minZ))
    const neckR = 0.075
    const top = hoodBot + 0.04
    const bot = chest.y - 0.07
    const COLLAR = 0.22 // fraction of the rows that tuck in toward the neck
    B.grid(
      10,
      28,
      KIND.mantle,
      (t, s) => {
        const open = lerp(0.3, 0.66, smooth(COLLAR, 1, t))
        const th = open + s * (Math.PI * 2 - 2 * open)
        const side = Math.abs(Math.sin(th))
        let rx: number
        let rz: number
        let y: number
        if (t < COLLAR) {
          // collar: from the neck out to just inside the hood rim
          const c = t / COLLAR
          rx = lerp(neckR, hoodRx - 0.01, c)
          rz = lerp(neckR, hoodRz - 0.01, c)
          y = top + 0.03 * (1 - c)
        } else {
          const u = (t - COLLAR) / (1 - COLLAR)
          const ease = Math.sin((Math.min(1, u * 1.35) * Math.PI) / 2)
          rx = lerp(hoodRx - 0.01, sh.x + 0.21, ease)
          rz = lerp(hoodRz - 0.01, 0.25, ease)
          y = lerp(top, bot, u) - 0.05 * side * side * u - 0.035 * Math.max(0, -Math.cos(th)) * u
        }
        const fold = 1 + 0.035 * t * Math.sin(th * 9)
        const sideW = smooth(0.35, 0.95, side) * t * 0.35
        const sL = Math.sin(th) > 0
        return {
          p: new THREE.Vector3(Math.sin(th) * rx * fold, y, nz + Math.cos(th) * rz * fold),
          u: s,
          v: t,
          w: 0.3 * smooth(0.3, 1, t),
          L: Math.max(0.001, top - y),
          side: 0,
          rowW: (Math.PI * 2 - 2 * open) * (rx + rz) * 0.5,
          len: top - bot,
          skin: [
            [iS3, 1 - sideW],
            [sL ? iCL : iCR, sideW],
          ],
        }
      },
      (p) => new THREE.Vector3(p.x, 0.6, p.z - nz),
    )
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
    B.grid(
      6,
      18,
      KIND.sleeve,
      (t, s) => {
        const th = s * Math.PI * 2
        const along = lerp(start, end, t)
        const r = lerp(0.066, 0.15, Math.pow(t, 1.3))
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
      },
      (p) => {
        const rel = p.clone().sub(a)
        return rel.sub(axis.clone().multiplyScalar(rel.dot(axis)))
      },
    )
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
    disc(new THREE.Vector3(0, yTop - 0.012, sashFront + 0.01), 0.036, iP)
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
