/**
 * Shared toolkit for VFX workstream B (Devastator / Defense / Knockbackless columns).
 * Owned by workstream B; spell modules in this folder import it.
 *
 * - Pools are created once per match world (ref-counted through kitInit / kitRelease) and
 *   rewritten every frame: kitBegin(ctx) (called from every module's frame(); the first call
 *   in a frame wins) resets them, add() calls fill them. Nothing allocates per frame.
 * - Sprites: own additive glow sprite batch (soft glow, ring, 4-point flare, smoke wisp) so
 *   workstream B never starves the world's shared Billboards.
 * - Cores: hitbox-sized energy orbs drawn last (renderOrder 10), readable above every effect.
 * - Circles: ground decals (rune circle, plain ring, clock, frost, cracks, ripples).
 * - Shadows: soft dark discs on the floor (Meteor shadow, Gravity well, Warpzone interior).
 */
import * as THREE from 'three/webgpu'
import {
  abs, atan, cos, dot, exp, float, floor, fract, hash, instancedBufferAttribute, length, max, mix, mrt, normalView,
  positionGeometry, positionView, pow, saturate, sin, smoothstep, step, texture, uv, vec2, vec3, vec4,
} from 'three/tsl'
import type { Node } from 'three/webgpu'
import { S } from '../../coords'
import { asV4 } from '../../scene/world'
import type { PawnRenderInfo, VfxCtx } from '../registry'

export type RGB = readonly [number, number, number]

// ---------------------------------------------------------------- palette (linear HDR)
/** column 4 Devastator: violet-magenta */
export const VIOLET: RGB = [1.15, 0.28, 2.6]
export const MAGENTA: RGB = [2.6, 0.35, 1.9]
export const PINK_HOT: RGB = [3.2, 1.5, 2.9]
export const VIOLET_DEEP: RGB = [0.35, 0.05, 0.75]
/** column 5 Defense: radiant gold-white */
export const GOLD: RGB = [2.7, 1.75, 0.55]
export const GOLD_WHITE: RGB = [3.0, 2.6, 1.7]
export const FLAME: RGB = [3.0, 0.95, 0.18]
/** column 6 Knockbackless: eldritch green */
export const ELDRITCH: RGB = [0.45, 2.7, 0.75]
export const ELD_PALE: RGB = [1.3, 3.0, 1.4]
export const ELD_DEEP: RGB = [0.06, 0.55, 0.16]
/** Snowball frost */
export const FROST: RGB = [1.6, 2.2, 3.0]
export const ICE_VIOLET: RGB = [1.4, 1.1, 3.0]

export const TAU = Math.PI * 2

export function rand(a = 0, b = 1): number {
  return a + Math.random() * (b - a)
}

/** Team colour 0xRRGGBB -> linear-ish rgb triple (0..1), written into `out`. */
export function hexRgb(hex: number, out: [number, number, number]): [number, number, number] {
  out[0] = ((hex >> 16) & 255) / 255
  out[1] = ((hex >> 8) & 255) / 255
  out[2] = (hex & 255) / 255
  return out
}

/** Where spells leave the caster: the hand / staff socket (castOrigin when render provides it). */
export function originOf(info: PawnRenderInfo): THREE.Vector3 {
  const o = (info as PawnRenderInfo & { castOrigin?: THREE.Vector3 }).castOrigin
  return o ?? info.tip
}

/** Ground height (game units) a decal at (x, y) should sit on. */
export function floorH(ctx: VfxCtx, x: number, y: number): number {
  return ctx.floorAt(x, y) + 1.2
}

// ---------------------------------------------------------------- screen helpers

const sv0 = new THREE.Vector3()
const sv1 = new THREE.Vector3()
/** Screen-space angle (radians) of a game-space direction at a game point. */
export function screenAngle(ctx: VfxCtx, x: number, y: number, h: number, dx: number, dy: number, dh = 0): number {
  const cam = ctx.camera
  sv0.set(x * S, h * S, -y * S).project(cam)
  sv1.set((x + dx * 50) * S, (h + dh * 50) * S, -(y + dy * 50) * S).project(cam)
  return Math.atan2(sv1.y - sv0.y, (sv1.x - sv0.x) * cam.aspect)
}

