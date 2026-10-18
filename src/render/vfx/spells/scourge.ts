/**
 * Scourge (VFX workstream C), the flagship AoE. Claims spell 'scourge', so the
 * built-in scourgeBlast is skipped.
 *
 * Sim: 0.9 s cancellable windup, AoE radius 250 centred on the caster (the
 * edge is exact), 100/110/120 damage, the caster pays 100 HP, knockback
 * factor 0.75 (edge) .. 1.0 (centre).
 *
 * Who sees the windup (close to the original, where Scourge had no tell
 * until the blast): only the LOCAL caster sees the telegraph below (ring at
 * the exact radius, runes, threads, hand crown, tremor) plus a faint
 * dashed inner line at R - pawn radius ("who will actually be hit").
 * Everyone else (opponents, allies, spectators / replays) gets a subtle but
 * noticeable "charging" cue on the caster (see windupCue: pulsing crimson
 * ember aura on the body, with a heartbeat that quickens toward release).
 * No radius ring, runes, beam or
 * crown, no floor light (the shared windup's light is hidden for them via
 * windupStyle 'light'), no tremor. The blast is unchanged and shown to all.
 *
 * Windup, local caster (the caster's two-hands-overhead summon):
 *   - a crisp blood-red boundary at exactly R telegraphs the hit area from
 *     the first frame; a band of runes just inside it ignites around the
 *     circle, and from every rune a thread of crimson crawls inward toward
 *     the caster while a shadow pool creeps in from the edge
 *   - a crimson crown seal stays on the real raised hands, with additional
 *     strokes at higher levels; no sphere, free motes, or airborne charge
 *   - a low ground tremor ramps up (fx scaled)
 * Cancel: hand/body marks extinguish immediately; the local target circle
 *   breaks apart in place over 0.45 s, without emitted shards or smoke.
 * Release (hands slam down):
 *   - a dark shockwave sweeps centre -> exactly R in 0.22 s with a hot crimson
 *     edge, then rests as the thin boundary and fades
 *   - the floor inside cracks open radially, cracks glow crimson and cool to
 *     charred black (L2 / L3; see the aftermath note), heat distortion on the
 *     front (High+)
 *   - shadow flames lick up along the front and the rim, black-red debris and
 *     embers burst outward but stop inside R
 *   - short shake (fx scaled); every warlock hit gets a crimson rim flash
 *     (the core's 'shadow' after-hit and afterhit.ts add the wisps)
 *
 * Level tiers (edge always the crisp ring at the sim radius: who gets hit):
 *   L1 (everyone, from round 1, so the look seen constantly) is tame: mostly
 *     outline, not fill. A thin ember-crimson edge, sparse runes, no threads,
 *     a faint floor tint, a dim hand crown and ~35 % of release particles;
 *     release = a quick shockwave ring + a short flash, no filled disc or
 *     crack blaze.
 *   L2: some fill, all runes plus an inner ring, the threads, an echo
 *     shockwave, moderate particles and cracks.
 *   L3: the full escalation: three rune rings, the full red pool, a detailed
 *     hand crown, a blade burst on release, dense flames, glowing cracks.
 *   Level comes from the event (`level`) when the sim sends it, else from the
 *   caster's slot level.
 * Caster identity: with bots spamming Scourge, 2-4 overlapping r250 circles are
 *   common, so a thin band just inside the crimson edge carries the caster's
 *   identity colour (render/teamColors colorForPawn: team colour in team modes,
 *   slot colour in FFA, like the pawn ring) through the windup and while the
 *   released edge rests. The
 *   edge, runes and blast stay Scourge crimson. The shared hand-cast rings and
 *   arm spiral are hidden (windupStyle): this module draws the hand crown.
 * Aftermath (one clean curve, nothing lingers as a smear): glow cools fast and
 *   is gone by ~1.1 s, the charred fill fades out crisply by 1.4 s, the dark
 *   crack lines by 1.8 s; decal alpha reaches exactly 0. Smoke <= 1 s.
 *
 * No white-out: colours stay saturated, every emissive is clamped (<= 3) so
 * Low / Medium (no bloom) clip to clean reds, not white.
 * Performance: windup circles are an 8-instance immediate batch, release
 * decals a 12-slot stateless ring buffer, own 96-sprite glow batch; pooled
 * records, no per-frame allocation.
 */
import * as THREE from 'three/webgpu'
import {
  abs, atan, clamp, dot, exp, float, floor, fract, hash, instancedBufferAttribute, length, max, min, mix, mod, mrt,
  positionGeometry, pow, saturate, sin, smoothstep, step, texture, varying, vec2, vec3, vec4,
} from 'three/tsl'
import type { Node } from 'three/webgpu'
import type { EntityId } from '../../../sim/types'
import { S } from '../../coords'
import { Billboards } from '../../scene/Billboards'
import { RING_EXPAND } from '../../scene/GroundFx'
import { asV4 } from '../../scene/world'
import { cameraZoomParam } from '../../cameraRig'
import { colorForPawn } from '../../teamColors'
import { BODY_H, decalFloor } from '../deathKit'
import { registerSpellVfx, type VfxCtx, type WindupStyle } from '../registry'

const TAU = Math.PI * 2
const rnd = Math.random
/** sim AoE radius (all levels) */
const R_DEFAULT = 250
const WINDUP_S = 0.9
const CANCEL_S = 0.18
const SWEEP_S = 0.22
/** decal lifetime: everything has faded to exactly 0 by then */
const RELEASE_LIFE = 1.8

// blood crimson over black (palette 'scourge'), linear HDR. Saturated reds
// stay red through bloom + tone mapping only below ~1.6 in the red channel;
// brighter, they wash out to pink / white
const CRIMSON: readonly [number, number, number] = [1.5, 0.045, 0.06]
const HOT: readonly [number, number, number] = [2.0, 0.32, 0.18]
const DEEP: readonly [number, number, number] = [0.6, 0.01, 0.02]

const ang01 = (q: Node<'vec2'>) => atan(q.y, q.x.add(1e-5)).div(TAU).add(0.5)
/** quad spans +-QUAD radii so the boundary ring and its glow fit */
const QUAD = 1.1

/** per-level value, L1 / L2 / L3 (CPU side) */
const tier = (level: number, v1: number, v2: number, v3: number) => (level >= 3 ? v3 : level >= 2 ? v2 : v1)
/** per-level value in a shader, from the level node (1..3) */
const tierN = (lvl: Node<'float'>, v1: number, v2: number, v3: number) => float(v1).add(step(1.5, lvl).mul(v2 - v1)).add(step(2.5, lvl).mul(v3 - v2))
/** tier base colour: L1 dark ember crimson (low bloom), L3 the full blood crimson */
const tierCol = (lvl: Node<'float'>) => vec3(tierN(lvl, 0.82, 1.15, CRIMSON[0]), tierN(lvl, 0.085, 0.06, CRIMSON[1]), tierN(lvl, 0.045, 0.055, CRIMSON[2]))

