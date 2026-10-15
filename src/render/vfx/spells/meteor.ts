/**
 * Meteor (column 4 Devastator; deep violet fire). spells.md §8.17. Flagship effect.
 *
 * Arc:
 * - windup (0.2 s cast point): violet fire gathers in the hand, a sky-rune wheels open above the
 *   caster, and the rune circle at the (clamped, range 1000) target burns in at EXACTLY the hit
 *   radius 225..304 with a team-tinted edge;
 * - cast: hand flash and a bolt of light thrown into the sky;
 * - hover (0.55 s): a jagged violet RIFT tears open in the sky at the spawn point (void interior,
 *   burning rim, lightning flickering off its edges) and the rock pushes out of it, wreathed in
 *   rolling fire;
 * - fall (0.60 s): a big basalt rock with glowing molten cracks dives in a motion-blurred comet
 *   of volumetric violet fire, shedding burning chunks; its shadow swallows the zone and the
 *   rune circle's countdown ring closes;
 * - impact at the stored target: a short coloured flash, a shockwave that stops exactly at R,
 *   a rolling fireball that rises into a mushroom of violet fire and black smoke, molten
 *   splashes, rock chunks flung out with burning trails, a dust ring, a cracked crater whose rim
 *   and cracks glow and cool over 3.4 s, settling dust, camera shake scaled by R.
 *
 * "Volumetric" fire = FireVolume: stateless camera-facing puffs (ring buffer, written once at
 * spawn, animated in the shader) whose edges are eroded by two noise octaves, shaded by a
 * temperature ramp (hot core -> magenta -> violet -> black smoke) and lit from below by the
 * fire; erosion grows with age so puffs break up as they cool. Time only enters the vertex
 * stage; the fragment gets age through a varying (three r186 stage pitfall).
 *
 * Tiers: every colour goes through tierCap (no white-out without bloom); puff counts go
 * through the particle budget. Worst case (3 meteors at once) ~ 130 live puffs in one draw.
 */
import * as THREE from 'three/webgpu'
import {
  abs, dot, exp, float, instancedBufferAttribute, length, max, mix, normalView, normalWorld, positionGeometry, positionView,
  pow, saturate, smoothstep, step, texture, uv, varying, vec2, vec3,
} from 'three/tsl'
import type { Node } from 'three/webgpu'
import { SPELLS, attr } from '../../../sim/spells/data'
import type { ProjectileState, SimEvent } from '../../../sim/types'
import { PROJECTILE_H, S, TILE_TOP_H } from '../../coords'
import { RING_EXPAND } from '../../scene/GroundFx'
import { asV4 } from '../../scene/world'
import { crater } from '../deathKit'
import { registerSpellVfx, type VfxCtx } from '../registry'
import {
  InstPool, STYLE_CRACKS, STYLE_RING, STYLE_RUNES, TAU, burst, castFlash, drawCircle, drawShadow, flashT, floorH, glowG, hexRgb,
  implode, kitAdopt, kitBegin, kitInit, kitRelease, levelOfThing, light, originOf, pal, palMix, projShadow, rand, screenAngle, tierCap, tierOfLevel,
  type RGB,
} from './kitB'

// identity: deep violet fire (vfx/palette.ts)
const VIOLET = pal('meteor', 'accent', 0.5)
const MAGENTA = palMix('meteor', 0.35, 0.8)
const PINK_HOT = pal('meteor', 'core', 1.7)
const VIOLET_DEEP = pal('meteor', 'accent', 0.1)
// fire ramp for the volume shader (linear, HDR on bloom tiers)
const F_VIOLET = pal('meteor', 'accent', 0.3)
/** saturated violet-magenta: the palette accent with its red pushed up (stays in the identity) */
const F_MAGENTA = saturated(pal('meteor', 'accent', 1), 2.4, 0.5, 0.62)
const F_HOT = palMix('meteor', 0.55, 1.0)
const F_SMOKE: RGB = [0.018, 0.01, 0.024]

function saturated(c: RGB, rK: number, gK: number, lum: number): RGB {
  const r = c[0] * rK
  const g = c[1] * gK
  const b = c[2]
  const l = Math.max(1e-4, 0.2126 * r + 0.7152 * g + 0.0722 * b)
  return [(r * lum) / l, (g * lum) / l, (b * lum) / l]
}

const SPELL = 'meteor'
const DEF = SPELLS[SPELL]
/** sim z of the impact plane (meteor.ts GAME_Z) */
const GAME_Z = 120
/** sim heights are compressed for the tilted camera: z 700 would sit next to the lens */
const Z_SCALE = 0.62
const ROCK_R = 112
const CRATER_LIFE = 3.4
const RIFT_OPEN = 0.25
const RIFT_CLOSE = 0.35

const EMBER: RGB = [2.6, 0.6, 1.5]
const DUST_C = [0.16, 0.13, 0.16] as const

// ------------------------------------------------------------------ FireVolume

/**
 * Stateless volumetric-looking fire / smoke puffs (see header). Written once at spawn.
 *   A0 pos.xyz (three), born      A1 vel.xyz (three/s), life
 *   A2 size0, size1 (three), seed, rise (three/s^2, + up)
 *   A3 heat0 (0..1.3), cool exponent, drag (1/s), smoke darkness 0..1
 */
class FireVolume {
  readonly object: THREE.Sprite
  private attrs: THREE.InstancedBufferAttribute[] = []
  private cursor = 0
  private written = 0
  private writeStart = 0
  private frameT = -1
  private material: THREE.SpriteNodeMaterial

