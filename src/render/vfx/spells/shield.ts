/**
 * Shield (column 5 Defense, radiant gold-white). spells.md §8.20.
 * Cast (IMMEDIATE): a golden flare at the hand and the bubble inflates to EXACTLY the sim
 * radius (200..260) in 0.12 s. While the `shield` modifier runs: a hexagonal energy dome
 * (fresnel rim, glowing hex lattice, a slow shimmer sweeping up it) whose floor footprint is a
 * crisp gold ring at the radius; it fades over its last 0.2 s and pops into hex sparks.
 * 'shieldReflect': a ripple spreads over the dome from the contact point, sparks fan out along
 * the new heading, and when ownership is stolen the lattice flashes the shielder's team colour.
 */
import * as THREE from 'three/webgpu'
import { abs, dot, exp, float, max, min, mix, mod, mrt, normalView, positionGeometry, positionView, pow, saturate, select, sin, smoothstep, vec2, vec3, vec4 } from 'three/tsl'
import type { Node } from 'three/webgpu'
import type { ModifierState, PawnState, SimEvent } from '../../../sim/types'
import { S } from '../../coords'
import { RING_EXPAND } from '../../scene/GroundFx'
import { registerSpellVfx, type VfxCtx } from '../registry'
import {
  InstPool, STYLE_RING, STYLE_RUNES, TAU, burst, castFlash, drawCircle, floorH, glowG, hexRgb, kitAdopt, kitBegin, kitInit,
  kitRelease, light, rand,
  pal, tierCap, flashT, levelOf, tierOfLevel,
} from './kitB'

// identity: pale gold-white (vfx/palette.ts)
const GOLD = pal('shield', 'accent', 1.4)
const GOLD_WHITE = pal('shield', 'core', 2.0)

const SPELL = 'shield'
const INFLATE = 0.12
const FADE_TICKS = 12
/** dome height relative to the radius (a full hemisphere would tower over the camera) */
const DOME_H = 0.62

interface Bubble {
  seen: number
  since: number
  owner: number
  /** last two hits: direction (local unit, three space), time */
  h0: THREE.Vector4
  h1: THREE.Vector4
  tintAt: number
  tint: [number, number, number]
  R: number
}

let pool: InstPool | null = null
const bubbles = new Map<number, Bubble>()
let frameNo = 0
const team: [number, number, number] = [1, 1, 1]
const hv = new THREE.Vector3()

/**
 * Dome instance attributes:
 *   A0 x alpha, y seed, z tint flash 0..1, w power tier 0..2
 *   A1 xyz hit direction 0 (local), w hit time
 *   A2 xyz hit direction 1, w hit time
 *   A3 rgb tint colour
 */
function domeMaterial(ctx: VfxCtx, A: Node<'vec4'>[]): THREE.Material {
  const [A0, A1, A2, A3] = A
  const t = ctx.world.uTime
  const p = positionGeometry
  const n = p.normalize()
  const viewDir = positionView.negate().normalize()
  const ndv = saturate(abs(dot(normalView, viewDir)))
  // fine hex lattice on a stereographic projection of the dome (even cells over the cap)
  // power tier (A0.w 0..2): finer, denser lattice
  const q = p.xz.div(p.y.add(1.0)).mul(A0.w.mul(2.5).add(11))
  const R = vec2(1, 1.7320508)
  const Hh = R.mul(0.5)
  const a = mod(q, R).sub(Hh)
  const b = mod(q.sub(Hh), R).sub(Hh)
  const g = select(dot(a, a).lessThan(dot(b, b)), a, b)
  const hexd = max(abs(g.x).mul(0.866).add(abs(g.y).mul(0.5)), abs(g.y))
  const lattice = smoothstep(0.42, 0.49, hexd)
  const cellFill = smoothstep(0.2, 0.48, hexd)
  // shimmer sweeping up the dome
  const sweep = pow(saturate(sin(p.y.mul(9).sub(t.mul(3.2)).add(A0.y))), 6)
  // reflect hits: a bright ripple ring plus the hex cells lighting up around the impact
  const hit = (H: Node<'vec4'>) => {
    const age = t.sub(H.w)
    const d = float(1).sub(dot(n, H.xyz))
    const x = d.sub(age.mul(2.4)).div(0.05)
    const ring = exp(x.mul(x).negate()).mul(exp(age.mul(-4)))
    const cells = exp(d.mul(-30)).mul(exp(age.mul(-6))).mul(lattice.add(cellFill.mul(0.25)))
    return ring.mul(0.7).add(cells.mul(0.8)).mul(step01(age))
  }
  // capped: a burst of hits (reflects, blocked Lightning) can never flood the dome white
  const rip = min(hit(A1).add(hit(A2)), float(0.8))
  const base = smoothstep(0.0, 0.1, p.y)
  const gold = vec3(...GOLD)
  const white = vec3(...GOLD_WHITE)
  const latticeCol = mix(gold, A3.xyz.mul(2.2), A0.z)
  // nearly clear in the middle (the warlock reads through it); rim and grazing lattice carry it
  const graze = pow(float(1).sub(ndv), 1.6)
  const col = white.mul(pow(float(1).sub(ndv), 3.5).mul(0.7))
    .add(latticeCol.mul(lattice.mul(graze).mul(0.55)))
    .add(gold.mul(sweep.mul(lattice).mul(graze.add(0.15)).mul(0.3)))
    .add(gold.mul(rip))
  const m = new THREE.MeshBasicNodeMaterial()
  m.transparent = true
  m.depthWrite = false
  m.blending = THREE.AdditiveBlending
  m.colorNode = tierCap(ctx, col.mul(A0.x).mul(base), 1.8, 0.5, 0.5)
  m.opacityNode = float(1)
  // faint refraction at the rim on heat-haze tiers
  if (ctx.tier.heatHaze) m.mrtNode = mrt({ heat: vec4(graze.mul(0.35).mul(A0.x).mul(base), 0, 0, 1) })
  m.name = 'VfxB-ShieldDome'
  return m
}

