import * as THREE from 'three/webgpu'
import { S } from '../../coords'
import { Part, mergeParts, rock } from './geo'
import type { PillarShape } from './pillars'
import { pillarShape } from './shapes'
import { contactDecalMaterial, lookForTheme, setPropAnisotropy, useLook, type Look } from './materials'
import { rng } from './rng'
import { STATIC_INSTANCE_CAPACITY } from '../world'

/**
 * One destructible pillar: sculpted seeded mesh (shared theme material),
 * contact-shadow ring, pooled stone chips, hit shudder, damage stages
 * (cracks open and glow brighter; at 66% / 33% hp a top chunk breaks off)
 * and the Rockpillar rise. The caller positions `object3d` at the pillar's
 * floor point (three units, y = tile top) and calls update(dt) each frame.
 */

export interface ObstacleVisualOpts {
  theme: 0 | 1 | 2
  /** sim variant; -1 = Rockpillar */
  variant: number
  /** collision radius (game units): the visual's base footprint */
  radius: number
  seed: number
  /** cast into the key-light shadow map (default true) */
  castShadow?: boolean
  /** texture anisotropy for the authored maps (default 4) */
  anisotropy?: number
}

export interface ObstacleVisual {
  readonly object3d: THREE.Group
  /** intact height (game units) */
  readonly height: number
  /** 1 = intact, 0 = about to break */
  setDamage(hpFrac: number): void
  /** game-space direction the hit travelled (x right, y up), strength ~1 per normal hit */
  hitShudder(dirX: number, dirY: number, strength: number): void
  /** 0 = below the floor, 1 = fully risen (eases with a small overshoot) */
  riseFromGround(t: number): void
  /** false when the floor under the pillar is gone (lava): hides the contact ring */
  setGrounded(onFloor: boolean): void
  /** back to intact, risen and at rest (pooled reuse across rounds) */
  reset(): void
  update(dt: number): void
  dispose(): void
}

// ------------------------------------------------------------------ chips

const CHIP_N = 28
const GRAV = 1900

let chipGeo: THREE.BufferGeometry | null = null
let chipGeoUsers = 0
function chipGeometry(): THREE.BufferGeometry {
  if (!chipGeo) {
    const p = new Part((25 * Math.PI) / 180)
    rock(p, 0, 0, 0, 1, 3, { squash: 0.75, rough: 0.35, flat: -2 })
    chipGeo = mergeParts([p])
  }
  chipGeoUsers++
  return chipGeo
}
function releaseChipGeometry(): void {
  chipGeoUsers--
  if (chipGeoUsers <= 0 && chipGeo) {
    chipGeo.dispose()
    chipGeo = null
    chipGeoUsers = 0
  }
}

class ChipPool {
  readonly mesh: THREE.InstancedMesh
  private px = new Float32Array(CHIP_N * 3)
  private pv = new Float32Array(CHIP_N * 3)
  private rot = new Float32Array(CHIP_N * 4)
  private size = new Float32Array(CHIP_N)
  private age = new Float32Array(CHIP_N)
  private life = new Float32Array(CHIP_N)
  private alive = new Uint8Array(CHIP_N)
  private next = 0
  private active = 0
  private m4 = new THREE.Matrix4()
  private q = new THREE.Quaternion()
  private ax = new THREE.Vector3()
  private v = new THREE.Vector3()
  private sc = new THREE.Vector3()
  private release: () => void

  constructor(look: Look, private footprint: number) {
    // capacity padded past the uniform limit (see staticInstancedMesh): every
    // pillar has a pool, and on the uniform path each pool compiled its own
    // pipeline when the match started (61 at once)
    this.mesh = new THREE.InstancedMesh(chipGeometry(), undefined, Math.max(CHIP_N, STATIC_INSTANCE_CAPACITY))
    this.release = useLook(look, this.mesh, 'chip')
    this.mesh.count = 0
    this.mesh.visible = false
    this.mesh.frustumCulled = false
    this.mesh.name = 'prop-chips'
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  }

  /** local game units (y up from the floor) */
  spawn(x: number, y: number, z: number, vx: number, vy: number, vz: number, size: number, life: number): void {
    const i = this.next
    this.next = (this.next + 1) % CHIP_N
    if (!this.alive[i]) this.active++
    this.alive[i] = 1
    this.px.set([x, y, z], i * 3)
    this.pv.set([vx, vy, vz], i * 3)
    this.ax.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize()
    this.rot.set([this.ax.x, this.ax.y, this.ax.z, (Math.random() - 0.5) * 24], i * 4)
    this.size[i] = size
    this.age[i] = 0
    this.life[i] = life
  }

