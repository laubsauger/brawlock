import * as THREE from 'three/webgpu'
import { attribute, dot, mix, normalView, positionView, pow, saturate, sin, smoothstep, vec3 } from 'three/tsl'
import type { ProjectileState } from '../../sim/types'
import { PROJECTILE_H, S } from '../coords'
import { projectileCoreRadius } from '../scale'
import type { Billboards } from './Billboards'
import type { Particles } from './Particles'
import { asV4, type WorldCtx } from './world'

const CAPACITY = 64

/** Spell look: core edge colour, trail colour, halo colour (linear HDR). */
interface SpellLook {
  edge: [number, number, number]
  trail: [number, number, number]
  halo: [number, number, number]
  light: [number, number, number]
}

const LOOKS: Record<string, SpellLook> = {
  // fire spectrum: crimson rim -> orange body -> yellow-white core (shader), trail cools to red
  fireball: { edge: [1.5, 0.22, 0.04], trail: [2.4, 0.62, 0.09], halo: [1.1, 0.22, 0.035], light: [1.0, 0.34, 0.07] },
}
const GENERIC: SpellLook = { edge: [0.6, 0.5, 1.0], trail: [1.2, 0.9, 2.4], halo: [0.6, 0.5, 1.4], light: [0.5, 0.45, 1.0] }

export function spellLook(spell: string): SpellLook {
  return LOOKS[spell] ?? GENERIC
}

interface Track {
  x: number
  y: number
  seen: number
  born: number
}

/**
 * Projectiles: hitbox-sized hot core drawn last (readable above every
 * effect), additive halo, particle trail, and a fake light on the floor.
 */
export class Projectiles {
  readonly mesh: THREE.InstancedMesh
  private aCol: THREE.InstancedBufferAttribute
  private material: THREE.MeshBasicNodeMaterial
  private tracks = new Map<number, Track>()
  private frameId = 0
  private m = new THREE.Matrix4()
  private q = new THREE.Quaternion()
  private v = new THREE.Vector3()
  private v0 = new THREE.Vector3()
  private v1 = new THREE.Vector3()
  private sc = new THREE.Vector3()
  private tc = new THREE.Color()

  constructor(
    private ctx: WorldCtx,
    private particles: Particles,
    private smoke: Particles,
    private billboards: Billboards,
  ) {
    const geo = new THREE.IcosahedronGeometry(1, 2)
    this.aCol = new THREE.InstancedBufferAttribute(new Float32Array(CAPACITY * 4), 4)
    this.aCol.setUsage(THREE.DynamicDrawUsage)
    geo.setAttribute('aCol', this.aCol)
    const A = asV4(attribute('aCol', 'vec4'))
    const viewDir = positionView.negate().normalize()
    const ndv = saturate(dot(normalView, viewDir))
    const tierN = A.w.div(10).floor()
    const seed = A.w.sub(tierN.mul(10))
    const flick = sin(ctx.uTime.mul(37).add(seed.mul(11))).mul(0.08).add(1)
    // temperature bands: crimson rim, orange body, hot core (kept below white
    // so ACES + bloom don't wash the fireball out to yellow)
    const rim = A.xyz.mul(1.7)
    const mid = vec3(2.7, 0.85, 0.12)
    // hotter core with power tier (yellow -> white-hot), hitbox size unchanged
    const core = mix(vec3(3.3, 2.2, 1.0), vec3(3.7, 3.4, 2.7), tierN.mul(0.5))
    const col = mix(mix(rim, mid, smoothstep(0.05, 0.5, ndv)), core, smoothstep(0.6, 0.95, ndv)).mul(flick)
    void pow
    const m = new THREE.MeshBasicNodeMaterial()
    m.colorNode = col
    m.transparent = true
    m.depthWrite = true
    m.name = 'ProjectileCore'
    this.material = m
    this.mesh = new THREE.InstancedMesh(geo, m, CAPACITY)
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.mesh.count = 0
    this.mesh.frustumCulled = false
    // drawn after particles and halos so the hitbox core always reads on top
    this.mesh.renderOrder = 10
    this.mesh.name = 'projectile-cores'
  }