  constructor(
    private ctx: VfxCtx,
    readonly capacity: number,
  ) {
    for (let i = 0; i < 4; i++) {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4)
      a.setUsage(THREE.DynamicDrawUsage)
      this.attrs.push(a)
    }
    const a0 = this.attrs[0].array as Float32Array
    const a1 = this.attrs[1].array as Float32Array
    for (let i = 0; i < capacity; i++) {
      a0[i * 4 + 3] = -1e4
      a1[i * 4 + 3] = 1
    }
    const [A0, A1, A2, A3] = this.attrs.map((a) => asV4(instancedBufferAttribute(a)))
    const noise = ctx.world.noise
    // ---- vertex: motion and size (time is read here only)
    const age = ctx.world.uTime.sub(A0.w)
    const tn = age.div(A1.w)
    const alive = step(0, tn).mul(step(tn, 1))
    const k = max(A3.z, 0.0001)
    const dragF = float(1).sub(exp(k.negate().mul(age))).div(k)
    const pos = A0.xyz.add(A1.xyz.mul(dragF)).add(vec3(0, A2.w.mul(age).mul(age).mul(0.5), 0))
    const grow = float(1).sub(pow(float(1).sub(saturate(tn)), 2))
    const size = mix(A2.x, A2.y, grow).mul(alive)
    const vAge = varying(age, 'vfxbFireAge')
    const vTn = varying(tn, 'vfxbFireTn')
    // ---- fragment: eroded noise shape, temperature ramp, fake lighting
    const q = uv().sub(0.5).mul(2)
    const d = length(q)
    const sd = A2.z
    const n1 = texture(noise, q.mul(0.28).add(vec2(sd, sd.mul(1.7))).add(vec2(0, vAge.mul(-0.12)))).r
    const n2 = texture(noise, q.mul(0.66).add(vec2(sd.mul(2.3), sd)).add(vec2(vAge.mul(0.07), vAge.mul(-0.26)))).g
    const shape = float(1).sub(d).add(n1.sub(0.5).mul(0.9)).add(n2.sub(0.5).mul(0.45))
    const erosion = vTn.mul(0.5)
    const dens = smoothstep(erosion, erosion.add(0.28), shape).mul(smoothstep(1.0, 0.82, d))
    const heat = A3.x.mul(pow(float(1).sub(saturate(vTn)), A3.y)).mul(float(0.4).add(float(1).sub(d).mul(0.75))).mul(n2.mul(0.6).add(0.7))
    // lit from below by the fire (uv y = 0 at the bottom of the sprite)
    const under = saturate(float(0.55).sub(q.y.mul(0.45)).add(n1.sub(0.5).mul(0.6)))
    const smoke = vec3(...F_SMOKE).mul(float(0.3).add(under.mul(0.8))).mul(float(1).sub(A3.w.mul(0.45)))
    const c1 = mix(smoke, vec3(...F_VIOLET), smoothstep(0.12, 0.38, heat))
    const c2 = mix(c1, vec3(...F_MAGENTA), smoothstep(0.38, 0.7, heat))
    const c3 = mix(c2, vec3(...F_HOT), smoothstep(0.9, 1.2, heat))
    const fade = smoothstep(0, 0.06, vTn).mul(float(1).sub(smoothstep(0.82, 1, vTn)))
    const m = new THREE.SpriteNodeMaterial()
    m.transparent = true
    m.depthWrite = false
    m.blending = THREE.NormalBlending
    m.positionNode = pos
    m.scaleNode = vec2(size, size)
    m.colorNode = tierCap(ctx, c3, 2.0, 0.9, 0.9)
    // smoke is denser than flame (value contrast)
    m.opacityNode = dens.mul(fade).mul(mix(float(0.97), float(0.85), smoothstep(0.2, 0.6, heat)))
    m.name = 'VfxB-MeteorFire'
    this.material = m
    this.object = new THREE.Sprite(m)
    this.object.count = capacity
    this.object.frustumCulled = false
    this.object.renderOrder = 6
    this.object.name = 'vfxB-meteor-fire'
  }

  /** stateless: nothing to reset per frame */
  begin(): void {}

  /** Game units: position (h = height), velocity (/s), sizes; rise (+ up, units/s^2). */
  spawn(x: number, y: number, h: number, vx: number, vy: number, vh: number, life: number, size0: number, size1: number, heat: number, cool: number, drag: number, rise: number, smoke = 0): void {
    const now = this.ctx.world.uTime.value
    if (this.frameT !== now) {
      this.frameT = now
      this.written = 0
    }
    const i = this.cursor
    this.cursor = (this.cursor + 1) % this.capacity
    if (this.written === 0) this.writeStart = i
    this.written++
    const o = i * 4
    const [a0, a1, a2, a3] = this.attrs.map((a) => a.array as Float32Array)
    a0[o] = x * S
    a0[o + 1] = h * S
    a0[o + 2] = -y * S
    a0[o + 3] = now
    a1[o] = vx * S
    a1[o + 1] = vh * S
    a1[o + 2] = -vy * S
    a1[o + 3] = Math.max(0.05, life)
    a2[o] = size0 * S
    a2[o + 1] = size1 * S
    a2[o + 2] = Math.random() * 10
    a2[o + 3] = rise * S
    a3[o] = heat
    a3[o + 1] = cool
    a3[o + 2] = drag
    a3[o + 3] = smoke
    const n = Math.min(this.written, this.capacity)
    const start = this.writeStart
    for (const a of this.attrs) {
      a.clearUpdateRanges()
      if (start + n <= this.capacity) a.addUpdateRange(start * 4, n * 4)
      else {
        a.addUpdateRange(start * 4, (this.capacity - start) * 4)
        a.addUpdateRange(0, (start + n - this.capacity) * 4)
      }
      a.needsUpdate = true
    }
  }

  dispose(): void {
    this.material.dispose()
  }
}

// ------------------------------------------------------------------ Rift

