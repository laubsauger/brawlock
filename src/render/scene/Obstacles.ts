import * as THREE from 'three/webgpu'
import {
  attribute,
  bumpMap,
  exp,
  float,
  max,
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
  vec2,
  vec3,
} from 'three/tsl'
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js'
import type { Node } from 'three/webgpu'
import type { ObstacleState } from '../../sim/types'
import { S, TILE_TOP_H } from '../coords'
import { loadSurface, type SurfaceMaps } from './textures'
import { asV4, gamePos, type WorldCtx } from './world'

/**
 * Destructible pillars (state.obstacles). One instanced mesh per theme:
 *  0 temple    - broken fluted column on a plinth, rune band
 *  1 volcanic  - tapered basalt spire with ember veins
 *  2 overgrown - mossy standing stone
 * Footprint = obstacle radius; damage opens glowing cracks by hp fraction;
 * hits flash and shake the pillar; new pillars mid-round rise from the floor
 * (Rockpillar). Destruction FX are driven by the world from events.
 */

const CAPACITY = 32
export const OBSTACLE_MAX_HP = 400
const RISE_DUR = 0.5

function hash(n: number): number {
  const s = Math.sin(n * 127.1) * 43758.5453
  return s - Math.floor(s)
}

/** Unit footprint (radius 1), height 1, base at y = 0. */
function columnGeometry(): THREE.BufferGeometry {
  const seg = 24
  const g = new THREE.CylinderGeometry(1, 1.06, 1, seg, 6, false)
  g.translate(0, 0.5, 0)
  const pos = g.getAttribute('position') as THREE.BufferAttribute
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i)
    const y = pos.getY(i)
    const z = pos.getZ(i)
    const a = Math.atan2(z, x)
    const r = Math.hypot(x, z)
    if (r < 1e-4) {
      if (y > 0.99) pos.setY(i, 0.86)
      continue
    }
    const flute = 1 - 0.07 * Math.pow(Math.abs(Math.cos(a * 6)), 0.6)
    let ny = y
    if (y > 0.99) ny = 0.78 + hash(a * 13.7) * 0.22 // broken top
    pos.setXYZ(i, (x / r) * r * flute, ny, (z / r) * r * flute)
  }
  g.computeVertexNormals()
  // chamfered plinth: wide foot, bevelled step, so the silhouette meets the floor
  const prof = [
    [1.0, 0.16],
    [1.18, 0.15],
    [1.26, 0.12],
    [1.3, 0.09],
    [1.42, 0.07],
    [1.5, 0.035],
    [1.54, 0.0],
  ].map(([r, y]) => new THREE.Vector2(r, y))
  const plinth = new THREE.LatheGeometry(prof.reverse(), 32)
  const merged = mergeGeometriesSimple([g, plinth])
  return merged
}

function spireGeometry(): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(0.62, 1.08, 1, 6, 5, false)
  g.translate(0, 0.5, 0)
  const pos = g.getAttribute('position') as THREE.BufferAttribute
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i)
    const y = pos.getY(i)
    const z = pos.getZ(i)
    const a = Math.atan2(z, x)
    const jag = 1 + (hash(a * 7.1 + y * 19.3) - 0.5) * 0.18
    let ny = y
    if (y > 0.99) ny = 0.84 + hash(a * 3.3) * 0.22
    pos.setXYZ(i, x * jag, ny, z * jag)
  }
  g.computeVertexNormals()
  return g.toNonIndexed()
}

function standingStoneGeometry(): THREE.BufferGeometry {
  let g: THREE.BufferGeometry = new THREE.IcosahedronGeometry(1, 2)
  g.deleteAttribute('normal')
  g.deleteAttribute('uv')
  g = mergeVertices(g)
  const pos = g.getAttribute('position') as THREE.BufferAttribute
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i)
    const y = pos.getY(i)
    const z = pos.getZ(i)
    const d = 0.85 + hash(x * 3.1 + y * 5.7 + z * 7.3) * 0.25
    // tall slab: base at 0, top at 1
    pos.setXYZ(i, x * d * 1.05, (y * d + 1) * 0.5, z * d * 0.78)
  }
  g.computeVertexNormals()
  return g
}