  /**
   * Draw this frame's projectiles. `colorOf(owner)` gives the owner's team colour.
   */
  update(
    prev: ProjectileState[] | null,
    curr: ProjectileState[],
    alpha: number,
    now: number,
    colorOf: (owner: number) => number,
    camera: THREE.Camera,
    aspect: number,
    /** spells drawn by a VFX module instead of the built-in look */
    skip?: (spell: string) => boolean,
  ): void {
    this.frameId++
    const fid = this.frameId
    let n = 0
    const ca = this.aCol.array as Float32Array
    const glow = this.ctx.glow
    const trailBudget = this.ctx.tier.particles
    for (let i = 0; i < curr.length && n < CAPACITY; i++) {
      const p = curr[i]
      if (skip && skip(p.spell)) continue
      let x = p.x
      let y = p.y
      if (prev) {
        for (let j = 0; j < prev.length; j++) {
          if (prev[j].id === p.id) {
            x = prev[j].x + (p.x - prev[j].x) * alpha
            y = prev[j].y + (p.y - prev[j].y) * alpha
            break
          }
        }
      }
      const look = spellLook(p.spell)
      this.tc.setHex(colorOf(p.owner))
      // core edge: spell hue with a share of the caster's team colour
      const er = look.edge[0] * 0.65 + this.tc.r * 0.35
      const eg = look.edge[1] * 0.65 + this.tc.g * 0.35
      const eb = look.edge[2] * 0.65 + this.tc.b * 0.35
      const r = projectileCoreRadius(p.radius)
      this.v.set(x * S, PROJECTILE_H * S, -y * S)
      this.sc.setScalar(r * S)
      this.m.compose(this.v, this.q, this.sc)
      this.mesh.setMatrixAt(n, this.m)
      ca[n * 4] = er
      ca[n * 4 + 1] = eg
      ca[n * 4 + 2] = eb
      // w = flicker seed (0..6) + 10 x power tier (levels 1-2 / 3-5 / 6-7)
      const lv = (p as { level?: number }).level ?? 1
      const tier = lv >= 6 ? 2 : lv >= 3 ? 1 : 0
      ca[n * 4 + 3] = (p.id % 7) + tier * 10
      n++

      // halo: broad spell glow (also bends the air: heat haze) plus a tighter
      // team-tinted ring of light
      const wx = x * S
      const wy = PROJECTILE_H * S
      const wz = -y * S
      this.billboards.add(wx, wy, wz, r * 6.5 * S, look.halo[0] * 0.5, look.halo[1] * 0.5, look.halo[2] * 0.5, 1.6, 0.9)
      this.billboards.add(wx, wy, wz, r * 3.2 * S, er * 0.9, eg * 0.9, eb * 0.9, 2.5)
      // power tiers (visual only): tier 1 a broad crimson outer flame, tier 2
      // adds two white-hot motes orbiting the core
      if (tier >= 1) this.billboards.add(wx, wy, wz, r * 9.5 * S, look.edge[0] * 0.42, look.edge[1] * 0.42, look.edge[2] * 0.42, 1.15)
      if (tier >= 2) {
        for (let k = 0; k < 2; k++) {
          const a = now * 11 + p.id + k * Math.PI
          const ox = Math.cos(a) * r * 1.7
          const oz = Math.sin(a) * r * 1.7
          const oh = Math.sin(a * 0.5) * r * 0.5
          this.billboards.add(wx + ox * S, wy + oh * S, wz + oz * S, r * 1.1 * S, 3.4, 2.7, 1.4, 2.4)
        }
      }
      // comet streak: stretched along the screen-space velocity, trailing the core
      const sp = Math.hypot(p.vx, p.vy)
      if (sp > 50) {
        const ux = p.vx / sp
        const uy = p.vy / sp
        this.v0.set(wx, wy, wz).project(camera)
        this.v1.set(wx + ux * 100 * S, wy, wz - uy * 100 * S).project(camera)
        const ang = Math.atan2(this.v1.y - this.v0.y, (this.v1.x - this.v0.x) * aspect)
        const len = Math.min(3.2, 1.4 + sp / 700) * (1 + tier * 0.18)
        const back = r * len * 0.9
        this.billboards.addStreak(
          wx - ux * back * S, wy, wz + uy * back * S,
          r * 2.1 * S, len, ang,
          look.edge[0] * 0.6, look.edge[1] * 0.6, look.edge[2] * 0.6, 1.5, 0.5,
        )
        this.billboards.addStreak(wx - ux * back * 0.45 * S, wy, wz + uy * back * 0.45 * S, r * 1.0 * S, len, ang, 2.2, 0.75, 0.14, 2.4)
      }
      glow.add(x, y, 240, 1.0, look.light[0], look.light[1], look.light[2])

      // trail particles along the segment travelled since last frame
      let tr = this.tracks.get(p.id)
      if (!tr) {
        tr = { x, y, seen: fid, born: now }
        this.tracks.set(p.id, tr)
      }
      const dx = x - tr.x
      const dy = y - tr.y
      const dist = Math.hypot(dx, dy)
      if (dist > 0.5 && dist < 400) {
        const spacing = 11 / Math.max(0.25, trailBudget)
        const count = Math.min(24, Math.ceil(dist / spacing))
        const ux = dx / dist
        const uy = dy / dist
        for (let k = 0; k < count; k++) {
          const f = (k + Math.random()) / count
          const px = tr.x + dx * f + (Math.random() - 0.5) * 10
          const py = tr.y + dy * f + (Math.random() - 0.5) * 10
          const ph = PROJECTILE_H + (Math.random() - 0.5) * 10
          this.particles.spawn(
            px, py, ph,
            -ux * 80 + (Math.random() - 0.5) * 60, -uy * 80 + (Math.random() - 0.5) * 60, 20 + Math.random() * 40,
            0.22 + Math.random() * 0.2,
            r * 1.6, -r * 0.35,
            look.trail[0], look.trail[1], look.trail[2],
            60, 2, 0,
          )
          if (tier >= 1 && Math.random() < 0.5) {
            // power tier: a second, wider flame layer licking off the trail
            this.particles.spawn(
              px, py, ph,
              (Math.random() - 0.5) * 120 - ux * 40, (Math.random() - 0.5) * 120 - uy * 40, 60 + Math.random() * 60,
              0.3 + Math.random() * 0.15,
              r * (1.9 + tier * 0.3), -r * 0.4,
              look.edge[0] * 1.5, look.edge[1] * 1.5, look.edge[2] * 1.5,
              120, 2.5, 0,
            )
          }
          if (Math.random() < 0.18 + tier * 0.08) {
            // stray sparks
            this.particles.spawn(
              px, py, ph,
              (Math.random() - 0.5) * 260 - ux * 120, (Math.random() - 0.5) * 260 - uy * 120, 60 + Math.random() * 160,
              0.35 + Math.random() * 0.3,
              7, 2,
              4, 2.2, 0.7,
              -900, 1.5, -0.1,
            )
          }
          if (Math.random() < 0.12 * trailBudget) {
            this.smoke.spawn(px, py, ph, 0, 0, 40, 0.6 + Math.random() * 0.4, 18, 60, 0.045, 0.026, 0.02, 30, 1, 6)
          }
        }
      }
      tr.x = x
      tr.y = y
      tr.seen = fid
    }
    this.mesh.count = n
    this.mesh.visible = n > 0
    if (n > 0) {
      this.mesh.instanceMatrix.clearUpdateRanges()
      this.mesh.instanceMatrix.addUpdateRange(0, n * 16)
      this.mesh.instanceMatrix.needsUpdate = true
      this.aCol.clearUpdateRanges()
      this.aCol.addUpdateRange(0, n * 4)
      this.aCol.needsUpdate = true
    }
    for (const [id, tr] of this.tracks) if (tr.seen !== fid) this.tracks.delete(id)
  }

  dispose(): void {
    this.mesh.geometry.dispose()
    this.material.dispose()
    this.mesh.dispose()
  }
}