/** Per-frame sky tears. P: pos.xyz (three), height (three). R: open 0..1, seed, width/height, alpha. */
class Rifts {
  readonly object: THREE.Sprite
  private p: THREE.InstancedBufferAttribute
  private r: THREE.InstancedBufferAttribute
  private n = 0
  private material: THREE.SpriteNodeMaterial

  constructor(ctx: VfxCtx, private capacity: number) {
    const mk = () => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4)
      a.setUsage(THREE.DynamicDrawUsage)
      return a
    }
    this.p = mk()
    this.r = mk()
    const P = asV4(instancedBufferAttribute(this.p))
    const R = asV4(instancedBufferAttribute(this.r))
    const t = ctx.world.uTime
    const noise = ctx.world.noise
    const q = uv().sub(0.5).mul(2)
    const open = R.x
    const sd = R.y
    const yy = q.y
    // crooked, jagged slit running top to bottom
    const jag = texture(noise, vec2(yy.mul(0.9).add(sd), sd.mul(0.7))).r.sub(0.5)
    const jag2 = texture(noise, vec2(yy.mul(3.7).add(sd.mul(2.1)), 0.31)).g.sub(0.5)
    const cx = q.x.sub(jag.mul(0.5)).sub(jag2.mul(0.1))
    const w = open.mul(0.4).mul(float(1).sub(yy.mul(yy))).mul(float(0.8).add(jag2.mul(0.8)))
    const ad = abs(cx)
    const inside = smoothstep(w, w.mul(0.6), ad).mul(step(0.001, w))
    const re = ad.sub(w).div(float(0.05).add(open.mul(0.05)))
    const rim = exp(re.mul(re).negate()).mul(smoothstep(1.0, 0.85, abs(yy))).mul(open)
    const halo = exp(ad.mul(-3.2)).mul(float(1).sub(abs(yy))).mul(open).mul(smoothstep(1.0, 0.7, abs(q.x)))
    // the void: churning violet depth with pin-prick stars
    const sw = texture(noise, q.mul(0.45).add(vec2(t.mul(0.05), t.mul(-0.11)).add(sd))).r
    const stars = smoothstep(0.07, 0.0, texture(noise, q.mul(1.6).add(sd.mul(3))).a)
    const voidC = mix(vec3(0.008, 0.0, 0.016), vec3(...F_VIOLET).mul(0.9), sw.mul(sw)).add(vec3(...F_HOT).mul(stars.mul(0.5)))
    const col = voidC.mul(inside).add(vec3(...F_MAGENTA).mul(rim.mul(0.75))).add(vec3(...F_HOT).mul(pow(rim, 6).mul(0.35))).add(vec3(...F_VIOLET).mul(halo.mul(0.6)))
    const m = new THREE.SpriteNodeMaterial()
    m.transparent = true
    m.depthWrite = false
    m.blending = THREE.NormalBlending
    m.positionNode = P.xyz
    m.scaleNode = vec2(P.w.mul(R.z), P.w)
    m.colorNode = tierCap(ctx, col, 1.6, 0.85, 0.9)
    m.opacityNode = saturate(inside.add(rim.mul(0.85)).add(halo.mul(0.35))).mul(R.w)
    m.name = 'VfxB-MeteorRift'
    this.material = m
    this.object = new THREE.Sprite(m)
    this.object.count = 0
    this.object.frustumCulled = false
    this.object.renderOrder = 5
    this.object.name = 'vfxB-meteor-rifts'
  }

  begin(): void {
    this.n = 0
    this.object.count = 0
    this.object.visible = false
  }

  /** game position, height of the tear (game units), open 0..1 */
  add(x: number, y: number, h: number, height: number, open: number, seed: number, aspect: number): void {
    if (this.n >= this.capacity || open <= 0.001) return
    const o = this.n * 4
    const pa = this.p.array as Float32Array
    const ra = this.r.array as Float32Array
    pa[o] = x * S
    pa[o + 1] = h * S
    pa[o + 2] = -y * S
    pa[o + 3] = height * S
    ra[o] = open
    ra[o + 1] = seed
    ra[o + 2] = aspect
    ra[o + 3] = 1
    this.n++
    this.object.count = this.n
    this.object.visible = true
    this.p.needsUpdate = true
    this.r.needsUpdate = true
  }

  dispose(): void {
    this.material.dispose()
  }
}

// ------------------------------------------------------------------ rock

interface Flight {
  id: number
  seen: number
  born: number
  /** rift position (where the rock came through) */
  rx: number
  ry: number
  rh: number
  fallAt: number
  sx: number
  sy: number
  lx: number
  ly: number
  lh: number
  spin: THREE.Quaternion
  axis: THREE.Vector3
  tier: number
}
interface Crater {
  x: number
  y: number
  r: number
  born: number
  seed: number
  tier: number
}

let rocks: InstPool | null = null
let fire: FireVolume | null = null
let rifts: Rifts | null = null
const flights = new Map<number, Flight>()
const freeFlights: Flight[] = []
const craters: Crater[] = []
let frameNo = 0
const team: [number, number, number] = [1, 1, 1]
const qTmp = new THREE.Quaternion()

function rockGeometry(): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(1, 4)
  const pos = g.getAttribute('position') as THREE.BufferAttribute
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i)
    const y = pos.getY(i)
    const z = pos.getZ(i)
    // deterministic layered lumps keyed on the vertex position (shared corners move together):
    // broad mass, mid ridges, small pits, a flattened face where it broke off a larger body
    const n0 = Math.sin(x * 2.3 + y * 1.7) * 0.5 + Math.sin(y * 2.9 - z * 2.1) * 0.4 + Math.sin(z * 2.6 + x * 1.3) * 0.35
    const n1 = Math.sin(x * 7.1 + z * 5.3) * 0.5 + Math.sin(y * 8.3 + x * 3.9) * 0.5
    const n2 = Math.abs(Math.sin(x * 15.7 + y * 13.1 + z * 11.3))
    let k = 0.84 + n0 * 0.09 + n1 * 0.035 - (n2 > 0.92 ? 0.04 : 0)
    if (x > 0.62) k -= (x - 0.62) * 0.55
    pos.setXYZ(i, x * k * 1.12, y * k * 0.9, z * k)
  }
  g.computeVertexNormals()
  return g
}

