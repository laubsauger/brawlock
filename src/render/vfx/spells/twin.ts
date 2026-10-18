/**
 * Twin (column 1, Knockout; identity gold-orange). spells.md §8.8.
 *
 * - windup / cast: glow at the hand, a split muzzle burst (two cones)
 * - flight: two gold bolts (core = sim radius 35, short comet tail along the
 *   velocity), each with a heat trail; the pair reads as one spell: a thin
 *   flickering thread joins them, the remaining mirrored half-ellipse paths
 *   are drawn as faint dashed guides on the floor, and a convergence mark
 *   pulses on the target point where both arcs meet
 * - hit: kb-scaled burst + golden flare; the second bolt of the pair landing
 *   close in time on the same spot adds a bigger convergence burst
 * - reaching the target point unhit: both fizzle in a soft gold pop
 */
import type { ProjectileState, SimEvent } from '../../../sim/types'
import { RING_EXPAND } from '../../scene/GroundFx'
import { registerSpellVfx, type SpellVfx, type VfxCtx } from '../registry'
import { G_CROSS, G_SHOCK, PH, acquireKit, kflash, kring, palFor, pspawn, releaseKit, trailFrom, windupProgress, type KitA, type TrailStyle } from './kitA'
import { spellDeath } from './deathsA'

const P = palFor('twin')
let K: KitA | null = null
const o = { x: 0, y: 0, h: 0 }
const dir = { x: 0, y: 0 }

interface Arc {
  cx: number
  cy: number
  x: number
  y: number
  seen: number
}
const arcs = new Map<number, Arc>()
let frameNo = 0
/** last pair landing, for the convergence burst */
const landed = { x: 0, y: 0, t: -10, owner: -1 }

const TRAIL: TrailStyle = trailFrom(P, { life: 0.26, width: 44, widthTail: 0.15, intensity: 2.0, falloff: 1.4, noise: 0.35, spacing: 8, rim: 0.3 })

/** point on the twin ellipse at parameter t (game coords) */
function arcPoint(p: ProjectileState, a: Arc, t: number, out: { x: number; y: number }): void {
  const d = p.data
  const ex = d.ea * Math.cos(t)
  const ey = d.sign * d.eb * Math.sin(t)
  out.x = a.cx + ex * d.edx - ey * d.edy
  out.y = a.cy + ex * d.edy + ey * d.edx
}
const tmp = { x: 0, y: 0 }

function burst(k: KitA, ctx: VfxCtx, x: number, y: number, big: number): void {
  const ps = ctx.particles
  const n = ps.budget(16 * big)
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2
    const sp = 200 + Math.random() * 420 * big
    pspawn(ps, x, y, PH, Math.cos(a) * sp, Math.sin(a) * sp, (Math.random() - 0.3) * 260, 0.25 + Math.random() * 0.25, 30 + Math.random() * 16 * big, -8, P.body[0], P.body[1], P.body[2], -200, 4.5, 0)
  }
  const fl = k.floor(x, y)
  k.pulse(G_SHOCK, false, x, y, fl + 1.5, 60 * big, 60 * big, 0.3, Math.random() * 6, 0, P.body, 1.0, 0.15, 0.95, 0.1)
  kring(ctx, RING_EXPAND, x, y, fl, 10, 70 * big, 0.3, 8, P.body[0] * 0.7, P.body[1] * 0.7, P.body[2] * 0.7)
  kflash(ctx, x, y, PH, 0.16, 160 * big, 90 * big, P.hot[0] * 0.8, P.hot[1] * 0.8, P.hot[2] * 0.8)
  const ns = ctx.smoke.budget(3 * big)
  for (let i = 0; i < ns; i++) ctx.smoke.spawn(x, y, PH, (Math.random() - 0.5) * 120, (Math.random() - 0.5) * 120, 60, 0.9, 30, 100, 0.05, 0.035, 0.02, 25, 1.2, 8)
}


