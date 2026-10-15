import * as THREE from 'three/webgpu'
import {
  abs,
  bumpMap,
  exp,
  float,
  mix,
  normalWorld,
  positionGeometry,
  positionWorld,
  pow,
  saturate,
  sin,
  smoothstep,
  step,
  texture,
  triplanarTexture,
  uniform,
  vec3,
} from 'three/tsl'
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js'
import { S } from '../coords'
import type { Node } from 'three/webgpu'
import { loadSurface, type SurfaceMaps } from './textures'
import { asF, gamePos, type WorldCtx } from './world'

/**
 * The caldera around the platform, so the arena reads as a place instead of
 * a void: basalt boulders and cliff walls rising out of the lava (molten glow
 * at the waterline, moss and glowing lichen on top), clusters of emissive
 * crystals, and a smoky sky dome for low camera angles (menu). Three themes
 * via uniforms: temple (warm stone, amber crystals), volcanic (black basalt,
 * fire crystals), overgrown (moss, green-cyan crystals).
 */

interface EnvTheme {
  rock: THREE.Color
  rock2: THREE.Color
  moss: THREE.Color
  mossAmt: number
  lichen: THREE.Color
  crystal: THREE.Color
}

const THEMES: EnvTheme[] = [
  { rock: new THREE.Color(0.075, 0.06, 0.05), rock2: new THREE.Color(0.17, 0.13, 0.1), moss: new THREE.Color(0.05, 0.08, 0.03), mossAmt: 0.35, lichen: new THREE.Color(0.9, 0.7, 0.2), crystal: new THREE.Color(2.4, 1.2, 0.3) },
  { rock: new THREE.Color(0.025, 0.022, 0.025), rock2: new THREE.Color(0.08, 0.065, 0.065), moss: new THREE.Color(0.04, 0.05, 0.025), mossAmt: 0.12, lichen: new THREE.Color(1.6, 0.5, 0.1), crystal: new THREE.Color(3.0, 0.7, 0.15) },
  { rock: new THREE.Color(0.05, 0.05, 0.045), rock2: new THREE.Color(0.11, 0.1, 0.085), moss: new THREE.Color(0.06, 0.14, 0.035), mossAmt: 0.85, lichen: new THREE.Color(0.3, 1.6, 0.6), crystal: new THREE.Color(0.4, 2.4, 1.6) },
]

/** Deterministic PRNG for placement (render-side only). */
function mulberry(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function hash3(x: number, y: number, z: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453
  return s - Math.floor(s)
}

function valueNoise3(x: number, y: number, z: number): number {
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
        const h = hash3(xi + dx, yi + dy, zi + dz)
        acc += h * (dx ? u : 1 - u) * (dy ? v : 1 - v) * (dz ? w : 1 - w)
      }
  return acc
}

/** Lumpy boulder: displaced icosphere with a flattened base. */
function rockGeometry(seed: number, detail: number): THREE.BufferGeometry {
  let g: THREE.BufferGeometry = new THREE.IcosahedronGeometry(1, detail)
  g.deleteAttribute('normal')
  g.deleteAttribute('uv')
  g = mergeVertices(g)
  const pos = g.getAttribute('position') as THREE.BufferAttribute
  const v = new THREE.Vector3()
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i)
    const n1 = valueNoise3(v.x * 1.6 + seed, v.y * 1.6, v.z * 1.6)
    const n2 = valueNoise3(v.x * 4.1, v.y * 4.1 + seed, v.z * 4.1)
    // faceted look: a few big planes plus grit
    const d = 0.72 + n1 * 0.45 + n2 * 0.12
    v.multiplyScalar(d)
    if (v.y < -0.2) v.y = -0.2 + (v.y + 0.2) * 0.3
    pos.setXYZ(i, v.x, v.y, v.z)
  }
  g.computeVertexNormals()
  g.computeBoundingSphere()
  return g
}