/** Basalt with glowing molten fissures; A0.x = heat 0..1, A0.y = seed. */
function rockMaterial(ctx: VfxCtx, A: Node<'vec4'>[]): THREE.Material {
  const [A0] = A
  const t = ctx.world.uTime
  const heat = A0.x
  const L = vec3(-0.42, 0.86, 0.3).normalize()
  const lam = saturate(dot(normalWorld, L))
  const viewDir = positionView.negate().normalize()
  const ndv = saturate(dot(normalView, viewDir))
  // geometry space: fissures turn with the tumbling rock
  const p = positionGeometry
  const uvA = vec2(p.x.mul(0.55).add(p.z.mul(0.31)), p.y.mul(0.55).sub(p.z.mul(0.27))).add(A0.y)
  const edge = texture(ctx.world.noise, uvA).b
  const edge2 = texture(ctx.world.noise, uvA.mul(2.3).add(0.37)).b
  const glowN = texture(ctx.world.noise, uvA.mul(0.6).add(vec2(t.mul(0.05), t.mul(-0.08)))).r
  // only some cell edges are molten: a broad mask picks the cracked regions
  const mask = smoothstep(0.32, 0.52, texture(ctx.world.noise, uvA.mul(0.35).add(1.3)).r)
  const fissure = smoothstep(0.06, 0.0, edge).add(smoothstep(0.035, 0.0, edge2).mul(0.5)).mul(mask).mul(glowN.mul(0.8).add(0.5))
  const grain = texture(ctx.world.noise, uvA.mul(3.1)).g
  // the side facing the fall glows hot (ablation): underside lit by its own fire
  const under = saturate(normalWorld.y.negate().mul(0.8).add(0.2))
  const base = vec3(0.075, 0.05, 0.08).mul(grain.mul(0.7).add(0.6)).mul(pow(lam, 1.5).mul(1.6).add(0.12))
  const hot = mix(vec3(...F_MAGENTA), vec3(...F_HOT), heat)
  const rim = pow(float(1).sub(ndv), 3.5).mul(heat.mul(0.9).add(0.3))
  const col = base
    .add(hot.mul(fissure).mul(heat.mul(1.5).add(0.5)))
    .add(vec3(...F_VIOLET).mul(rim))
    .add(vec3(...F_MAGENTA).mul(under.mul(heat).mul(0.45)))
  const m = new THREE.MeshBasicNodeMaterial()
  m.colorNode = tierCap(ctx, col, 3.0, 1.0, 0.85)
  // drawn after the volume fire (renderOrder 9) so the rock silhouette always reads
  m.transparent = true
  m.depthWrite = true
  m.name = 'VfxB-MeteorRock'
  return m
}

function visualH(z: number): number {
  return PROJECTILE_H + (z - GAME_Z) * Z_SCALE
}

/** Same clamp as sim util.clampTarget (range 1000, no range mastery). */
function clampTarget(px: number, py: number, x: number, y: number, range: number, out: { x: number; y: number }): void {
  const dx = x - px
  const dy = y - py
  const d = Math.hypot(dx, dy)
  if (d <= range || d === 0) {
    out.x = x
    out.y = y
    return
  }
  out.x = px + (dx / d) * range
  out.y = py + (dy / d) * range
}
const tgt = { x: 0, y: 0 }

/** deterministic 0..1 hash */
function hr(n: number): number {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453
  return s - Math.floor(s)
}

// ------------------------------------------------------------------ impact

