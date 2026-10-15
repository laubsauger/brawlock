/**
 * Look-dev kit for spell VFX workstream A (columns 1-3, Redirector, Pact).
 * Owned by workstream A; other workstreams should not depend on it.
 *
 * Immediate-mode primitives drawn by the spell modules every frame and
 * uploaded once per frame (lazy begin on the first draw, flush from the
 * onBeforeRender of any kit object, i.e. after every module ran):
 *   - Strips: camera-facing (or flat) ribbons with a hot core, noise-flicker
 *     and a team-tinted rim: trails, lightning bolts, tethers, guide arcs.
 *   - Glyphs: flat procedural decals (rune circles, spinning glaive, target
 *     reticle, vortex, refresh arrows, pact sigil, shock ring, bow shock,
 *     convergence mark, soft disc). Two layers: ground and air.
 *   - Cores: hitbox-sized hot projectile cores (sphere or teardrop oriented
 *     along velocity), drawn last so the collision core reads on top.
 *   - own Billboards (halos, streaks, afterimages).
 *   - Trails: per-projectile point history that keeps fading after the
 *     projectile dies (dissipation), drawn into the strips at flush.
 * Plus damage-event attribution (which of our spells caused a 'damage'
 * event, so the module can claim it and draw its own kb-scaled impact).
 *
 * Nothing here allocates per frame: fixed typed arrays and pooled records.
 */
import * as THREE from 'three/webgpu'
import {
  Fn,
  If,
  abs,
  atan,
  attribute,
  cameraPosition,
  cos,
  dot,
  exp,
  float,
  floor,
  fract,
  instancedBufferAttribute,
  length,
  log,
  max,
  min,
  mix,
  normalize,
  positionGeometry,
  positionWorld,
  pow,
  saturate,
  sin,
  smoothstep,
  step,
  texture,
  uniform,
  uv,
  varying,
  vec2,
  vec3,
} from 'three/tsl'
import type { Node } from 'three/webgpu'
import type { ProjectileState, SimEvent, SimState } from '../../../sim/types'
import { LAVA_H, PROJECTILE_H, S, TILE_TOP_H } from '../../coords'
import { Billboards } from '../../scene/Billboards'
import { RING_EXPAND } from '../../scene/GroundFx'
import { asV4 } from '../../scene/world'
import { getSpellColor, mixRGB, withLuminance, type RGB3 } from '../palette'
import type { PawnRenderInfo, VfxCtx } from '../registry'

export type RGB = readonly [number, number, number]

/** Spell palette, linear HDR. hot = white-hot core, body = identity hue, edge = rim, tail = cooled end. */
export interface Pal {
  hot: RGB
  body: RGB
  edge: RGB
  tail: RGB
  light: RGB
  spark: RGB
}

const palCache = new Map<string, Pal>()

/**
 * Kit palette for a spell id, derived from the shared identity palette
 * (vfx/palette.ts, colorblind-tuned): hot = the near-white core, body / edge /
 * tail / light = the identity ACCENT at falling luminance, spark = core-accent mix.
 * Cached, one allocation per id.
 */
export function palFor(id: string): Pal {
  let p = palCache.get(id)
  if (p) return p
  const c = getSpellColor(id)
  const core: RGB3 = [c.core.r, c.core.g, c.core.b]
  const acc: RGB3 = [c.accent.r, c.accent.g, c.accent.b]
  const L = (rgb: readonly number[], l: number) => withLuminance(rgb, l, [0, 0, 0])
  p = {
    hot: L(core, 2.3),
    body: L(acc, 1.0),
    edge: L(acc, 0.42),
    tail: L(acc, 0.1),
    light: L(acc, 0.5),
    spark: L(mixRGB(core, acc, 0.45, [0, 0, 0]), 2.8),
  }
  palCache.set(id, p)
  return p
}

/** the same hues, darker and hotter-cored (Homing burnout, Pact slow ...) */
export function palShade(base: Pal, k: number): Pal {
  const m = (c: RGB): RGB => [c[0] * k, c[1] * k, c[2] * k]
  return { hot: base.hot, body: m(base.body), edge: m(base.edge), tail: m(base.tail), light: m(base.light), spark: base.spark }
}

/** trail colours from a palette: white-hot head, identity body, cooled tail */
export function trailFrom(P: Pal, s: Omit<TrailStyle, 'head' | 'mid' | 'tail'>, hotMix = 0.5): TrailStyle {
  const head: RGB = [P.hot[0] * hotMix + P.body[0] * (1 - hotMix) * 1.4, P.hot[1] * hotMix + P.body[1] * (1 - hotMix) * 1.4, P.hot[2] * hotMix + P.body[2] * (1 - hotMix) * 1.4]
  return { ...s, head, mid: P.body, tail: P.tail }
}

/** glyph types (Glyphs.add `type`) */
export const G_RUNE = 0
export const G_BLADE = 1
export const G_RETICLE = 2
export const G_SWIRL = 3
export const G_REFRESH = 4
export const G_SIGIL = 5
export const G_SHOCK = 6
export const G_BOW = 7
export const G_CROSS = 8
export const G_DISC = 9

const TAU = Math.PI * 2

/** spells drawn by workstream A (damage attribution) */
const OUR_SPELLS: ReadonlySet<string> = new Set(['boomerang', 'lightning', 'homing', 'twin', 'thrust', 'cluster', 'drain', 'bouncer', 'recharge'])

// ---------------------------------------------------------------------------
// Strips
// ---------------------------------------------------------------------------

/** set a single upload range, reusing the range object (no per-frame allocation) */
function uploadRange(a: THREE.BufferAttribute, start: number, count: number): void {
  const r = a.updateRanges
  if (r.length === 1) {
    r[0].start = start
    r[0].count = count
  } else {
    a.clearUpdateRanges()
    a.addUpdateRange(start, count)
  }
  a.needsUpdate = true
}

const STRIP_MAXP = 512

class Strips {
  readonly mesh: THREE.Mesh
  private geo: THREE.BufferGeometry
  private material: THREE.MeshBasicNodeMaterial
  private aPos: THREE.BufferAttribute
  private aCol: THREE.BufferAttribute
  private aAux: THREE.BufferAttribute
  private aEdge: THREE.BufferAttribute
  private aIdx: THREE.BufferAttribute
  private readonly cap: number
  private nv = 0
  private ni = 0
  // scratch for the strip being built
  private px = new Float32Array(STRIP_MAXP)
  private py = new Float32Array(STRIP_MAXP)
  private pz = new Float32Array(STRIP_MAXP)
  private pw = new Float32Array(STRIP_MAXP)
  private pc = new Float32Array(STRIP_MAXP * 4)
  private pe = new Float32Array(STRIP_MAXP * 4)
  private sn = 0
  private sFlat = false
  private sFall = 2
  private sNoise = 0
  private sU0 = 0

  constructor(ctx: VfxCtx, cap: number) {
    this.cap = cap
    const g = new THREE.BufferGeometry()
    const mk = (n: number) => {
      const a = new THREE.BufferAttribute(new Float32Array(cap * n), n)
      a.setUsage(THREE.DynamicDrawUsage)
      return a
    }
    this.aPos = mk(3)
    this.aCol = mk(4)
    this.aAux = mk(4)
    this.aEdge = mk(4)
    g.setAttribute('position', this.aPos)
    g.setAttribute('sCol', this.aCol)
    g.setAttribute('sAux', this.aAux)
    g.setAttribute('sEdge', this.aEdge)
    this.aIdx = new THREE.BufferAttribute(new Uint16Array(cap * 3), 1)
    this.aIdx.setUsage(THREE.DynamicDrawUsage)
    g.setIndex(this.aIdx)
    g.setDrawRange(0, 0)
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5)
    this.geo = g