// ---------------------------------------------------------------- windup circles (immediate)

const WC = 8

class WindupCircles {
  readonly dark: THREE.Mesh
  readonly glow: THREE.Mesh
  private a0: THREE.InstancedBufferAttribute
  private a1: THREE.InstancedBufferAttribute
  private a2: THREE.InstancedBufferAttribute
  private mats: THREE.MeshBasicNodeMaterial[] = []
  private geo: THREE.BufferGeometry
  private n = 0

  constructor(ctx: VfxCtx) {
    const mk = () => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(WC * 4), 4)
      a.setUsage(THREE.DynamicDrawUsage)
      return a
    }
    this.a0 = mk() // centre (three), R (game)
    this.a1 = mk() // progress 0..1, cancel 0..1, seed, seconds since windup start
    this.a2 = mk() // caster colour (linear, peak 1), -
    const A0 = asV4(instancedBufferAttribute(this.a0))
    const A1 = asV4(instancedBufferAttribute(this.a1))
    const A2 = asV4(instancedBufferAttribute(this.a2))
    const q = positionGeometry.xy
    const positionNode = A0.xyz.add(vec3(q.x, 0, q.y.negate()).mul(A0.w.mul(S * QUAD)))
    const w = ctx.world
    const rn = length(q).mul(QUAD)
    const a = ang01(q)
    const prog = A1.x
    const cancel = A1.y
    // seed channel packs level * 100 + seed (seed < 100)
    const lvl = floor(A1.z.div(100))
    const seed = mod(A1.z, 100)
    const l2 = step(1.5, lvl)
    const l3 = step(2.5, lvl)
    // per-instance clock comes in as an attribute (written on the CPU), never a fragment uniform read
    const age = varying(A1.w)
    const live = float(1).sub(cancel)

    // boundary at exactly R: crisp line + a soft glow that stays INSIDE the radius
    const bx = rn.sub(1).div(0.0055)
    const ignite = saturate(age.mul(9))
    const sweepA = fract(age.mul(0.9))
    const sweep = exp(abs(a.sub(sweepA)).min(abs(a.sub(sweepA).add(1))).min(abs(a.sub(sweepA).sub(1))).mul(-30))
    const boundary = exp(bx.mul(bx).negate()).mul(ignite).mul(float(0.75).add(sweep.mul(0.9)).add(prog.mul(0.5)))
    const innerGlow = smoothstep(0.9, 1.0, rn).mul(step(rn, 1)).mul(0.22).mul(prog.add(0.3))

    // rune band just inside the edge: 30 cells, three strokes each (a spine + two hashed branches)
    const N = 30
    const cellF = a.mul(N)
    const ci = floor(cellF)
    const cu = fract(cellF).sub(0.5)
    const arcW = rn.mul(TAU / N)
    const gp = (h: Node<'float'>) => {
      const i = floor(h.mul(8.999))
      return vec2(mod(i, 3).sub(1), floor(i.div(3)).sub(1)).mul(0.72)
    }
    const seg = (p: Node<'vec2'>, s0: Node<'vec2'>, s1: Node<'vec2'>) => {
      const pa = p.sub(s0)
      const ba = s1.sub(s0)
      const hh = clamp(dot(pa, ba).div(max(dot(ba, ba), 1e-4)), 0, 1)
      return length(pa.sub(ba.mul(hh)))
    }
    const cs = ci.mul(13).add(seed.mul(97))
    const gpos = vec2(cu.mul(arcW).div(0.05), rn.sub(0.9).div(0.05))
    const d0 = seg(gpos, vec2(0, -0.8), vec2(0, 0.8))
    const d1 = seg(gpos, gp(hash(cs.add(1))), gp(hash(cs.add(2))))
    const d2 = seg(gpos, gp(hash(cs.add(3))), gp(hash(cs.add(4))))
    const gd = min(d0, min(d1, d2))
    const stroke = smoothstep(0.24, 0.1, gd).mul(step(abs(gpos.y), 1.25)).mul(step(abs(gpos.x), 1.25))
    const igniteAt = hash(cs.add(5)).mul(0.32)
    const lit = smoothstep(igniteAt, igniteAt.add(0.05), prog)
    const litFlash = exp(prog.sub(igniteAt).max(0).mul(-22)).mul(lit)
    // cancel: each rune breaks at its own moment
    const intact = step(cancel.mul(1.25), hash(cs.add(6)))
    // L1: sparse runes (every third cell), L2+ the full band
    const sparse = mix(step(mod(ci, 3), 0.5), float(1), l2)
    const runes = stroke.mul(lit).mul(intact).mul(sparse).mul(float(0.65).add(litFlash.mul(1.4))).mul(tierN(lvl, 0.75, 0.9, 1))

    // inner rune rings: L2 adds one at 0.66 R (counter-rotating), L3 one more at 0.44 R
    const band = (rc: number, cells: number, rot: Node<'float'>, salt: number, gs: number) => {
      const aa = fract(a.add(rot))
      const cF = aa.mul(cells)
      const cI = floor(cF)
      const cU = fract(cF).sub(0.5)
      const aw = rn.mul(TAU / cells)
      const css = cI.mul(17).add(seed.mul(53)).add(salt)
      const gq = vec2(cU.mul(aw).div(gs), rn.sub(rc).div(gs))
      const e0 = seg(gq, vec2(0, -0.8), vec2(0, 0.8))
      const e1 = seg(gq, gp(hash(css.add(1))), gp(hash(css.add(2))))
      const e2 = seg(gq, gp(hash(css.add(3))), gp(hash(css.add(4))))
      const dd = min(e0, min(e1, e2))
      const st = smoothstep(0.24, 0.1, dd).mul(step(abs(gq.y), 1.25)).mul(step(abs(gq.x), 1.25))
      const at = hash(css.add(5)).mul(0.3).add(0.25)
      const on = smoothstep(at, at.add(0.06), prog).mul(step(cancel.mul(1.25), hash(css.add(6))))
      const fl = exp(prog.sub(at).max(0).mul(-20)).mul(on)
      // guide circles either side of the glyph band
      const c1 = rn.sub(rc + gs * 1.45).div(0.0035)
      const c2 = rn.sub(rc - gs * 1.45).div(0.0035)
      const guide = exp(c1.mul(c1).negate()).add(exp(c2.mul(c2).negate())).mul(smoothstep(at, at.add(0.1), prog)).mul(0.8)
      return st.mul(on).mul(float(0.7).add(fl.mul(1.3))).add(guide.mul(float(1).sub(cancel)))
    }
    const runes2 = band(0.6, 20, age.mul(-0.05), 211, 0.055).mul(l2)
    const runes3 = band(0.34, 12, age.mul(0.08), 419, 0.06).mul(l3)

    // threads crawling inward from every rune toward the caster
    const speed = hash(cs.add(7)).mul(0.35).add(0.8)
    const front = float(0.84).sub(prog.mul(speed).mul(0.72))
    const wob = texture(w.noise, vec2(a.mul(30), rn.mul(2).add(seed))).r.sub(0.5).mul(0.012)
    const lx = cu.mul(arcW).add(wob)
    const line = smoothstep(0.009, 0.0025, abs(lx)).mul(step(front, rn)).mul(step(rn, 0.85))
    const tx = rn.sub(front).div(0.02)
    const tip = exp(tx.mul(tx).negate()).mul(smoothstep(0.012, 0.0, abs(lx)))
    const gap2 = float(1).sub(smoothstep(0.075, 0.065, abs(rn.sub(0.6))).mul(l2))
    const gap3 = float(1).sub(smoothstep(0.085, 0.075, abs(rn.sub(0.34))).mul(l3))
    const threads = line.mul(0.55).mul(gap2).mul(gap3).add(tip.mul(1.6)).mul(lit).mul(intact).mul(smoothstep(0.02, 0.12, prog)).mul(tierN(lvl, 0, 0.55, 1))

    // shadow pool creeping inward from the edge
    const pool = smoothstep(float(1).sub(prog.mul(0.95)).sub(0.12), float(1).sub(prog.mul(0.95)).add(0.25), rn).mul(step(rn, 1))
    const pn = texture(w.noise, vec2(a.mul(4), rn.mul(0.8).sub(age.mul(0.15)).add(seed))).r
    // floor tint: L1 a faint low-alpha shade, L3 the full creeping pool
    const darkA = pool.mul(pn.mul(0.4).add(0.6)).mul(tierN(lvl, 0.2, 0.45, 0.72)).mul(saturate(prog.mul(2.5))).mul(live)

    const flick = mix(float(1), sin(age.mul(70)).mul(0.5).add(0.5), saturate(cancel.mul(4)))
    // who will actually be hit: pawn centres inside R - 30 (a pawn overlaps the edge
    // with its radius), a faint dashed line, local caster only (only local circles exist)
    const innerR = (R_DEFAULT - 30) / R_DEFAULT
    const ix = rn.sub(innerR).div(0.0028)
    const dash = step(0.5, fract(a.mul(72)))
    const innerLine = exp(ix.mul(ix).negate()).mul(dash).mul(ignite).mul(0.32)
    // caster identity: a thin band in the caster's colour just inside the edge
    const cbx = rn.sub(0.958).div(tierN(lvl, 0.0042, 0.0046, 0.0052))
    const casterBand = exp(cbx.mul(cbx).negate()).mul(ignite).mul(tierN(lvl, 0.75, 0.95, 1.3))
    // a clean gap around the band so the caster colour reads even under L3's runes
    const gapX = rn.sub(0.958).div(0.012)
    const gap = float(1).sub(exp(gapX.mul(gapX).negate()).mul(0.85).mul(ignite))
    // the edge line stays crisp on every tier (gameplay info); the fill glow scales
    const glowC = A2.xyz.mul(casterBand).add(gap.mul(tierCol(lvl).mul(innerLine.add(boundary.mul(tierN(lvl, 0.85, 0.95, 1))).add(innerGlow.mul(tierN(lvl, 0.25, 0.65, 1))).add(runes).add(threads).add(runes2).add(runes3))
      .add(vec3(...HOT).mul(runes.mul(litFlash).add(tip.mul(0.4)).add(sweep.mul(boundary).mul(0.3))).mul(tierN(lvl, 0.25, 0.6, 1)))))
      .mul(live.mul(live)).mul(flick)
    const dm = new THREE.MeshBasicNodeMaterial()
    dm.transparent = true
    dm.depthWrite = false
    dm.positionNode = positionNode
    dm.colorNode = vec3(0.012, 0.0, 0.004)
    dm.opacityNode = saturate(darkA)
    dm.name = 'ScourgeWindupDark'
    const gm = new THREE.MeshBasicNodeMaterial()
    gm.transparent = true
    gm.depthWrite = false
    gm.blending = THREE.AdditiveBlending
    gm.positionNode = positionNode
    gm.colorNode = min(glowC, vec3(3))
    gm.opacityNode = float(1)
    gm.name = 'ScourgeWindupGlow'
    this.mats.push(dm, gm)
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, -1, 1, 0, 1, 1, 0], 3))
    g.setIndex([0, 1, 2, 2, 1, 3])
    this.geo = g
    this.dark = new THREE.Mesh(g, dm)
    this.glow = new THREE.Mesh(g, gm)
    for (const m of [this.dark, this.glow]) {
      m.count = 0
      m.frustumCulled = false
      m.visible = false
    }
    this.dark.renderOrder = 1
    this.glow.renderOrder = 3
    this.dark.name = 'scourge-windup-dark'
    this.glow.name = 'scourge-windup'
  }

  begin(): void {
    this.n = 0
  }

  add(x: number, y: number, h: number, R: number, progress: number, cancel: number, seed: number, age: number, level: number, caster: readonly number[]): void {
    if (this.n >= WC) return
    const o = this.n * 4
    const a0 = this.a0.array as Float32Array
    const a1 = this.a1.array as Float32Array
    const a2 = this.a2.array as Float32Array
    a2[o] = caster[0]
    a2[o + 1] = caster[1]
    a2[o + 2] = caster[2]
    a0[o] = x * S
    a0[o + 1] = h * S
    a0[o + 2] = -y * S
    a0[o + 3] = R
    a1[o] = progress
    a1[o + 1] = cancel
    a1[o + 2] = Math.max(1, Math.min(3, level)) * 100 + (seed % 100)
    a1[o + 3] = age
    this.n++
  }

  commit(): void {
    for (const m of [this.dark, this.glow]) {
      m.count = this.n
      m.visible = this.n > 0
    }
    if (this.n > 0) {
      this.a0.needsUpdate = true
      this.a1.needsUpdate = true
      this.a2.needsUpdate = true
    }
  }

  dispose(): void {
    for (const m of this.mats) m.dispose()
    this.geo.dispose()
  }
}