// ---------------------------------------------------------------- pools

/** Anything kitBegin() resets each frame. */
interface Resettable {
  begin(): void
  dispose(): void
  readonly object: THREE.Object3D
}

/**
 * Additive camera-facing sprites (per frame). kind: 0 soft glow (falloff = exponent),
 * 1 ring (falloff = ring width), 2 four-point flare, 3 smoke wisp (noise), 4 hard dot.
 */
export class GlowSprites implements Resettable {
  readonly object: THREE.Sprite
  private p: THREE.InstancedBufferAttribute
  private c: THREE.InstancedBufferAttribute
  private e: THREE.InstancedBufferAttribute
  private n = 0
  private material: THREE.SpriteNodeMaterial

  constructor(
    ctx: VfxCtx,
    private capacity: number,
  ) {
    const mk = () => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4)
      a.setUsage(THREE.DynamicDrawUsage)
      return a
    }
    this.p = mk()
    this.c = mk()
    this.e = mk()
    const P = asV4(instancedBufferAttribute(this.p))
    const C = asV4(instancedBufferAttribute(this.c))
    const E = asV4(instancedBufferAttribute(this.e))
    const q = uv().sub(0.5).mul(2)
    const d = length(q)
    const soft = saturate(float(1).sub(d))
    const k = E.w
    const isK = (v: number) => step(v - 0.5, k).mul(step(k, v + 0.5))
    const glow = pow(soft, C.w)
    const rw = max(C.w, 0.02)
    const rx = d.sub(0.72).div(rw)
    const ring = exp(rx.mul(rx).negate()).mul(step(d, 1))
    const ax = abs(q.x)
    const ay = abs(q.y)
    const flare = exp(ax.mul(14).negate()).mul(saturate(float(1).sub(ay))).add(exp(ay.mul(14).negate()).mul(saturate(float(1).sub(ax)))).mul(0.8).add(pow(soft, 3).mul(1.2))
    const nz = texture(ctx.world.noise, q.mul(0.33).add(vec2(E.z.mul(0.0), C.w.mul(0.137)).add(ctx.world.uTime.mul(vec2(0.03, -0.05))))).r
    const wisp = pow(soft, 1.6).mul(smoothstep(0.32, 0.75, nz.add(soft.mul(0.35)))).mul(1.6)
    const dot = smoothstep(1, 0.6, d)
    // every kind fades to zero well inside the quad: no square or hard edges
    const edge = smoothstep(1.0, 0.82, d)
    const shape = glow.mul(isK(0)).add(ring.mul(isK(1))).add(flare.mul(isK(2))).add(wisp.mul(isK(3))).add(dot.mul(isK(4))).mul(edge)
    const m = new THREE.SpriteNodeMaterial()
    m.transparent = true
    m.depthWrite = false
    m.blending = THREE.AdditiveBlending
    m.positionNode = P.xyz
    m.scaleNode = vec2(P.w.mul(E.y), P.w)
    m.rotationNode = E.x
    m.colorNode = C.xyz.mul(shape)
    m.opacityNode = float(1)
    if (ctx.tier.heatHaze) m.mrtNode = mrt({ heat: vec4(saturate(shape).mul(E.z), 0, 0, 1) })
    m.name = 'VfxB-Sprites'
    this.material = m
    this.object = new THREE.Sprite(m)
    this.object.count = 0
    this.object.frustumCulled = false
    this.object.renderOrder = 7
    this.object.name = 'vfxB-sprites'
  }

  begin(): void {
    this.n = 0
    this.object.count = 0
    this.object.visible = false
  }

  /**
   * World-space (three units) position, size in three units, linear HDR colour.
   * stretch/rot: screen-aligned stretch; heat: distortion strength (heat haze tiers).
   */
  add(x: number, y: number, z: number, size: number, r: number, g: number, b: number, falloff = 2, kind = 0, stretch = 1, rot = 0, heat = 0): void {
    if (this.n >= this.capacity) return
    const o = this.n * 4
    const pa = this.p.array as Float32Array
    const ca = this.c.array as Float32Array
    const ea = this.e.array as Float32Array
    pa[o] = x
    pa[o + 1] = y
    pa[o + 2] = z
    pa[o + 3] = size
    ca[o] = r
    ca[o + 1] = g
    ca[o + 2] = b
    ca[o + 3] = falloff
    ea[o] = rot
    ea[o + 1] = stretch
    ea[o + 2] = heat
    ea[o + 3] = kind
    this.n++
    this.object.count = this.n
    this.object.visible = true
    this.p.needsUpdate = true
    this.c.needsUpdate = true
    this.e.needsUpdate = true
  }

  /** Game-space convenience (x, y ground, h height; size in game units). */
  addG(x: number, y: number, h: number, size: number, r: number, g: number, b: number, falloff = 2, kind = 0, stretch = 1, rot = 0, heat = 0): void {
    this.add(x * S, h * S, -y * S, size * S, r, g, b, falloff, kind, stretch, rot, heat)
  }

  dispose(): void {
    this.material.dispose()
  }
}