    const C = asV4(attribute('sCol', 'vec4'))
    const A = asV4(attribute('sAux', 'vec4'))
    const E = asV4(attribute('sEdge', 'vec4'))
    const d = abs(A.x)
    const inv = saturate(float(1).sub(d))
    const body = pow(inv, A.z)
    const core = pow(inv, A.z.mul(5).add(2))
    const n = texture(ctx.world.noise, vec2(A.y.mul(0.9).sub(ctx.world.uTime.mul(1.6)), A.x.mul(0.18).add(A.y.mul(0.07)))).r
    const nm = mix(float(1), smoothstep(0.3, 0.7, n).mul(2.1), A.w)
    const base = mix(C.rgb, E.rgb, smoothstep(0.2, 0.95, d).mul(E.w))
    const m = new THREE.MeshBasicNodeMaterial()
    m.transparent = true
    m.depthWrite = false
    m.blending = THREE.AdditiveBlending
    m.side = THREE.DoubleSide
    m.colorNode = base.mul(body.add(core.mul(1.3))).mul(nm).mul(C.a)
    m.opacityNode = float(1)
    m.name = 'KitA-Strips'
    this.material = m
    this.mesh = new THREE.Mesh(g, m)
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = 6
    this.mesh.name = 'vfxA-strips'
  }

  reset(): void {
    this.nv = 0
    this.ni = 0
  }

  /** Start a strip. flat = lies in the ground plane (else faces the camera). */
  begin(flat: boolean, falloff = 1.6, noise = 0, u0 = 0): void {
    this.sn = 0
    this.sFlat = flat
    this.sFall = falloff
    this.sNoise = noise
    this.sU0 = u0
  }

  /** Strip point: three world position, full width (three units), HDR colour x intensity, optional rim colour. */
  point(x: number, y: number, z: number, w: number, r: number, g: number, b: number, a: number, er = 0, eg = 0, eb = 0, edge = 0): void {
    const i = this.sn
    if (i >= STRIP_MAXP) return
    this.px[i] = x
    this.py[i] = y
    this.pz[i] = z
    this.pw[i] = w
    const o = i * 4
    this.pc[o] = r
    this.pc[o + 1] = g
    this.pc[o + 2] = b
    this.pc[o + 3] = a
    this.pe[o] = er
    this.pe[o + 1] = eg
    this.pe[o + 2] = eb
    this.pe[o + 3] = edge
    this.sn++
  }

  end(cam: THREE.Vector3): void {
    const n = this.sn
    this.sn = 0
    if (n < 2 || this.nv + n * 2 > this.cap || this.ni + (n - 1) * 6 > this.cap * 3) return
    const P = this.aPos.array as Float32Array
    const Cc = this.aCol.array as Float32Array
    const Ax = this.aAux.array as Float32Array
    const Ed = this.aEdge.array as Float32Array
    const I = this.aIdx.array as Uint16Array
    const base = this.nv
    let u = this.sU0
    let lsx = 1
    let lsy = 0
    let lsz = 0
    for (let i = 0; i < n; i++) {
      const i0 = i > 0 ? i - 1 : 0
      const i1 = i < n - 1 ? i + 1 : n - 1
      const tx = this.px[i1] - this.px[i0]
      const ty = this.py[i1] - this.py[i0]
      const tz = this.pz[i1] - this.pz[i0]
      let sx: number
      let sy: number
      let sz: number
      if (this.sFlat) {
        sx = -tz
        sy = 0
        sz = tx
      } else {
        const vx = cam.x - this.px[i]
        const vy = cam.y - this.py[i]
        const vz = cam.z - this.pz[i]
        sx = ty * vz - tz * vy
        sy = tz * vx - tx * vz
        sz = tx * vy - ty * vx
      }
      const l = Math.sqrt(sx * sx + sy * sy + sz * sz)
      if (l > 1e-9) {
        sx /= l
        sy /= l
        sz /= l
        lsx = sx
        lsy = sy
        lsz = sz
      } else {
        sx = lsx
        sy = lsy
        sz = lsz
      }
      if (i > 0) {
        const dx = this.px[i] - this.px[i - 1]
        const dy = this.py[i] - this.py[i - 1]
        const dz = this.pz[i] - this.pz[i - 1]
        u += Math.sqrt(dx * dx + dy * dy + dz * dz)
      }
      const hw = this.pw[i] * 0.5
      const v0 = base + i * 2
      const p0 = v0 * 3
      P[p0] = this.px[i] + sx * hw
      P[p0 + 1] = this.py[i] + sy * hw
      P[p0 + 2] = this.pz[i] + sz * hw
      P[p0 + 3] = this.px[i] - sx * hw
      P[p0 + 4] = this.py[i] - sy * hw
      P[p0 + 5] = this.pz[i] - sz * hw
      const c0 = v0 * 4
      const o = i * 4
      for (let k = 0; k < 4; k++) {
        Cc[c0 + k] = this.pc[o + k]
        Cc[c0 + 4 + k] = this.pc[o + k]
        Ed[c0 + k] = this.pe[o + k]
        Ed[c0 + 4 + k] = this.pe[o + k]
      }
      Ax[c0] = 1
      Ax[c0 + 1] = u
      Ax[c0 + 2] = this.sFall
      Ax[c0 + 3] = this.sNoise
      Ax[c0 + 4] = -1
      Ax[c0 + 5] = u
      Ax[c0 + 6] = this.sFall
      Ax[c0 + 7] = this.sNoise
    }
    let ii = this.ni
    for (let i = 0; i < n - 1; i++) {
      const a = base + i * 2
      I[ii++] = a
      I[ii++] = a + 1
      I[ii++] = a + 2
      I[ii++] = a + 1
      I[ii++] = a + 3
      I[ii++] = a + 2
    }
    this.ni = ii
    this.nv = base + n * 2
  }

  commit(): void {
    this.geo.setDrawRange(0, this.ni)
    if (this.nv === 0) return
    uploadRange(this.aPos, 0, this.nv * 3)
    uploadRange(this.aCol, 0, this.nv * 4)
    uploadRange(this.aAux, 0, this.nv * 4)
    uploadRange(this.aEdge, 0, this.nv * 4)
    uploadRange(this.aIdx, 0, this.ni)
  }

  dispose(): void {
    this.geo.dispose()
    this.material.dispose()
  }
}

// ---------------------------------------------------------------------------
// Glyphs
// ---------------------------------------------------------------------------

class Glyphs {
  readonly mesh: THREE.Mesh
  private material: THREE.MeshBasicNodeMaterial
  private g0: THREE.InstancedBufferAttribute
  private g1: THREE.InstancedBufferAttribute
  private g2: THREE.InstancedBufferAttribute
  private n = 0