function mergeGeometriesSimple(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const p: number[] = []
  const n: number[] = []
  for (const g of list) {
    const ni = g.index ? g.toNonIndexed() : g
    p.push(...(ni.getAttribute('position').array as Float32Array))
    n.push(...(ni.getAttribute('normal').array as Float32Array))
  }
  const out = new THREE.BufferGeometry()
  out.setAttribute('position', new THREE.Float32BufferAttribute(p, 3))
  out.setAttribute('normal', new THREE.Float32BufferAttribute(n, 3))
  return out
}

interface ObsTrack {
  id: number
  hp: number
  seen: number
  spawnAt: number
  hitAt: number
  seed: number
}

export class Obstacles {
  readonly group = new THREE.Group()
  private meshes: THREE.InstancedMesh[] = []
  private attrs: THREE.InstancedBufferAttribute[] = []
  private materials: THREE.MeshStandardNodeMaterial[] = []
  private tracks = new Map<number, ObsTrack>()
  private theme = 0
  private frameId = 0
  private m4 = new THREE.Matrix4()
  private q = new THREE.Quaternion()
  private e = new THREE.Euler()
  private v = new THREE.Vector3()
  private sc = new THREE.Vector3()
  /** shared authored stone set (public/textures/shared/cliff_rock), null = procedural */
  private maps: SurfaceMaps | null = null
  private disposed = false
  /** called when a pillar loses hp (x, y, hpFrac) for chip FX */
  onHit: ((x: number, y: number, radius: number, hpFrac: number) => void) | null = null

  constructor(private ctx: WorldCtx) {
    this.group.name = 'Obstacles'
    const geos = [columnGeometry(), spireGeometry(), standingStoneGeometry()]
    geos.forEach((g, k) => {
      const attr = new THREE.InstancedBufferAttribute(new Float32Array(CAPACITY * 4), 4)
      attr.setUsage(THREE.DynamicDrawUsage)
      g.setAttribute('aObs', attr)
      const mat = this.material(k)
      const mesh = new THREE.InstancedMesh(g, mat, CAPACITY)
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
      mesh.count = 0
      mesh.frustumCulled = false
      mesh.castShadow = ctx.tier.shadowMap > 0
      mesh.receiveShadow = ctx.tier.shadowMap > 0
      mesh.name = `obstacles-${k}`
      this.group.add(mesh)
      this.meshes.push(mesh)
      this.attrs.push(attr)
      this.materials.push(mat)
    })
    void loadSurface('shared', 'cliff_rock', ctx.tier.anisotropy).then((m) => {
      if (!m || this.disposed) return
      this.maps = m
      this.materials.forEach((old, k) => {
        const mat = this.material(k)
        this.meshes[k].material = mat
        this.materials[k] = mat
        old.dispose()
      })
    })
  }

  setTheme(theme: number): void {
    this.theme = ((theme % 3) + 3) % 3
  }

  /** Is `id` a live obstacle? (to route projectile hits to chip FX) */
  has(id: number): boolean {
    return this.tracks.has(id)
  }

  get(id: number): ObsTrack | undefined {
    return this.tracks.get(id)
  }