/**
 * Per-frame instanced mesh with N extra vec4 attributes per instance. build() receives the
 * attribute nodes and returns the material.
 */
export class InstPool implements Resettable {
  readonly object: THREE.InstancedMesh
  readonly attrs: THREE.InstancedBufferAttribute[] = []
  n = 0
  private mtx = new THREE.Matrix4()
  private pos = new THREE.Vector3()
  private scl = new THREE.Vector3()
  readonly quat = new THREE.Quaternion()

  constructor(
    geo: THREE.BufferGeometry,
    nAttr: number,
    readonly capacity: number,
    build: (A: Node<'vec4'>[]) => THREE.Material,
    renderOrder: number,
    name: string,
  ) {
    const nodes: Node<'vec4'>[] = []
    for (let i = 0; i < nAttr; i++) {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4)
      a.setUsage(THREE.DynamicDrawUsage)
      this.attrs.push(a)
      nodes.push(asV4(instancedBufferAttribute(a)))
    }
    const mat = build(nodes)
    this.object = new THREE.InstancedMesh(geo, mat, capacity)
    this.object.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.object.count = 0
    this.object.frustumCulled = false
    this.object.renderOrder = renderOrder
    this.object.name = name
  }

  begin(): void {
    this.n = 0
    this.object.count = 0
    this.object.visible = false
  }

  /** Add an instance (three world units) with rotation this.quat. Returns its index or -1. */
  add(x: number, y: number, z: number, sx: number, sy: number, sz: number): number {
    if (this.n >= this.capacity) return -1
    this.pos.set(x, y, z)
    this.scl.set(sx, sy, sz)
    this.mtx.compose(this.pos, this.quat, this.scl)
    const i = this.n++
    this.object.setMatrixAt(i, this.mtx)
    this.object.count = this.n
    this.object.visible = true
    this.object.instanceMatrix.needsUpdate = true
    return i
  }

  set(i: number, k: number, a: number, b: number, c: number, d: number): void {
    if (i < 0) return
    const arr = this.attrs[k].array as Float32Array
    const o = i * 4
    arr[o] = a
    arr[o + 1] = b
    arr[o + 2] = c
    arr[o + 3] = d
    this.attrs[k].needsUpdate = true
  }

  dispose(): void {
    this.object.geometry.dispose()
    ;(this.object.material as THREE.Material).dispose()
    this.object.dispose()
  }
}

// ---------------------------------------------------------------- shared materials