  constructor(
    ctx: VfxCtx,
    private readonly cap: number,
    renderOrder: number,
  ) {
    const mk = () => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4)
      a.setUsage(THREE.DynamicDrawUsage)
      return a
    }
    this.g0 = mk()
    this.g1 = mk()
    this.g2 = mk()
    const G0 = asV4(instancedBufferAttribute(this.g0))
    const G1 = asV4(instancedBufferAttribute(this.g1))
    const G2 = asV4(instancedBufferAttribute(this.g2))
    const geo = new THREE.PlaneGeometry(2, 2)
    const qv = positionGeometry.xy
    const cr = cos(G2.y)
    const sr = sin(G2.y)
    const rx = qv.x.mul(cr).sub(qv.y.mul(sr))
    const ry = qv.x.mul(sr).add(qv.y.mul(cr))
    const positionNode = G0.xyz.add(vec3(rx, 0, ry.negate()).mul(G0.w))

    const T = varying(G2.x)
    const P1 = varying(G2.z)
    const P2 = varying(G2.w)
    // local quad coords -1..1 (PlaneGeometry uv), same frame as positionGeometry.xy
    const q = uv().mul(2).sub(1)
    const t = ctx.world.uTime
    const noise = ctx.world.noise
    const sq = (x: Node<'float'>) => x.mul(x)
    const band = (r: Node<'float'>, c: number | Node<'float'>, w: number | Node<'float'>) => exp(sq(r.sub(c).div(w)).negate())
    const hash1 = (x: Node<'float'>) => fract(sin(x.mul(12.9898)).mul(43758.5453))

    const shape = Fn(() => {
      // shared by every branch: materialize in the outer scope (TSL would otherwise emit them
      // inside the first branch that uses them, leaving the others reading zeros)
      const r = length(q).toVar()
      const a = atan(q.y, q.x).toVar()
      const body = float(0).toVar()
      const hot = float(0).toVar()
      If(T.lessThan(0.5), () => {
        // RUNE circle: two rings, blocky rune marks between them, progress arc (p1), seed p2
        const an = a.div(TAU).add(0.5)
        const cell = floor(an.mul(18))
        const f = fract(an.mul(18))
        const hv = hash1(cell.add(P2.mul(7.31)))
        const runeBand = step(0.745, r).mul(step(r, 0.875))
        const glyph = step(abs(f.sub(0.5)), hv.mul(0.2).add(0.14)).mul(step(0.3, hv)).mul(runeBand).mul(step(0.35, fract(r.mul(9).add(hv.mul(3)))).mul(0.5).add(0.5))
        const pa = fract(float(0.25).sub(a.div(TAU)))
        const fill = step(pa, P1)
        const ring1 = band(r, 0.93, 0.03)
        const ring2 = band(r, 0.7, 0.022).mul(0.8)
        body.assign(ring1.add(ring2).add(glyph.mul(0.9)).mul(fill.mul(0.65).add(0.35)).add(exp(sq(r.div(0.3)).negate()).mul(0.12)))
        hot.assign(ring1.mul(fill).mul(0.6).add(glyph.mul(fill).mul(0.3)))
      })
        .ElseIf(T.lessThan(1.5), () => {
          // BLADE: spinning glaive, p1 = motion blur 0..1, p2 = blade count
          const ph = a.sub(r.mul(2.3))
          const u = fract(ph.div(TAU).mul(P2))
          const du = u.sub(0.5)
          const w = pow(saturate(float(1).sub(r)), float(0.7)).mul(0.24).add(0.02)
          const lead = max(du, 0)
          const trail = max(du.negate(), 0)
          const mask = smoothstep(w, w.mul(0.62), lead).mul(smoothstep(w.add(P1.mul(0.3)), w.mul(0.4), trail))
          const radial = smoothstep(1.0, 0.88, r).mul(smoothstep(0.1, 0.2, r))
          const edge = exp(sq(lead.sub(w.mul(0.72)).div(0.035)).negate()).mul(step(0.0, du))
          const hub = band(r, 0.2, 0.045)
          const gem = exp(sq(r.div(0.11)).negate())
          body.assign(mask.mul(radial).mul(float(1.15).sub(r.mul(0.5))).add(hub.mul(0.9)))
          hot.assign(edge.mul(mask).mul(radial).mul(1.4).add(gem.mul(1.5)).add(hub.mul(0.4)))
        })
        .ElseIf(T.lessThan(2.5), () => {
          // RETICLE: target lock, p1 = lock pulse
          const g = abs(fract(a.div(Math.PI / 2).add(0.5)).sub(0.5))
          const ring = band(r, 0.82, 0.035).mul(step(0.11, g))
          const ticks = step(g, 0.035).mul(step(0.52, r)).mul(step(r, 0.97))
          const inner = band(r, 0.44, 0.02).mul(0.45)
          const dotc = exp(sq(r.div(0.07)).negate())
          body.assign(ring.add(ticks.mul(1.2)).add(inner).add(dotc))
          hot.assign(ticks.add(dotc).mul(P1))
        })
        .ElseIf(T.lessThan(3.5), () => {
          // SWIRL vortex: p1 = twist, p2 = arms
          const s = sin(a.mul(P2).add(log(r.add(0.03)).mul(P1)))
          const spiral = pow(saturate(s.mul(0.5).add(0.5)), float(4))
          const fade = smoothstep(1.0, 0.35, r).mul(smoothstep(0.0, 0.12, r))
          const core = exp(sq(r.div(0.2)).negate())
          body.assign(spiral.mul(fade).add(core.mul(0.6)))
          hot.assign(core.add(spiral.mul(fade).mul(smoothstep(0.65, 0.2, r)).mul(0.6)))
        })
        .ElseIf(T.lessThan(4.5), () => {
          // REFRESH: arrows chasing around a ring, p1 = arrow count, p2 = thickness scale
          const sN = fract(a.div(TAU).add(0.5).mul(P1))
          const hw = P2.mul(0.085)
          const dr = abs(r.sub(0.78))
          const arc = smoothstep(0.06, 0.3, sN).mul(step(sN, 0.74)).mul(smoothstep(hw, hw.mul(0.55), dr))
          const k = saturate(sN.sub(0.74).div(0.2))
          const headW = hw.mul(2.4).mul(float(1).sub(k))
          const head = step(0.74, sN).mul(step(sN, 0.94)).mul(smoothstep(headW, headW.mul(0.7), dr))
          body.assign(arc.add(head))
          hot.assign(head.mul(0.8).add(arc.mul(smoothstep(0.35, 0.74, sN)).mul(0.5)))
        })
        .ElseIf(T.lessThan(5.5), () => {
          // SIGIL: pentagram in a double ring with runes; p1 = shatter 0..1, p2 = seed
          const ring1 = band(r, 0.93, 0.028)
          const ring2 = band(r, 0.8, 0.02)
          const lines = float(0).toVar()
          for (let k = 0; k < 5; k++) {
            const ang = Math.PI / 2 + (TAU / 5) * k + Math.PI / 5
            const d = dot(q, vec2(Math.cos(ang), Math.sin(ang))).sub(0.8 * 0.309)
            lines.assign(max(lines, exp(sq(d.div(0.024)).negate())))
          }
          const star = lines.mul(step(r, 0.8))
          const an = a.div(TAU).add(0.5)
          const cell = floor(an.mul(24))
          const hv = hash1(cell.add(P2))
          const runes = step(abs(fract(an.mul(24)).sub(0.5)), 0.22).mul(step(0.35, hv)).mul(step(0.83, r)).mul(step(r, 0.9))
          const crack = texture(noise, q.mul(0.35).add(P2.mul(0.13))).b
          const keep = float(1).sub(smoothstep(P1.sub(0.15), P1, float(1).sub(crack).mul(1.1)))
          const shard = mix(float(1), keep, step(0.001, P1))
          body.assign(ring1.add(ring2.mul(0.8)).add(star).add(runes.mul(0.7)).mul(shard))
          hot.assign(star.mul(0.5).add(ring1.mul(0.4)).mul(shard))
        })
        .ElseIf(T.lessThan(6.5), () => {
          // SHOCK ring: p1 = radius fraction, p2 = thickness
          const wob = texture(noise, vec2(a.div(TAU).mul(3), P1.mul(0.7))).r.sub(0.5).mul(0.08)
          const x = r.add(wob).sub(P1).div(P2)
          const ring = exp(sq(x).negate())
          const fill = smoothstep(P1, 0, r).mul(0.18).mul(float(1).sub(P1))
          body.assign(ring.add(fill).mul(smoothstep(1.0, 0.92, r)))
          hot.assign(pow(ring, float(3)).mul(0.7))
        })
        .ElseIf(T.lessThan(7.5), () => {
          // BOW shock: crescent ahead (+x), speed lines behind; p1 = streak phase, p2 = arc tightness
          const c = q.sub(vec2(-0.55, 0))
          const rr = length(c)
          const ang = atan(c.y, c.x)
          const arc = exp(sq(rr.sub(1.32).div(P2.mul(0.1).add(0.06))).negate()).mul(smoothstep(1.15, 0.2, abs(ang)))
          const lane = fract(q.y.mul(4.5).add(0.5))
          const lines = step(abs(lane.sub(0.5)), 0.06).mul(smoothstep(0.9, 0.2, abs(q.y))).mul(smoothstep(-1.0, 0.4, q.x)).mul(step(q.x, 0.55))
          const flick = texture(noise, vec2(q.x.mul(0.6).add(P1), q.y.mul(0.4))).r
          body.assign(arc.add(lines.mul(flick).mul(0.7)))
          hot.assign(arc.mul(arc).mul(0.9))
        })
        .ElseIf(T.lessThan(8.5), () => {
          // CROSS: convergence mark; p1 = pulse
          const d1 = abs(q.x.sub(q.y)).mul(0.7071)
          const d2 = abs(q.x.add(q.y)).mul(0.7071)
          const bar = exp(sq(min(d1, d2).div(0.055)).negate()).mul(smoothstep(0.85, 0.55, r)).mul(step(0.16, r))
          const ring = band(r, 0.9, 0.04).mul(0.55)
          body.assign(bar.add(ring))
          hot.assign(bar.mul(P1))
        })
        .Else(() => {
          // DISC: soft round glow; p1 = falloff exponent
          body.assign(pow(saturate(float(1).sub(r)), max(P1, 0.3)))
        })
      return vec2(body, hot)
    })()
    const res = shape as unknown as Node<'vec2'>
    const tint = G1.rgb
    const hotTint = tint.mul(0.35).add(vec3(1.15, 1.0, 0.85))
    void t
    const m = new THREE.MeshBasicNodeMaterial()
    m.transparent = true
    m.depthWrite = false
    m.blending = THREE.AdditiveBlending
    m.side = THREE.DoubleSide
    m.positionNode = positionNode
    m.colorNode = tint.mul(res.x).add(hotTint.mul(res.y)).mul(G1.w)
    m.opacityNode = float(1)
    m.name = 'KitA-Glyphs'
    this.material = m
    this.mesh = new THREE.Mesh(geo, m)
    this.mesh.count = 0
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = renderOrder
    this.mesh.name = 'vfxA-glyphs'
  }

  reset(): void {
    this.n = 0
  }

  /**
   * Flat glyph at game (x, y), height h (game units), radius (game units),
   * rotation (radians, game space CCW), HDR colour x intensity, two params.
   */
  add(type: number, x: number, y: number, h: number, radius: number, rot: number, r: number, g: number, b: number, a: number, p1 = 0, p2 = 0): void {
    if (this.n >= this.cap || a <= 0.001) return
    const o = this.n * 4
    const A0 = this.g0.array as Float32Array
    const A1 = this.g1.array as Float32Array
    const A2 = this.g2.array as Float32Array
    A0[o] = x * S
    A0[o + 1] = h * S
    A0[o + 2] = -y * S
    A0[o + 3] = radius * S
    A1[o] = r
    A1[o + 1] = g
    A1[o + 2] = b
    A1[o + 3] = a
    A2[o] = type
    A2[o + 1] = rot
    A2[o + 2] = p1
    A2[o + 3] = p2
    this.n++
  }

  commit(): void {
    this.mesh.count = this.n
    if (this.n === 0) return
    uploadRange(this.g0, 0, this.n * 4)
    uploadRange(this.g1, 0, this.n * 4)
    uploadRange(this.g2, 0, this.n * 4)
  }

  dispose(): void {
    this.mesh.geometry.dispose()
    this.material.dispose()
  }
}