// ---------------------------------------------------------------- release decals (stateless)

const RD = 12

class ReleaseDecals {
  readonly dark: THREE.Mesh
  readonly glow: THREE.Mesh
  private a0: THREE.InstancedBufferAttribute
  private a1: THREE.InstancedBufferAttribute
  private a2: THREE.InstancedBufferAttribute
  private mats: THREE.MeshBasicNodeMaterial[] = []
  private geo: THREE.BufferGeometry
  private cursor = 0
  private dirty = false

  constructor(private ctx: VfxCtx) {
    const mk = () => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(RD * 4), 4)
      a.setUsage(THREE.DynamicDrawUsage)
      return a
    }
    this.a0 = mk() // centre (three), born
    this.a1 = mk() // R (game), seed, life, level
    this.a2 = mk() // caster colour (linear, peak 1), -
    const a0 = this.a0.array as Float32Array
    const a1 = this.a1.array as Float32Array
    for (let i = 0; i < RD; i++) {
      a0[i * 4 + 3] = -1e4
      a1[i * 4 + 2] = 1
    }
    const A0 = asV4(instancedBufferAttribute(this.a0))
    const A1 = asV4(instancedBufferAttribute(this.a1))
    const A2 = asV4(instancedBufferAttribute(this.a2))
    const w = ctx.world
    const ageVert = w.uTime.sub(A0.w)
    const aliveVert = step(0, ageVert).mul(step(ageVert, A1.z))
    const q = positionGeometry.xy
    const positionNode = A0.xyz.add(vec3(q.x, 0, q.y.negate()).mul(A1.x.mul(S * QUAD).mul(aliveVert)))
    // clock via varying, clamped (no negative ages -> no Inf / NaN into bloom)
    const age = max(varying(ageVert), 0)
    const tn = age.div(A1.z)
    const alive = step(tn, 1)
    const seed = A1.y
    const rn = length(q).mul(QUAD)
    const a = ang01(q)
    const n1 = texture(w.noise, q.mul(0.5).add(seed)).r
    const n2 = texture(w.noise, q.mul(1.4).add(seed.mul(1.7))).g

    // shockwave: centre -> exactly R in SWEEP_S, hot edge, then rests on R
    const sp = saturate(age.div(SWEEP_S))
    const f = float(1).sub(pow(float(1).sub(sp), 2.4))
    const sx = rn.sub(f).div(0.035)
    const shock = exp(sx.mul(sx).negate()).mul(float(1).sub(smoothstep(SWEEP_S, SWEEP_S + 0.22, age))).mul(step(rn, 1.0))
    const hx = rn.sub(1).div(0.0055)
    const hold = exp(hx.mul(hx).negate()).mul(smoothstep(SWEEP_S * 0.8, SWEEP_S, age)).mul(float(1).sub(smoothstep(0.3, 0.75, age)))
    const revealed = step(rn, f)
    const wake = smoothstep(f, f.sub(0.3), rn).mul(revealed)

    // radial cracks (worley edges in polar space: long along the radius), glowing then cooling
    const cb = texture(w.noise, vec2(a.mul(5), rn.mul(0.36).add(seed))).b
    const cb2 = texture(w.noise, vec2(a.mul(11).add(0.31), rn.mul(0.8).add(seed.mul(2)))).b
    const crack = max(float(1).sub(smoothstep(0.05, 0.16, cb)), float(1).sub(smoothstep(0.04, 0.11, cb2)).mul(0.6))
      .mul(smoothstep(1.0, 0.82, rn)).mul(smoothstep(0.04, 0.14, rn)).mul(smoothstep(0.22, 0.5, n2)).mul(revealed)
    // one coordinated ease-out: fast cool-down, then a crisp end (explicit
    // seconds, not fractions of a long life, so nothing trails semi-transparent)
    // glow cools straight to nothing (no dim-red floor that reads as a smear);
    // the charred black cracks of the dark layer carry the leftover
    const heat = exp(age.mul(-2.8))
    const glowEnd = float(1).sub(smoothstep(0.5, 0.85, age))
    const crackGlow = mix(vec3(...DEEP), vec3(...CRIMSON), heat).mul(crack).mul(heat.mul(1.3)).mul(glowEnd)
    const coreBurn = smoothstep(0.32, 0.0, rn).mul(exp(age.mul(-4))).mul(0.5)
    const fillEnd = float(1).sub(smoothstep(0.85, 1.4, age))
    const crackEnd = float(1).sub(smoothstep(1.25, 1.8, age))
    const fill = smoothstep(1.0, 0.15, rn.add(n1.sub(0.5).mul(0.25))).mul(0.62).mul(fillEnd)
    // L1 leaves no filled disc and only a ghost of the cracks; L2 half; L3 full
    const lvlD = A1.w
    const darkA = max(fill.mul(tierN(lvlD, 0, 0.5, 1)), crack.mul(0.95).mul(crackEnd).mul(tierN(lvlD, 0.15, 0.6, 1))).mul(revealed)
      .add(wake.mul(0.25).mul(fillEnd).mul(tierN(lvlD, 0.4, 0.75, 1)))
    // tiers: L2+ an echo shockwave 0.1 s behind the first, L3 a ring of rune
    // ticks burnt in just inside the edge (cools with the cracks)
    const lvl = A1.w
    const age2 = age.sub(0.1)
    const sp2 = saturate(age2.div(SWEEP_S * 1.1))
    const f2 = float(1).sub(pow(float(1).sub(sp2), 2.4)).mul(0.96)
    const ex = rn.sub(f2).div(0.022)
    const echo = exp(ex.mul(ex).negate()).mul(step(0, age2)).mul(float(1).sub(smoothstep(SWEEP_S + 0.08, SWEEP_S + 0.32, age))).mul(step(1.5, lvl))
    const tu = abs(fract(a.mul(48)).sub(0.5))
    const ticks = smoothstep(0.12, 0.05, tu).mul(smoothstep(0.84, 0.86, rn)).mul(smoothstep(0.95, 0.93, rn))
      .add(smoothstep(0.004, 0.0015, abs(rn.sub(0.83))))
      .mul(revealed).mul(exp(age.mul(-1.8))).mul(glowEnd).mul(step(2.5, lvl))
    // L1: the quick shockwave ring and the edge only (no crack blaze, no core
    // burn); L2 some; L3 everything
    // caster band rests with the edge after the sweep (same timing as `hold`)
    const rbx = rn.sub(0.958).div(0.0042)
    const casterBand = exp(rbx.mul(rbx).negate()).mul(smoothstep(SWEEP_S * 0.8, SWEEP_S, age)).mul(float(1).sub(smoothstep(0.3, 0.75, age))).mul(0.8)
    const glowC = A2.xyz.mul(casterBand).add(tierCol(lvl).mul(shock.mul(tierN(lvl, 0.9, 1, 1)).add(hold.mul(0.85)).add(echo.mul(0.75)).add(ticks.mul(1.2)))
      .add(vec3(...HOT).mul(shock.mul(tierN(lvl, 0.12, 0.25, 0.35)).add(coreBurn.mul(tierN(lvl, 0.2, 0.6, 1)))))
      .add(crackGlow.mul(tierN(lvl, 0, 0.5, 1.09))))
      .mul(alive)
    const dm = new THREE.MeshBasicNodeMaterial()
    dm.transparent = true
    dm.depthWrite = false
    dm.positionNode = positionNode
    dm.colorNode = mix(vec3(0.02, 0.006, 0.006), vec3(0.008, 0.004, 0.004), crack)
    dm.opacityNode = saturate(darkA).mul(alive).mul(smoothstep(0, 0.03, age))
    dm.name = 'ScourgeReleaseDark'
    const gm = new THREE.MeshBasicNodeMaterial()
    gm.transparent = true
    gm.depthWrite = false
    gm.blending = THREE.AdditiveBlending
    gm.positionNode = positionNode
    const gcol = min(glowC, vec3(3))
    gm.colorNode = gcol
    gm.opacityNode = float(1)
    if (ctx.tier.heatHaze) gm.mrtNode = mrt({ heat: vec4(saturate(shock.mul(tierN(lvlD, 0.35, 0.55, 0.7)).add(crack.mul(heat).mul(glowEnd).mul(tierN(lvlD, 0, 0.12, 0.25)))).mul(alive), 0, 0, 1) })
    gm.name = 'ScourgeReleaseGlow'
    this.mats.push(dm, gm)
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, -1, 1, 0, 1, 1, 0], 3))
    g.setIndex([0, 1, 2, 2, 1, 3])
    this.geo = g
    this.dark = new THREE.Mesh(g, dm)
    this.glow = new THREE.Mesh(g, gm)
    for (const m of [this.dark, this.glow]) {
      m.count = RD
      m.frustumCulled = false
    }
    this.dark.renderOrder = 1
    this.glow.renderOrder = 3
    this.dark.name = 'scourge-release-dark'
    this.glow.name = 'scourge-release'
    this.dark.onBeforeRender = () => this.commit()
  }

  spawn(x: number, y: number, h: number, R: number, level: number, caster: readonly number[]): void {
    const i = this.cursor
    this.cursor = (this.cursor + 1) % RD
    const o = i * 4
    const a0 = this.a0.array as Float32Array
    const a1 = this.a1.array as Float32Array
    const a2 = this.a2.array as Float32Array
    a2[o] = caster[0]
    a2[o + 1] = caster[1]
    a2[o + 2] = caster[2]
    a0[o] = x * S
    a0[o + 1] = h * S
    a0[o + 2] = -y * S
    a0[o + 3] = this.ctx.world.uTime.value
    a1[o] = R
    a1[o + 1] = rnd() * 13
    a1[o + 2] = RELEASE_LIFE
    a1[o + 3] = level
    this.dirty = true
  }

  commit(): void {
    if (!this.dirty) return
    this.dirty = false
    this.a0.needsUpdate = true
    this.a1.needsUpdate = true
    this.a2.needsUpdate = true
  }

  dispose(): void {
    for (const m of this.mats) m.dispose()
    this.geo.dispose()
  }
}