/** Hitbox energy orb: rim -> body -> core bands; mode 1 = dark core (event horizon). */
function coreMaterial(ctx: VfxCtx, A: Node<'vec4'>[]): THREE.Material {
  const [A0, A1] = A
  const t = ctx.world.uTime
  const viewDir = positionView.negate().normalize()
  const ndv = saturate(dot(normalView, viewDir))
  const flick = sin(t.mul(37).add(A0.w.mul(11))).mul(0.07).add(1)
  const swirl = texture(ctx.world.noise, normalView.xy.mul(0.35).add(vec2(t.mul(0.21), t.mul(-0.17)).add(A0.w))).r
  const edge = A0.xyz
  const core = A1.xyz
  const mid = mix(edge, core, 0.45)
  const hot = mix(mix(edge.mul(1.7), mid, smoothstep(0.05, 0.5, ndv)), core, smoothstep(0.62, 0.95, ndv)).mul(flick).mul(swirl.mul(0.5).add(0.75))
  // event horizon: black disc with a razor bright rim
  const rim = pow(float(1).sub(ndv), 3)
  const dark = edge.mul(rim.mul(3.2)).add(core.mul(0.02))
  const mode = A1.w
  const m = new THREE.MeshBasicNodeMaterial()
  m.colorNode = mix(hot, dark, mode)
  m.transparent = true
  m.depthWrite = true
  m.name = 'VfxB-Core'
  return m
}

/**
 * Ground decal material. Instance attributes:
 *   A0 rgb colour, w intensity
 *   A1 x progress 0..1, y style, z spin (rad/s), w seed
 *   A2 x fill, y ring width scale, z rune count, w born time
 * Styles: 0 rune circle, 1 plain ring, 2 clock, 3 frost patch, 4 cracks, 5 inward ripples, 6 swap arrows
 */
