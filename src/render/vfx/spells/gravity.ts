/**
 * Gravity (column 6 Knockbackless; black-violet lensing). spells.md §8.23.
 * Windup (0.2 s cast point): the light around the hand bends into a small lens and streaks
 * of light are sucked into the palm. Orb (sim r25 core, 450 u/s, 2 s): an event horizon (black
 * core, razor lilac photon ring) inside a gravitational lens that bends the arena behind it
 * (screen-space refraction, medium+ tiers), a tilted accretion disk spiralling inward, rock
 * chunks and light streaks spiralling into it from the pull radius, enemies inside the pull
 * trailing light toward it. Ground: crisp DPS ring at exactly 250 that pulses with every damage
 * tick, inward ripples ending exactly at the 550 pull radius, a darkened well below.
 * End: the singularity collapses and pops. Pillar bounce: spark burst.
 */
import * as THREE from 'three/webgpu'
import {
  atan, dot, float, instancedBufferAttribute, length, mix, normalView, positionGeometry, positionView, pow, saturate, screenUV,
  smoothstep, texture, uv, vec2, vec3, viewportSharedTexture,
} from 'three/tsl'
import type { Node } from 'three/webgpu'
import type { ProjectileState, SimEvent } from '../../../sim/types'
import { isEnemy } from '../../../sim/teams'
import { PROJECTILE_H, S } from '../../coords'
import { RING_EXPAND, RING_IMPLODE } from '../../scene/GroundFx'
import { asV4 } from '../../scene/world'
import { registerSpellVfx, type VfxCtx } from '../registry'
import {
  InstPool, STYLE_RING, STYLE_RIPPLES, TAU, burst, castFlash, drawCircle, drawCore, drawShadow, floorH, glowG, implode,
  kitAdopt, kitBegin, kitInit, markRange, kitRelease, light, originOf, pal, palMix, projShadow, screenAngle, tierCap, flashT, levelOfThing, tierOfLevel,
} from './kitB'

const SPELL = 'gravity'
const H = PROJECTILE_H
// identity: black-violet lensing (vfx/palette.ts)
const LILAC = pal('gravity', 'core', 1.6)
const LILAC_DIM = pal('gravity', 'core', 0.45)
const ABYSS = palMix('gravity', 0.15, 0.05)
const RIM = pal('gravity', 'core', 2.6)

const N_STREAK = 26
const N_ROCK = 14

/** Screen-space lens: instanced sprites sampling the framebuffer with a radial pull. */
class Lens {
  readonly object: THREE.Sprite
  private p: THREE.InstancedBufferAttribute
  private l: THREE.InstancedBufferAttribute
  private n = 0
  private material: THREE.SpriteNodeMaterial
  private v0 = new THREE.Vector3()
  private v1 = new THREE.Vector3()
  private v2 = new THREE.Vector3()

  constructor(private capacity: number) {
    const mk = () => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4)
      a.setUsage(THREE.StaticDrawUsage)
      return a
    }
    this.p = mk()
    this.l = mk()
    const P = asV4(instancedBufferAttribute(this.p))
    const L = asV4(instancedBufferAttribute(this.l))
    const q = uv().sub(0.5).mul(2)
    const d = length(q)
    const dir = q.div(d.add(1e-4))
    // light behind the mass appears pushed outward: sample further from the centre
    const pull = smoothstep(1.0, 0.25, d).mul(L.y)
    const off = dir.mul(L.x).mul(pull).mul(float(0.18).div(d.add(0.12)))
    // screen y flips between uv and NDC conventions: mirror the vertical offset
    const suv = screenUV.add(vec2(off.x, off.y.negate()))
    const scene = viewportSharedTexture(suv).rgb
    const horizon = smoothstep(L.z, L.z.add(0.06), d)
    const photon = pow(saturate(float(1).sub(d.sub(L.z.add(0.05)).abs().mul(18))), 3)
    const m = new THREE.SpriteNodeMaterial()
    m.transparent = true
    m.depthWrite = false
    m.blending = THREE.NormalBlending
    m.positionNode = P.xyz
    m.scaleNode = vec2(P.w, P.w)
    m.colorNode = scene.mul(horizon).mul(mix(vec3(0.75, 0.7, 0.85), vec3(1), smoothstep(0.2, 0.9, d))).add(vec3(...RIM).mul(photon).mul(L.w))
    m.opacityNode = smoothstep(1.0, 0.8, d)
    m.name = 'VfxB-GravityLens'
    this.material = m
    this.object = new THREE.Sprite(m)
    this.object.count = 0
    this.object.frustumCulled = false
    this.object.renderOrder = 9
    this.object.name = 'vfxB-gravity-lens'
  }

  begin(): void {
    this.n = 0
    this.object.count = 0
    this.object.visible = false
  }

  /** game position, radius (game units), strength 0..1, horizon (0..1 of the sprite), photon ring 0..1 */
  add(ctx: VfxCtx, x: number, y: number, h: number, radius: number, strength: number, horizon: number, photon: number): void {
    if (this.n >= this.capacity) return
    const cam = ctx.camera
    this.v0.set(x * S, h * S, -y * S).project(cam)
    this.v1.set(x * S, h * S, -y * S).addScaledVector(this.v2.set(1, 0, 0).applyQuaternion(cam.quaternion), radius * S).project(cam)
    // sprite radius in screen-uv units (vertical)
    const ruv = Math.hypot((this.v1.x - this.v0.x) * cam.aspect, this.v1.y - this.v0.y) * 0.5
    const o = this.n * 4
    const pa = this.p.array as Float32Array
    const la = this.l.array as Float32Array
    pa[o] = x * S
    pa[o + 1] = h * S
    pa[o + 2] = -y * S
    pa[o + 3] = radius * 2 * S
    la[o] = ruv
    la[o + 1] = strength
    la[o + 2] = horizon
    la[o + 3] = photon
    this.n++
    this.object.count = this.n
    this.object.visible = true
    markRange(this.p, this.n)
    markRange(this.l, this.n)
  }

  dispose(): void {
    this.material.dispose()
  }
}

