/**
 * Spell-specific lingering after-hit effects on the victim (VFX workstream C).
 *
 * Render core already runs the generic kinds through ctx.afterHit (fire
 * smoulder for Fireball / Meteor, lightning sparks, Scourge wisps, lava hem,
 * knockback dust). This module layers what those lack, keyed by
 * ctx.damageCause(e) and strength-scaled by damage + knockback:
 *
 *   fire family (fireball, meteor, cluster, twin)  flames licking up the robe
 *                                                  (+ core fire kind for cluster / twin)
 *   lightning     crackling jagged arcs crawling over the body (~1 s)
 *   scourge       blood-crimson edge glints in the dark wisps
 *   snowball      frost mist, ice glints, crystals dropping off (~1.2 s)
 *   drain         sickly life-wisps pulled out toward the caster (~1 s)
 *   gravity       violet motes spiralling inward
 *   any other spell with a palette colour: identity sparks shed off the body
 *
 * The short red hit tint is render's (not duplicated). A module that draws
 * its own lingering effect for a spell calls optOutAfterHit(spell).
 *
 * Cheap: 32 pooled records, emission through tier-scaled accumulators, at
 * most 2 lightning arcs (8 billboard streaks) per pawn per frame, no arcs on
 * Low. No per-frame allocation.
 */
import * as THREE from 'three/webgpu'
import type { EntityId } from '../../../sim/types'
import { S } from '../../coords'
import { BODY_H, BODY_R } from '../deathKit'
import { SPELL_PALETTE, baseSpellId, getSpellColor, type RGB3 } from '../palette'
import { registerSpellVfx, type VfxCtx } from '../registry'

const K_FIRE = 1
const K_ARCS = 2
const K_SHADOW = 3
const K_FROST = 4
const K_DRAIN = 5
const K_GRAVITY = 6
const K_SPARKS = 7

const DUR: Record<number, number> = { [K_FIRE]: 1.5, [K_ARCS]: 1.0, [K_SHADOW]: 1.2, [K_FROST]: 1.2, [K_DRAIN]: 1.0, [K_GRAVITY]: 0.9, [K_SPARKS]: 0.6 }

interface Linger {
  kind: number
  pawn: EntityId
  /** damage source player (Drain pulls toward it), -1 = none */
  src: number
  t0: number
  t1: number
  k: number
  acc: number
  acc2: number
  rgb: RGB3
}

const N = 32
const pool: Linger[] = []
for (let i = 0; i < N; i++) pool.push({ kind: 0, pawn: -1, src: -1, t0: 0, t1: 0, k: 0, acc: 0, acc2: 0, rgb: [1, 1, 1] })

const optOut = new Set<string>()
/** Call once from a module that draws its own lingering after-hit for `spell`. */
export function optOutAfterHit(spell: string): void {
  optOut.add(baseSpellId(spell))
}

const rnd = Math.random
const TAU = Math.PI * 2

function kindFor(spell: string): number {
  switch (spell) {
    case 'fireball':
    case 'meteor':
    case 'cluster':
    case 'twin':
      return K_FIRE
    case 'lightning':
      return K_ARCS
    case 'scourge':
      return K_SHADOW
    case 'snowball':
      return K_FROST
    case 'drain':
      return K_DRAIN
    case 'gravity':
      return K_GRAVITY
    default:
      return SPELL_PALETTE[spell] ? K_SPARKS : 0
  }
}

function peak(c: THREE.Color, p: number, out: RGB3): RGB3 {
  const k = p / Math.max(1e-4, c.r, c.g, c.b)
  out[0] = c.r * k
  out[1] = c.g * k
  out[2] = c.b * k
  return out
}

function add(ctx: VfxCtx, pawn: EntityId, kind: number, k: number, src: number, spell: string): void {
  const now = ctx.now
  let slot: Linger | null = null
  let oldest = pool[0]
  for (const l of pool) {
    if (l.kind === kind && l.pawn === pawn && now < l.t1) {
      // re-hit refreshes and strengthens
      l.t1 = Math.max(l.t1, now + DUR[kind])
      l.k = Math.min(2, Math.max(l.k, k) + 0.15)
      l.src = src
      return
    }
    if (!slot && (l.kind === 0 || now >= l.t1)) slot = l
    if (l.t1 < oldest.t1) oldest = l
  }
  const l = slot ?? oldest
  l.kind = kind
  l.pawn = pawn
  l.src = src
  l.t0 = now
  l.t1 = now + DUR[kind]
  l.k = k
  l.acc = 0
  l.acc2 = 0
  peak(getSpellColor(spell).accent, 1, l.rgb)
}

function rate(ctx: VfxCtx, l: Linger, r: number, which: 'acc' | 'acc2' = 'acc'): number {
  const v = l[which] + r * ctx.dt * ctx.tier.particles
  const n = Math.floor(v)
  l[which] = v - n
  return n
}

// ---------------------------------------------------------------- lightning arcs

