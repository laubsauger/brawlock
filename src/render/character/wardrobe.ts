import * as THREE from 'three/webgpu'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import type { RigRest, StaffVariant } from './geometry'
import type { BackCosmeticId, EmblemCosmeticId, HeadCosmeticId, RobeCosmeticId, StaffCosmeticId } from '../../game/progressionCatalog'

/**
 * Wearable cosmetics as shapes, never colours: player colour owns identity, so every piece is
 * neutral material (bronze, iron, bone, horn, wood, felt) and anything that glows glows in the
 * wearer's player colour (gems, cracks, flames). Built procedurally in the rig's rest (bind)
 * space like the cloth, skinned rigidly to one or two bones, and merged per outfit into one
 * skinned draw per warlock.
 *
 * Read at the gameplay camera: the camera looks down from far away, so pieces are chunky,
 * rise above the hood or stick out past the shoulders, and keep the silhouette's centre
 * (where the player-colour ring and plate sit) clear.
 *
 * Per-vertex attributes (trinket material, materials.ts):
 *   aPart   material: see PART
 *   aT      0..1 along the piece (horn base -> tip, hat brim -> point): gradients and stripes
 *   aFlop   0 rigid .. 1 free: follows the cape's sway spring (hat tips, hanging bits)
 */
export const PART = { bronze: 0, iron: 1, bone: 2, horn: 3, glow: 4, felt: 5, wood: 6, flame: 7, stripe: 8, feather: 9 } as const

type HeadwearId = HeadCosmeticId
type BackId = BackCosmeticId
/** Robe cut (cloth shader): torn hem, or torn with player-colour ember veins. */
type RobeId = RobeCosmeticId
export interface Outfit {
  head: HeadwearId | null
  back: BackId | null
  robe: RobeId | null
  /** cape print (emblems.ts) */
  emblem: EmblemCosmeticId | null
  /** held in the left hand; spells then leave from its crystal (warlock.ts placeStaff) */
  staff: StaffCosmeticId | null
}
export const NO_OUTFIT: Readonly<Outfit> = { head: null, back: null, robe: null, emblem: null, staff: null }
/** staff cosmetic -> geometry variant (geometry.ts buildStaff) */
export const STAFF_VARIANT: Record<StaffCosmeticId, StaffVariant> = { 'staff-gnarled': 'gnarled', 'staff-iron': 'iron', 'staff-bone': 'bone' }
/** robe cut -> cloth shader style (gpuState.robeStyle) */
export const ROBE_STYLE: Record<RobeId, number> = { 'robe-tattered': 1, 'robe-emberveil': 2 }

type Skin = [number, number][]

/** Accumulates tagged, skinned pieces in rest space. */
class Piece {
  readonly parts: THREE.BufferGeometry[] = []
  constructor(private readonly rig: RigRest) {}