/** Accretion disk: flat ring, swirling inward (differential rotation), hot inner edge. A0.x alpha, y seed. */
function diskMaterial(ctx: VfxCtx, A: Node<'vec4'>[]): THREE.Material {
  const [A0] = A
  const t = ctx.world.uTime
  const p = positionGeometry.xy
  const r = length(p)
  const rn = saturate(r.sub(1.0).div(4.0))
  const ang = atan(p.y, p.x)
  const swirl = ang.add(t.mul(2.6).div(rn.add(0.25))).add(rn.mul(5))
  const n1 = texture(ctx.world.noise, vec2(swirl.div(TAU).mul(2), rn.mul(1.4).add(A0.y))).r
  const n2 = texture(ctx.world.noise, vec2(swirl.div(TAU).mul(5).add(0.3), rn.mul(3).sub(t.mul(0.4)))).g
  const bands = smoothstep(0.42, 0.8, n1.mul(0.6).add(n2.mul(0.5)))
  const radial = smoothstep(0.0, 0.08, rn).mul(pow(float(1).sub(rn), 1.6))
  const hot = mix(vec3(...LILAC_DIM), vec3(...RIM).mul(0.5), pow(float(1).sub(rn), 4))
  const m = new THREE.MeshBasicNodeMaterial()
  m.transparent = true
  m.depthWrite = false
  m.side = THREE.DoubleSide
  m.blending = THREE.AdditiveBlending
  m.colorNode = tierCap(ctx, hot.mul(bands.mul(0.85).add(0.15)).mul(radial).mul(A0.x), 2.0, 0.7, 0.7)
  m.opacityNode = float(1)
  m.name = 'VfxB-GravityDisk'
  return m
}

/** Dark infalling rock chips with a lilac rim. */
function rockMaterial(): THREE.Material {
  const viewDir = positionView.negate().normalize()
  const ndv = saturate(dot(normalView, viewDir))
  const m = new THREE.MeshBasicNodeMaterial()
  m.colorNode = vec3(0.02, 0.015, 0.03).add(vec3(...LILAC).mul(pow(float(1).sub(ndv), 3).mul(0.8)))
  m.name = 'VfxB-GravityRocks'
  return m
}

interface Orb {
  seen: number
  born: number
  dpsTimer: number
  pulseAt: number
  seed: number
}

let lens: Lens | null = null
let disks: InstPool | null = null
let rocks: InstPool | null = null
const orbs = new Map<number, Orb>()
let frameNo = 0
const tiltQ = new THREE.Quaternion()
const qa = new THREE.Quaternion()
const ax = new THREE.Vector3()

function lensOk(ctx: VfxCtx): boolean {
  return ctx.tier.post
}