function impact(ctx: VfxCtx, x: number, y: number, R: number, tier: number): void {
  const fh = floorH(ctx, x, y)
  const onTile = !ctx.isLava(x, y)
  const k = R / 260
  /** power tier: more fire, chunks and debris (edges stay at exactly R) */
  const pw = 1 + 0.3 * tier
  // the authoritative edge first; everything below stays inside it
  ctx.aoeRing(x, y, R, MAGENTA[0], MAGENTA[1], MAGENTA[2], 0.6)
  // short coloured flash (2-3 frames), never a white disc
  flashT(ctx, x, y, fh + 90, 0.03, R * 0.9, R * 0.6, F_MAGENTA[0] * 0.6, F_MAGENTA[1] * 0.6, F_MAGENTA[2] * 0.6)
  // ground-shaking shockwave racing out to exactly R, then a slower dust front
  ctx.ground.spawn(RING_EXPAND, x, y, fh, 30, R - 12, 0.32, 20 * k, VIOLET[0] * 0.6, VIOLET[1] * 0.6, VIOLET[2] * 0.6)
  ctx.ground.spawn(RING_EXPAND, x, y, fh, 20, R * 0.6, 0.2, 14, PINK_HOT[0] * 0.35, PINK_HOT[1] * 0.35, PINK_HOT[2] * 0.35)
  if (onTile) {
    ctx.scorches.spawn(x, y, TILE_TOP_H + 0.6, R * 0.78, 7)
    crater(ctx, x, y, R * 0.55, 1, DUST_C)
  }
  const fv = fire
  if (fv) {
    const b = (n: number) => ctx.particles.budget(n)
    // 1. rolling fireball at the core: hot, swelling, cooling to smoke
    let n = b(8 * pw)
    for (let i = 0; i < n; i++) {
      const a = Math.random() * TAU
      const sp = rand(0.2, 0.55) * R
      const s0 = R * rand(0.32, 0.42)
      fv.spawn(x + Math.cos(a) * 30, y + Math.sin(a) * 30, fh + s0 * 0.45 + rand(0, 40), Math.cos(a) * sp, Math.sin(a) * sp, rand(80, 260), rand(0.75, 1.05), s0, s0 * 1.9, 0.95, 2.2, 2.6, 160)
    }
    // 2. stem rising out of the crater
    n = b(5 * pw)
    for (let i = 0; i < n; i++) {
      const s0 = R * rand(0.22, 0.3)
      fv.spawn(x + rand(-25, 25), y + rand(-25, 25), fh + s0 * 0.5, rand(-30, 30), rand(-30, 30), rand(520, 760), rand(1.0, 1.35), s0, s0 * 1.6, 0.9, 2.4, 1.6, -60)
    }
    // 3. mushroom cap: rolls outward at the top of the stem, burns out into black smoke
    n = b(8 * pw)
    for (let i = 0; i < n; i++) {
      const a = (i / Math.max(1, n)) * TAU + rand(-0.2, 0.2)
      const sp = rand(0.35, 0.55) * R
      const s0 = R * rand(0.28, 0.36)
      fv.spawn(x + Math.cos(a) * 30, y + Math.sin(a) * 30, fh + 210 + rand(0, 60), Math.cos(a) * sp, Math.sin(a) * sp, rand(200, 320), rand(1.4, 1.8), s0, s0 * 1.9, 0.7, 2.6, 1.6, -40, 0.4)
    }
    // 4. dust ring rolling out along the floor, stopping inside R
    n = b(14)
    for (let i = 0; i < n; i++) {
      const a = (i / Math.max(1, n)) * TAU + rand(-0.15, 0.15)
      const s0 = R * rand(0.18, 0.24)
      // travel = v / drag stays <= 0.62 R; puff radius adds <= 0.35 R
      fv.spawn(x + Math.cos(a) * R * 0.2, y + Math.sin(a) * R * 0.2, fh + s0 * 0.42, Math.cos(a) * R * 1.5, Math.sin(a) * R * 1.5, rand(10, 50), rand(1.1, 1.5), s0, s0 * 1.7, 0.25, 2.2, 3.6, 0, 0)
    }
  }
  const ps = ctx.particles
  // molten splash: glowing droplets arcing out and landing inside R
  let n = ps.budget(40 * k)
  for (let i = 0; i < n; i++) {
    const a = Math.random() * TAU
    const sp = rand(0.6, 1.9) * R
    ps.spawn(x, y, fh + 40, Math.cos(a) * sp, Math.sin(a) * sp, rand(350, 950), rand(0.6, 0.95), rand(8, 13), 4, EMBER[0], EMBER[1], EMBER[2], -1900, 1.5, -0.05)
  }
  // flung rock chunks with burning trails: chunk (opaque) + streak (additive), same motion
  n = ctx.debris.budget(14 * k * pw)
  for (let i = 0; i < n; i++) {
    const a = Math.random() * TAU
    const sp = rand(0.5, 1.2) * R
    const vx = Math.cos(a) * sp
    const vy = Math.sin(a) * sp
    const vh = rand(450, 850)
    const life = rand(0.9, 1.2)
    const g = rand(0.03, 0.06)
    const sz = rand(16, 28)
    ctx.debris.spawn(x, y, fh + 50, vx, vy, vh, life, sz, sz * 0.8, g * 1.2, g * 0.8, g * 1.3, -2000, 1.1, 0)
    ps.spawn(x, y, fh + 50, vx, vy, vh, life * 0.7, sz * 1.5, sz * 0.4, EMBER[0] * 0.8, EMBER[1] * 0.8, EMBER[2] * 0.8, -2000, 1.1, -0.07)
  }
  // a few heavy boulders that barely leave the crater
  n = ctx.debris.budget((4 + 2 * tier) * k)
  for (let i = 0; i < n; i++) {
    const a = Math.random() * TAU
    const sp = rand(0.25, 0.7) * R
    ctx.debris.spawn(x, y, fh + 50, Math.cos(a) * sp, Math.sin(a) * sp, rand(450, 700), rand(1.0, 1.3), rand(36, 50), 26, 0.035, 0.025, 0.04, -2200, 1.3, 0)
  }
  // fine rock debris
  n = ctx.debris.budget(30 * k)
  for (let i = 0; i < n; i++) {
    const a = Math.random() * TAU
    const sp = rand(0.45, 1.45) * R
    const g = rand(0.03, 0.08)
    ctx.debris.spawn(x + Math.cos(a) * 30, y + Math.sin(a) * 30, fh + rand(10, 70), Math.cos(a) * sp, Math.sin(a) * sp, rand(350, 800), rand(0.9, 1.3), rand(8, 16), 6, g * 1.15, g * 0.85, g * 1.25, -2100, 1.2, 0)
  }
  // settling dust (inside R)
  const sm = ctx.smoke
  n = sm.budget(12 * k)
  for (let i = 0; i < n; i++) {
    const a = Math.random() * TAU
    const rr = Math.sqrt(Math.random()) * R * 0.75
    sm.spawn(x + Math.cos(a) * rr, y + Math.sin(a) * rr, fh + rand(40, 140), rand(-20, 20), rand(-20, 20), rand(-30, 10), rand(2.0, 2.8), 70, R * 0.35, DUST_C[0], DUST_C[1], DUST_C[2], 0, 0.8, 12)
  }
  ctx.shakeNear(x, y, 0.5 + 0.35 * k)
  if (craters.length >= 4) craters.shift()
  craters.push({ x, y, r: R, born: ctx.now, seed: Math.random() * 10, tier })
}