  /** Add `g` (rest space) with one material part, a 0..1 gradient and a sway weight. */
  add(g: THREE.BufferGeometry, part: number, skin: Skin, t: number | ((p: THREE.Vector3) => number) = 0, flop: number | ((p: THREE.Vector3) => number) = 0): void {
    const ng = g.index ? g.toNonIndexed() : g
    ng.deleteAttribute('uv')
    if (!ng.getAttribute('normal')) ng.computeVertexNormals()
    const pos = ng.getAttribute('position')
    const n = pos.count
    const aPart = new Float32Array(n).fill(part)
    const aT = new Float32Array(n)
    const aFlop = new Float32Array(n)
    const si = new Uint16Array(n * 4)
    const sw = new Float32Array(n * 4)
    const p = new THREE.Vector3()
    const tot = skin.reduce((a, e) => a + e[1], 0) || 1
    for (let i = 0; i < n; i++) {
      p.fromBufferAttribute(pos, i)
      aT[i] = typeof t === 'number' ? t : t(p)
      aFlop[i] = typeof flop === 'number' ? flop : flop(p)
      for (let k = 0; k < Math.min(4, skin.length); k++) {
        si[i * 4 + k] = skin[k][0]
        sw[i * 4 + k] = skin[k][1] / tot
      }
    }
    ng.setAttribute('aPart', new THREE.BufferAttribute(aPart, 1))
    ng.setAttribute('aT', new THREE.BufferAttribute(aT, 1))
    ng.setAttribute('aFlop', new THREE.BufferAttribute(aFlop, 1))
    ng.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4))
    ng.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4))
    this.parts.push(ng)
  }

  bone(name: string): number {
    return this.rig.index(name)
  }

  /** Scale every part added since `from` about `anchor` (sizes are authored small, then read-tuned here). */
  scaleFrom(from: number, anchor: THREE.Vector3, k: number): void {
    const m = new THREE.Matrix4().makeTranslation(anchor.x, anchor.y, anchor.z).multiply(new THREE.Matrix4().makeScale(k, k, k)).multiply(new THREE.Matrix4().makeTranslation(-anchor.x, -anchor.y, -anchor.z))
    for (let i = from; i < this.parts.length; i++) this.parts[i].applyMatrix4(m)
  }
}

/**
 * Gameplay-camera scale per piece: the camera sits ~11 m away looking down, where a warlock is
 * ~70 px tall, so true-to-life horns vanish. Each piece is drawn at life size and enlarged
 * about where it touches the hood or shoulder (tuned with media/perf-harness/wardrobe.cjs).
 */
const READ_SCALE: Partial<Record<HeadwearId | BackId, number>> = {
  'head-ram': 1.4,
  'head-demon': 1.4,
  'head-antlers': 1.45,
  'head-wizard': 1.6,
  'head-crescent': 1.8,
  'head-candles': 1.15,
  'head-party': 2.0,
  'head-crow': 2.8,
  'head-lantern': 1.5,
  'back-antlers': 1.3,
  'back-crescent': 1.35,
  'back-spikes': 1.35,
  'back-wings': 1.25,
}

/**
 * A tube along `pts` (rest space) whose radius follows `radius(t)`; capped with a point at the
 * end when the last radius is ~0. `t` (0 base .. 1 tip) is stored for gradients.
 */
function taperedTube(pts: THREE.Vector3[], radius: (t: number) => number, segs = 16, sides = 7): { g: THREE.BufferGeometry; t: (p: THREE.Vector3) => number } {
  const curve = new THREE.CatmullRomCurve3(pts)
  const tube = new THREE.TubeGeometry(curve, segs, 1, sides, false)
  const pos = tube.getAttribute('position')
  const ring = sides + 1
  const tOf = new Float32Array(pos.count)
  for (let i = 0; i <= segs; i++) {
    const t = i / segs
    const c = curve.getPointAt(t)
    const r = radius(t)
    for (let k = 0; k < ring; k++) {
      const vi = i * ring + k
      pos.setXYZ(vi, c.x + (pos.getX(vi) - c.x) * r, c.y + (pos.getY(vi) - c.y) * r, c.z + (pos.getZ(vi) - c.z) * r)
      tOf[vi] = t
    }
  }
  // close the base with a small cap (the tip closes itself at radius ~0)
  const base = new THREE.CircleGeometry(radius(0), sides)
  const tan = curve.getTangentAt(0)
  base.lookAt(tan.clone().negate())
  const c0 = curve.getPointAt(0)
  base.translate(c0.x, c0.y, c0.z)
  tube.computeVertexNormals()
  const parts = [tube.toNonIndexed(), base.toNonIndexed()]
  for (const x of parts) x.deleteAttribute('uv')
  const g = mergeGeometries(parts)!
  // aT by nearest curve parameter: precomputed per tube vertex, ~0 for the cap
  const lookup = new Map<string, number>()
  const key = (p: THREE.Vector3) => `${Math.round(p.x * 1e4)},${Math.round(p.y * 1e4)},${Math.round(p.z * 1e4)}`
  const tp = new THREE.Vector3()
  for (let i = 0; i < pos.count; i++) lookup.set(key(tp.fromBufferAttribute(pos, i)), tOf[i])
  return { g, t: (p) => lookup.get(key(p)) ?? 0 }
}