function drawOrb(p: ProjectileState, x: number, y: number, ctx: VfxCtx): void {
  let o = orbs.get(p.id)
  if (!o) {
    o = { seen: 0, born: ctx.now, dpsTimer: p.data.dpsTimer ?? 0, pulseAt: -10, seed: Math.random() * 10 }
    orbs.set(p.id, o)
  }
  o.seen = frameNo
  const d = p.data
  if ((d.dpsTimer ?? 0) > o.dpsTimer + 0.5) o.pulseAt = ctx.now
  o.dpsTimer = d.dpsTimer ?? 0
  const t = ctx.now
  const intro = Math.min(1, (t - o.born) / 0.25)
  const fh = floorH(ctx, x, y)
  const left = p.ticksLeft / 60
  const outro = Math.min(1, Math.max(0, left / 0.25))
  const k = intro * outro
  const pullR = d.pawnRadius || 550
  const tier = tierOfLevel(ctx, levelOfThing(p))
  const dpsR = d.dpsRadius || 250

  // the core: event horizon at the sim radius, lens around it
  drawCore(x, y, H, p.radius * 1.05 * (0.6 + 0.4 * k), ABYSS, ABYSS, p.id % 7, 1)
  if (lens && lensOk(ctx)) lens.add(ctx, x, y, H, 170 * k, 0.9, 0.2, 1)
  else glowG(x, y, H, 120, LILAC, 0.5 * k, 0.06, 1)
  glowG(x, y, H, 150 * k, LILAC_DIM, 0.25, 2.2, 0, 1, 0, 0.6)
  // tilted accretion disk
  if (disks) {
    qa.setFromAxisAngle(ax.set(0, 1, 0), t * 0.5)
    disks.quat.copy(tiltQ).multiply(qa)
    const i = disks.add(x * S, H * S, -y * S, 26 * k * S, 26 * k * S, 26 * k * S)
    disks.set(i, 0, (1.0 + 0.2 * tier) * k, o.seed, 0, 0)
  }
  // ground: darkened well, DPS ring (pulses per tick), inward ripples ending at the pull radius
  const pulse = Math.max(0, 1 - (t - o.pulseAt) / 0.18)
  drawShadow(x, y, fh - 0.3, dpsR, 0.62 * k, 0.75, 0.2, p.id)
  drawCircle(x, y, fh + 0.2, dpsR, STYLE_RING, LILAC[0], LILAC[1], LILAC[2], (0.5 + 0.5 * pulse) * k, 0, 0, o.seed, 0, 0.8, 0, o.born)
  drawCircle(x, y, fh + 0.1, pullR, STYLE_RIPPLES, LILAC_DIM[0], LILAC_DIM[1], LILAC_DIM[2], 0.3 * k, 0, 7, o.seed, 0, 0.7, 0, o.born)
  light(ctx, x, y, dpsR * 0.7, 0.3 * k, LILAC, 0.3)
  projShadow(ctx, x, y, H, 40)

  // infall: light streaks and rock chips spiralling in from the pull radius
  for (let i = 0; i < N_STREAK - 8 + 4 * tier; i++) {
    const s = (i * 0.618 + o.seed) % 1
    const ph = (s + t * (0.55 + (i % 5) * 0.08)) % 1
    const rr = pullR * Math.pow(1 - ph, 1.4) * 0.97 + 30
    const th = s * TAU + 2.2 / (rr / pullR + 0.12) + t * 0.2
    const px = x + Math.cos(th) * rr
    const py = y + Math.sin(th) * rr
    const tang = th + Math.PI / 2 + 0.6
    const vx = Math.cos(tang)
    const vy = Math.sin(tang)
    const ph2 = H - 40 + 40 * (1 - ph) * Math.sin(i * 1.7) + 40
    const ang = screenAngle(ctx, px, py, ph2, vx, vy)
    const fade = Math.sin(Math.PI * Math.min(1, ph * 1.2)) * k
    glowG(px, py, ph2, 22 + 18 * ph, i % 3 === 0 ? RIM : LILAC, 0.5 * fade, 2, 0, 3 + 4 * ph, ang)
  }
  if (rocks) {
    for (let i = 0; i < N_ROCK - 4 + 3 * tier; i++) {
      const s = (i * 0.381 + o.seed * 0.7) % 1
      const ph = (s + t * (0.35 + (i % 4) * 0.06)) % 1
      const rr = pullR * 0.8 * Math.pow(1 - ph, 1.3) + 35
      const th = s * TAU + 2.0 / (rr / pullR + 0.15) - t * 0.1
      const sz = (7 + (i % 3) * 4) * Math.min(1, (1 - ph) * 4) * k
      qa.setFromAxisAngle(ax.set(Math.sin(i), 1, Math.cos(i)).normalize(), t * (2 + i * 0.3))
      rocks.quat.copy(qa)
      rocks.add((x + Math.cos(th) * rr) * S, (H - 30 + 50 * (1 - ph) + (i % 4) * 10) * S, -(y + Math.sin(th) * rr) * S, sz * S, sz * S, sz * S)
    }
  }
  // enemies in the pull trail light toward the orb
  const st = ctx.state
  if (st) {
    const pr2 = pullR * pullR
    for (const pw of st.pawns) {
      if (!pw.alive || !isEnemy(st, p.owner, pw.owner)) continue
      const dx = x - pw.x
      const dy = y - pw.y
      const d2 = dx * dx + dy * dy
      if (d2 > pr2 || d2 < 1) continue
      const dl = Math.sqrt(d2)
      const f = 1 - d2 / pr2
      const ang = screenAngle(ctx, pw.x, pw.y, 70, dx / dl, dy / dl)
      glowG(pw.x + (dx / dl) * 50, pw.y + (dy / dl) * 50, 90, 40, LILAC, 0.5 * f * k, 2, 0, 3 + 3 * f, ang)
    }
  }
}