// ---------------------------------------------------------------------------
// Cores
// ---------------------------------------------------------------------------

class Cores {
  readonly mesh: THREE.Mesh
  private material: THREE.MeshBasicNodeMaterial
  private attrs: THREE.InstancedBufferAttribute[]
  private n = 0

  constructor(
    ctx: VfxCtx,
    private readonly cap: number,
  ) {
    const mk = () => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4)
      a.setUsage(THREE.DynamicDrawUsage)
      return a
    }
    this.attrs = [mk(), mk(), mk(), mk(), mk()]
    const [C0, C1, C2, C3, C4] = this.attrs.map((a) => asV4(instancedBufferAttribute(a)))
    const P = positionGeometry
    const tail = C1.z
    const back = max(P.x.negate(), 0)
    const sx = float(1).add(tail.mul(step(P.x, 0)))
    const taper = float(1).sub(back.mul(tail.div(tail.add(1))).mul(0.6))
    const f = vec3(C1.x, 0, C1.y)
    const sd = vec3(C1.y.negate(), 0, C1.x)
    const up = vec3(0, 1, 0)
    const lx = P.x.mul(sx)
    const local = f.mul(lx).add(up.mul(P.y.mul(taper))).add(sd.mul(P.z.mul(taper)))
    const m = new THREE.MeshBasicNodeMaterial()
    m.positionNode = C0.xyz.add(local.mul(C0.w))
    const nW = varying(normalize(f.mul(P.x.div(sx)).add(up.mul(P.y)).add(sd.mul(P.z))))
    const vX = varying(P.x)
    const viewDir = normalize(cameraPosition.sub(positionWorld))
    const ndv = saturate(dot(normalize(nW), viewDir))
    const flick = sin(ctx.world.uTime.mul(37).add(C1.w.mul(11))).mul(0.07).add(1)
    const rim = C2.rgb.mul(1.7)
    const mid = C3.rgb
    const core = C4.rgb
    let col = mix(mix(rim, mid, smoothstep(0.05, 0.5, ndv)), core, smoothstep(0.6, 0.95, ndv))
    // teardrops cool toward the pointed tail
    const cool = smoothstep(0.15, -0.95, vX).mul(min(tail, 1))
    col = mix(col, rim.mul(0.8), cool.mul(0.7))
    m.colorNode = col.mul(flick).mul(C2.w)
    m.transparent = true
    m.depthWrite = true
    m.name = 'KitA-Cores'
    this.material = m
    const geo = new THREE.IcosahedronGeometry(1, 3)
    this.mesh = new THREE.Mesh(geo, m)
    this.mesh.count = 0
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = 10
    this.mesh.name = 'vfxA-cores'
  }

  reset(): void {
    this.n = 0
  }

  /**
   * Core at game (x, y, h), radius in game units. (dx, dy) = game-space
   * heading (unit), tail = teardrop stretch (0 = sphere). Colours HDR.
   */
  add(x: number, y: number, h: number, radius: number, dx: number, dy: number, tail: number, seed: number, edge: RGB, mid: RGB, core: RGB, intensity = 1): void {
    if (this.n >= this.cap) return
    const o = this.n * 4
    const [A0, A1, A2, A3, A4] = this.attrs
    const a0 = A0.array as Float32Array
    const a1 = A1.array as Float32Array
    const a2 = A2.array as Float32Array
    const a3 = A3.array as Float32Array
    const a4 = A4.array as Float32Array
    a0[o] = x * S
    a0[o + 1] = h * S
    a0[o + 2] = -y * S
    a0[o + 3] = radius * S
    // game (dx, dy) -> three (dx, -dy) on the XZ plane
    a1[o] = dx
    a1[o + 1] = -dy
    a1[o + 2] = tail
    a1[o + 3] = seed % 7
    a2[o] = edge[0]
    a2[o + 1] = edge[1]
    a2[o + 2] = edge[2]
    a2[o + 3] = intensity
    a3[o] = mid[0]
    a3[o + 1] = mid[1]
    a3[o + 2] = mid[2]
    a4[o] = core[0]
    a4[o + 1] = core[1]
    a4[o + 2] = core[2]
    this.n++
  }

  commit(): void {
    this.mesh.count = this.n
    if (this.n === 0) return
    for (let i = 0; i < this.attrs.length; i++) uploadRange(this.attrs[i], 0, this.n * 4)
  }

  dispose(): void {
    this.mesh.geometry.dispose()
    this.material.dispose()
  }
}

// ---------------------------------------------------------------------------
// Floating text (Recharge streak numbers)
// ---------------------------------------------------------------------------

interface Label {
  sprite: THREE.Sprite
  canvas: HTMLCanvasElement
  tex: THREE.CanvasTexture
  alpha: ReturnType<typeof uniform>
  born: number
  life: number
  x: number
  y: number
  h: number
  text: string
}

class Labels {
  readonly group = new THREE.Group()
  private pool: Label[] = []
  private next = 0

  constructor(count: number) {
    for (let i = 0; i < count; i++) {
      const canvas = document.createElement('canvas')
      canvas.width = 256
      canvas.height = 128
      const tex = new THREE.CanvasTexture(canvas)
      tex.colorSpace = THREE.SRGBColorSpace
      const alpha = uniform(0)
      const m = new THREE.SpriteNodeMaterial()
      m.transparent = true
      m.depthWrite = false
      m.depthTest = false
      const tx = texture(tex)
      m.colorNode = tx.rgb.mul(1.6)
      m.opacityNode = tx.a.mul(alpha)
      const sprite = new THREE.Sprite(m)
      sprite.renderOrder = 30
      sprite.visible = false
      sprite.frustumCulled = false
      this.group.add(sprite)
      this.pool.push({ sprite, canvas, tex, alpha, born: -10, life: 1, x: 0, y: 0, h: 0, text: '' })
    }
  }

  /** Pop a text label at a game position (rises and fades). */
  show(text: string, color: string, glow: string, x: number, y: number, h: number, now: number, life = 1.3): void {
    const l = this.pool[this.next]
    this.next = (this.next + 1) % this.pool.length
    l.born = now
    l.life = life
    l.x = x
    l.y = y
    l.h = h
    if (l.text !== text + color) {
      l.text = text + color
      const g = l.canvas.getContext('2d')
      if (g) {
        g.clearRect(0, 0, 256, 128)
        g.font = '900 72px system-ui, -apple-system, Segoe UI, sans-serif'
        g.textAlign = 'center'
        g.textBaseline = 'middle'
        g.lineJoin = 'round'
        g.shadowColor = glow
        g.shadowBlur = 18
        g.lineWidth = 10
        g.strokeStyle = 'rgba(20,4,30,0.9)'
        g.strokeText(text, 128, 66)
        g.fillStyle = color
        g.fillText(text, 128, 66)
        g.shadowBlur = 0
        g.fillStyle = 'rgba(255,255,255,0.35)'
        g.fillText(text, 128, 62)
      }
      l.tex.needsUpdate = true
    }
  }

  update(now: number): void {
    for (const l of this.pool) {
      const k = (now - l.born) / l.life
      if (k < 0 || k >= 1) {
        l.sprite.visible = false
        continue
      }
      // pop in with a little overshoot, drift up, fade
      const pop = k < 0.12 ? 0.6 + (k / 0.12) * 0.55 : k < 0.22 ? 1.15 - ((k - 0.12) / 0.1) * 0.15 : 1
      const s = 1.15 * pop
      l.sprite.visible = true
      l.sprite.position.set(l.x * S, (l.h + k * 70) * S, -l.y * S)
      l.sprite.scale.set(s, s * 0.5, 1)
      l.alpha.value = k < 0.7 ? 1 : 1 - (k - 0.7) / 0.3
    }
  }