/** Flat crescent (two arcs) extruded `depth`, in the XY plane, centred on the origin, horns up. */
function crescent(outer: number, inner: number, offset: number, depth: number, arc = Math.PI * 1.25): THREE.BufferGeometry {
  const s = new THREE.Shape()
  const a0 = -Math.PI / 2 - arc / 2
  const a1 = -Math.PI / 2 + arc / 2
  s.absarc(0, 0, outer, a0, a1, false)
  // inner arc, shifted down so the horns taper to points
  const steps = 24
  for (let i = 0; i <= steps; i++) {
    const a = a1 - (i / steps) * (a1 - a0)
    const k = Math.sin(((a - a0) / (a1 - a0)) * Math.PI)
    s.lineTo(Math.cos(a) * outer * (1 - k) + Math.cos(a) * inner * k, Math.sin(a) * outer * (1 - k) + (Math.sin(a) * inner - offset) * k)
  }
  const g = new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: true, bevelThickness: depth * 0.4, bevelSize: depth * 0.35, bevelSegments: 1, curveSegments: 20 })
  g.translate(0, 0, -depth / 2)
  return g.toNonIndexed()
}

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)

/** Hood measurements: top point and half-width at brow height (rest space). */
function hood(rig: RigRest): { top: THREE.Vector3; brow: number; back: number; front: number; head: THREE.Vector3 } {
  const head = rig.pos('Head')
  const top = rig.slice(head.y + 0.16, 2.2, 'head')
  const brow = rig.slice(head.y + 0.05, head.y + 0.12, 'head')
  // hood tip: the highest head vertex region
  const s = rig.slice(head.y, 2.2, 'head')
  return {
    head,
    top: v((top.minX + top.maxX) / 2, Math.max(head.y + 0.22, 1.83), (top.minZ + top.maxZ) / 2),
    brow: Math.max(brow.maxX, -brow.minX, 0.1),
    back: s.minZ,
    front: s.maxZ,
  }
}

// ------------------------------------------------------------------ headwear

function buildHead(id: HeadwearId, rig: RigRest, out: Piece): void {
  const H = hood(rig)
  const head: Skin = [[out.bone('Head'), 1]]
  const from = out.parts.length
  buildHeadShape(id, H, head, out)
  // enlarged about the crown, where everything sits on or grows from the hood
  out.scaleFrom(from, v(H.head.x, H.top.y - 0.08, H.head.z), READ_SCALE[id] ?? 1)
}