  update(dt: number): void {
    if (this.active === 0) {
      this.mesh.visible = false
      return
    }
    let n = 0
    const R = this.footprint
    for (let i = 0; i < CHIP_N; i++) {
      if (!this.alive[i]) continue
      const a = (this.age[i] += dt)
      if (a >= this.life[i]) {
        this.alive[i] = 0
        this.active--
        continue
      }
      const o = i * 3
      let x = this.px[o]
      let y = this.px[o + 1]
      let z = this.px[o + 2]
      let vx = this.pv[o]
      let vy = this.pv[o + 1] - GRAV * dt
      let vz = this.pv[o + 2]
      x += vx * dt
      y += vy * dt
      z += vz * dt
      const s = this.size[i]
      // chips never rest inside the pillar
      const d = Math.hypot(x, z)
      if (d < R * 0.9 && y < R * 2) {
        const k = (R * 0.9) / Math.max(1e-3, d)
        x *= k
        z *= k
      }
      if (y < s * 0.4) {
        y = s * 0.4
        if (vy < 0) vy = -vy * 0.3
        vx *= 0.6
        vz *= 0.6
        this.rot[i * 4 + 3] *= 0.6
        if (Math.abs(vy) < 40) vy = 0
      }
      this.px[o] = x
      this.px[o + 1] = y
      this.px[o + 2] = z
      this.pv[o] = vx
      this.pv[o + 1] = vy
      this.pv[o + 2] = vz
      // shrink away at the end of life
      const fade = Math.min(1, (this.life[i] - a) / 0.35)
      this.ax.set(this.rot[i * 4], this.rot[i * 4 + 1], this.rot[i * 4 + 2])
      this.q.setFromAxisAngle(this.ax, this.rot[i * 4 + 3] * a)
      this.v.set(x * S, y * S, z * S)
      this.sc.setScalar(s * S * fade)
      this.m4.compose(this.v, this.q, this.sc)
      this.mesh.setMatrixAt(n++, this.m4)
    }
    this.mesh.count = n
    this.mesh.visible = n > 0
    if (n > 0) this.mesh.instanceMatrix.needsUpdate = true
  }

  clear(): void {
    this.alive.fill(0)
    this.active = 0
    this.mesh.count = 0
    this.mesh.visible = false
  }

  dispose(): void {
    this.release()
    this.mesh.dispose()
    releaseChipGeometry()
  }
}

// ------------------------------------------------------------------ visual

let decalGeo: THREE.CircleGeometry | null = null