function circleMaterial(ctx: VfxCtx, A: Node<'vec4'>[]): THREE.Material {
  const [A0, A1, A2] = A
  const t = ctx.world.uTime
  const noise = ctx.world.noise
  const q = positionGeometry.xy
  const r = length(q)
  const progress = A1.x
  const style = A1.y
  const spin = A1.z
  const seed = A1.w
  const fillAmt = A2.x
  const wScale = A2.y
  const runes = A2.z
  const born = A2.w
  const isS = (v: number) => step(v - 0.5, style).mul(step(style, v + 0.5))
  const intro = saturate(t.sub(born).mul(5))
  const ang = atan(q.y, q.x).add(spin.mul(t)).add(float(1).sub(intro).mul(1.2))
  const ringAt = (r0: Node<'float'> | number, w: Node<'float'> | number) => {
    const x = r.sub(r0).div(w)
    return exp(x.mul(x).negate())
  }
  const th = wScale
  // --- style 0: rune circle
  const outer = ringAt(0.982, th.mul(0.009)).add(ringAt(0.895, th.mul(0.007)).mul(0.75))
  const cellsF = max(runes, 1)
  const ca = fract(ang.div(Math.PI * 2)).mul(cellsF)
  const cell = floor(ca)
  const cu = fract(ca)
  const cv = r.sub(0.905).div(0.06)
  const inBand = step(0, cv).mul(step(cv, 1))
  const h = hash(cell.add(seed.mul(17.3)))
  const bit = (k: number) => step(0.5, fract(h.mul(2 ** k)))
  const strokeU = (u0: number) => smoothstep(0.13, 0.0, abs(cu.sub(u0)))
  const strokeV = (v0: number) => smoothstep(0.13, 0.0, abs(cv.sub(v0)))
  const glyph = strokeU(0.5).mul(bit(1)).add(strokeV(0.25).mul(bit(2))).add(strokeV(0.75).mul(bit(3))).add(smoothstep(0.12, 0, abs(cu.sub(cv))).mul(bit(4))).add(strokeU(0.2).mul(bit(5)))
  const runeBand = saturate(glyph).mul(inBand).mul(step(0.12, cu)).mul(step(cu, 0.88))
  const fold = (a: Node<'float'>) => fract(a.div(Math.PI * 2 / 3)).sub(0.5).mul(Math.PI * 2 / 3)
  const tri = (off: number) => {
    const a2 = fold(ang.add(off))
    const dl = abs(r.mul(cos(a2)).sub(0.43))
    return smoothstep(th.mul(0.012), 0, dl).mul(step(r, 0.865))
  }
  const hexa = tri(0).add(tri(Math.PI / 3)).mul(0.6)
  const inner = ringAt(0.43, th.mul(0.008)).mul(0.6)
  const closing = ringAt(float(1).sub(progress).mul(0.97), th.mul(0.02)).mul(step(0.001, progress)).mul(1.6)
  const s0 = outer.add(runeBand.mul(0.85)).add(hexa).add(inner).add(closing)
  // --- style 1: plain ring (inner edge of the disc)
  // crisp band whose OUTER edge is exactly the radius (authoritative AoE boundary)
  const s1 = smoothstep(float(1).sub(th.mul(0.035)), float(1).sub(th.mul(0.012)), r).mul(1.4).add(smoothstep(0.6, 1.0, r).mul(0.12))
  // --- style 2: clock
  const ticks = fract(ang.div(Math.PI * 2).mul(60))
  const major = fract(ang.div(Math.PI * 2).mul(12))
  const tickBand = step(0.86, r).mul(step(r, 0.95))
  const tickM = smoothstep(0.12, 0.0, abs(ticks.sub(0.5))).mul(0.45).add(smoothstep(0.05, 0.0, abs(major.sub(0.5))).mul(step(0.81, r)))
  const dashA = atan(q.y, q.x).sub(spin.mul(t).mul(2.3))
  const dash = step(0.5, fract(dashA.div(Math.PI * 2).mul(24))).mul(ringAt(0.72, th.mul(0.012)))
  const spiralA = atan(q.y, q.x).add(spin.mul(t).mul(0.6))
  const spiral = pow(saturate(sin(spiralA.mul(3).add(r.mul(9)))), 6).mul(smoothstep(0.95, 0.2, r)).mul(smoothstep(0.05, 0.3, r)).mul(0.5)
  const handA = fract(atan(q.y, q.x).div(Math.PI * 2).add(t.mul(-0.07)).add(seed))
  const hand = smoothstep(0.03, 0.0, handA).add(smoothstep(0.97, 1.0, handA)).mul(step(r, 0.7)).mul(0.6).add(smoothstep(0.25, 0.0, handA).mul(step(r, 0.7)).mul(0.25))
  const s2 = ringAt(0.975, th.mul(0.014)).mul(1.3).add(tickM.mul(tickBand)).add(dash).add(spiral).add(hand).add(ringAt(0.4, th.mul(0.006)).mul(0.5))
  // --- style 3: frost patch (crystal cell edges, cooling with progress)
  const fq = q.mul(0.9).add(seed)
  const cellEdge = texture(noise, fq.mul(0.55)).b
  const fn = texture(noise, fq.mul(0.3)).r
  const patch = smoothstep(1.0, 0.35, r.add(fn.sub(0.5).mul(0.6)))
  const crystals = smoothstep(0.1, 0.0, cellEdge).mul(0.9).add(0.18)
  const s3 = patch.mul(crystals).mul(float(1).sub(progress))
  // --- style 4: cracked ground (cell edges glowing, hottest at the centre, cooling with progress)
  const cq = q.mul(1.25).add(seed)
  const ce = texture(noise, cq.mul(0.5)).b
  const ce2 = texture(noise, cq.mul(1.1).add(3.7)).b
  const crackMask = smoothstep(1.0, 0.2, r.add(texture(noise, cq.mul(0.2)).r.sub(0.5).mul(0.5))).mul(float(1).sub(progress))
  const s4 = smoothstep(0.06, 0.0, ce).add(smoothstep(0.04, 0.0, ce2).mul(0.5)).mul(crackMask).mul(1.5).add(smoothstep(0.45, 0.0, r).mul(float(1).sub(progress)).mul(float(1).sub(progress)).mul(0.6))
  // --- style 5: ripples running inward (spin > 0) / outward (spin < 0)
  const rip = pow(saturate(sin(r.mul(14).add(t.mul(spin)).add(seed))), 8)
  const s5 = rip.mul(smoothstep(1.0, 0.75, r)).mul(smoothstep(0.08, 0.3, r)).mul(0.55).add(ringAt(0.98, th.mul(0.01)).mul(0.5))
  // --- style 6: swap arrows chasing around the ring
  const sa = fract(atan(q.y, q.x).div(Math.PI * 2).sub(t.mul(spin).mul(0.16)).mul(2))
  const head = smoothstep(0.12, 0.0, abs(r.sub(0.86).sub(sa.sub(0.9).mul(-0.9)).mul(step(0.88, sa)))).mul(step(0.88, sa))
  const shaft = ringAt(0.86, th.mul(0.012)).mul(step(0.35, sa)).mul(step(sa, 0.9)).mul(smoothstep(0.35, 0.8, sa))
  const s6 = head.mul(step(0.78, r)).mul(step(r, 0.94)).add(shaft).add(ringAt(0.985, th.mul(0.008)).mul(0.6))

  const fill = saturate(float(1).sub(r)).mul(0.5).add(smoothstep(1.0, 0.88, r).mul(0.5)).mul(fillAmt)
  const shape = s0.mul(isS(0)).add(s1.mul(isS(1))).add(s2.mul(isS(2))).add(s3.mul(isS(3))).add(s4.mul(isS(4))).add(s5.mul(isS(5))).add(s6.mul(isS(6)))
  const edgeCut = smoothstep(1.0, 0.994, r)
  const m = new THREE.MeshBasicNodeMaterial()
  m.transparent = true
  m.depthWrite = false
  m.blending = THREE.AdditiveBlending
  m.colorNode = A0.xyz.mul(shape.add(fill)).mul(A0.w).mul(intro).mul(edgeCut)
  m.opacityNode = float(1)
  m.name = 'VfxB-Circles'
  return m
}