function buildHeadShape(id: HeadwearId, H: ReturnType<typeof hood>, head: Skin, out: Piece): void {
  switch (id) {
    case 'head-ram': {
      // thick ribbed horns curling back and down beside the hood, ivory tips
      for (const s of [1, -1]) {
        const pts: THREE.Vector3[] = []
        for (let i = 0; i <= 10; i++) {
          const a = (i / 10) * Math.PI * 1.55
          const r = 0.11 - i * 0.004
          pts.push(v(s * (0.06 + i * 0.016), H.top.y - 0.06 + Math.sin(a) * r * 0.9, H.head.z - (1 - Math.cos(a)) * r * 0.9))
        }
        const { g, t } = taperedTube(pts, (k) => 0.042 * (1 - k * 0.75) * (1 + 0.12 * Math.sin(k * 48)), 30, 8)
        out.add(g, PART.horn, head, t)
      }
      break
    }
    case 'head-demon': {
      // tall horns sweeping up and back from the brow, a glowing seam near the tip
      for (const s of [1, -1]) {
        const pts = [v(s * 0.05, H.top.y - 0.08, H.head.z + 0.02), v(s * 0.1, H.top.y + 0.02, H.head.z - 0.02), v(s * 0.15, H.top.y + 0.13, H.head.z - 0.1), v(s * 0.13, H.top.y + 0.22, H.head.z - 0.19)]
        const radius = (k: number) => 0.034 * Math.pow(1 - k, 0.9) + 0.003
        const { g, t } = taperedTube(pts, radius, 22, 8)
        out.add(g, PART.horn, head, t)
        // two bands wrapped around the horn: perpendicular to it, just wider than it is there
        const curve = new THREE.CatmullRomCurve3(pts)
        for (const at of [0.3, 0.5]) {
          const ring = new THREE.TorusGeometry(radius(at) + 0.006, 0.009, 6, 18)
          const c = curve.getPointAt(at)
          ring.lookAt(curve.getTangentAt(at))
          ring.translate(c.x, c.y, c.z)
          out.add(ring, PART.glow, head)
        }
      }
      break
    }
    case 'head-antlers': {
      // branching antlers (wood), the widest silhouette of the set
      for (const s of [1, -1]) {
        const main = [v(s * 0.05, H.top.y - 0.08, H.head.z), v(s * 0.13, H.top.y + 0.02, H.head.z - 0.04), v(s * 0.22, H.top.y + 0.12, H.head.z - 0.08), v(s * 0.24, H.top.y + 0.25, H.head.z - 0.12)]
        const m = taperedTube(main, (k) => 0.045 * (1 - k * 0.6), 20, 7)
        out.add(m.g, PART.bone, head, m.t)
        const curve = new THREE.CatmullRomCurve3(main)
        for (const [at, dx, dy, dz] of [[0.35, 0.14, 0.1, 0.08], [0.6, 0.03, 0.18, 0.1], [0.8, 0.14, 0.08, -0.08]] as const) {
          const b = curve.getPointAt(at)
          const tine = taperedTube([b, v(b.x + s * dx * 0.5, b.y + dy * 0.6, b.z + dz * 0.5), v(b.x + s * dx, b.y + dy, b.z + dz)], (k) => 0.03 * (1 - k * 0.8), 10, 6)
          out.add(tine.g, PART.bone, head, tine.t)
        }
      }
      break
    }
    case 'head-wizard': {
      // a tall pointed hat whose upper half flops with the cape spring
      const brim = new THREE.CylinderGeometry(H.brow + 0.12, H.brow + 0.14, 0.018, 24)
      brim.translate(H.head.x, H.top.y - 0.06, H.head.z - 0.01)
      out.add(brim, PART.felt, head, 0)
      const pts: THREE.Vector3[] = []
      for (let i = 0; i <= 12; i++) {
        const k = i / 12
        pts.push(v(H.head.x, H.top.y - 0.06 + k * 0.48, H.head.z - 0.01 - Math.pow(k, 2.2) * 0.2))
      }
      const cone = taperedTube(pts, (k) => (H.brow + 0.02) * Math.pow(1 - k, 1.1) + 0.004, 24, 14)
      const baseY = H.top.y - 0.06
      out.add(cone.g, PART.felt, head, cone.t, (p) => Math.max(0, (p.y - baseY - 0.16) / 0.32))
      const band = new THREE.TorusGeometry(H.brow + 0.015, 0.012, 5, 24)
      band.rotateX(Math.PI / 2)
      band.translate(H.head.x, baseY + 0.03, H.head.z - 0.01)
      out.add(band, PART.glow, head)
      break
    }
    case 'head-crescent': {
      // a crescent moon floating above and behind the hood, glowing edge
      const c = crescent(0.17, 0.12, 0.05, 0.025)
      c.rotateX(-0.35)
      c.translate(H.head.x, H.top.y + 0.1, H.back + 0.02)
      out.add(c, PART.bronze, head)
      const glow = crescent(0.19, 0.17, 0.0, 0.012)
      glow.rotateX(-0.35)
      glow.translate(H.head.x, H.top.y + 0.1, H.back + 0.02)
      out.add(glow, PART.glow, head)
      break
    }
    case 'head-candles': {
      // an iron ring of five candles with player-colour flames
      const ring = new THREE.TorusGeometry(H.brow + 0.03, 0.014, 5, 24)
      ring.rotateX(Math.PI / 2)
      const cy = H.top.y - 0.05
      ring.translate(H.head.x, cy, H.head.z - 0.01)
      out.add(ring, PART.iron, head)
      for (let i = 0; i < 5; i++) {
        const a = Math.PI / 2 + (i - 2) * 0.62 + Math.PI
        const x = H.head.x + Math.cos(a) * (H.brow + 0.03)
        const z = H.head.z - 0.01 - Math.sin(a) * (H.brow + 0.03)
        const h = 0.08 + (i % 2) * 0.035
        const candle = new THREE.CylinderGeometry(0.024, 0.027, h, 8)
        candle.translate(x, cy + h / 2, z)
        out.add(candle, PART.bone, head)
        const flame = new THREE.ConeGeometry(0.022, 0.075, 6)
        flame.translate(x, cy + h + 0.04, z)
        out.add(flame, PART.flame, head, i / 5)
      }
      break
    }
    case 'head-party': {
      // a party hat, slightly askew, with a pom-pom: striped bronze and iron
      const baseY = H.top.y - 0.04
      const tilt = new THREE.Matrix4().makeRotationZ(0.28).setPosition(H.head.x + 0.03, baseY, H.head.z - 0.01)
      const cone = new THREE.ConeGeometry(0.075, 0.26, 16, 6, true)
      cone.translate(0, 0.13, 0)
      cone.applyMatrix4(tilt)
      out.add(cone, PART.stripe, head, (p) => (p.y - baseY) / 0.26)
      const pom = new THREE.IcosahedronGeometry(0.03, 1)
      pom.translate(0, 0.27, 0)
      pom.applyMatrix4(tilt)
      out.add(pom, PART.glow, head, 0, 0.6)
      break
    }
    case 'head-crow': {
      // a crow perched on the hood, beak forward, wings folded, player-colour eyes
      const y = H.top.y - 0.03
      const z = H.head.z - 0.03
      const body = new THREE.SphereGeometry(0.06, 10, 8)
      body.scale(0.85, 0.8, 1.35)
      body.rotateX(0.35)
      body.translate(0, y + 0.06, z)
      out.add(body, PART.feather, head)
      const headG = new THREE.SphereGeometry(0.038, 10, 8)
      headG.translate(0, y + 0.12, z + 0.06)
      out.add(headG, PART.feather, head)
      const beak = new THREE.ConeGeometry(0.014, 0.06, 6)
      beak.rotateX(Math.PI / 2)
      beak.translate(0, y + 0.115, z + 0.12)
      out.add(beak, PART.bone, head)
      const tail = new THREE.ConeGeometry(0.035, 0.11, 4)
      tail.scale(1.4, 0.4, 1)
      tail.rotateX(-Math.PI / 2 - 0.4)
      tail.translate(0, y + 0.04, z - 0.12)
      out.add(tail, PART.feather, head, 0, 0.5)
      for (const s of [1, -1]) {
        const eye = new THREE.SphereGeometry(0.008, 6, 4)
        eye.translate(s * 0.026, y + 0.13, z + 0.085)
        out.add(eye, PART.glow, head)
      }
      break
    }
    case 'head-lantern': {
      // an anglerfish lure: a horn stalk grows from the hood's crown and arches forward on the
      // centre line, dangling a lantern in the wearer's colour over the hood's tip, above the eyes
      const x = H.head.x
      const root = v(x, H.top.y - 0.07, H.head.z)
      // high enough that the lantern hangs over the hood's tip: any lower and it covers the eyes
      const stalk = [root, v(x, H.top.y + 0.14, H.head.z - 0.05), v(x, H.top.y + 0.3, H.head.z + 0.03), v(x, H.top.y + 0.32, H.head.z + 0.14), v(x, H.top.y + 0.26, H.front + 0.04)]
      const st = taperedTube(stalk, (k) => 0.026 * (1 - k * 0.55), 18, 7)
      out.add(st.g, PART.horn, head, (p) => st.t(p) * 0.75)
      const hook = stalk[4]
      const chain = taperedTube([hook, v(hook.x, hook.y - 0.03, hook.z)], () => 0.005, 3, 4)
      out.add(chain.g, PART.iron, head, 0, 0.5)
      // open bars so the bulb shows from every side; a cap narrower than the bulb (seen from above)
      const ly = hook.y - 0.09
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2 + Math.PI / 4
        const bar = new THREE.CylinderGeometry(0.006, 0.006, 0.1, 4)
        bar.translate(hook.x + Math.cos(a) * 0.05, ly, hook.z + Math.sin(a) * 0.05)
        out.add(bar, PART.iron, head, 0, 1)
      }
      const base = new THREE.CylinderGeometry(0.056, 0.048, 0.018, 8)
      base.translate(hook.x, ly - 0.058, hook.z)
      out.add(base, PART.iron, head, 0, 1)
      const cap = new THREE.ConeGeometry(0.016, 0.03, 6)
      cap.translate(hook.x, ly + 0.065, hook.z)
      out.add(cap, PART.iron, head, 0, 1)
      const light = new THREE.IcosahedronGeometry(0.044, 1)
      light.translate(hook.x, ly, hook.z)
      out.add(light, PART.glow, head, 0, 1)
      break
    }
  }
}