const pa = new THREE.Vector3()
const pb = new THREE.Vector3()
const AX = new Float32Array(5)
const AY = new Float32Array(5)
const AH = new Float32Array(5)

/** One jagged 4-segment arc between two points on the body, as screen-aligned streaks. */
function arc(ctx: VfxCtx, x: number, y: number, h: number, k: number, r: number, g: number, b: number): void {
  const a1 = rnd() * TAU
  const a2 = a1 + (rnd() < 0.5 ? -1 : 1) * (0.9 + rnd() * 1.6)
  const h1 = h + 10 + rnd() * BODY_H * 0.85
  const h2 = Math.max(h + 6, Math.min(h + BODY_H, h1 + (rnd() - 0.5) * 70))
  const rr = BODY_R * 0.95
  const x1 = x + Math.cos(a1) * rr
  const y1 = y + Math.sin(a1) * rr
  const x2 = x + Math.cos(a2) * rr
  const y2 = y + Math.sin(a2) * rr
  for (let i = 0; i <= 4; i++) {
    const f = i / 4
    const j = i === 0 || i === 4 ? 0 : 1
    // bulge outward from the body + jitter
    const bulge = Math.sin(f * Math.PI) * 10
    const am = a1 + (a2 - a1) * f
    AX[i] = x1 + (x2 - x1) * f + Math.cos(am) * bulge + (rnd() - 0.5) * 14 * j
    AY[i] = y1 + (y2 - y1) * f + Math.sin(am) * bulge + (rnd() - 0.5) * 14 * j
    AH[i] = h1 + (h2 - h1) * f + (rnd() - 0.5) * 18 * j
  }
  const cam = ctx.camera
  const w = 3.2 * S
  for (let i = 0; i < 4; i++) {
    pa.set(AX[i] * S, AH[i] * S, -AY[i] * S)
    pb.set(AX[i + 1] * S, AH[i + 1] * S, -AY[i + 1] * S)
    const len = pa.distanceTo(pb)
    const mx = (pa.x + pb.x) * 0.5
    const my = (pa.y + pb.y) * 0.5
    const mz = (pa.z + pb.z) * 0.5
    pa.project(cam)
    pb.project(cam)
    const rot = Math.atan2(pb.y - pa.y, (pb.x - pa.x) * cam.aspect)
    ctx.billboards.addStreak(mx, my, mz, w, Math.max(1, len / w), rot, r * k, g * k, b * k, 1.3, 0)
  }
}

// ---------------------------------------------------------------- tick