/** Dark soft disc. A0: x opacity, y softness (0 hard .. 1 soft), z noise amount, w seed. */
function shadowMaterial(ctx: VfxCtx, A: Node<'vec4'>[]): THREE.Material {
  const [A0] = A
  const q = positionGeometry.xy
  const r = length(q)
  const n = texture(ctx.world.noise, q.mul(0.4).add(A0.w)).r.sub(0.5).mul(A0.z)
  const a = smoothstep(1, float(1).sub(A0.y), r.add(n))
  const m = new THREE.MeshBasicNodeMaterial()
  m.transparent = true
  m.depthWrite = false
  m.blending = THREE.NormalBlending
  m.colorNode = vec3(0.004, 0.0, 0.01)
  m.opacityNode = saturate(a.mul(A0.x))
  m.name = 'VfxB-Shadows'
  return m
}

// ---------------------------------------------------------------- kit singleton

interface Kit {
  ctx: VfxCtx
  sprites: GlowSprites
  cores: InstPool
  circles: InstPool
  shadows: InstPool
  pools: Resettable[]
  lastNow: number
  /** fake floor lights used by workstream B this frame (the world shares GLOW_N = 12) */
  lights: number
}

let kit: Kit | null = null
let refs = 0
const flatQ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2)
const identQ = new THREE.Quaternion()

/** Call from every module's init(). */
export function kitInit(ctx: VfxCtx): Kit {
  refs++
  if (import.meta.env.DEV) (globalThis as Record<string, unknown>).__vfxBctx = ctx
  if (kit && kit.ctx.scene === ctx.scene) return kit
  if (kit) disposeKit()
  const sprites = new GlowSprites(ctx, 900)
  const cores = new InstPool(new THREE.IcosahedronGeometry(1, 3), 2, 96, (A) => coreMaterial(ctx, A), 10, 'vfxB-cores')
  const circles = new InstPool(new THREE.PlaneGeometry(2, 2), 3, 128, (A) => circleMaterial(ctx, A), 4, 'vfxB-circles')
  const shadows = new InstPool(new THREE.PlaneGeometry(2, 2), 1, 24, (A) => shadowMaterial(ctx, A), 3, 'vfxB-shadows')
  kit = { ctx, sprites, cores, circles, shadows, pools: [sprites, cores, circles, shadows], lastNow: -1, lights: 0 }
  for (const p of kit.pools) ctx.scene.add(p.object)
  return kit
}

/** Call from every module's dispose(). */
export function kitRelease(): void {
  refs = Math.max(0, refs - 1)
  if (refs === 0) disposeKit()
}

function disposeKit(): void {
  if (!kit) return
  for (const p of kit.pools) {
    p.object.removeFromParent()
    p.dispose()
  }
  kit = null
}

export function getKit(): Kit {
  if (!kit) throw new Error('vfxB kit used before kitInit')
  return kit
}