/** Hexagonal prism with a pointed cap, base at y = 0, height ~3.1. */
function crystalGeometry(): THREE.BufferGeometry {
  const prism = new THREE.CylinderGeometry(1, 1, 2.4, 6, 1).toNonIndexed()
  prism.translate(0, 1.2, 0)
  const cone = new THREE.ConeGeometry(1, 1.4, 6, 1).toNonIndexed()
  cone.translate(0, 3.1, 0)
  const merged = new THREE.BufferGeometry()
  const p = [...(prism.getAttribute('position').array as Float32Array), ...(cone.getAttribute('position').array as Float32Array)]
  const n = [...(prism.getAttribute('normal').array as Float32Array), ...(cone.getAttribute('normal').array as Float32Array)]
  merged.setAttribute('position', new THREE.Float32BufferAttribute(p, 3))
  merged.setAttribute('normal', new THREE.Float32BufferAttribute(n, 3))
  merged.computeBoundingSphere()
  prism.dispose()
  cone.dispose()
  return merged
}

export class Environment {
  readonly group = new THREE.Group()
  private uRock = uniform(new THREE.Color())
  private uRock2 = uniform(new THREE.Color())
  private uMoss = uniform(new THREE.Color())
  private uMossAmt = uniform(0.3)
  private uLichen = uniform(new THREE.Color())
  private uCrystal = uniform(new THREE.Color())
  private theme = -1
  private disposables: { dispose(): void }[] = []
  private rockMaps: SurfaceMaps | null = null
  private mossMaps: SurfaceMaps | null = null
  private rockMeshes: THREE.InstancedMesh[] = []
  private rockMat: THREE.MeshStandardNodeMaterial | null = null
  private disposed = false