  dispose(): void {
    for (const l of this.pool) {
      l.tex.dispose()
      ;(l.sprite.material as THREE.Material).dispose()
    }
  }
}

// ---------------------------------------------------------------------------
// Trails
// ---------------------------------------------------------------------------

export interface TrailStyle {
  /** seconds a point lives */
  life: number
  /** width at the head, game units */
  width: number
  /** width multiplier at the oldest point */
  widthTail: number
  /** colours along the trail: head -> mid (at 30%) -> tail */
  head: RGB
  mid: RGB
  tail: RGB
  /** overall intensity */
  intensity: number
  /** cross-section falloff exponent (higher = thinner bright line) */
  falloff: number
  /** noise flicker 0..1 (flame break-up) */
  noise: number
  /** min spacing between stored points, game units */
  spacing: number
  /** team-colour rim mix 0..1 */
  rim: number
  /** lie flat on the ground plane instead of facing the camera */
  flat?: boolean
  /** rim colour instead of the owner's team colour */
  rimRGB?: RGB
}

const TRAIL_MAXP = 64

class Trail {
  key = -1
  n = 0
  start = 0
  readonly x = new Float32Array(TRAIL_MAXP)
  readonly y = new Float32Array(TRAIL_MAXP)
  readonly h = new Float32Array(TRAIL_MAXP)
  readonly t = new Float32Array(TRAIL_MAXP)
  style: TrailStyle | null = null
  /** head position this frame (live projectile) */
  hx = 0
  hy = 0
  hh = 0
  live = false
  stamp = 0
  rimR = 1
  rimG = 1
  rimB = 1
  /** fade multiplier (diminishing Bouncer etc.) */
  gain = 1
}

// ---------------------------------------------------------------------------
// Timed glyphs
// ---------------------------------------------------------------------------

interface Pulse {
  type: number
  air: boolean
  x: number
  y: number
  h: number
  r0: number
  r1: number
  born: number
  life: number
  rot: number
  spin: number
  r: number
  g: number
  b: number
  a: number
  p1a: number
  p1b: number
  p2: number
  hold: boolean
}

// ---------------------------------------------------------------------------
// Damage attribution
// ---------------------------------------------------------------------------

interface Tracked {
  id: number
  owner: number
  spell: string
  kind: string
  x: number
  y: number
  r: number
  sp: number
}

export interface Expect {
  spell: string
  owner: number
  /** pawn entity expected to take the hit (-1 = any within radius) */
  target: number
  x: number
  y: number
  radius: number
  until: number
  data: number
}

// ---------------------------------------------------------------------------
// Kit
// ---------------------------------------------------------------------------

export class KitA {
  readonly scene: THREE.Group
  readonly strips: Strips
  readonly ground: Glyphs
  readonly air: Glyphs
  readonly cores: Cores
  readonly bb: Billboards
  readonly labels: Labels
  private trails: Trail[] = []
  private trailFree: Trail[] = []
  private pulses: Pulse[] = []
  private nPulse = 0
  private frameStamp = 1
  private live = false
  private lastFlushNow = -1
  private camPos = new THREE.Vector3()
  private tracked: Tracked[] = []
  private trackedPrev: Tracked[] = []
  private nTracked = 0
  private nTrackedPrev = 0
  private expects: Expect[] = []
  private lastAttrEvt: SimEvent | null = null
  private tc = new THREE.Color()
  /** scratch team colour (linear) from teamRGB() */
  readonly team: [number, number, number] = [1, 1, 1]
  /** windup lengths by pawn entity (castStart ticks) */
  readonly windupTotal = new Map<number, number>()

  constructor(readonly ctx: VfxCtx) {
    this.scene = ctx.scene
    const pb = Math.max(0.5, ctx.tier.particles)
    this.strips = new Strips(ctx, Math.round(12288 * Math.min(1, pb)))
    this.ground = new Glyphs(ctx, 160, 3)
    this.air = new Glyphs(ctx, 160, 8)
    this.cores = new Cores(ctx, 96)
    this.bb = new Billboards(320, ctx.tier.heatHaze)
    this.labels = new Labels(6)
    for (let i = 0; i < 6; i++) this.tracked.push(this.newTracked()), this.trackedPrev.push(this.newTracked())
    for (let i = 0; i < 96; i++) {
      this.pulses.push({ type: 0, air: false, x: 0, y: 0, h: 0, r0: 0, r1: 0, born: 0, life: 1, rot: 0, spin: 0, r: 0, g: 0, b: 0, a: 0, p1a: 0, p1b: 0, p2: 0, hold: false })
    }
    for (let i = 0; i < 8; i++) this.expects.push({ spell: '', owner: -1, target: -1, x: 0, y: 0, radius: 0, until: -1, data: 0 })
    const flush = (renderer: unknown) => {
      if (import.meta.env.DEV) (globalThis as Record<string, unknown>).__kitARenderer = renderer
      this.flush()
    }
    for (const o of [this.strips.mesh, this.ground.mesh, this.air.mesh, this.cores.mesh, this.bb.sprite]) {
      o.onBeforeRender = flush
      ctx.scene.add(o)
    }
    ctx.scene.add(this.labels.group)
  }

  private newTracked(): Tracked {
    return { id: -1, owner: -1, spell: '', kind: '', x: 0, y: 0, r: 0, sp: 0 }
  }

  /** Start this frame's immediate draws (lazy, on the first draw after the last render). */
  private use(): void {
    if (this.live) return
    this.live = true
    this.frameStamp++
    this.strips.reset()
    this.ground.reset()
    this.air.reset()
    this.cores.reset()
    this.bb.begin()
    const t = this.tracked
    this.tracked = this.trackedPrev
    this.trackedPrev = t
    this.nTrackedPrev = this.nTracked
    this.nTracked = 0
  }

  /** Call at the top of every module draw entry point. */
  begin(): this {
    this.use()
    return this
  }

  private flush(): void {
    const now = this.ctx.now
    // hit-stop (world clock frozen, no module ran): keep last frame's buffers
    if (!this.live && now === this.lastFlushNow) return
    this.use()
    this.ctx.camera.getWorldPosition(this.camPos)
    this.drawPulses(now)
    this.drawTrails(now)
    this.strips.commit()
    this.ground.commit()
    this.air.commit()
    this.cores.commit()
    this.bb.commit()
    this.labels.update(now)
    this.live = false
    this.lastFlushNow = now
  }

  // ------------------------------------------------------------ strips helpers

  stripBegin(flat: boolean, falloff = 1.6, noise = 0, u0 = 0): void {
    this.use()
    this.strips.begin(flat, falloff, noise, u0)
  }

  /** strip point at a GAME position (x, y, h), width in game units */
  stripPoint(x: number, y: number, h: number, w: number, r: number, g: number, b: number, a: number, er = 0, eg = 0, eb = 0, edge = 0): void {
    this.strips.point(x * S, h * S, -y * S, w * S, r, g, b, a, er, eg, eb, edge)
  }

  stripEnd(): void {
    this.ctx.camera.getWorldPosition(this.camPos)
    this.strips.end(this.camPos)
  }

  // ------------------------------------------------------------ bolts

  private bx = new Float32Array(64)
  private by = new Float32Array(64)
  private bh = new Float32Array(64)

  /** jagged path (game coords) into bx/by/bh; returns the point count */
  private boltPath(x0: number, y0: number, h0: number, x1: number, y1: number, h1: number, seed: number, amp: number, seg: number): number {
    const dx = x1 - x0
    const dy = y1 - y0
    const len = Math.hypot(dx, dy) || 1
    const n = Math.max(2, Math.min(63, Math.ceil(len / seg)))
    const px = -dy / len
    const py = dx / len
    let walk = 0
    for (let i = 0; i <= n; i++) {
      const f = i / n
      const env = Math.pow(Math.sin(Math.PI * f), 0.6)
      // random walk + jitter: big kinks with fine crackle
      walk = walk * 0.55 + (hash01(seed, i) * 2 - 1)
      const o = (walk * 0.75 + (hash01(seed + 17, i) * 2 - 1) * 0.35) * amp * env
      const v = (hash01(seed + 31, i) * 2 - 1) * amp * 0.45 * env
      this.bx[i] = x0 + dx * f + px * o
      this.by[i] = y0 + dy * f + py * o
      this.bh[i] = h0 + (h1 - h0) * f + v
    }
    return n + 1
  }