// ---------------------------------------------------------------- state

interface Windup {
  pawn: EntityId
  /** spell level 1..3 (visual tier) */
  level: number
  /** world clock when the windup started */
  t0: number
  /** windup length (s), from castStart */
  total: number
  /** world clock of the cancel, -1 = running / released */
  cancelAt: number
  /** progress at the cancel */
  cancelP: number
  active: boolean
  x: number
  y: number
  h: number
  seed: number
  /** caster colour, linear, peak 1 (the pawn ring's colour) */
  col: [number, number, number]
  /** the caster is the local player: full telegraph; else only the subtle cue */
  local: boolean
  acc: number
  acc2: number
  acc3: number
}

interface Release {
  level: number
  x: number
  y: number
  h: number
  R: number
  t0: number
  acc: number
  acc2: number
  on: boolean
}

interface RimFlash {
  pawn: EntityId
  t0: number
  on: boolean
}

const windups: Windup[] = []
for (let i = 0; i < 8; i++) windups.push({ pawn: -1, level: 1, t0: 0, total: WINDUP_S, cancelAt: -1, cancelP: 0, active: false, x: 0, y: 0, h: 0, seed: 0, col: [1, 1, 1], local: false, acc: 0, acc2: 0, acc3: 0 })
const releases: Release[] = []
for (let i = 0; i < 8; i++) releases.push({ level: 1, x: 0, y: 0, h: 0, R: R_DEFAULT, t0: 0, acc: 0, acc2: 0, on: false })
const rims: RimFlash[] = []
for (let i = 0; i < 12; i++) rims.push({ pawn: -1, t0: 0, on: false })