const mod: SpellVfx = {
  spell: 'twin',
  init(ctx) {
    K = acquireKit(ctx)
  },
  // The shared kit draws a compact palm glow, never a projectile during windup.
  windupStyle: () => ({ hide: ['orb'] }),
  dispose() {
    releaseKit(K)
    K = null
    arcs.clear()
  },

  onEvent(e: SimEvent, ctx) {
    const k = K
    if (!k) return
    switch (e.type) {
      case 'castStart':
        if (e.spell === 'twin') k.windupTotal.set(e.pawn, e.ticks)
        return
      case 'cast': {
        if (e.spell !== 'twin') return
        const info = ctx.pawn(e.pawn)
        if (!info) return
        k.origin(info, o)
        const dx = e.x - info.x
        const dy = e.y - info.y
        const l = Math.hypot(dx, dy) || 1
        // two mirrored cones
        const ux = dx / l
        const uy = dy / l
        for (const s of [1, -1]) {
          const c = Math.cos(0.8 * s)
          const sn = Math.sin(0.8 * s)
          k.muzzle(o.x, o.y, o.h, ux * c - uy * sn, ux * sn + uy * c, P, 0.7)
        }
        k.levelFlash(o.x, o.y, o.h, k.tierOf(e), P, e.pawn)
        return
      }
      case 'damage': {
        const a = k.attributeDamage(e)
        if (!a || a.spell !== 'twin') return
        const v = ctx.pawn(e.target)
        k.hitDir(ctx.state, e.target, e.x - 1, e.y, e.x, e.y, dir)
        k.impact(e.x, e.y, (v?.h ?? 30) + 55, e.kb, dir.x, dir.y, P, 1, a.tier)
        return true
      }
      case 'projectileHit': {
        if (e.spell !== 'twin') return
        const pair = ctx.now - landed.t < 0.35 && Math.hypot(e.x - landed.x, e.y - landed.y) < 140
        burst(k, ctx, e.x, e.y, pair ? 1.8 : 1)
        if (pair) {
          ctx.shakeNear(e.x, e.y, 0.15)
          landed.t = -10
        } else {
          landed.x = e.x
          landed.y = e.y
          landed.t = ctx.now
        }
        return
      }
      case 'death':
        if (e.cause !== 'twin') return
        return spellDeath(k, ctx, e)
      default:
        return
    }
  },

  frame(ctx) {
    const k = K
    const s = ctx.state
    if (!k || !s) return
    frameNo++
    for (const p of s.pawns) {
      if (!p.alive || !p.cast || p.cast.spell !== 'twin' || p.cast.started === false) continue
      const info = ctx.pawn(p.id)
      if (!info) continue
      k.begin()
      k.origin(info, o)
      const w = windupProgress(k, ctx, p.id, p.cast.ticksLeft)
      k.glowAt(o.x, o.y, o.h, 20, P.body[0] * (0.08 + 0.08 * w), P.body[1] * (0.08 + 0.08 * w), P.body[2] * (0.08 + 0.08 * w), 1.4)
    }
    if (arcs.size > 0) for (const [id, a] of arcs) if (frameNo - a.seen > 2) arcs.delete(id)
  },

  drawProjectile(p, x, y, ctx) {
    const k = K
    if (!k) return
    k.begin()
    k.track(p, x, y)
    const now = ctx.now
    const d = p.data
    let a = arcs.get(p.id)
    if (!a) {
      // ellipse centre from the current state: pos = C + rot(E(t))
      const ex = d.ea * Math.cos(d.t)
      const ey = d.sign * d.eb * Math.sin(d.t)
      a = { cx: p.x - (ex * d.edx - ey * d.edy), cy: p.y - (ex * d.edy + ey * d.edx), x, y, seen: frameNo }
      arcs.set(p.id, a)
    }
    a.x = x
    a.y = y
    a.seen = frameNo
    const r = p.radius
    const sp = Math.hypot(p.vx, p.vy)
    const dx = sp > 1 ? p.vx / sp : 1
    const dy = sp > 1 ? p.vy / sp : 0
    k.cores.add(x, y, PH, r, dx, dy, 0.9, p.id, P.edge, P.body, P.hot)
    k.halo(x, y, PH, r * 3.2, P.body[0] * 0.38, P.body[1] * 0.38, P.body[2] * 0.38, 1.7, 0.5)
    ctx.glow.add(x, y, 150, 0.55, P.light[0], P.light[1], P.light[2])
    ctx.projectileShadow(x, y, PH, r)
    k.trailPoint(p.id * 16, x, y, PH, TRAIL, p.owner)
    k.powerLayers(p.id * 16 + 15, x, y, PH, P, k.tierOf(p), dx, dy, r)
    const ps = ctx.particles
    const n = ps.budget(ctx.dt * 45)
    for (let i = 0; i < n; i++) {
      const ang = Math.random() * Math.PI * 2
      const sv = 30 + Math.random() * 80
      pspawn(ps, x - dx * r, y - dy * r, PH, -dx * 90 + Math.cos(ang) * sv, -dy * 90 + Math.sin(ang) * sv, 30 + Math.random() * 60, 0.3 + Math.random() * 0.25, 6 + Math.random() * 4, -2, P.spark[0], P.spark[1], P.spark[2], -150, 2, 3)
    }
    // remaining path as a faint dashed guide on the floor (fades as it is used up)
    const tLeft = Math.PI - d.t
    if (tLeft > 0.05) {
      const fl = k.floor(x, y) + 2.5
      k.teamRGB(p.owner)
      k.stripBegin(true, 1.6, 0.9, d.t * 40)
      const N = 18
      for (let i = 0; i <= N; i++) {
        const t = d.t + (tLeft * i) / N
        arcPoint(p, a, t, tmp)
        const f = i / N
        const al = 0.3 * Math.min(1, i / 2) * (0.5 + 0.5 * f) * Math.min(1, tLeft * 2)
        k.stripPoint(tmp.x, tmp.y, fl, 14, P.body[0], P.body[1], P.body[2], al, k.team[0], k.team[1], k.team[2], 0.4)
      }
      k.stripEnd()
      // convergence mark on the target point (once per pair)
      if (d.sign > 0) {
        arcPoint(p, a, Math.PI, tmp)
        const pulse = 0.5 + 0.5 * Math.sin(now * 10)
        k.over.add(G_CROSS, tmp.x, tmp.y, k.floor(tmp.x, tmp.y) + 2, 44, now * 0.8, P.body[0], P.body[1], P.body[2], 0.6 + 0.4 * pulse, pulse)
      }
    }
    // the pair thread: drawn by the second bolt (its partner was drawn earlier this frame)
    if (d.sign < 0) {
      const partner = arcs.get(p.id - 1)
      if (partner && partner.seen === frameNo) {
        const len = Math.hypot(partner.x - x, partner.y - y)
        if (len > 30) {
          k.stripBegin(false, 2.4, 0.9, now * 5)
          const N = 10
          for (let i = 0; i <= N; i++) {
            const f = i / N
            const sag = Math.sin(Math.PI * f) * 12 * Math.sin(now * 20 + f * 6)
            k.stripPoint(x + (partner.x - x) * f, y + (partner.y - y) * f, PH + sag, 7, P.hot[0], P.hot[1], P.hot[2], 0.28 * Math.sin(Math.PI * f) + 0.05)
          }
          k.stripEnd()
        }
      }
    }
  },
}

registerSpellVfx(mod)