registerSpellVfx({
  spell: SPELL,
  init(ctx: VfxCtx) {
    kitInit(ctx)
    tiltQ.setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2 + 0.42)
    lens = kitAdopt(new Lens(10))
    const dg = new THREE.RingGeometry(1.0, 5.0, 72, 1)
    disks = kitAdopt(new InstPool(dg, 1, 10, (A) => diskMaterial(ctx, A), 8, 'vfxB-gravity-disks'))
    rocks = kitAdopt(new InstPool(new THREE.IcosahedronGeometry(1, 0), 0, 10 * (N_ROCK + 2), () => rockMaterial(), 5, 'vfxB-gravity-rocks'))
  },
  dispose() {
    lens = null
    disks = null
    rocks = null
    orbs.clear()
    kitRelease()
  },
  onEvent(e: SimEvent, ctx: VfxCtx): boolean | void {
    switch (e.type) {
      case 'cast':
        if (e.spell !== SPELL) return
        castFlash(ctx, e.pawn, LILAC, 0.9)
        return true
      case 'castStart': {
        if (e.spell !== SPELL) return
        const info = ctx.pawn(e.pawn)
        if (info) {
          const o = originOf(info)
          implode(ctx, o.x / S, -o.z / S, o.y / S, 26, 90, 170, 0.2, 9, LILAC, 1, 80)
        }
        return
      }
      case 'projectileExpire':
      case 'projectileHit': {
        if (e.spell !== SPELL) return
        // collapse: everything rushes in, then a short pop (inside the DPS ring)
        const fh = floorH(ctx, e.x, e.y)
        implode(ctx, e.x, e.y, H, 30, 120, 240, 0.18, 12, LILAC, 1.1, 60)
        ctx.ground.spawn(RING_IMPLODE, e.x, e.y, fh, 20, 240, 0.25, 12, LILAC[0], LILAC[1], LILAC[2])
        ctx.ground.spawn(RING_EXPAND, e.x, e.y, fh, 10, 160, 0.35, 8, LILAC_DIM[0], LILAC_DIM[1], LILAC_DIM[2])
        burst(ctx, e.x, e.y, H, 24, 200, 500, 0.25, 0.45, 9, 2, RIM, 0.8, -300, 3, -0.08, 20, 200)
        flashT(ctx, e.x, e.y, H, 0.08, 160, 140, LILAC[0] * 0.6, LILAC[1] * 0.6, LILAC[2] * 0.6)
        return true
      }
      case 'projectileBounce':
        if (e.spell !== SPELL) return
        burst(ctx, e.x, e.y, H, 16, 150, 420, 0.2, 0.35, 8, 2, LILAC, 1, -600, 3, -0.08, 20, 160)
        return true
      default:
        return
    }
  },
  frame(ctx: VfxCtx) {
    kitBegin(ctx)
    frameNo++
    for (const [id, o] of orbs) if (frameNo - o.seen > 30) orbs.delete(id)
    // windup flavour: a small lens bends the light around the casting hand
    const st = ctx.state
    if (!st) return
    for (const pw of st.pawns) {
      const c = pw.cast
      if (!pw.alive || !c || c.spell !== SPELL || !c.started) continue
      const info = ctx.pawn(pw.id)
      if (!info) continue
      const o = originOf(info)
      const k = 1 - c.ticksLeft / 12
      const gx = o.x / S
      const gy = -o.z / S
      const gh = o.y / S
      if (lens && lensOk(ctx)) lens.add(ctx, gx, gy, gh, 40 + 60 * k, 0.8, 0.12 * k, 0.6 * k)
      glowG(gx, gy, gh, 60 + 80 * k, LILAC, 0.3 + 0.5 * k, 0.08, 1, 1, ctx.now * 2)
    }
  },
  drawProjectile(p: ProjectileState, x: number, y: number, ctx: VfxCtx) {
    drawOrb(p, x, y, ctx)
  },
})