let circles: WindupCircles | null = null
let decals: ReleaseDecals | null = null
let bb: Billboards | null = null
let scene: THREE.Object3D | null = null
/** the world's ctx (for the local-player check in windupStyle) */
let vctx: VfxCtx | null = null
/** preallocated windupStyle results (called per winding-up pawn per frame) */
const STYLE_LOCAL: WindupStyle = { hide: ['rings', 'spiral', 'orb', 'ground'] }
const STYLE_OTHER: WindupStyle = { hide: ['rings', 'spiral', 'orb', 'ground', 'light'] }

function windupOf(pawn: EntityId, create: boolean, now: number): Windup | null {
  let free: Windup | null = null
  for (const w of windups) {
    if (w.pawn === pawn && (w.active || w.cancelAt >= 0)) return w
    if (!free && !w.active && (w.cancelAt < 0 || now - w.cancelAt > CANCEL_S)) free = w
  }
  if (!create) return null
  const w = free ?? windups[0]
  w.pawn = pawn
  w.active = false
  w.cancelAt = -1
  w.acc = w.acc2 = w.acc3 = 0
  w.seed = rnd() * 50
  return w
}

const isScourge = (s: string) => s.startsWith('scourge')

const tmpCol = new THREE.Color()
const relCol: [number, number, number] = [1, 1, 1]
/** 0xRRGGBB (sRGB, as the pawn ring) -> linear, brightest channel 1, written into out */
function casterRGB(hex: number, out: [number, number, number]): [number, number, number] {
  tmpCol.setHex(hex, THREE.SRGBColorSpace)
  const k = 1 / Math.max(1e-3, tmpCol.r, tmpCol.g, tmpCol.b)
  out[0] = tmpCol.r * k
  out[1] = tmpCol.g * k
  out[2] = tmpCol.b * k
  return out
}

/** Owner of the pawn standing at (x, y): the Scourge caster at its blast centre. */
function ownerAt(ctx: VfxCtx, x: number, y: number): number {
  const st = ctx.state
  if (!st) return -1
  let best = 1e9
  let owner = -1
  for (const p of st.pawns) {
    const d = Math.hypot(p.x - x, p.y - y)
    if (d < best) {
      best = d
      owner = p.owner
    }
  }
  return owner
}