  update(list: ObstacleState[], now: number, animateNew: boolean): void {
    this.frameId++
    const fid = this.frameId
    const k = this.theme
    const mesh = this.meshes[k]
    const attr = this.attrs[k]
    const a = attr.array as Float32Array
    for (let j = 0; j < this.meshes.length; j++) if (j !== k) this.meshes[j].count = 0
    let n = 0
    for (const o of list) {
      let tr = this.tracks.get(o.id)
      if (!tr) {
        tr = { id: o.id, hp: o.hp, seen: fid, spawnAt: animateNew ? now : -100, hitAt: -10, seed: hash(o.id * 1.37 + o.variant) }
        this.tracks.set(o.id, tr)
      }
      if (o.hp < tr.hp - 0.01) {
        tr.hitAt = now
        this.onHit?.(o.x, o.y, o.radius, Math.max(0, o.hp / OBSTACLE_MAX_HP))
      }
      tr.hp = o.hp
      tr.seen = fid
      if (n >= CAPACITY) continue
      const height = 150 + o.radius * 1.3 + tr.seed * 60 + (o.variant % 3) * 18
      // rise from the floor (Rockpillar / mid-round spawns), ease-out
      const riseT = Math.min(1, Math.max(0, (now - tr.spawnAt) / RISE_DUR))
      const sink = (1 - (1 - Math.pow(1 - riseT, 3))) * (height + 20)
      // hit: a quick decaying shudder
      const hk = Math.exp(-(now - tr.hitAt) * 18)
      const jx = Math.sin(now * 90 + tr.seed * 10) * hk * 4
      const jy = Math.cos(now * 77 + tr.seed * 7) * hk * 4
      this.e.set(0, tr.seed * Math.PI * 2, 0)
      this.q.setFromEuler(this.e)
      this.v.set((o.x + jx) * S, (TILE_TOP_H - 2 - sink) * S, -(o.y + jy) * S)
      this.sc.set(o.radius * S, height * S, o.radius * S)
      this.m4.compose(this.v, this.q, this.sc)
      mesh.setMatrixAt(n, this.m4)
      a[n * 4] = Math.max(0, Math.min(1, o.hp / OBSTACLE_MAX_HP))
      a[n * 4 + 1] = tr.spawnAt
      a[n * 4 + 2] = tr.hitAt
      a[n * 4 + 3] = tr.seed
      n++
    }
    for (const [id, tr] of this.tracks) if (tr.seen !== fid) this.tracks.delete(id)
    mesh.count = n
    mesh.visible = n > 0
    if (n > 0) {
      mesh.instanceMatrix.needsUpdate = true
      attr.needsUpdate = true
    }
  }