export function createObstacleVisual(opts: ObstacleVisualOpts): ObstacleVisual {
  if (opts.anisotropy) setPropAnisotropy(opts.anisotropy)
  const r = opts.radius
  const look = lookForTheme(opts.theme, opts.variant)
  // shared, cached shape (built off-thread by prefetchShapes); never disposed here
  const shape: PillarShape = pillarShape(opts.theme, opts.variant, r, opts.seed)
  const R = rng(opts.seed * 3 + 1)

  const object3d = new THREE.Group()
  object3d.name = `pillar-${look}-${opts.variant}`
  const lift = new THREE.Group()
  const body = new THREE.Group()
  body.scale.setScalar(S)
  body.rotation.y = R() * Math.PI * 2
  lift.add(body)
  object3d.add(lift)

  const stone = new THREE.Mesh(shape.geometry)
  stone.name = 'pillar-stone'
  const releases: (() => void)[] = [useLook(look, stone, 'stone')]
  const cast = opts.castShadow ?? true
  stone.castShadow = cast
  stone.receiveShadow = cast
  body.add(stone)
  const meshes: THREE.Mesh[] = [stone]
  if (shape.crystals) {
    const cr = new THREE.Mesh(shape.crystals)
    cr.name = 'pillar-crystals'
    releases.push(useLook(look, cr, 'crystal'))
    body.add(cr)
    meshes.push(cr)
  }
  for (const m of meshes) m.userData = { propDmg: 0, propHit: 0, propLost: 0, propHitX: 0, propHitZ: 0 }

  if (!decalGeo) decalGeo = new THREE.CircleGeometry(1, 40)
  const decal = new THREE.Mesh(decalGeo, contactDecalMaterial())
  decal.name = 'pillar-contact'
  decal.rotation.x = -Math.PI / 2
  decal.position.y = 0.8 * S
  decal.renderOrder = 1
  const decalR = r * 1.75 * S
  decal.scale.setScalar(decalR)
  object3d.add(decal)

  const chips = new ChipPool(look, r)
  object3d.add(chips.mesh)

  // shudder spring (tilt toward three +x / +z, radians)
  let tx = 0
  let tz = 0
  let vx = 0
  let vz = 0
  let hit = 0
  let lost = 0
  let dmg = 0
  let rise = 1
  let lastRise = 1
  const W = 2 * Math.PI * 8.5
  const ZETA = 0.22

  const burst = (x: number, y: number, z: number, dx: number, dz: number, n: number, sMin: number, sMax: number, speed: number) => {
    for (let i = 0; i < n; i++) {
      const a = Math.atan2(dz, dx) + (Math.random() - 0.5) * 1.6
      const sp = speed * (0.4 + Math.random() * 0.8)
      chips.spawn(x, y, z, Math.cos(a) * sp, 120 + Math.random() * 380, Math.sin(a) * sp, sMin + Math.random() * (sMax - sMin), 1.3 + Math.random() * 0.9)
    }
  }

  const vis: ObstacleVisual = {
    object3d,
    height: shape.height,
    setDamage(hpFrac: number) {
      const h = Math.max(0, Math.min(1, hpFrac))
      dmg = 1 - h
      const stage = h < 0.33 ? 2 : h < 0.66 ? 1 : 0
      while (lost < stage) {
        lost++
        const c = shape.chunks[lost - 1]
        if (c) {
          // local -> rotated body space for the debris origin
          const cy = Math.cos(body.rotation.y)
          const sy = Math.sin(body.rotation.y)
          const x = c.x * cy + c.z * sy
          const z = -c.x * sy + c.z * cy
          const a = Math.random() * Math.PI * 2
          burst(x, c.y, z, Math.cos(a), Math.sin(a), 7, c.size * 0.25, c.size * 0.5, 260)
        }
      }
      for (const m of meshes) {
        m.userData.propDmg = dmg
        m.userData.propLost = lost
      }
    },
    hitShudder(dirX: number, dirY: number, strength: number) {
      const l = Math.hypot(dirX, dirY) || 1
      // game (x, y) -> three (x, -y)
      const dx = dirX / l
      const dz = -dirY / l
      const k = Math.min(2.5, Math.max(0.2, strength))
      vx += dx * k * 1.6
      vz += dz * k * 1.6
      hit = Math.min(1, hit + 0.55 + k * 0.25)
      for (const m of meshes) {
        m.userData.propHitX = -dx
        m.userData.propHitZ = -dz
      }
      // chips fly back toward the attacker from the struck face
      const hy = 25 + Math.random() * 60
      burst(-dx * r * 0.95, hy, -dz * r * 0.95, -dx, -dz, Math.round(3 + k * 4), 2.5, 6 + dmg * 4, 320)
    },
    riseFromGround(t: number) {
      const c = Math.max(0, Math.min(1, t))
      // ease out with a small overshoot, then settle
      const e = c >= 1 ? 1 : 1 + 2.2 * Math.pow(c - 1, 3) + 1.2 * Math.pow(c - 1, 2)
      rise = e
      if (lastRise < 0.05 && c >= 0.05) {
        // the floor bursts open around the base
        for (let i = 0; i < 12; i++) {
          const a = (i / 12) * Math.PI * 2 + Math.random() * 0.4
          chips.spawn(Math.cos(a) * r * 1.0, 6, Math.sin(a) * r * 1.0, Math.cos(a) * (150 + Math.random() * 200), 300 + Math.random() * 350, Math.sin(a) * (150 + Math.random() * 200), 4 + Math.random() * 7, 1.2 + Math.random() * 0.8)
        }
      }
      lastRise = c
    },
    setGrounded(onFloor: boolean) {
      decal.visible = onFloor
    },
    reset() {
      tx = tz = vx = vz = 0
      hit = lost = dmg = 0
      rise = lastRise = 1
      chips.clear()
      for (const m of meshes) Object.assign(m.userData, { propDmg: 0, propHit: 0, propLost: 0 })
      body.rotation.x = body.rotation.z = 0
      lift.position.y = 0
      lift.visible = true
      decal.visible = true
      decal.scale.setScalar(decalR)
    },
    update(dt: number) {
      const d = Math.min(dt, 1 / 20)
      // damped spring on the tilt (semi-implicit Euler, substepped for stability)
      const steps = Math.max(1, Math.ceil(d * 120))
      const h = d / steps
      for (let s = 0; s < steps; s++) {
        vx += (-W * W * tx - 2 * ZETA * W * vx) * h
        vz += (-W * W * tz - 2 * ZETA * W * vz) * h
        tx += vx * h
        tz += vz * h
      }
      const lim = 0.06
      tx = Math.max(-lim, Math.min(lim, tx))
      tz = Math.max(-lim, Math.min(lim, tz))
      body.rotation.z = -tx
      body.rotation.x = tz
      hit *= Math.exp(-d * 11)
      for (const m of meshes) m.userData.propHit = hit
      // rise: the whole pillar (incl. rubble) comes up through the floor
      const sinkH = (shape.height + 30) * S
      lift.position.y = -(1 - rise) * sinkH
      lift.visible = rise > 0.001
      decal.scale.setScalar(decalR * Math.max(0.01, Math.min(1, rise * 1.4)))
      chips.update(d)
    },
    dispose() {
      for (const rel of releases) rel()
      chips.dispose()
      object3d.removeFromParent()
    },
  }
  vis.update(0)
  return vis
}