/** 1 for age >= 0 (hit happened), 0 before / unused slots. */
function step01(age: Node<'float'>): Node<'float'> {
  return smoothstep(-0.001, 0.0, age)
}

function bubble(id: number, owner: number, now: number): Bubble {
  let b = bubbles.get(id)
  if (!b) {
    b = { seen: 0, since: now, owner, h0: new THREE.Vector4(0, 1, 0, -100), h1: new THREE.Vector4(0, 1, 0, -100), tintAt: -100, tint: [1, 1, 1], R: 220 }
    bubbles.set(id, b)
  }
  return b
}

function pop(ctx: VfxCtx, x: number, y: number, h: number, R: number): void {
  const fh = floorH(ctx, x, y)
  const ps = ctx.particles
  const n = ps.budget(40)
  for (let i = 0; i < n; i++) {
    const a = Math.random() * TAU
    const el = Math.random() * 1.2
    const rr = R * 0.98
    const px = x + Math.cos(a) * Math.cos(el) * rr
    const py = y + Math.sin(a) * Math.cos(el) * rr
    const ph = fh + Math.sin(el) * R * DOME_H
    ps.spawn(px, py, ph, Math.cos(a) * rand(-60, 40), Math.sin(a) * rand(-60, 40), rand(-40, 80), rand(0.3, 0.6), rand(10, 18), 2, GOLD[0], GOLD[1], GOLD[2], -200, 2, 0)
  }
  ctx.ground.spawn(RING_EXPAND, x, y, fh, R * 0.9, R - 3, 0.25, 6, GOLD[0] * 0.6, GOLD[1] * 0.6, GOLD[2] * 0.6)
  void h
}