  /**
   * Lightning bolt between two game points: wide glow strip + white-hot core,
   * with forked branches. `seed` picks the shape (change it to flicker).
   */
  bolt(x0: number, y0: number, h0: number, x1: number, y1: number, h1: number, seed: number, amp: number, width: number, glow: RGB, hot: RGB, intensity: number, branches = 0, seg = 26, glowWidth = width * 4.2, glowGain = 0.32): void {
    this.use()
    const n = this.boltPath(x0, y0, h0, x1, y1, h1, seed, amp, seg)
    this.emitBolt(n, width, glow, hot, intensity, glowWidth, glowGain)
    if (branches <= 0 || n < 5) return
    const len = Math.hypot(x1 - x0, y1 - y0) || 1
    const ux = (x1 - x0) / len
    const uy = (y1 - y0) / len
    for (let b = 0; b < branches; b++) {
      const i = 1 + Math.floor(hash01(seed + 101, b) * (n - 3))
      // the branch starts on the main path (recompute it: the scratch is reused)
      this.boltPath(x0, y0, h0, x1, y1, h1, seed, amp, seg)
      const sx = this.bx[i]
      const sy = this.by[i]
      const sh = this.bh[i]
      const side = hash01(seed + 7, b) < 0.5 ? -1 : 1
      const ang = side * (0.45 + hash01(seed + 13, b) * 0.6)
      const bl = len * (0.12 + hash01(seed + 19, b) * 0.22)
      const c = Math.cos(ang)
      const sn = Math.sin(ang)
      const ex = sx + (ux * c - uy * sn) * bl
      const ey = sy + (ux * sn + uy * c) * bl
      const m = this.boltPath(sx, sy, sh, ex, ey, sh - 10 - hash01(seed, b) * 30, seed * 3 + b, amp * 0.6, seg * 0.8)
      this.emitBolt(m, width * 0.55, glow, hot, intensity * 0.6, glowWidth * 0.55, glowGain)
    }
  }

  private emitBolt(n: number, width: number, glow: RGB, hot: RGB, intensity: number, glowWidth: number, glowGain: number): void {
    const cam = this.camPos
    this.ctx.camera.getWorldPosition(cam)
    this.strips.begin(false, 2.2, 0, 0)
    for (let i = 0; i < n; i++) {
      const taper = i === n - 1 ? 0.4 : 1
      this.strips.point(this.bx[i] * S, this.bh[i] * S, -this.by[i] * S, glowWidth * taper * S, glow[0], glow[1], glow[2], intensity * glowGain)
    }
    this.strips.end(cam)
    this.strips.begin(false, 2.6, 0, 0)
    for (let i = 0; i < n; i++) {
      const taper = i === n - 1 ? 0.3 : 1
      this.strips.point(this.bx[i] * S, this.bh[i] * S, -this.by[i] * S, width * taper * S, hot[0], hot[1], hot[2], intensity)
    }
    this.strips.end(cam)
  }

  // ------------------------------------------------------------ billboards

  /** glow sprite at a game position; size in game units */
  glowAt(x: number, y: number, h: number, size: number, r: number, g: number, b: number, falloff = 2, heat = 0): void {
    this.use()
    this.bb.add(x * S, h * S, -y * S, size * S, r, g, b, falloff, heat)
  }

  /** stretched glow along a game-space direction (projected to the screen) */
  streakAt(x: number, y: number, h: number, size: number, stretch: number, dx: number, dy: number, r: number, g: number, b: number, falloff = 2, heat = 0): void {
    this.use()
    const ang = this.screenAngle(x, y, h, dx, dy)
    this.bb.addStreak(x * S, h * S, -y * S, size * S, stretch, ang, r, g, b, falloff, heat)
  }

  private v0 = new THREE.Vector3()
  private v1 = new THREE.Vector3()
  /** screen-space angle of a game-space direction at a point */
  screenAngle(x: number, y: number, h: number, dx: number, dy: number): number {
    const cam = this.ctx.camera
    this.v0.set(x * S, h * S, -y * S).project(cam)
    this.v1.set((x + dx * 50) * S, h * S, -(y + dy * 50) * S).project(cam)
    return Math.atan2(this.v1.y - this.v0.y, (this.v1.x - this.v0.x) * cam.aspect)
  }

  // ------------------------------------------------------------ timed glyphs

  /**
   * Fire-and-forget glyph: radius r0 -> r1 (ease out) over `life` seconds, spinning,
   * p1 animated p1a -> p1b. hold = stay bright and fade over the last 40% (sigils),
   * else fade from the start (shockwaves).
   */
  pulse(type: number, air: boolean, x: number, y: number, h: number, r0: number, r1: number, life: number, rot: number, spin: number, c: RGB, a: number, p1a = 0, p1b = 0, p2 = 0, hold = false): void {
    let p: Pulse
    if (this.nPulse < this.pulses.length) p = this.pulses[this.nPulse++]
    else {
      // full: replace the oldest
      let oi = 0
      for (let i = 1; i < this.pulses.length; i++) if (this.pulses[i].born < this.pulses[oi].born) oi = i
      p = this.pulses[oi]
    }
    p.type = type
    p.air = air
    p.x = x
    p.y = y
    p.h = h
    p.r0 = r0
    p.r1 = r1
    p.born = this.ctx.now
    p.life = Math.max(0.02, life)
    p.rot = rot
    p.spin = spin
    p.r = c[0]
    p.g = c[1]
    p.b = c[2]
    p.a = a
    p.p1a = p1a
    p.p1b = p1b
    p.p2 = p2
    p.hold = hold
  }

  private drawPulses(now: number): void {
    let w = 0
    for (let i = 0; i < this.nPulse; i++) {
      const p = this.pulses[i]
      const k = (now - p.born) / p.life
      if (k >= 1) continue
      if (w !== i) {
        const tmp = this.pulses[w]
        this.pulses[w] = p
        this.pulses[i] = tmp
      }
      w++
      if (k < 0) continue
      const e = 1 - (1 - k) * (1 - k) * (1 - k)
      const rad = p.r0 + (p.r1 - p.r0) * e
      const fin = Math.min(1, k / 0.06)
      const fout = p.hold ? Math.min(1, (1 - k) / 0.4) : Math.pow(1 - k, 1.5)
      const a = p.a * fin * fout
      const g = p.air ? this.air : this.ground
      g.add(p.type, p.x, p.y, p.h, rad, p.rot + p.spin * (now - p.born), p.r, p.g, p.b, a, p.p1a + (p.p1b - p.p1a) * e, p.p2)
    }
    this.nPulse = w
  }

  // ------------------------------------------------------------ trails

  /** Feed a trail head for `key` (projectile id) this frame. */
  trailPoint(key: number, x: number, y: number, h: number, style: TrailStyle, owner = -1, gain = 1): void {
    this.use()
    let tr: Trail | undefined
    for (let i = 0; i < this.trails.length; i++) {
      if (this.trails[i].key === key) {
        tr = this.trails[i]
        break
      }
    }
    const now = this.ctx.now
    if (!tr) {
      tr = this.trailFree.pop() ?? new Trail()
      tr.key = key
      tr.n = 0
      tr.start = 0
      tr.style = style
      this.trails.push(tr)
      if (style.rimRGB) {
        tr.rimR = style.rimRGB[0]
        tr.rimG = style.rimRGB[1]
        tr.rimB = style.rimRGB[2]
      } else if (owner >= 0) {
        this.teamRGB(owner)
        tr.rimR = this.team[0]
        tr.rimG = this.team[1]
        tr.rimB = this.team[2]
      } else {
        tr.rimR = tr.rimG = tr.rimB = 1
      }
    }
    tr.style = style
    tr.gain = gain
    tr.live = true
    tr.stamp = this.frameStamp
    tr.hx = x
    tr.hy = y
    tr.hh = h
    // store a point when far enough from the last stored one
    let push = tr.n === 0
    if (!push) {
      const li = (tr.start + tr.n - 1) % TRAIL_MAXP
      const dx = x - tr.x[li]
      const dy = y - tr.y[li]
      const dh = h - tr.h[li]
      push = dx * dx + dy * dy + dh * dh >= style.spacing * style.spacing
    }
    if (push) {
      if (tr.n === TRAIL_MAXP) {
        tr.start = (tr.start + 1) % TRAIL_MAXP
        tr.n--
      }
      const i = (tr.start + tr.n) % TRAIL_MAXP
      tr.x[i] = x
      tr.y[i] = y
      tr.h[i] = h
      tr.t[i] = now
      tr.n++
    }
  }

  /** Drop a trail at once (e.g. a teleporting projectile). */
  trailCut(key: number): void {
    for (const tr of this.trails) if (tr.key === key) tr.n = 0
  }