  constructor(private ctx: WorldCtx) {
    this.group.name = 'Environment'
    const rand = mulberry(0x5eed)
    const rockGeos = [rockGeometry(1.3, 2), rockGeometry(7.7, 2), rockGeometry(13.1, 3)]
    const rockMat = this.rockMaterial()
    const crystalMat = this.crystalMaterial()
    this.disposables.push(rockMat, crystalMat, ...rockGeos)

    // placements: inner boulder band, outer cliff wall (game units)
    type Place = { x: number; y: number; sx: number; sy: number; sz: number; rot: number; sink: number }
    const places: Place[][] = [[], [], []]
    const crystals: { x: number; y: number; h: number; s: number; rx: number; rz: number; ry: number }[] = []
    const addRock = (r: number, a: number, size: number, tall: number) => {
      const x = Math.cos(a) * r
      const y = Math.sin(a) * r
      const k = Math.floor(rand() * 3)
      const p = { x, y, sx: size * (0.8 + rand() * 0.5), sy: size * tall, sz: size * (0.8 + rand() * 0.5), rot: rand() * Math.PI * 2, sink: size * (0.15 + rand() * 0.2) }
      places[k].push(p)
      // crystals sprout from some rock tops
      if (rand() < 0.4) {
        const n = 2 + Math.floor(rand() * 4)
        for (let i = 0; i < n; i++) {
          const ca = rand() * Math.PI * 2
          const cr = size * 0.35 * rand()
          crystals.push({
            x: x + Math.cos(ca) * cr,
            y: y + Math.sin(ca) * cr,
            h: p.sy * 0.55 - p.sink,
            s: size * (0.05 + rand() * 0.07),
            rx: (rand() - 0.5) * 0.9,
            rz: (rand() - 0.5) * 0.9,
            ry: rand() * Math.PI,
          })
        }
      }
    }
    for (let i = 0; i < 70; i++) addRock(2380 + rand() * 1600, rand() * Math.PI * 2, 70 + rand() * 170, 0.5 + rand() * 0.5)
    for (let i = 0; i < 46; i++) addRock(4300 + rand() * 1700, (i / 46) * Math.PI * 2 + rand() * 0.1, 500 + rand() * 600, 0.9 + rand() * 0.9)
    for (let i = 0; i < 34; i++) addRock(6200 + rand() * 900, (i / 34) * Math.PI * 2 + rand() * 0.15, 900 + rand() * 700, 1.3 + rand() * 1.1)

    const m4 = new THREE.Matrix4()
    const q = new THREE.Quaternion()
    const e = new THREE.Euler()
    const sc = new THREE.Vector3()
    const tp = new THREE.Vector3()
    places.forEach((list, k) => {
      if (list.length === 0) return
      const mesh = new THREE.InstancedMesh(rockGeos[k], rockMat, list.length)
      list.forEach((p, i) => {
        e.set(0, p.rot, 0)
        q.setFromEuler(e)
        sc.set(p.sx * S, p.sy * S, p.sz * S)
        tp.set(p.x * S, -p.sink * S, -p.y * S)
        m4.compose(tp, q, sc)
        mesh.setMatrixAt(i, m4)
      })
      mesh.computeBoundingSphere()
      mesh.frustumCulled = false
      mesh.name = `rocks-${k}`
      this.rockMeshes.push(mesh)
      this.group.add(mesh)
      this.disposables.push(mesh)
    })
    if (crystals.length > 0) {
      const cg = crystalGeometry()
      this.disposables.push(cg)
      const mesh = new THREE.InstancedMesh(cg, crystalMat, crystals.length)
      crystals.forEach((c, i) => {
        e.set(c.rx, c.ry, c.rz)
        q.setFromEuler(e)
        sc.set(c.s * S, c.s * S * (1 + (i % 3) * 0.5), c.s * S)
        tp.set(c.x * S, c.h * S, -c.y * S)
        m4.compose(tp, q, sc)
        mesh.setMatrixAt(i, m4)
      })
      mesh.frustumCulled = false
      mesh.name = 'crystals'
      this.group.add(mesh)
      this.disposables.push(mesh)
    }

    // sky dome (visible only from the low menu camera): smoky horizon lit by lava
    const skyGeo = new THREE.SphereGeometry(140, 32, 16)
    const skyMat = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false })
    const dir = positionWorld.normalize()
    const elev = saturate(dir.y)
    const smoke = texture(ctx.noise, dir.xz.mul(1.3).add(ctx.uTime.mul(0.004))).r
    const horizon = vec3(0.16, 0.04, 0.018).mul(pow(float(1).sub(elev), 6)).mul(smoke.mul(0.8).add(0.6))
    skyMat.colorNode = vec3(0.008, 0.006, 0.012).add(horizon)
    skyMat.fog = false
    const sky = new THREE.Mesh(skyGeo, skyMat)
    sky.renderOrder = -20
    sky.frustumCulled = false
    this.group.add(sky)
    this.disposables.push(skyGeo, skyMat)

    this.setTheme(0)
    this.rockMat = rockMat
    const aniso = ctx.tier.anisotropy
    void Promise.all([loadSurface('shared', 'cliff_rock', aniso), loadSurface('shared', 'ground_moss', aniso)]).then(([rock, moss]) => {
      if (this.disposed || !rock) return
      this.rockMaps = rock
      this.mossMaps = moss
      const mat = this.rockMaterial()
      for (const m of this.rockMeshes) m.material = mat
      this.rockMat?.dispose()
      this.rockMat = mat
      this.disposables.push(mat)
    })
  }

  setTheme(theme: number): void {
    const t = ((theme % 3) + 3) % 3
    if (t === this.theme) return
    this.theme = t
    const th = THEMES[t]
    this.uRock.value.copy(th.rock)
    this.uRock2.value.copy(th.rock2)
    this.uMoss.value.copy(th.moss)
    this.uMossAmt.value = th.mossAmt
    this.uLichen.value.copy(th.lichen)
    this.uCrystal.value.copy(th.crystal)
  }

  private rockMaterial(): THREE.MeshStandardNodeMaterial {
    const { noise, uTime: t } = this.ctx
    const gp = gamePos()
    const h = positionWorld.y.div(S)
    const n = texture(noise, gp.mul(1 / 300))
    const n2 = texture(noise, gp.mul(1 / 70).add(h.mul(0.004)))
    const strata = sin(h.mul(0.05).add(n.r.mul(6))).mul(0.5).add(0.5)
    let rock = mix(this.uRock, this.uRock2, saturate(n.g.mul(0.9).add(strata.mul(0.3)).sub(0.2)))
    rock = rock.mul(n2.r.mul(0.5).add(0.75))
    const up = saturate(normalWorld.y)
    const mossMask = smoothstep(0.45, 0.8, up.add(n.b.mul(0.4)).sub(float(1).sub(this.uMossAmt).mul(0.6))).mul(step(30, h))
    let col: Node<'vec3'> = mix(rock, this.uMoss.mul(n2.g.mul(0.6).add(0.7)), mossMask)
    let height: Node<'float'> = n2.r.mul(0.6).add(n.g.mul(0.3)).add(strata.mul(0.15))
    let rough: Node<'float'> = mix(float(0.78), float(0.95), mossMask).sub(n2.g.mul(0.25)).add(n2.r.sub(0.5).mul(0.2))
    const rm = this.rockMaps
    if (rm) {
      // authored cliff rock + moss, triplanar in world space (huge boulders, no stretching)
      const sc = float(1 / 3.2)
      const alb = triplanarTexture(texture(rm.albedo), null, null, sc, positionWorld, normalWorld).rgb
      const orm = triplanarTexture(texture(rm.orm), null, null, sc, positionWorld, normalWorld).rgb
      const hh = triplanarTexture(texture(rm.height ?? rm.albedo), null, null, sc, positionWorld, normalWorld).r
      const rockT = alb.mul(mix(this.uRock, this.uRock2, n.g).mul(3.2)).mul(orm.r)
      let mossT: Node<'vec3'> = this.uMoss.mul(n2.g.mul(0.6).add(0.7))
      const mm = this.mossMaps
      if (mm) mossT = triplanarTexture(texture(mm.albedo), null, null, float(1 / 1.6), positionWorld, normalWorld).rgb.mul(this.uMoss.mul(6))
      col = mix(rockT, mossT, mossMask)
      height = hh.mul(0.85).add(strata.mul(0.15))
      rough = mix(orm.g, float(0.95), mossMask)
    }
    // molten waterline and heat cracks low on the rock
    const water = exp(h.div(-12))
    const crack = float(1).sub(smoothstep(0, 0.06, texture(noise, gp.mul(1 / 160).add(h.mul(0.006))).b)).mul(exp(h.div(-160)))
    const lichen = step(0.82, n2.b).mul(mossMask).mul(sin(t.mul(1.2).add(n.r.mul(20))).mul(0.3).add(0.7))
    const m = new THREE.MeshStandardNodeMaterial()
    m.name = 'CalderaRock'
    m.colorNode = col
    m.roughnessNode = saturate(rough)
    // faceted grit and strata relief
    m.normalNode = bumpMap(height.sub(crack.mul(0.4)), float(1.4))
    m.metalnessNode = float(0)
    m.emissiveNode = vec3(2.2, 0.5, 0.06)
      .mul(water.mul(0.8).add(crack.mul(0.45)))
      .add(this.uLichen.mul(lichen.mul(0.35)))
    return m
  }

  private crystalMaterial(): THREE.MeshStandardNodeMaterial {
    const t = this.ctx.uTime
    const h01 = asF(positionGeometry.y.div(3.1))
    const pulse = sin(t.mul(1.7).add(positionWorld.x.mul(3)).add(positionWorld.z.mul(2))).mul(0.25).add(0.75)
    const rimF = pow(float(1).sub(abs(normalWorld.y)), 2)
    const m = new THREE.MeshStandardNodeMaterial()
    m.name = 'Crystal'
    m.colorNode = this.uCrystal.mul(0.05)
    m.roughnessNode = float(0.15)
    m.metalnessNode = float(0)
    m.emissiveNode = this.uCrystal.mul(h01.mul(0.8).add(0.3)).mul(pulse).mul(rimF.mul(0.5).add(0.5)).mul(0.8)
    return m
  }

  dispose(): void {
    this.disposed = true
    for (const d of this.disposables) d.dispose()
  }
}