registerSpellVfx({
  spell: SPELL,
  modifiers: [SPELL],
  init(ctx: VfxCtx) {
    kitInit(ctx)
    const geo = new THREE.SphereGeometry(1, 56, 20, 0, TAU, 0, Math.PI / 2)
    pool = kitAdopt(new InstPool(geo, 4, 12, (A) => domeMaterial(ctx, A), 8, 'vfxB-shield-domes'))
  },
  dispose() {
    pool = null
    bubbles.clear()
    kitRelease()
  },
  onEvent(e: SimEvent, ctx: VfxCtx): boolean | void {
    switch (e.type) {
      case 'cast':
        if (e.spell !== SPELL) return
        castFlash(ctx, e.pawn, GOLD_WHITE, 0.8)
        return true
      case 'modifier': {
        if (e.id !== SPELL) return
        const info = ctx.pawn(e.pawn)
        if (!info) return
        if (e.on) {
          bubble(e.pawn, info.owner, ctx.now).since = ctx.now
          burst(ctx, info.x, info.y, info.h + 70, 26, 200, 500, 0.2, 0.4, 12, 3, GOLD_WHITE, 0.9, -300, 3, -0.06, 40, 220)
        } else {
          pop(ctx, info.x, info.y, info.h, bubbles.get(e.pawn)?.R ?? 220)
        }
        return
      }
      case 'beam': {
        // Lightning stopped by this bubble: a local, short ripple where it struck (Lightning's
        // own module draws the bolt and its spark; nothing here is screen-wide)
        if (!e.blocked || e.target === null) return
        const b = bubbles.get(e.target)
        const info = ctx.pawn(e.target)
        if (!b || !info) return
        const dx = e.fromX - info.x
        const dy = e.fromY - info.y
        const l = Math.hypot(dx, dy) || 1
        const tmp = b.h0
        b.h0 = b.h1
        b.h1 = tmp
        hv.set(dx / l, 0.3, -dy / l).normalize()
        b.h1.set(hv.x, hv.y, hv.z, ctx.now)
        return
      }
      case 'shieldReflect': {
        const info = ctx.pawn(e.pawn)
        const b = bubbles.get(e.pawn)
        const fh = floorH(ctx, e.x, e.y)
        if (info && b) {
          // ripple from the contact direction (three local: x, h, -y)
          const dx = e.x - info.x
          const dy = e.y - info.y
          const l = Math.hypot(dx, dy) || 1
          const tmp = b.h0
          b.h0 = b.h1
          b.h1 = tmp
          hv.set(dx / l, 0.25, -dy / l).normalize()
          b.h1.set(hv.x, hv.y, hv.z, ctx.now)
          if (e.stolen) {
            b.tintAt = ctx.now
            hexRgb(ctx.colorOf(info.owner), b.tint)
          }
        }
        // sparks fanning out along the bounce, contact flash
        const st = ctx.state
        const proj = st?.projectiles.find((q) => q.id === e.projectile)
        const vx = proj ? proj.vx : e.x - (info?.x ?? e.x)
        const vy = proj ? proj.vy : e.y - (info?.y ?? e.y)
        const base = Math.atan2(vy, vx)
        const ps = ctx.particles
        const n = ps.budget(14)
        for (let i = 0; i < n; i++) {
          const a = base + rand(-0.6, 0.6)
          const sp = rand(250, 700)
          ps.spawn(e.x, e.y, fh + 40, Math.cos(a) * sp, Math.sin(a) * sp, rand(0, 160), rand(0.15, 0.3), 7, 1.5, GOLD[0] * 0.8, GOLD[1] * 0.8, GOLD[2] * 0.8, -800, 3, -0.1)
        }
        if (e.stolen && info) {
          hexRgb(ctx.colorOf(info.owner), team)
          burst(ctx, e.x, e.y, fh + 40, 12, 80, 220, 0.3, 0.5, 14, 3, team, 2.2, 0, 2.5)
        }
        // calm and local: a small glint on the bubble surface, no screen-wide flash / shake
        flashT(ctx, e.x, e.y, fh + 40, 0.08, 90, 60, GOLD[0] * 0.5, GOLD[1] * 0.5, GOLD[2] * 0.5)
        return
      }
      default:
        return
    }
  },
  frame(ctx: VfxCtx) {
    kitBegin(ctx)
    frameNo++
    for (const [id, b] of bubbles) if (frameNo - b.seen > 2) bubbles.delete(id)
  },
  drawModifier(pawn: PawnState, mod: ModifierState, x: number, y: number, ctx: VfxCtx) {
    const b = bubble(pawn.id, pawn.owner, ctx.now)
    if (frameNo - b.seen > 2 && b.seen !== 0) b.since = ctx.now
    b.seen = frameNo
    const R = mod.data.radius || 220
    b.R = R
    const age = ctx.now - b.since
    const k = Math.min(1, age / INFLATE)
    const grow = 1 - (1 - k) * (1 - k) * (1 - k)
    const fade = Math.min(1, mod.ticksLeft < 0 ? 1 : mod.ticksLeft / FADE_TICKS)
    const info = ctx.pawn(pawn.id)
    const fh = info ? info.h : 30
    const flashK = Math.max(0, 1 - (ctx.now - b.tintAt) / 0.5)
    if (pool) {
      pool.quat.identity()
      const i = pool.add(x * S, (fh + 0.5) * S, -y * S, R * grow * S, R * DOME_H * grow * S, R * grow * S)
      pool.set(i, 0, (0.75 + 0.6 * flashK) * fade, pawn.id * 1.7, flashK, tierOfLevel(ctx, levelOf(ctx, pawn.owner, SPELL)))
      pool.set(i, 1, b.h0.x, b.h0.y, b.h0.z, b.h0.w)
      pool.set(i, 2, b.h1.x, b.h1.y, b.h1.z, b.h1.w)
      pool.set(i, 3, b.tint[0], b.tint[1], b.tint[2], 0)
    }
    // cast: a crisp golden rune circle sweeps out and becomes the dome's footprint
    if (age < 0.35) drawCircle(x, y, fh + 1.5, R * grow, STYLE_RUNES, GOLD[0], GOLD[1], GOLD[2], 1.2 * (1 - age / 0.35), 0, 3, pawn.id, 0, 0.8, 22 + 8 * tierOfLevel(ctx, levelOf(ctx, pawn.owner, SPELL)), b.since)
    // crisp footprint at exactly the reflect radius
    drawCircle(x, y, fh + 1.4, R * grow, STYLE_RING, GOLD[0], GOLD[1], GOLD[2], 0.9 * fade, 0, 0, pawn.id, 0.06, 0.6, 0, b.since)
    glowG(x, y, fh + 70, 160, GOLD_WHITE, 0.18 * fade, 1.6)
    light(ctx, x, y, R, 0.55 * fade, GOLD, 0.45)
  },
})