function tick(ctx: VfxCtx, l: Linger): void {
  const p = ctx.pawn(l.pawn)
  if (!p || !p.alive) {
    l.kind = 0 // death takes over
    return
  }
  const t = ctx.now
  const left = Math.max(0, (l.t1 - t) / (l.t1 - l.t0))
  const fade = Math.min(1, left * 2.2)
  const k = l.k * fade
  const ps = ctx.particles
  const c = l.rgb
  switch (l.kind) {
    case K_FIRE: {
      // flames licking up from scorched patches on the robe
      const n = rate(ctx, l, 34 * k)
      for (let i = 0; i < n; i++) {
        const a = rnd() * TAU
        const rr = BODY_R * (0.7 + rnd() * 0.3)
        ps.spawn(p.x + Math.cos(a) * rr, p.y + Math.sin(a) * rr, p.h + 15 + rnd() * BODY_H * 0.6, Math.cos(a) * 15, Math.sin(a) * 15, 110 + rnd() * 90, 0.22 + rnd() * 0.2, 9 + rnd() * 7, -3, 3.0, 1.0, 0.16, 120, 1.6, 4)
      }
      if (ctx.quality !== 'low') ctx.glow.add(p.x, p.y, 90, 0.35 * k, 1.0, 0.36, 0.06)
      break
    }
    case K_ARCS: {
      if (ctx.quality === 'low') break
      // crackle: arcs flicker on and off at random, denser right after the hit
      if (rnd() < 0.35 + 0.5 * left) {
        const na = left > 0.5 && rnd() < 0.5 ? 2 : 1
        for (let i = 0; i < na; i++) arc(ctx, p.x, p.y, p.h, (1.6 + rnd() * 1.4) * Math.min(1.4, 0.6 + k * 0.5), c[0] * 0.8 + 0.7, c[1] * 0.8 + 0.8, c[2] * 0.8 + 1.0)
        ctx.glow.add(p.x, p.y, 110, 0.45 * k, c[0] * 0.6, c[1] * 0.6, c[2] * 0.6)
      }
      break
    }
    case K_SHADOW: {
      const n = rate(ctx, l, 18 * k)
      for (let i = 0; i < n; i++) {
        const a = rnd() * TAU
        const rr = BODY_R * (0.8 + rnd() * 0.3)
        ps.spawn(p.x + Math.cos(a) * rr, p.y + Math.sin(a) * rr, p.h + rnd() * BODY_H * 0.9, Math.cos(a) * 25, Math.sin(a) * 25, 50 + rnd() * 60, 0.35 + rnd() * 0.3, 5 + rnd() * 3, 1, c[0] * 3, c[1] * 3, c[2] * 3, 30, 1, -0.06)
      }
      break
    }
    case K_FROST: {
      const n = rate(ctx, l, 20 * k)
      for (let i = 0; i < n; i++) {
        const a = rnd() * TAU
        const rr = BODY_R * (0.6 + rnd() * 0.5)
        const hh = p.h + 10 + rnd() * BODY_H * 0.8
        // cold mist rolling off and sinking
        ctx.smoke.spawn(p.x + Math.cos(a) * rr, p.y + Math.sin(a) * rr, hh, Math.cos(a) * 20, Math.sin(a) * 20, -25, 0.9 + rnd() * 0.4, 14, 50, 0.42, 0.56, 0.68, -20, 1, 8)
        // ice glints / crystals dropping off
        if (rnd() < 0.6) ps.spawn(p.x + Math.cos(a) * rr, p.y + Math.sin(a) * rr, hh, 0, 0, -40, 0.4 + rnd() * 0.3, 4 + rnd() * 2, 1, c[0] * 2.4 + 0.6, c[1] * 2.4 + 0.6, c[2] * 2.4 + 0.6, -500, 0.5, 0)
      }
      break
    }
    case K_DRAIN: {
      // life drawn out of the victim toward whoever drains it
      const src = l.src >= 0 ? ctx.pawnOf(l.src) : null
      const n = rate(ctx, l, 26 * k)
      for (let i = 0; i < n; i++) {
        const a = rnd() * TAU
        const rr = BODY_R * (0.5 + rnd() * 0.5)
        const sx = p.x + Math.cos(a) * rr
        const sy = p.y + Math.sin(a) * rr
        const sh = p.h + 30 + rnd() * BODY_H * 0.6
        const life = 0.45 + rnd() * 0.25
        let vx = Math.cos(a) * 30
        let vy = Math.sin(a) * 30
        if (src) {
          // travel up to ~60 % of the way, curling (sway) and fading on route
          const dx = src.x - sx
          const dy = src.y - sy
          vx = (dx * 0.6) / life
          vy = (dy * 0.6) / life
        }
        ps.spawn(sx, sy, sh, vx, vy, 40, life, 8 + rnd() * 4, 2, c[0] * 2.4, c[1] * 2.4, c[2] * 2.4, 0, 0.6, 10)
      }
      break
    }
    case K_GRAVITY: {
      const n = rate(ctx, l, 22 * k)
      for (let i = 0; i < n; i++) {
        const a = rnd() * TAU
        const rr = 55 + rnd() * 30
        const life = 0.35
        // spiral inward: tangential + radial velocity
        const vx = (-Math.cos(a) * rr) / life - Math.sin(a) * 120
        const vy = (-Math.sin(a) * rr) / life + Math.cos(a) * 120
        ps.spawn(p.x + Math.cos(a) * rr, p.y + Math.sin(a) * rr, p.h + 30 + rnd() * BODY_H * 0.6, vx, vy, 0, life, 6, 1.5, c[0] * 2.8, c[1] * 2.8, c[2] * 2.8, 0, 0.5, -0.06)
      }
      break
    }
    case K_SPARKS: {
      const n = rate(ctx, l, 22 * k)
      for (let i = 0; i < n; i++) {
        const a = rnd() * TAU
        const rr = BODY_R * (0.8 + rnd() * 0.3)
        const sp = 40 + rnd() * 80
        ps.spawn(p.x + Math.cos(a) * rr, p.y + Math.sin(a) * rr, p.h + 15 + rnd() * BODY_H * 0.8, Math.cos(a) * sp, Math.sin(a) * sp, 40 + rnd() * 90, 0.3 + rnd() * 0.25, 5 + rnd() * 3, 1, c[0] * 2.6, c[1] * 2.6, c[2] * 2.6, -200, 1.2, -0.05)
      }
      break
    }
  }
}

registerSpellVfx({
  spell: '__afterhit',
  onEvent(e, ctx) {
    if (e.type !== 'damage' || e.amount <= 0) return false
    const cause = ctx.damageCause(e)
    if (!cause || cause === 'lava') return false
    const spell = baseSpellId(cause)
    if (optOut.has(spell)) return false
    const kind = kindFor(spell)
    if (!kind) return false
    const k = Math.max(0.3, Math.min(2, 0.4 + e.amount / 100 + e.kb / 1500))
    add(ctx, e.target, kind, k, e.source ?? -1, spell)
    // the core fire smoulder only knows Fireball / Meteor: give the other fire spells it too
    if (kind === K_FIRE && (spell === 'cluster' || spell === 'twin')) ctx.afterHit(e.target, 'fire', k)
    return false
  },
  frame(ctx) {
    const now = ctx.now
    for (const l of pool) {
      if (l.kind === 0) continue
      if (now >= l.t1) {
        l.kind = 0
        continue
      }
      tick(ctx, l)
    }
  },
  dispose() {
    for (const l of pool) l.kind = 0
  },
})