// ------------------------------------------------------------------ back

/**
 * Back pieces rise from behind the shoulders and break the silhouette. They never cover the
 * mantle, whose player-colour wash is the strongest identity read from the top-down camera.
 */
function buildBack(id: BackId, rig: RigRest, out: Piece): void {
  const spine = rig.pos('spine_03')
  const neck = rig.pos('neck_01')
  const skin: Skin = [[out.bone('spine_03'), 0.8], [out.bone('spine_02'), 0.2]]
  // the upper back's surface, between the shoulder blades
  const by = (spine.y + neck.y) / 2
  const bz = spine.z - 0.13
  const from = out.parts.length
  switch (id) {
    case 'back-antlers': {
      // two branching antlers from the shoulder blades, up and out past the hood
      for (const s of [1, -1]) {
        const main = [v(s * 0.08, by, bz), v(s * 0.16, by + 0.14, bz - 0.06), v(s * 0.26, by + 0.3, bz - 0.1), v(s * 0.3, by + 0.46, bz - 0.12)]
        const m = taperedTube(main, (k) => 0.04 * (1 - k * 0.65), 18, 7)
        out.add(m.g, PART.bone, skin, m.t)
        const curve = new THREE.CatmullRomCurve3(main)
        for (const [at, dx, dy, dz] of [[0.35, 0.13, 0.06, 0.04], [0.6, 0.03, 0.15, 0.06], [0.82, 0.12, 0.05, -0.05]] as const) {
          const b = curve.getPointAt(at)
          const tine = taperedTube([b, v(b.x + s * dx * 0.5, b.y + dy * 0.6, b.z + dz * 0.5), v(b.x + s * dx, b.y + dy, b.z + dz)], (k) => 0.026 * (1 - k * 0.8), 8, 6)
          out.add(tine.g, PART.bone, skin, tine.t)
        }
      }
      break
    }
    case 'back-crescent': {
      // twin crescent blades behind the shoulders, leaning out so they read from above
      for (const s of [1, -1]) {
        const blade = crescent(0.27, 0.19, 0.09, 0.026, Math.PI * 1.05)
        const glow = crescent(0.19, 0.172, 0.0, 0.032, Math.PI * 0.95)
        for (const [g, part] of [[blade, PART.iron], [glow, PART.glow]] as const) {
          g.rotateY(Math.PI / 2)
          g.rotateZ(-s * 0.75)
          g.rotateX(0.35)
          g.translate(s * 0.24, by + 0.22, bz - 0.06)
          out.add(g, part, skin)
        }
      }
      break
    }
    case 'back-spikes': {
      // a fan of bone spikes radiating from the collar behind the hood
      // long and wide enough to stick out past the hood and the cape's rim from above
      for (let i = 0; i < 7; i++) {
        const a = ((i - 3) / 3) * 1.3
        const len = 0.44 - Math.abs(i - 3) * 0.04
        const b = v(Math.sin(a) * 0.07, by + 0.02, bz)
        const tip = v(Math.sin(a) * len * 1.1, by + Math.cos(a) * len * 0.9, bz - 0.16 - Math.cos(a) * 0.06)
        const spike = taperedTube([b, b.clone().lerp(tip, 0.55).add(v(0, 0.03, -0.03)), tip], (k) => 0.05 * (1 - k) + 0.003, 8, 6)
        out.add(spike.g, PART.bone, skin, spike.t)
      }
      const clasp = new THREE.TorusGeometry(0.07, 0.016, 6, 16)
      clasp.translate(0, by + 0.03, bz + 0.01)
      out.add(clasp, PART.iron, skin)
      break
    }
    case 'back-wings': {
      // folded bat wings: bone fingers with a leathery membrane, spread up and out
      for (const s of [1, -1]) {
        const root = v(s * 0.07, by + 0.02, bz)
        const elbow = v(s * 0.24, by + 0.24, bz - 0.12)
        const tips = [v(s * 0.46, by + 0.36, bz - 0.2), v(s * 0.48, by + 0.16, bz - 0.24), v(s * 0.4, by - 0.04, bz - 0.22), v(s * 0.26, by - 0.14, bz - 0.17)]
        const arm = taperedTube([root, root.clone().lerp(elbow, 0.5).add(v(0, 0.04, 0)), elbow], (k) => 0.024 * (1 - k * 0.4), 8, 6)
        out.add(arm.g, PART.bone, skin, arm.t)
        const pts: number[] = []
        let prev = elbow
        for (const t of tips) {
          const finger = taperedTube([elbow, elbow.clone().lerp(t, 0.5).add(v(0, 0.02, 0)), t], (k) => 0.012 * (1 - k * 0.7) + 0.002, 8, 5)
          out.add(finger.g, PART.bone, skin, finger.t)
          if (prev !== elbow) pts.push(elbow.x, elbow.y, elbow.z, prev.x, prev.y, prev.z, t.x, t.y, t.z)
          prev = t
        }
        // membrane between consecutive fingers, and from the last finger back to the root
        const last = tips[tips.length - 1]
        pts.push(elbow.x, elbow.y, elbow.z, last.x, last.y, last.z, root.x, root.y, root.z)
        const mem = new THREE.BufferGeometry()
        mem.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
        mem.computeVertexNormals()
        // rigid like the fingers it spans: following the cape's sway, a knockback swung it off
        // the frame and into the body
        out.add(mem, PART.felt, skin)
      }
      break
    }
  }
  out.scaleFrom(from, v(0, by, bz), READ_SCALE[id] ?? 1)
}

/** Merged, skinned geometry for an outfit (null when nothing is worn). */
export function buildOutfit(rig: RigRest, outfit: Outfit): THREE.BufferGeometry | null {
  const out = new Piece(rig)
  if (outfit.head) buildHead(outfit.head, rig, out)
  if (outfit.back) buildBack(outfit.back, rig, out)
  if (out.parts.length === 0) return null
  const keep = ['position', 'normal', 'aPart', 'aT', 'aFlop', 'skinIndex', 'skinWeight']
  for (const g of out.parts) for (const name of Object.keys(g.attributes)) if (!keep.includes(name)) g.deleteAttribute(name)
  const g = mergeGeometries(out.parts, false)
  if (!g) throw new Error('wardrobe: merge failed')
  g.computeBoundingSphere()
  return g
}