/** Visual tier: the event's `level` when the sim sends it, else the caster's Scourge slot level. */
function levelOf(ctx: VfxCtx, e: object, pawnId: EntityId | null, x?: number, y?: number): number {
  const l = (e as { level?: number }).level
  if (typeof l === 'number' && l > 0) return Math.min(3, l)
  const st = ctx.state
  if (!st) return 1
  let pawn = pawnId !== null ? st.pawns.find((p) => p.id === pawnId) : undefined
  if (!pawn && x !== undefined && y !== undefined) {
    // explosion: the caster stands at its centre
    let best = 1e9
    for (const p of st.pawns) {
      const d = Math.hypot(p.x - x, p.y - (y ?? 0))
      if (d < best) {
        best = d
        pawn = p
      }
    }
  }
  if (!pawn) return 1
  const i = pawn.slots.findIndex((s) => s !== null && isScourge(s))
  return i >= 0 ? Math.max(1, Math.min(3, pawn.levels[i] || 1)) : 1
}

// ---------------------------------------------------------------- per-frame emission

/** Camera-plane stroke on the real raised hands, rebuilt every rendered frame. */
function bloodStroke(ctx: VfxCtx, hand: THREE.Vector3, x0: number, y0: number, x1: number, y1: number, strength: number): void {
  if (!bb) return
  const e = ctx.camera.matrixWorld.elements
  const mx = (x0 + x1) * 0.5 * S
  const my = (y0 + y1) * 0.5 * S
  const dx = x1 - x0
  const dy = y1 - y0
  const width = 4 * S
  bb.addStreak(hand.x + e[0] * mx + e[4] * my, hand.y + e[1] * mx + e[5] * my, hand.z + e[2] * mx + e[6] * my,
    width, Math.hypot(dx, dy) * S / width, Math.atan2(dy, dx), CRIMSON[0] * strength, CRIMSON[1] * 2 * strength, CRIMSON[2] * 2 * strength, 0.8)
}

function windupFx(ctx: VfxCtx, w: Windup, p: number): void {
  const info = ctx.pawn(w.pawn)
  if (!info) return
  const hand = info.castOrigin
  const k = (0.45 + p * 0.55) * tier(w.level, 0.55, 0.8, 1)
  // A blood crown stays on the joined hands: three connected teeth, no orb,
  // free motes, overhead body, or growing outward flight silhouette.
  bloodStroke(ctx, hand, -23, -12, -23, 9, k)
  bloodStroke(ctx, hand, -23, 9, -10, -2, k)
  bloodStroke(ctx, hand, -10, -2, 0, 19, k)
  bloodStroke(ctx, hand, 0, 19, 10, -2, k)
  bloodStroke(ctx, hand, 10, -2, 23, 9, k)
  bloodStroke(ctx, hand, 23, 9, 23, -12, k)
  bloodStroke(ctx, hand, 23, -12, -23, -12, k)
  if (w.level >= 2) bloodStroke(ctx, hand, -19, -18, 19, -18, k * 0.7)
  if (w.level >= 3) {
    bloodStroke(ctx, hand, -7, -5, 0, 7, k * 0.8)
    bloodStroke(ctx, hand, 0, 7, 7, -5, k * 0.8)
  }
  if (ctx.quality !== 'low') ctx.glow.add(w.x, w.y, R_DEFAULT * 0.7, (0.06 + 0.2 * p) * tier(w.level, 0.35, 0.7, 1), 1.0, 0.03, 0.04)
  ctx.shakeNear(w.x, w.y, (0.02 + 0.16 * p) * tier(w.level, 0.5, 0.75, 1) * 6 * ctx.dt)
}

const CROWN_N = 9
function crownBurst(ctx: VfxCtx, x: number, y: number, h: number): void {
  const ps = ctx.particles
  for (let i = 0; i < CROWN_N; i++) {
    const a = (i / CROWN_N) * TAU
    // each blade flies out and down, inside the radius
    for (let j = 0; j < 3; j++) {
      const sp = 260 + j * 80
      ps.spawn(x + Math.cos(a) * 30, y + Math.sin(a) * 30, h, Math.cos(a) * sp, Math.sin(a) * sp, -120, 0.42, 9 - j * 2, 2, CRIMSON[0] * 1.3, CRIMSON[1] * 2.5, CRIMSON[2] * 2.5, -900, 2.4, -0.12)
    }
  }
}

/** Crimson hit on a warlock: spark cone along the push, dark burst, floor ring. */
function hitImpact(ctx: VfxCtx, target: EntityId, x: number, y: number, kb: number): void {
  const st = ctx.state
  // push direction: away from the blast centre (the caster that just cast Scourge)
  let dx = 0
  let dy = 0
  let lv = 1
  for (const r of releases) {
    if (r.on && ctx.now - r.t0 < 0.1) {
      dx = x - r.x
      dy = y - r.y
      lv = r.level
    }
  }
  const tp = st?.pawns.find((p) => p.id === target)
  if (dx === 0 && dy === 0 && tp) {
    dx = tp.vx
    dy = tp.vy
  }
  const dl = Math.hypot(dx, dy) || 1
  dx /= dl
  dy /= dl
  const info = ctx.pawn(target)
  const h = (info?.h ?? 30) + 60
  const k = Math.min(1.4, kb / 900)
  const ps = ctx.particles
  const base = Math.atan2(dy, dx)
  const n = ps.budget((18 + 22 * k) * tier(lv, 0.6, 0.8, 1))
  for (let i = 0; i < n; i++) {
    const a = base + (rnd() - 0.5) * 1.2
    const sp = 400 + rnd() * 700
    ps.spawn(x, y, h, Math.cos(a) * sp, Math.sin(a) * sp, 60 + rnd() * 260, 0.18 + rnd() * 0.22, 6, 1, CRIMSON[0] * 1.3, CRIMSON[1] * 3 + 0.1, CRIMSON[2] * 2.5, -1200, 3, -0.12)
  }
  const ns = ctx.smoke.budget(5)
  for (let i = 0; i < ns; i++) {
    ctx.smoke.spawn(x, y, h - 10, dx * (60 + rnd() * 80), dy * (60 + rnd() * 80), 40, 0.6 + rnd() * 0.3, 26, 80, 0.025, 0.004, 0.008, 10, 1.4, 8)
  }
  const f = decalFloor(ctx, x, y) + 1
  ctx.ground.spawn(RING_EXPAND, x, y, f, 14, 70 + 50 * k, 0.3, 8, CRIMSON[0] * 0.9, CRIMSON[1], CRIMSON[2])
}