  private drawTrails(now: number): void {
    let w = 0
    for (let i = 0; i < this.trails.length; i++) {
      const tr = this.trails[i]
      const st = tr.style!
      tr.live = tr.stamp === this.frameStamp
      // drop expired points (oldest first)
      while (tr.n > 0 && now - tr.t[tr.start] > st.life) {
        tr.start = (tr.start + 1) % TRAIL_MAXP
        tr.n--
      }
      if (tr.n === 0 && !tr.live) {
        tr.key = -1
        this.trailFree.push(tr)
        continue
      }
      this.trails[w++] = tr
      this.drawTrail(tr, now)
    }
    this.trails.length = w
  }

  private drawTrail(tr: Trail, now: number): void {
    const st = tr.style!
    const total = tr.n + (tr.live ? 1 : 0)
    if (total < 2) return
    this.strips.begin(!!st.flat, st.falloff, st.noise, 0)
    if (tr.live) this.emitTrail(tr, st, tr.hx, tr.hy, tr.hh, 0)
    for (let k = tr.n - 1; k >= 0; k--) {
      const i = (tr.start + k) % TRAIL_MAXP
      this.emitTrail(tr, st, tr.x[i], tr.y[i], tr.h[i], now - tr.t[i])
    }
    this.strips.end(this.camPos)
  }

  private emitTrail(tr: Trail, st: TrailStyle, x: number, y: number, h: number, age: number): void {
    const f = Math.min(1, Math.max(0, age / st.life))
    let r: number
    let g: number
    let b: number
    if (f < 0.3) {
      const k = f / 0.3
      r = st.head[0] + (st.mid[0] - st.head[0]) * k
      g = st.head[1] + (st.mid[1] - st.head[1]) * k
      b = st.head[2] + (st.mid[2] - st.head[2]) * k
    } else {
      const k = (f - 0.3) / 0.7
      r = st.mid[0] + (st.tail[0] - st.mid[0]) * k
      g = st.mid[1] + (st.tail[1] - st.mid[1]) * k
      b = st.mid[2] + (st.tail[2] - st.mid[2]) * k
    }
    const fade = (1 - f) * (1 - f) * Math.min(1, age * 40 + 0.35)
    const wd = st.width * (1 + (st.widthTail - 1) * f)
    this.strips.point(x * S, h * S, -y * S, wd * S, r, g, b, st.intensity * tr.gain * fade, tr.rimR, tr.rimG, tr.rimB, st.rim)
  }

  // ------------------------------------------------------------ pawns, colours

  /** linear RGB of a player's team colour into this.team */
  teamRGB(owner: number): [number, number, number] {
    this.tc.setHex(this.ctx.colorOf(owner))
    this.team[0] = this.tc.r
    this.team[1] = this.tc.g
    this.team[2] = this.tc.b
    return this.team
  }

  /** cast origin (palm socket or staff tip) of a pawn, game coords into `out` */
  origin(info: PawnRenderInfo, out: { x: number; y: number; h: number }): { x: number; y: number; h: number } {
    const o = (info as PawnRenderInfo & { castOrigin?: THREE.Vector3 }).castOrigin ?? info.tip
    out.x = o.x / S
    out.y = -o.z / S
    out.h = o.y / S
    return out
  }

  /** floor height under a game position (tile top or lava) */
  floor(x: number, y: number): number {
    return this.ctx.isLava(x, y) ? LAVA_H + 2 : TILE_TOP_H + 1
  }

  // ------------------------------------------------------------ attribution

  /** Remember a drawn projectile so a later 'damage' event can be attributed to it. */
  track(p: ProjectileState, x: number, y: number): void {
    this.use()
    if (this.nTracked >= this.tracked.length) this.tracked.push(this.newTracked())
    const t = this.tracked[this.nTracked++]
    t.id = p.id
    t.owner = p.owner
    t.spell = p.spell
    t.kind = p.kind ?? p.spell
    t.x = x
    t.y = y
    t.r = p.radius
    t.sp = Math.hypot(p.vx, p.vy)
  }

  /** Expect a hit from a non-projectile source (beam, slam, area): claimed by attributeDamage. */
  expect(spell: string, owner: number, target: number, x: number, y: number, radius: number, data = 0): void {
    let slot = this.expects[0]
    for (const e of this.expects) {
      if (e.until < this.ctx.now) {
        slot = e
        break
      }
      if (e.until < slot.until) slot = e
    }
    slot.spell = spell
    slot.owner = owner
    slot.target = target
    slot.x = x
    slot.y = y
    slot.radius = radius
    slot.until = this.ctx.now + 0.25
    slot.data = data
  }

  /** Clear expectations of a spell for an owner (e.g. the beam event closes the Lightning window). */
  unexpect(spell: string, owner: number): void {
    for (const e of this.expects) if (e.spell === spell && e.owner === owner) e.until = -1
  }

  /**
   * Which of our spells caused this 'damage' event: an expectation (beam, slam, area) or a
   * tracked projectile of the same owner near the victim. Cached per event object.
   */
  attributeDamage(e: Extract<SimEvent, { type: 'damage' }>): { spell: string; kind: string; data: number } | null {
    if (e === this.lastAttrEvt) return this.attrResult
    this.lastAttrEvt = e
    this.attrResult = null
    if (e.source === null) return null
    // render's same-tick cause (projectileHit / beam / spellHit / explosion) wins when it names one of ours
    const cause = this.ctx.damageCause ? this.ctx.damageCause(e) : null
    if (cause !== null && OUR_SPELLS.has(cause)) {
      let id = -1
      for (const x of this.ctx.tickEvents ?? []) {
        if (x.type === 'projectileHit' && x.target === e.target && x.spell === cause) {
          id = x.id
          break
        }
      }
      this.attrResult = { spell: cause, kind: cause, data: id }
      return this.attrResult
    }
    const now = this.ctx.now
    for (const x of this.expects) {
      if (x.until < now || (x.owner >= 0 && x.owner !== e.source)) continue
      if (x.target >= 0 ? x.target === e.target : Math.hypot(e.x - x.x, e.y - x.y) <= x.radius + 60) {
        this.attrResult = { spell: x.spell, kind: x.spell, data: x.data }
        return this.attrResult
      }
    }
    let best: Tracked | null = null
    let bd = Infinity
    const scan = (arr: Tracked[], n: number) => {
      for (let i = 0; i < n; i++) {
        const t = arr[i]
        if (t.owner !== e.source) continue
        const d = Math.hypot(e.x - t.x, e.y - t.y)
        const lim = t.r + 30 + 40 + t.sp * 0.06
        if (d <= lim && d < bd) {
          bd = d
          best = t
        }
      }
    }
    scan(this.tracked, this.nTracked)
    scan(this.trackedPrev, this.nTrackedPrev)
    if (best) {
      const b = best as Tracked
      this.attrResult = { spell: b.spell, kind: b.kind, data: b.id }
    }
    return this.attrResult
  }
  private attrResult: { spell: string; kind: string; data: number } | null = null

  /** knockback direction of a damaged pawn (victim's physics velocity), else from (fx, fy) */
  hitDir(state: SimState | null, target: number, fromX: number, fromY: number, x: number, y: number, out: { x: number; y: number }): { x: number; y: number } {
    let dx = 0
    let dy = 0
    if (state) {
      for (const p of state.pawns) {
        if (p.id === target) {
          dx = p.vx - p.walkVx
          dy = p.vy - p.walkVy
          break
        }
      }
    }
    if (Math.hypot(dx, dy) < 40) {
      dx = x - fromX
      dy = y - fromY
    }
    const l = Math.hypot(dx, dy)
    out.x = l > 1e-3 ? dx / l : 0
    out.y = l > 1e-3 ? dy / l : 0
    // remembered for a lethal-hit death drawn right after this damage event
    this.lastHit.target = target
    this.lastHit.x = out.x
    this.lastHit.y = out.y
    this.lastHit.t = this.ctx.now
    return out
  }

  /** direction of the last hit drawn by one of our modules (for the death that follows it) */
  readonly lastHit = { target: -1, x: 0, y: 0, t: -10 }

  // ------------------------------------------------------------ shared bursts