function drawTelegraph(ctx: VfxCtx, x: number, y: number, R: number, prog: number, born: number, ownerColor: number, seed: number, tier = 0): void {
  const fh = floorH(ctx, x, y)
  const pulse = 0.85 + 0.15 * Math.sin(ctx.now * 18)
  const danger = 0.55 + 0.9 * prog * prog
  drawCircle(x, y, fh, R, STYLE_RUNES, MAGENTA[0], MAGENTA[1], MAGENTA[2], danger * pulse, prog, 0.6, seed, 0.015, 1.4, 20 + 8 * tier, born)
  // higher tiers: a second, counter-turning rune ring inside the zone
  if (tier > 0) drawCircle(x, y, fh + 0.1, R * 0.62, STYLE_RUNES, VIOLET[0], VIOLET[1], VIOLET[2], 0.5 * tier * pulse, 0, -0.9, seed + 3, 0, 1.2, 12 + 6 * tier, born)
  hexRgb(ownerColor, team)
  // crisp authoritative edge at exactly R, team tinted
  drawCircle(x, y, fh + 0.3, R, STYLE_RING, team[0] * 0.8 + 1.2, team[1] * 0.8 + 0.2, team[2] * 0.8 + 1.0, 1.1, 0, 0, seed, 0, 0.5, 0, born)
}

/** Lightning flickering off the rift's edges (re-rolled every 0.07 s). */
function riftBolts(ctx: VfxCtx, f: Flight, open: number): void {
  const slot = Math.floor(ctx.now / 0.07)
  for (let b = 0; b < 3; b++) {
    const s = f.id * 31.7 + slot * 7.3 + b * 3.1
    if (hr(s) > (0.3 + 0.15 * f.tier) * open) continue
    const side = hr(s + 1) < 0.5 ? -1 : 1
    let px = f.rx + side * ROCK_R * 0.5 * open
    let ph = f.rh + 40 + (hr(s + 2) - 0.5) * ROCK_R * 2.2
    for (let j = 0; j < 3; j++) {
      const ang = side * 0.0 + (hr(s + 5 + j) - 0.5) * 1.6
      const L = 40 + hr(s + 9 + j) * 50
      const dx = Math.cos(ang) * L * side
      const dh = Math.sin(ang) * L
      const a = screenAngle(ctx, px + dx * 0.5, f.ry, ph + dh * 0.5, dx / L, 0, dh / L)
      glowG(px + dx * 0.5, f.ry, ph + dh * 0.5, 12, MAGENTA, 0.8 * open, 3, 0, L / 12, a)
      px += dx
      ph += dh
    }
  }
}

function drawRock(ctx: VfxCtx, p: ProjectileState, x: number, y: number, f: Flight, falling: boolean, fallU: number, tier: number): void {
  const d = p.data
  // interpolate height with the previous snapshot
  let z = d.z
  if (ctx.prev) {
    for (const q of ctx.prev.projectiles) {
      if (q.id === p.id) {
        z = q.data.z + (d.z - q.data.z) * ctx.alpha
        break
      }
    }
  }
  const h = visualH(z)
  const age = ctx.now - f.born
  const emerge = Math.min(1, age / 0.3)
  const scale = ROCK_R * (0.35 + 0.65 * (1 - (1 - emerge) * (1 - emerge)))
  const heat = falling ? 0.45 + 0.55 * Math.min(1, fallU) : 0.3
  // slow, heavy tumble
  qTmp.setFromAxisAngle(f.axis, ctx.dt * (falling ? 1.8 : 0.6))
  f.spin.premultiply(qTmp)
  if (rocks) {
    rocks.quat.copy(f.spin)
    const i = rocks.add(x * S, h * S, -y * S, scale * S, scale * S, scale * S)
    rocks.set(i, 0, heat, (p.id % 13) * 0.37, 0, 0)
  }
  // tight heat wreath (the fire itself is volumetric puffs)
  glowG(x, y, h, scale * 3.2, VIOLET, 0.12 + heat * 0.15, 2, 0, 1, 0, 0.9)
  const dt = ctx.dt
  const fv = fire
  if (falling) {
    const vx = (d.tx - f.sx) / Math.max(0.01, d.fallTime)
    const vy = (d.ty - f.sy) / Math.max(0.01, d.fallTime)
    const vh = (visualH(GAME_Z) - visualH(d.z0 ?? 700)) / Math.max(0.01, d.fallTime)
    const sp = Math.hypot(vx, vy, vh)
    const ux = vx / sp
    const uy = vy / sp
    const uh = vh / sp
    // motion-blurred comet streak (screen aligned), two layers, kept coloured
    const ang = screenAngle(ctx, x, y, h, ux, uy, uh)
    glowG(x - ux * scale * 2.4, y - uy * scale * 2.4, h - uh * scale * 2.4, scale * 1.6, MAGENTA, 0.3, 2, 0, 4.2, ang, 0.6)
    // volumetric fire trail: puffs shed along the path travelled this frame
    if (fv) {
      const dl = Math.hypot(x - f.lx, y - f.ly, h - f.lh)
      const cnt = Math.min(6 + 2 * tier, Math.ceil((dl / (scale * (0.34 - 0.04 * tier))) * ctx.tier.particles))
      for (let i = 0; i < cnt; i++) {
        const u = (i + Math.random()) / Math.max(1, cnt)
        const px = f.lx + (x - f.lx) * u + rand(-0.35, 0.35) * scale
        const py = f.ly + (y - f.ly) * u + rand(-0.35, 0.35) * scale
        const ph = f.lh + (h - f.lh) * u + rand(-0.3, 0.3) * scale
        fv.spawn(px, py, ph, -vx * 0.12 + rand(-60, 60), -vy * 0.12 + rand(-60, 60), -vh * 0.12 + rand(20, 90), rand(0.32, 0.55), scale * 1.05, scale * 2.1, 1.0, 1.6, 2.2, 140)
      }
    }
    // burning chunks shed behind it: chunk + streak with identical motion
    const nc = ctx.debris.budget(dt * (20 + 12 * tier))
    for (let i = 0; i < nc; i++) {
      const cvx = vx * 0.55 + rand(-160, 160)
      const cvy = vy * 0.55 + rand(-160, 160)
      const cvh = vh * 0.4 + rand(100, 300)
      const life = rand(0.6, 0.9)
      const sz = rand(9, 16)
      const a = Math.random() * TAU
      const sx = x + Math.cos(a) * scale * 0.6
      const sy = y + Math.sin(a) * scale * 0.6
      ctx.debris.spawn(sx, sy, h, cvx, cvy, cvh, life, sz, sz * 0.7, 0.05, 0.03, 0.05, -1500, 0.6, 0)
      ctx.particles.spawn(sx, sy, h, cvx, cvy, cvh, life * 0.8, sz * 1.8, sz * 0.5, EMBER[0] * 0.7, EMBER[1] * 0.7, EMBER[2] * 0.7, -1500, 0.6, -0.07)
    }
  } else if (fv) {
    // hovering: flames lick up around the rock as it pushes out of the rift
    const nf = Math.floor(dt * 34 * ctx.tier.particles + Math.random())
    for (let i = 0; i < nf; i++) {
      const a = Math.random() * TAU
      const rr = scale * rand(0.3, 0.75)
      fv.spawn(x + Math.cos(a) * rr, y + Math.sin(a) * rr, h + rand(-0.3, 0.2) * scale, Math.cos(a) * 40, Math.sin(a) * 40, rand(60, 160), rand(0.35, 0.5), scale * 0.75, scale * 1.4, 1.1, 1.2, 1.5, 260)
    }
  }
  projShadow(ctx, x, y, h, scale)
  f.lx = x
  f.ly = y
  f.lh = h
}