/** Others see only an immediate body heartbeat, never the local pose or blast radius. */
function windupCue(ctx: VfxCtx, w: Windup, p: number): void {
  if (!bb) return
  const lk = tier(w.level, 0.65, 0.85, 1.05)
  const X = w.x * S
  const Z = -w.y * S
  const interval = 0.42 - 0.31 * Math.pow(p, 1.3)
  w.acc2 += ctx.dt
  if (w.acc2 >= interval) w.acc2 = 0
  const env = Math.exp(-w.acc2 * 14)
  const base = (0.3 + 0.7 * p) * lk
  const k = base * (0.55 + 0.45 * env)
  const zs = Math.min(1.8, Math.max(1, Math.sqrt(cameraZoomParam.distance / 1100)))
  bb.add(X, (w.h + BODY_H * 0.5) * S, Z, (96 + 14 * env) * zs * S, CRIMSON[0] * 0.8 * k, CRIMSON[1] * 1.4 * k, CRIMSON[2] * 1.3 * k, -2.0)
  bb.add(X, (w.h + BODY_H * 0.5) * S, Z, 78 * zs * S, CRIMSON[0] * 0.26 * k, CRIMSON[1] * 0.4 * k, CRIMSON[2] * 0.45 * k, 1.4)
}

function releaseBurst(ctx: VfxCtx, x: number, y: number, h: number, R: number, level: number): void {
  const ps = ctx.particles
  if (level >= 3) crownBurst(ctx, x, y, h + BODY_H + 52)
  const pk = tier(level, 0.35, 0.65, 1)
  // short coloured flash at the slam (never white): L1 small, L3 full
  const fk = tier(level, 0.45, 0.7, 1) * (0.45 + 0.55 * ctx.fx)
  ctx.flash(x, y, h + 60, tier(level, 0.12, 0.16, 0.2), R * 0.7, tier(level, 110, 150, 190), CRIMSON[0] * fk, CRIMSON[1] * 2 * fk, CRIMSON[2] * 2 * fk)
  // black-red debris and embers outward; drag-limited so nothing travels past ~0.95 R
  const nd = ctx.debris.budget(34 * pk)
  for (let i = 0; i < nd; i++) {
    const a = rnd() * TAU
    const r0 = rnd() * R * 0.35
    const life = 0.7 + rnd() * 0.4
    const k = 2.4
    const reach = (R * 0.92 - r0) * (0.4 + rnd() * 0.6)
    const sp = (reach * k) / (1 - Math.exp(-k * life))
    const red = rnd() < 0.35
    ctx.debris.spawn(x + Math.cos(a) * r0, y + Math.sin(a) * r0, h + 8, Math.cos(a) * sp, Math.sin(a) * sp, 240 + rnd() * 300, life, 5 + rnd() * 7, 3, red ? 0.16 : 0.025, red ? 0.012 : 0.012, red ? 0.014 : 0.012, -1700, k, 0)
  }
  const ne = ps.budget(56 * pk)
  for (let i = 0; i < ne; i++) {
    const a = rnd() * TAU
    const life = 0.45 + rnd() * 0.45
    const k = 3
    const reach = R * (0.35 + rnd() * 0.55)
    const sp = (reach * k) / (1 - Math.exp(-k * life))
    ps.spawn(x, y, h + 20 + rnd() * 40, Math.cos(a) * sp, Math.sin(a) * sp, 80 + rnd() * 220, life, 7 + rnd() * 5, -2, CRIMSON[0] * 1.2, CRIMSON[1] * 2.5 + 0.08, CRIMSON[2] * 1.5, -500, k, rnd() < 0.5 ? -0.06 : 5)
  }
  // dark burst from the slam point
  const ns = ctx.smoke.budget(16 * pk)
  for (let i = 0; i < ns; i++) {
    const a = rnd() * TAU
    const sp = 80 + rnd() * 160
    ctx.smoke.spawn(x, y, h + 10 + rnd() * 30, Math.cos(a) * sp, Math.sin(a) * sp, 60 + rnd() * 90, 0.7 + rnd() * 0.3, 40, 110, 0.02, 0.004, 0.008, 10, 1.8, 14)
  }
}

function releaseTick(ctx: VfxCtx, r: Release): void {
  const age = ctx.now - r.t0
  if (age > 0.7) {
    r.on = false
    return
  }
  const R = r.R
  const ps = ctx.particles
  // shadow flames along the front while it sweeps, then along the rim
  const sp = Math.min(1, age / SWEEP_S)
  const f = 1 - Math.pow(1 - sp, 2.4)
  const rf = Math.min(R * 0.97, R * f)
  const k = age < SWEEP_S ? 1 : Math.max(0, 1 - (age - SWEEP_S) / 0.45)
  // flame density per tier (L3 unchanged: 1.7)
  const n = emitN2(ctx, r, 'acc', 260 * k * (0.35 + f) * tier(r.level, 0.35, 0.85, 1.7))
  for (let i = 0; i < n; i++) {
    const a = rnd() * TAU
    const rr = rf * (0.94 + rnd() * 0.05)
    const px = r.x + Math.cos(a) * rr
    const py = r.y + Math.sin(a) * rr
    // flames lean inward and up (never past R)
    ps.spawn(px, py, r.h + 4, -Math.cos(a) * 25, -Math.sin(a) * 25, 120 + rnd() * 160, 0.28 + rnd() * 0.25, 12 + rnd() * 10, -3, CRIMSON[0], CRIMSON[1] * 1.6, CRIMSON[2] * 1.4, 160, 1.5, 4)
    if (rnd() < 0.45) {
      const g = 0.012 + rnd() * 0.01
      ctx.smoke.spawn(px, py, r.h + 10, -Math.cos(a) * 20, -Math.sin(a) * 20, 70 + rnd() * 70, 0.55 + rnd() * 0.3, 18, 46, g + 0.015, g * 0.2, g * 0.4, 20, 1, 8)
    }
  }
  if (ctx.quality !== 'low') ctx.glow.add(r.x, r.y, R * 0.9, 0.35 * (1 - age / 0.7) * tier(r.level, 0.35, 0.7, 1), 1.0, 0.04, 0.04)
}

/** Release-only tier-scaled continuous counts with a fractional carry. */
function emitN2(ctx: VfxCtx, r: Release, which: 'acc' | 'acc2', rate: number): number {
  const v = r[which] + rate * ctx.dt * ctx.tier.particles
  const n = Math.floor(v)
  r[which] = v - n
  return n
}

// ---------------------------------------------------------------- module