  /**
   * Knockback-scaled hit: directional spark cone along the push in the spell's
   * hues, white-hot core sparks, falling embers, contact flash, ground shockwave
   * and dust. kb in game units/s (damage event).
   */
  impact(x: number, y: number, h: number, kb: number, dx: number, dy: number, pal: Pal, scale = 1): void {
    const ctx = this.ctx
    const ps = ctx.particles
    const k = Math.min(2.2, kb / 900) * scale
    const hasDir = dx !== 0 || dy !== 0
    const baseA = Math.atan2(dy, dx)
    const cone = hasDir ? 0.55 : Math.PI
    const n = ps.budget(8 + k * 30)
    for (let i = 0; i < n; i++) {
      const a = baseA + (Math.random() - 0.5) * 2 * cone
      const sp = (420 + Math.random() * 900) * (0.6 + k * 0.5)
      ps.spawn(x, y, h, Math.cos(a) * sp, Math.sin(a) * sp, 60 + Math.random() * 380, 0.2 + Math.random() * 0.3, 6 + k * 3, 1.5, pal.spark[0], pal.spark[1], pal.spark[2], -1400, 3, -0.11)
    }
    const nh = ps.budget(5 + k * 8)
    for (let i = 0; i < nh; i++) {
      const a = baseA + (Math.random() - 0.5) * 2 * cone * 0.6
      const sp = (900 + Math.random() * 900) * (0.6 + k * 0.4)
      ps.spawn(x, y, h, Math.cos(a) * sp, Math.sin(a) * sp, 80 + Math.random() * 200, 0.12 + Math.random() * 0.12, 5 + k * 2, 1, pal.hot[0] * 1.3, pal.hot[1] * 1.3, pal.hot[2] * 1.3, -900, 4, -0.14)
    }
    const nd = ps.budget(3 + k * 5)
    for (let i = 0; i < nd; i++) {
      const a = baseA + (Math.random() - 0.5) * 2 * cone * 1.4
      const sp = 150 + Math.random() * 350
      ps.spawn(x, y, h, Math.cos(a) * sp, Math.sin(a) * sp, 250 + Math.random() * 250, 0.6 + Math.random() * 0.5, 9, 4, pal.body[0], pal.body[1], pal.body[2], -1500, 1.2, -0.04)
    }
    ctx.flash(x - dx * 20, y - dy * 20, h, 0.09 + k * 0.05, 170 + k * 90, 80 + k * 55, pal.hot[0] * 0.8, pal.hot[1] * 0.8, pal.hot[2] * 0.8)
    const fl = this.floor(x, y)
    ctx.ground.spawn(RING_EXPAND, x, y, fl, 18, 70 + k * 75, 0.3 + k * 0.06, 8 + k * 4, pal.body[0] * 0.8, pal.body[1] * 0.8, pal.body[2] * 0.8)
    if (k > 0.55) {
      const ns = ctx.smoke.budget(2 + k * 2)
      for (let i = 0; i < ns; i++) {
        ctx.smoke.spawn(x, y, h - 20, -dx * 80 + (Math.random() - 0.5) * 60, -dy * 80 + (Math.random() - 0.5) * 60, 40, 0.8 + Math.random() * 0.4, 30, 100, 0.06, 0.045, 0.04, 20, 1.2, 8)
      }
    }
  }

  /** Muzzle burst at a cast origin toward (dx, dy): flash, cone of sparks, a puff. */
  muzzle(x: number, y: number, h: number, dx: number, dy: number, pal: Pal, scale = 1): void {
    const ctx = this.ctx
    const ps = ctx.particles
    ctx.flash(x, y, h, 0.14, 150 * scale, 80 * scale, pal.hot[0] * 0.75, pal.hot[1] * 0.75, pal.hot[2] * 0.75)
    const base = Math.atan2(dy, dx)
    const n = ps.budget(10 * scale)
    for (let i = 0; i < n; i++) {
      const a = base + (Math.random() - 0.5) * 1.1
      const sp = 300 + Math.random() * 600
      ps.spawn(x, y, h, Math.cos(a) * sp, Math.sin(a) * sp, (Math.random() - 0.3) * 200, 0.14 + Math.random() * 0.14, 7, 1, pal.spark[0], pal.spark[1], pal.spark[2], -600, 4, -0.1)
    }
    const nf = ps.budget(6 * scale)
    for (let i = 0; i < nf; i++) {
      const a = base + (Math.random() - 0.5) * 0.7
      const sp = 120 + Math.random() * 260
      ps.spawn(x, y, h, Math.cos(a) * sp, Math.sin(a) * sp, 30 + Math.random() * 60, 0.2 + Math.random() * 0.15, 26 * scale, -8, pal.body[0], pal.body[1], pal.body[2], 40, 5, 0)
    }
  }

  /**
   * Base of every signature charge-up (render draws the shared "someone is
   * casting" telegraph): motes in the spell's colour spiralling into the cast
   * hand and a glow that grows with progress k (0..1). Each spell adds its own
   * recognizable shape on top.
   */
  windupAt(x: number, y: number, h: number, k: number, pal: Pal, _now: number, dt: number, _seed: number): void {
    const ps = this.ctx.particles
    const n = ps.budget(dt * (30 + k * 60))
    for (let i = 0; i < n; i++) {
      const a = Math.random() * TAU
      const rr = 55 + Math.random() * 45
      const life = 0.16 + Math.random() * 0.08
      // spawn on a ring, fly into the origin over its life (slight swirl)
      const ox = Math.cos(a) * rr
      const oy = Math.sin(a) * rr
      const oh = (Math.random() - 0.5) * 60
      ps.spawn(x + ox, y + oy, h + oh, (-ox + oy * 0.6) / life, (-oy - ox * 0.6) / life, -oh / life, life, 5 + k * 4, 2, pal.spark[0], pal.spark[1], pal.spark[2], 0, 0, -0.03)
    }
    this.glowAt(x, y, h, 40 + k * 50, pal.body[0] * (0.3 + k * 0.7), pal.body[1] * (0.3 + k * 0.7), pal.body[2] * (0.3 + k * 0.7), 2.2)
  }

  /**
   * n small glowing bodies orbiting (x, y, h) on a tilted ring: hot core
   * spheres with short trails (Twin's pair, Cluster's four embers...).
   */
  orbit(x: number, y: number, h: number, n: number, radius: number, angle: number, size: number, pal: Pal, intensity: number, key: number, trail: TrailStyle | null, tilt = 14): void {
    for (let i = 0; i < n; i++) {
      const a = angle + (i / n) * TAU
      const ox = x + Math.cos(a) * radius
      const oy = y + Math.sin(a) * radius
      const oh = h + Math.sin(a * 2) * tilt * (i % 2 === 0 ? 1 : -1)
      this.cores.add(ox, oy, oh, size, -Math.sin(a), Math.cos(a), 0.6, key + i, pal.edge, pal.body, pal.hot, intensity)
      this.glowAt(ox, oy, oh, size * 4, pal.body[0] * 0.4 * intensity, pal.body[1] * 0.4 * intensity, pal.body[2] * 0.4 * intensity, 2)
      if (trail) this.trailPoint(key + i, ox, oy, oh, trail)
    }
  }

  dispose(): void {
    for (const o of [this.strips.mesh, this.ground.mesh, this.air.mesh, this.cores.mesh, this.bb.sprite]) this.scene.remove(o)
    this.scene.remove(this.labels.group)
    this.strips.dispose()
    this.ground.dispose()
    this.air.dispose()
    this.cores.dispose()
    this.bb.dispose()
    this.labels.dispose()
  }
}

let shared: KitA | null = null
let refs = 0

/** Get the kit for this world (created on first use). Pair with releaseKit in dispose(). */
export function acquireKit(ctx: VfxCtx): KitA {
  if (shared && shared.scene !== ctx.scene) {
    shared.dispose()
    shared = null
    refs = 0
  }
  if (!shared) {
    shared = new KitA(ctx)
    if (import.meta.env.DEV) (globalThis as Record<string, unknown>).__kitA = shared
  }
  refs++
  return shared
}

export function releaseKit(k: KitA | null): void {
  if (!k || k !== shared) return
  refs--
  if (refs <= 0) {
    shared.dispose()
    shared = null
    refs = 0
  }
}

// ---------------------------------------------------------------------------
// small shared helpers
// ---------------------------------------------------------------------------

/** deterministic hash -> [0, 1) */
export function hash01(seed: number, i: number): number {
  let h = (Math.imul(seed | 0, 374761393) + Math.imul(i | 0, 668265263)) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}

/** pawn by entity id in a snapshot */
export function pawnById(s: SimState | null, id: number) {
  if (!s) return undefined
  for (const p of s.pawns) if (p.id === id) return p
  return undefined
}

/** windup progress 0..1 of a pawn's running cast (null if none / not started) */
export function windupProgress(k: KitA, ctx: VfxCtx, pawnId: number, ticksLeft: number): number {
  const total = k.windupTotal.get(pawnId) ?? 12
  return Math.max(0, Math.min(1, 1 - (ticksLeft - ctx.alpha) / Math.max(1, total)))
}

/** projectile height used by every spell (chest height) */
export const PH = PROJECTILE_H

/** scale an RGB into a reusable tuple */
export function mulRGB(c: RGB, k: number, out: [number, number, number]): [number, number, number] {
  out[0] = c[0] * k
  out[1] = c[1] * k
  out[2] = c[2] * k
  return out
}