// ------------------------------------------------------------------ module

registerSpellVfx({
  spell: SPELL,
  init(ctx: VfxCtx) {
    kitInit(ctx)
    rocks = kitAdopt(new InstPool(rockGeometry(), 1, 12, (A) => rockMaterial(ctx, A), 9, 'vfxB-meteor-rocks'))
    fire = kitAdopt(new FireVolume(ctx, 384))
    rifts = kitAdopt(new Rifts(ctx, 8))
  },
  dispose() {
    rocks = null
    fire = null
    rifts = null
    flights.clear()
    craters.length = 0
    kitRelease()
  },
  onEvent(e: SimEvent, ctx: VfxCtx): boolean | void {
    switch (e.type) {
      case 'castStart': {
        if (e.spell !== SPELL) return
        const info = ctx.pawn(e.pawn)
        if (info) {
          const o = originOf(info)
          implode(ctx, o.x / S, -o.z / S, o.y / S, 22, 70, 140, 0.2, 14, MAGENTA, 1.2, 60)
        }
        return
      }
      case 'cast': {
        if (e.spell !== SPELL) return
        const o = castFlash(ctx, e.pawn, MAGENTA, 1.2)
        if (o) {
          // a bolt of violet light thrown up into the sky
          const ps = ctx.particles
          const n = ps.budget(26)
          for (let i = 0; i < n; i++) {
            ps.spawn(o.x / S + rand(-10, 10), -o.z / S + rand(-10, 10), o.y / S, rand(-40, 40), rand(-40, 40), rand(1200, 2000), rand(0.3, 0.5), rand(14, 22), 4, MAGENTA[0], MAGENTA[1], MAGENTA[2], 0, 0.5, -0.12)
          }
        }
        return
      }
      case 'projectileSpawn': {
        if (e.spell !== SPELL || !ctx.state) return
        const p = ctx.state.projectiles.find((q) => q.id === e.id)
        if (!p) return
        const h = visualH(p.data.z)
        // the rift tears open: sparks spray out of the slit
        burst(ctx, p.x, p.y, h, 30, 200, 600, 0.3, 0.6, 18, 4, MAGENTA, 1.1, -200, 3, -0.06, -200, 200)
        flashT(ctx, p.x, p.y, h + 40, 0.08, 10, ROCK_R * 2, VIOLET[0] * 0.6, VIOLET[1] * 0.6, VIOLET[2] * 0.6)
        return
      }
      case 'projectileHit':
      case 'projectileExpire':
        return e.spell === SPELL ? true : undefined
      case 'explosion':
        if (e.spell !== SPELL) return
        impact(ctx, e.x, e.y, e.radius, tierOfLevel(ctx, levelOfThing(e)))
        return true
      default:
        return
    }
  },
  frame(ctx: VfxCtx) {
    kitBegin(ctx)
    frameNo++
    const st = ctx.state
    if (!st) return
    // windup: telegraph the impact zone from the cast point on
    for (const pw of st.pawns) {
      const c = pw.cast
      if (!pw.alive || !c || c.spell !== SPELL || !c.started) continue
      const lvl = pw.levels[c.slot] || 1
      const R = attr(DEF, 'radius', lvl)
      clampTarget(pw.x, pw.y, c.x, c.y, attr(DEF, 'range', lvl), tgt)
      const total = Math.max(1, Math.round(DEF.castPoint * 60))
      const k = 1 - c.ticksLeft / total
      drawTelegraph(ctx, tgt.x, tgt.y, R, 0, ctx.now - k * DEF.castPoint, ctx.colorOf(pw.owner), pw.id * 0.71, tierOfLevel(ctx, lvl))
      const info = ctx.pawn(pw.id)
      if (info) {
        const o = originOf(info)
        glowG(o.x / S, -o.z / S, o.y / S, 60 + 120 * k, MAGENTA, 0.6 + 1.2 * k, 2.2)
        glowG(o.x / S, -o.z / S, o.y / S, 40 + 60 * k, PINK_HOT, 0.5 + k, 2, 2, 1, ctx.now * 3)
        // signature: a violet sky-rune wheels open above the caster's raised arm
        drawCircle(info.x, info.y, info.h + 250, 70 + 60 * k, STYLE_RUNES, VIOLET[0], VIOLET[1], VIOLET[2], 0.6 + 1.2 * k, 0, 2.5, pw.id, 0.1, 1.2, 12, ctx.now - 1)
        glowG(info.x, info.y, info.h + 250, 140 + 100 * k, VIOLET_DEEP, 2, 1, 3, 1, ctx.now)
      }
    }
    // craters: glowing cracks and rim that cool, embers rising
    for (let i = craters.length - 1; i >= 0; i--) {
      const c = craters[i]
      const age = ctx.now - c.born
      if (age > CRATER_LIFE) {
        craters.splice(i, 1)
        continue
      }
      const u = age / CRATER_LIFE
      const fh = floorH(ctx, c.x, c.y)
      const cool = 1 - u
      // molten magenta cooling to violet (saturated, never pale)
      const cr = F_MAGENTA[0] * 1.6 * cool + VIOLET[0] * u
      const cg = F_MAGENTA[1] * 1.6 * cool + VIOLET[1] * u
      const cb = F_MAGENTA[2] * 1.6 * cool + VIOLET[2] * u
      drawCircle(c.x, c.y, fh + 0.2, c.r * 0.85, STYLE_CRACKS, cr, cg, cb, 1.1 * cool, u * 0.85, 0, c.seed, 0, 1, 0, c.born - 1)
      drawCircle(c.x, c.y, fh + 0.3, c.r * 0.55, STYLE_RING, cr, cg, cb, (0.7 + 0.2 * c.tier) * cool * cool, 0, 0, c.seed, 0, 1.6, 0, c.born - 1)
      const lu = Math.max(0, 1 - age / 0.6)
      if (lu > 0) light(ctx, c.x, c.y, c.r * 0.8, 1.4 * lu * lu, MAGENTA, 0.5, true)
      const ps = ctx.particles
      const n = ps.budget(ctx.dt * 60 * cool)
      for (let j = 0; j < n; j++) {
        const a = Math.random() * TAU
        const rr = Math.sqrt(Math.random()) * c.r * 0.6
        ps.spawn(c.x + Math.cos(a) * rr, c.y + Math.sin(a) * rr, fh + 5, rand(-20, 20), rand(-20, 20), rand(60, 160), rand(0.8, 1.6), rand(5, 9), 1.5, EMBER[0], EMBER[1], EMBER[2], 20, 0.4, 18)
      }
    }
    // rifts: open on spawn, stay through the hover, close during the first part of the fall
    for (const [id, f] of flights) {
      if (frameNo - f.seen > 1) {
        flights.delete(id)
        freeFlights.push(f)
        continue
      }
      const openU = Math.min(1, (ctx.now - f.born) / RIFT_OPEN)
      const closeU = f.fallAt > 0 ? Math.min(1, (ctx.now - f.fallAt) / RIFT_CLOSE) : 0
      const open = (1 - (1 - openU) * (1 - openU)) * (1 - closeU)
      if (open > 0.01 && rifts) {
        rifts.add(f.rx, f.ry, f.rh + 40, ROCK_R * (3.1 + 0.4 * f.tier), open, id * 0.37, 0.9)
        riftBolts(ctx, f, open)
        light(ctx, f.rx, f.ry, 240, 0.3 * open, VIOLET, 1)
      }
    }
  },
  drawProjectile(p: ProjectileState, x: number, y: number, ctx: VfxCtx) {
    const d = p.data
    let f = flights.get(p.id)
    if (!f) {
      f = freeFlights.pop() ?? { id: 0, seen: 0, born: 0, rx: 0, ry: 0, rh: 0, fallAt: -1, sx: 0, sy: 0, lx: 0, ly: 0, lh: 0, spin: new THREE.Quaternion(), axis: new THREE.Vector3(), tier: 0 }
      f.id = p.id
      f.born = ctx.now
      f.fallAt = -1
      f.rx = f.sx = f.lx = p.x
      f.ry = f.sy = f.ly = p.y
      f.rh = f.lh = visualH(d.z0 ?? d.z)
      f.spin.identity()
      f.axis.set(rand(-1, 1), rand(-0.3, 0.3), rand(-1, 1)).normalize()
      flights.set(p.id, f)
    }
    f.seen = frameNo
    f.tier = tierOfLevel(ctx, levelOfThing(p))
    const falling = d.falling === 1
    if (!falling) {
      f.sx = p.x
      f.sy = p.y
    } else if (f.fallAt < 0) f.fallAt = ctx.now
    const hover = d.hoverTime ?? 0.55
    const fall = d.fallTime ?? 0.6
    const el = (d.elapsed ?? 0) / 60
    const tLeft = falling ? Math.max(0, fall - el) : hover - el + fall
    const prog = Math.max(0, Math.min(1, 1 - tLeft / (hover + fall)))
    const R = d.radius
    const tier = tierOfLevel(ctx, levelOfThing(p))
    drawTelegraph(ctx, d.tx, d.ty, R, prog, f.born - 1, ctx.colorOf(p.owner), p.id * 0.71, tier)
    const fh = floorH(ctx, d.tx, d.ty)
    // the shadow of the rock swallows the zone as it falls (never past the hit radius)
    drawShadow(d.tx, d.ty, fh - 0.4, R * (0.6 + 0.4 * prog), 0.15 + 0.7 * prog * prog, 0.7, 0.25, p.id)
    light(ctx, d.tx, d.ty, R, 0.1 + 0.7 * prog * prog, MAGENTA, 0.45, true)
    drawRock(ctx, p, x, y, f, falling, falling ? el / fall : 0, tier)
  },
})