registerSpellVfx({
  spell: 'scourge',
  init(ctx) {
    vctx = ctx
    if (circles) return
    circles = new WindupCircles(ctx)
    decals = new ReleaseDecals(ctx)
    bb = new Billboards(96, false, ctx.world.field)
    bb.sprite.name = 'scourge-glow'
    scene = ctx.scene
    ctx.scene.add(circles.dark, circles.glow, decals.dark, decals.glow, bb.sprite)
  },
  onEvent(e, ctx) {
    const now = ctx.now
    switch (e.type) {
      case 'castStart': {
        if (!isScourge(e.spell)) return false
        const w = windupOf(e.pawn, true, now)!
        w.level = levelOf(ctx, e, e.pawn)
        const owner = ctx.pawn(e.pawn)?.owner ?? -1
        casterRGB(colorForPawn(ctx.state, owner), w.col)
        w.local = owner >= 0 && owner === ctx.localPlayer
        w.acc = w.acc2 = w.acc3 = 0
        w.active = true
        w.cancelAt = -1
        w.t0 = now
        w.total = Math.max(0.1, e.ticks / 60)
        return true
      }
      case 'castCancel': {
        if (!isScourge(e.spell) || !e.started) return false
        const w = windupOf(e.pawn, false, now)
        if (w && w.active) {
          w.active = false
          w.cancelAt = now
          w.cancelP = Math.min(1, (now - w.t0) / w.total)
        }
        return true
      }
      case 'cast': {
        if (!isScourge(e.spell)) return false
        const w = windupOf(e.pawn, false, now)
        if (w) {
          w.active = false
          w.cancelAt = -1
        }
        return true
      }
      case 'explosion': {
        if (!isScourge(e.spell)) return false
        const h = decalFloor(ctx, e.x, e.y) - 0.3
        const level = levelOf(ctx, e, null, e.x, e.y)
        casterRGB(colorForPawn(ctx.state, ownerAt(ctx, e.x, e.y)), relCol)
        decals?.spawn(e.x, e.y, h, e.radius, level, relCol)
        let slot = releases[0]
        for (const r of releases) {
          if (!r.on) {
            slot = r
            break
          }
          if (r.t0 < slot.t0) slot = r
        }
        slot.x = e.x
        slot.y = e.y
        slot.h = h
        slot.R = e.radius
        slot.level = level
        slot.t0 = now
        slot.acc = slot.acc2 = 0
        slot.on = true
        releaseBurst(ctx, e.x, e.y, h, e.radius, level)
        ctx.shakeNear(e.x, e.y, tier(level, 0.2, 0.28, 0.34))
        return true
      }
      case 'damage': {
        const cause = ctx.damageCause(e)
        if (e.kb <= 0 || cause === null || !isScourge(cause)) return false
        hitImpact(ctx, e.target, e.x, e.y, e.kb)
        let slot = rims[0]
        for (const r of rims) {
          if (!r.on) {
            slot = r
            break
          }
          if (r.t0 < slot.t0) slot = r
        }
        slot.pawn = e.target
        slot.t0 = now
        slot.on = true
        // claimed: the built-in warm-white hit impact is replaced by the crimson one
        // (core still applies the cloth impulse, after-hit wisps and the damage number)
        return true
      }
    }
    return false
  },
  // the shared hand-cast arm rings and spiral clash with the summon pose and
  // the tame L1; this module draws its own hand crown
  // + 'ground': the shared cast ring under the caster would warn everyone;
  // + 'light' for anyone but the local caster: no floor-light tell either
  windupStyle: (_spell, caster) => (caster && vctx && caster.owner >= 0 && caster.owner === vctx.localPlayer ? STYLE_LOCAL : STYLE_OTHER),
  beginFrame() {
    // every rendered frame (also frozen ones): the batches are refilled in frame()
    circles?.begin()
    bb?.begin()
  },
  frame(ctx) {
    if (!circles || !bb) return
    const now = ctx.now
    const st = ctx.state
    for (const w of windups) {
      if (w.pawn < 0) continue
      const info = ctx.pawn(w.pawn)
      // Recheck even while cancelling: a spectator/POV change must never
      // retain the previous local caster's full-radius targeting preview.
      w.local = !!info && info.owner >= 0 && info.owner === ctx.localPlayer
      if (w.active) {
        const ps = st?.pawns.find((q) => q.id === w.pawn)
        if (!ps || !ps.alive || !ps.cast || !isScourge(ps.cast.spell) || ps.cast.started === false || !info || !info.alive) {
          // A charge only exists while that exact kind of live cast exists.
          // Missing cancel events must not leave its marks or radius behind.
          w.active = false
          w.cancelAt = -1
          w.pawn = -1
          continue
        }
        const total = Math.max(1, Math.round(w.total * 60))
        const p = Math.max(0, Math.min(1, 1 - (ps.cast.ticksLeft - ctx.alpha) / total))
        w.x = info.x
        w.y = info.y
        w.h = info.h
        // read live: Shuffle re-teams between rounds; the POV can change (spectating)
        casterRGB(colorForPawn(st, info.owner), w.col)
        if (w.active) {
          if (w.local) {
            circles.add(w.x, w.y, decalFloor(ctx, w.x, w.y) + 0.4, R_DEFAULT, p, 0, w.seed, now - w.t0, w.level, w.col)
            windupFx(ctx, w, p)
          } else {
            windupCue(ctx, w, p)
          }
        }
      }
      if (!w.active && w.cancelAt >= 0) {
        const c = (now - w.cancelAt) / CANCEL_S
        if (c >= 1) {
          w.cancelAt = -1
          w.pawn = -1
          continue
        }
        if (w.local) circles.add(w.x, w.y, decalFloor(ctx, w.x, w.y) + 0.4, R_DEFAULT, w.cancelP, c, w.seed, now - w.t0, w.level, w.col)
      }
    }
    for (const r of releases) if (r.on) releaseTick(ctx, r)
    // crimson rim flash on every warlock the blast hit
    for (const r of rims) {
      if (!r.on) continue
      const k = 1 - (now - r.t0) / 0.3
      const info = ctx.pawn(r.pawn)
      if (k <= 0 || !info) {
        r.on = false
        continue
      }
      const kk = k * k
      bb.add(info.x * S, (info.h + BODY_H * 0.5) * S, -info.y * S, 95 * S, CRIMSON[0] * 0.9 * kk, CRIMSON[1] * kk, CRIMSON[2] * kk, -2.2)
      bb.add(info.x * S, (info.h + BODY_H * 0.5) * S, -info.y * S, 70 * S, CRIMSON[0] * 0.5 * kk, 0.02 * kk, 0.03 * kk, 1.4)
    }
    circles.commit()
    bb.commit()
  },
  dispose() {
    if (scene) {
      if (circles) scene.remove(circles.dark, circles.glow)
      if (decals) scene.remove(decals.dark, decals.glow)
      if (bb) scene.remove(bb.sprite)
    }
    circles?.dispose()
    decals?.dispose()
    bb?.dispose()
    circles = null
    decals = null
    bb = null
    scene = null
    vctx = null
    for (const w of windups) {
      w.pawn = -1
      w.active = false
      w.cancelAt = -1
    }
    for (const r of releases) r.on = false
    for (const r of rims) r.on = false
  },
})