/** Register a module-owned pool so the kit resets and disposes it with the world. */
export function kitAdopt<T extends Resettable>(pool: T): T {
  const k = getKit()
  k.pools.push(pool)
  k.ctx.scene.add(pool.object)
  return pool
}

/** Reset every per-frame pool once per rendered frame (first module frame() wins). */
export function kitBegin(ctx: VfxCtx): Kit {
  const k = getKit()
  if (k.lastNow !== ctx.now) {
    k.lastNow = ctx.now
    k.lights = 0
    for (const p of k.pools) p.begin()
  }
  return k
}

// ---------------------------------------------------------------- drawing helpers

/** Hitbox core at a game position (radius = sim radius), colours linear HDR. */
export function drawCore(x: number, y: number, h: number, radius: number, edge: RGB, core: RGB, seed: number, dark = 0, sx = 1, sy = 1, sz = 1): void {
  const k = getKit()
  k.cores.quat.copy(identQ)
  const i = k.cores.add(x * S, h * S, -y * S, radius * S * sx, radius * S * sy, radius * S * sz)
  k.cores.set(i, 0, edge[0], edge[1], edge[2], seed)
  k.cores.set(i, 1, core[0], core[1], core[2], dark)
}

export const STYLE_RUNES = 0
export const STYLE_RING = 1
export const STYLE_CLOCK = 2
export const STYLE_FROST = 3
export const STYLE_CRACKS = 4
export const STYLE_RIPPLES = 5
export const STYLE_ARROWS = 6

/** Ground decal circle at a game position. */
export function drawCircle(
  x: number, y: number, h: number, radius: number, style: number,
  r: number, g: number, b: number, intensity: number,
  progress = 0, spin = 0, seed = 0, fill = 0, width = 1, runes = 24, born = -100,
): void {
  const k = getKit()
  k.circles.quat.copy(flatQ)
  const i = k.circles.add(x * S, h * S, -y * S, radius * S, radius * S, 1)
  k.circles.set(i, 0, r, g, b, intensity)
  k.circles.set(i, 1, progress, style, spin, seed)
  k.circles.set(i, 2, fill, width, runes, born)
}

/** Dark soft disc on the floor. */
export function drawShadow(x: number, y: number, h: number, radius: number, opacity: number, softness = 0.8, noise = 0.3, seed = 0): void {
  const k = getKit()
  k.shadows.quat.copy(flatQ)
  const i = k.shadows.add(x * S, h * S, -y * S, radius * S, radius * S, 1)
  k.shadows.set(i, 0, opacity, softness, noise, seed)
}

/** Max fake floor lights workstream B takes per frame (leaves the rest for the world). */
export const LIGHT_BUDGET = 6

/**
 * Projectile ground shadow through render's ctx.projectileShadow when it exists (height and
 * radius in game units); falls back to a soft dark disc of our own.
 */
export function projShadow(ctx: VfxCtx, x: number, y: number, h: number, radius: number): void {
  const fn = (ctx as VfxCtx & { projectileShadow?: (x: number, y: number, h: number, r: number) => void }).projectileShadow
  if (fn) {
    fn.call(ctx, x, y, h, radius)
    return
  }
  const fh = floorH(ctx, x, y)
  const lift = Math.max(0, h - fh)
  drawShadow(x, y, fh - 0.3, radius * (1.1 + lift / 260), Math.max(0.08, 0.5 - lift / 1400), 0.9, 0, 0)
}

/** Fake floor light (ctx.glow) within workstream B's per-frame budget; important = may exceed it by 2. */
export function light(ctx: VfxCtx, x: number, y: number, radius: number, intensity: number, c: RGB, k = 1, important = false): void {
  const kt = getKit()
  if (kt.lights >= LIGHT_BUDGET + (important ? 2 : 0)) return
  kt.lights++
  ctx.glow.add(x, y, radius, intensity, c[0] * k, c[1] * k, c[2] * k)
}

/** Glow sprite at a game position (size in game units). */
export function glowG(x: number, y: number, h: number, size: number, c: RGB, k = 1, falloff = 2, kind = 0, stretch = 1, rot = 0, heat = 0): void {
  getKit().sprites.addG(x, y, h, size, c[0] * k, c[1] * k, c[2] * k, falloff, kind, stretch, rot, heat)
}