  private material(kind: number): THREE.MeshStandardNodeMaterial {
    const { uTime: t, noise } = this.ctx
    const A = asV4(attribute('aObs', 'vec4'))
    const hpFrac = A.x
    const spawnAt = A.y
    const hitAt = A.z
    const seed = A.w
    const dmg = float(1).sub(hpFrac)

    // rise and hit shake are applied to the instance matrix on the CPU
    const hitK = exp(t.sub(hitAt).mul(-18)).mul(step(hitAt, t))
    const lp = positionGeometry
    void spawnAt

    const gp = gamePos()
    const h = positionWorld.y.div(S)
    const n1 = texture(noise, vec2(gp.x.add(gp.y), h).mul(1 / 90).add(seed))
    const n2 = texture(noise, vec2(gp.x.sub(gp.y), h.mul(1.3)).mul(1 / 28).add(seed.mul(3)))
    const crackTex = texture(noise, vec2(gp.x.add(gp.y.mul(0.7)), h).mul(1 / 60).add(seed.mul(5))).b
    const crackW = dmg.mul(0.09).add(0.004)
    const crack = float(1).sub(smoothstep(0, crackW, crackTex))
    const up = saturate(normalWorld.y)

    let base: Node<'vec3'>
    let em: Node<'vec3'>
    let rough: Node<'float'> = float(0.8)
    if (kind === 0) {
      // temple: pale weathered stone, glowing rune band
      base = mix(vec3(0.13, 0.125, 0.12), vec3(0.24, 0.225, 0.2), n1.r).mul(n2.g.mul(0.3).add(0.8))
      const band = smoothstep(0.03, 0.0, max(lp.y.sub(0.52).abs().sub(0.04), 0)).mul(step(0.5, sin(lp.x.add(lp.z).mul(18).add(seed.mul(9))).mul(0.5).add(0.5)))
      em = vec3(2.0, 0.7, 0.15).mul(band.mul(dmg.mul(1.5).add(0.15)))
    } else if (kind === 1) {
      // volcanic: black basalt with ember veins that widen as it cracks
      base = mix(vec3(0.025, 0.022, 0.024), vec3(0.075, 0.06, 0.06), n1.r).mul(n2.g.mul(0.4).add(0.75))
      rough = mix(float(0.45), float(0.85), n2.r)
      const veins = float(1).sub(smoothstep(0, 0.035, texture(noise, vec2(gp.x.add(gp.y), h).mul(1 / 120).add(seed)).b))
      em = vec3(2.4, 0.5, 0.06).mul(veins.mul(dmg.mul(1.4).add(0.25)).mul(sin(t.mul(2).add(h.mul(0.05))).mul(0.2).add(0.8)))
    } else {
      // overgrown: grey stone carpeted in moss on top, lichen speckles
      const stone = mix(vec3(0.07, 0.07, 0.065), vec3(0.16, 0.15, 0.13), n1.r)
      const moss = vec3(0.05, 0.13, 0.03).mul(n2.g.mul(0.6).add(0.7))
      const mossMask = smoothstep(0.35, 0.75, up.add(n1.g.mul(0.5)).sub(0.15))
      base = mix(stone, moss, mossMask)
      rough = mix(float(0.85), float(0.97), mossMask)
      em = vec3(0.3, 1.5, 0.6).mul(step(0.86, n2.b).mul(mossMask).mul(0.25))
    }
    // authored stone (triplanar, world space so non-uniform instance scale never
    // stretches it), tinted per theme; procedural stays the fallback
    let height: Node<'float'> = n2.g.mul(0.5).add(n1.r.mul(0.4))
    let aoTex: Node<'float'> = float(1)
    const maps = this.maps
    if (maps) {
      const sc = float(1 / 1.7)
      const alb = triplanarTexture(texture(maps.albedo), null, null, sc, positionWorld, normalWorld).rgb
      const orm = triplanarTexture(texture(maps.orm), null, null, sc, positionWorld, normalWorld).rgb
      const hTex = maps.height ?? maps.albedo
      const hh = triplanarTexture(texture(hTex), null, null, sc, positionWorld, normalWorld).r
      const tint = kind === 0 ? vec3(0.92, 0.88, 0.82) : kind === 1 ? vec3(0.32, 0.3, 0.32) : vec3(0.7, 0.72, 0.66)
      const stoneT = alb.mul(tint)
      // keep the theme's character (runes, veins, moss) by blending over the texture
      base = mix(stoneT, base, kind === 2 ? 0.45 : 0.25)
      rough = mix(orm.g, rough, 0.3)
      aoTex = orm.r
      height = hh.mul(0.8).add(n2.g.mul(0.2))
    }
    base = base.mul(float(1).sub(crack.mul(0.75))).mul(aoTex)
    // ambient occlusion toward the floor: the pillar sits IN the light, not on it
    const aoFloor = mix(float(0.3), float(1), smoothstep(0, 75, h.sub(TILE_TOP_H)))
    base = base.mul(aoFloor)
    em = em.add(vec3(2.6, 0.75, 0.12).mul(crack.mul(pow(dmg, 1.3)).mul(1.5)))
    em = em.add(vec3(2.2, 1.6, 1.1).mul(hitK.mul(0.8)))
    // faint warm floor bounce on the lowest band only
    em = em.add(vec3(0.3, 0.09, 0.02).mul(exp(h.sub(TILE_TOP_H).div(-18))).mul(base.r.add(0.02)))

    const m = new THREE.MeshStandardNodeMaterial()
    m.name = `Obstacle${kind}`
    m.colorNode = base
    m.roughnessNode = saturate(rough.add(n2.r.sub(0.5).mul(0.25)).add(crack.mul(0.2)))
    m.normalNode = bumpMap(height.sub(crack.mul(0.6)), float(1.3))
    m.metalnessNode = float(0)
    m.emissiveNode = em
    return m
  }

  dispose(): void {
    this.disposed = true
    for (const m of this.meshes) {
      m.geometry.dispose()
      m.dispose()
    }
    for (const m of this.materials) m.dispose()
  }
}