/** Glow sprite at a three world position. */
export function glowW(v: THREE.Vector3, size: number, c: RGB, k = 1, falloff = 2, kind = 0, stretch = 1, rot = 0, heat = 0): void {
  getKit().sprites.add(v.x, v.y, v.z, size * S, c[0] * k, c[1] * k, c[2] * k, falloff, kind, stretch, rot, heat)
}

/** Radial particle burst (additive). */
export function burst(
  ctx: VfxCtx, x: number, y: number, h: number, n: number, sp0: number, sp1: number, life0: number, life1: number,
  size0: number, size1: number, c: RGB, k = 1, gravity = 0, drag = 2, sway = 0, up0 = 0, up1 = 0, spread = 0,
): void {
  const ps = ctx.particles
  const cnt = ps.budget(n)
  for (let i = 0; i < cnt; i++) {
    const a = Math.random() * TAU
    const sp = rand(sp0, sp1)
    const ox = spread ? Math.cos(a) * spread * Math.random() : 0
    const oy = spread ? Math.sin(a) * spread * Math.random() : 0
    ps.spawn(x + ox, y + oy, h, Math.cos(a) * sp, Math.sin(a) * sp, rand(up0, up1), rand(life0, life1), size0, size1, c[0] * k, c[1] * k, c[2] * k, gravity, drag, sway)
  }
}

/** Particles collapsing onto a point from a ring (anticipation / summon). */
export function implode(ctx: VfxCtx, x: number, y: number, h: number, n: number, r0: number, r1: number, life: number, size: number, c: RGB, k = 1, dh = 0): void {
  const ps = ctx.particles
  const cnt = ps.budget(n)
  for (let i = 0; i < cnt; i++) {
    const a = Math.random() * TAU
    const rr = rand(r0, r1)
    const hh = (Math.random() - 0.5) * dh
    ps.spawn(x + Math.cos(a) * rr, y + Math.sin(a) * rr, h + hh, (-Math.cos(a) * rr) / life, (-Math.sin(a) * rr) / life, -hh / life, life, size, size * 0.3, c[0] * k, c[1] * k, c[2] * k, 0, 0, 0)
  }
}

/** Standard cast flash at the caster's hand: flare, ring and sparks in the spell colour. */
export function castFlash(ctx: VfxCtx, pawnId: number, c: RGB, size = 1): THREE.Vector3 | null {
  const info = ctx.pawn(pawnId)
  if (!info) return null
  const o = originOf(info)
  const gx = o.x / S
  const gy = -o.z / S
  const gh = o.y / S
  ctx.flash(gx, gy, gh, 0.18, 180 * size, 110 * size, c[0], c[1], c[2])
  burst(ctx, gx, gy, gh, 14 * size, 120, 420, 0.18, 0.4, 9, 2, c, 1.1, -500, 2.5, -0.06, 40, 220)
  return o
}

/** Linear colour mix helper into a reusable triple. */
export function mixRgb(a: RGB, b: RGB, t: number, out: [number, number, number]): [number, number, number] {
  out[0] = a[0] + (b[0] - a[0]) * t
  out[1] = a[1] + (b[1] - a[1]) * t
  out[2] = a[2] + (b[2] - a[2]) * t
  return out
}

/** Interpolated position of a projectile id in prev/curr (fills out, returns false if absent). */
export function lerpProjectile(ctx: VfxCtx, id: number, out: { x: number; y: number }): boolean {
  const curr = ctx.state
  if (!curr) return false
  let c: { x: number; y: number } | null = null
  for (const p of curr.projectiles) if (p.id === id) c = p
  if (!c) return false
  out.x = c.x
  out.y = c.y
  if (ctx.prev) {
    for (const p of ctx.prev.projectiles) {
      if (p.id === id) {
        out.x = p.x + (c.x - p.x) * ctx.alpha
        out.y = p.y + (c.y - p.y) * ctx.alpha
        break
      }
    }
  }
  return true
}

export { flatQ, identQ }
