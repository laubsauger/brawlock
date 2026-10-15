/**
 * Boomerang (column 1, Knockout; identity red-copper). spells.md §8.5.
 *
 * - windup / cast: motes into the hand, muzzle sparks
 * - flight: flat spinning three-armed glaive whose tips sit exactly on the
 *   collision radius (38), rotational smear, hot hub core, copper halo, a long
 *   heat trail that draws the curved out-and-back arc, sparks flung off the
 *   tips, floor light + shadow
 * - return mode: the predicted homing path back to the thrower is drawn as a
 *   faint dashed guide (team-tinted) so the return arc reads before it happens
 * - hits: kb-scaled burst plus slash streaks across the blade path;
 *   'projectileBounce' (pawn / pillar): ricochet sparks + clang flash
 * - catch (destroyed at the thrower): blade folds into the hand, implode ring
 */
import type { SimEvent, SimState } from '../../../sim/types'
import { RING_IMPLODE } from '../../scene/GroundFx'
import { registerSpellVfx, type PawnRenderInfo, type SpellVfx, type VfxCtx } from '../registry'
import { G_BLADE, G_SHOCK, PH, acquireKit, palFor, releaseKit, trailFrom, windupProgress, type KitA, type TrailStyle } from './kitA'
import { spellDeath } from './deathsA'

const P = palFor('boomerang')
let K: KitA | null = null
const o = { x: 0, y: 0, h: 0 }
const dir = { x: 0, y: 0 }
const last = new Map<number, { x: number; y: number }>()

const TRAIL: TrailStyle = trailFrom(P, { life: 0.55, width: 48, widthTail: 0.25, intensity: 1.1, falloff: 1.5, noise: 0.35, spacing: 10, rim: 0.35 }, 0.4)
const EDGE: TrailStyle = trailFrom(P, { life: 0.22, width: 10, widthTail: 0.2, intensity: 1.6, falloff: 2, noise: 0, spacing: 6, rim: 0 }, 0.8)

/** signature charge-up: the glaive materializes in the hand, spinning up */
function signature(k: KitA, ctx: VfxCtx, info: PawnRenderInfo, _id: number, _tx: number, _ty: number, w: number): void {
  const now = ctx.now
  const r = 38 * (0.35 + 0.65 * w)
  k.air.add(G_BLADE, o.x, o.y, o.h + 8, r, now * (6 + 22 * w), P.body[0], P.body[1], P.body[2], 0.4 + 0.9 * w, 0.5 + 0.5 * w, 3)
  k.air.add(G_BLADE, o.x, o.y, o.h + 7, r * 1.05, now * (6 + 22 * w) - 0.4, P.edge[0], P.edge[1], P.edge[2], 0.3 * w, 1, 3)
  void info
}

const mod: SpellVfx = {
  spell: 'boomerang',
  init(ctx) {
    K = acquireKit(ctx)
  },
  // our signature occupies the palm: keep render's arm rings + ground ring, drop its palm orb
  windupStyle: () => ({ hide: ['orb'] }),
  dispose() {
    releaseKit(K)
    K = null
    last.clear()
  },

  onEvent(e: SimEvent, ctx) {
    const k = K
    if (!k) return
    switch (e.type) {
      case 'castStart':
        if (e.spell === 'boomerang') k.windupTotal.set(e.pawn, e.ticks)
        return
      case 'cast': {
        if (e.spell !== 'boomerang') return
        const info = ctx.pawn(e.pawn)
        if (!info) return
        k.origin(info, o)
        const dx = e.x - info.x
        const dy = e.y - info.y
        const l = Math.hypot(dx, dy) || 1
        k.muzzle(o.x, o.y, o.h, dx / l, dy / l, P, 1)
        return
      }
      case 'damage': {
        const a = k.attributeDamage(e)
        if (!a || a.spell !== 'boomerang') return
        const v = ctx.pawn(e.target)
        const from = last.get(a.data)
        k.hitDir(ctx.state, e.target, from ? from.x : e.x - 1, from ? from.y : e.y, e.x, e.y, dir)
        const h = (v?.h ?? 30) + 55
        k.impact(e.x, e.y, h, e.kb, dir.x, dir.y, P)
        // slash: bright streaks across the cut, perpendicular to the push
        const ps = ctx.particles
        const n = ps.budget(10)
        for (let i = 0; i < n; i++) {
          const s = (Math.random() - 0.5) * 2
          const sp = 700 + Math.random() * 700
          ps.spawn(e.x + dir.x * 10, e.y + dir.y * 10, h + (Math.random() - 0.5) * 30, -dir.y * sp * s, dir.x * sp * s, (Math.random() - 0.5) * 120, 0.12 + Math.random() * 0.08, 8, 1, P.hot[0], P.hot[1], P.hot[2], 0, 6, -0.16)
        }
        return true
      }
      case 'projectileBounce': {
        if (e.spell !== 'boomerang') return
        const ps = ctx.particles
        const n = ps.budget(18)
        for (let i = 0; i < n; i++) {
          const a = Math.random() * Math.PI * 2
          const sp = 400 + Math.random() * 700
          ps.spawn(e.x, e.y, PH, Math.cos(a) * sp, Math.sin(a) * sp, 80 + Math.random() * 260, 0.18 + Math.random() * 0.2, 6, 1, P.spark[0], P.spark[1], P.spark[2], -1400, 3, -0.12)
        }
        ctx.flash(e.x, e.y, PH, 0.12, 180, 110, P.hot[0], P.hot[1], P.hot[2])
        k.pulse(G_SHOCK, false, e.x, e.y, k.floor(e.x, e.y) + 1.5, 60, 60, 0.25, 0, 0, P.body, 0.9, 0.15, 0.95, 0.12)
        ctx.shakeNear(e.x, e.y, 0.08)
        return
      }
      case 'projectileHit': {
        if (e.spell !== 'boomerang') return
        // caught by the thrower (or removed): fold into the hand
        const pw = e.target === null ? nearestOwnerPawn(ctx.state, e.x, e.y) : null
        const info = pw !== null ? ctx.pawn(pw) : null
        const fl = k.floor(e.x, e.y)
        if (info) {
          k.origin(info, o)
          const ps = ctx.particles
          const n = ps.budget(16)
          for (let i = 0; i < n; i++) {
            const a = Math.random() * Math.PI * 2
            const rr = 50 + Math.random() * 30
            const life = 0.14 + Math.random() * 0.06
            ps.spawn(o.x + Math.cos(a) * rr, o.y + Math.sin(a) * rr, o.h + (Math.random() - 0.5) * 30, (-Math.cos(a) * rr) / life, (-Math.sin(a) * rr) / life, 0, life, 7, 2, P.spark[0], P.spark[1], P.spark[2], 0, 0, -0.05)
          }
          ctx.flash(o.x, o.y, o.h, 0.16, 140, 90, P.hot[0] * 0.8, P.hot[1] * 0.8, P.hot[2] * 0.8)
          k.teamRGB(info.owner)
          ctx.ground.spawn(RING_IMPLODE, info.x, info.y, k.floor(info.x, info.y), 10, 70, 0.22, 6, k.team[0] * 1.6, k.team[1] * 1.6, k.team[2] * 1.6)
        } else {
          ctx.flash(e.x, e.y, PH, 0.12, 160, 90, P.body[0], P.body[1], P.body[2])
          k.pulse(G_SHOCK, false, e.x, e.y, fl + 1.5, 50, 50, 0.25, 0, 0, P.body, 0.8, 0.2, 0.95, 0.12)
        }
        return
      }
      case 'death':
        if (e.cause !== 'boomerang') return
        return spellDeath(k, ctx, e)
      default:
        return
    }
  },

  frame(ctx) {
    const k = K
    const s = ctx.state
    if (!k || !s) return
    for (const p of s.pawns) {
      if (!p.alive || !p.cast || p.cast.spell !== 'boomerang' || p.cast.started === false) continue
      const info = ctx.pawn(p.id)
      if (!info) continue
      k.begin()
      k.origin(info, o)
      const w = windupProgress(k, ctx, p.id, p.cast.ticksLeft)
      k.windupAt(o.x, o.y, o.h, w, P, ctx.now, ctx.dt, p.id)
      signature(k, ctx, info, p.id, p.cast.x, p.cast.y, w)
    }
    // forget positions of blades that are gone
    if (last.size > 0) {
      for (const id of last.keys()) {
        let alive = false
        for (const q of s.projectiles) {
          if (q.id === id) {
            alive = true
            break
          }
        }
        if (!alive) last.delete(id)
      }
    }
  },

  drawProjectile(p, x, y, ctx) {
    const k = K
    if (!k) return
    k.begin()
    k.track(p, x, y)
    let l = last.get(p.id)
    if (!l) {
      l = { x, y }
      last.set(p.id, l)
    }
    l.x = x
    l.y = y
    const now = ctx.now
    const r = p.radius
    const sp = Math.hypot(p.vx, p.vy)
    const dx = sp > 1 ? p.vx / sp : 1
    const dy = sp > 1 ? p.vy / sp : 0
    const spin = now * 24 + p.id * 1.3
    const returning = p.data.returning === 1
    // blade: tips on the collision radius; hot hub on top
    k.air.add(G_BLADE, x, y, PH, r, spin, P.body[0], P.body[1], P.body[2], 1.15, 0.9, 3)
    k.air.add(G_BLADE, x, y, PH - 2, r * 1.05, spin - 0.35, P.edge[0], P.edge[1], P.edge[2], 0.45, 1.0, 3)
    k.cores.add(x, y, PH, r * 0.3, dx, dy, 0, p.id, P.edge, P.body, P.hot)
    k.glowAt(x, y, PH, r * 3.2, P.body[0] * 0.35, P.body[1] * 0.35, P.body[2] * 0.35, 1.6, 0.5)
    ctx.glow.add(x, y, 220, 0.85, P.light[0], P.light[1], P.light[2])
    ctx.projectileShadow(x, y, PH, r)
    // the path (draws the out-and-back arc) + the tip arc of the leading blade
    k.trailPoint(p.id * 4, x, y, PH, TRAIL, p.owner)
    const tipA = spin + 0.2
    k.trailPoint(p.id * 4 + 1, x + Math.cos(tipA) * r, y + Math.sin(tipA) * r, PH, EDGE)
    // sparks flung off the spinning tips
    const ps = ctx.particles
    const n = ps.budget(ctx.dt * 60)
    for (let i = 0; i < n; i++) {
      const a = spin + Math.floor(Math.random() * 3) * ((Math.PI * 2) / 3)
      const tx = Math.cos(a)
      const ty = Math.sin(a)
      const tv = 300 + Math.random() * 250
      ps.spawn(x + tx * r, y + ty * r, PH, -ty * tv + p.vx * 0.3, tx * tv + p.vy * 0.3, 40 + Math.random() * 120, 0.2 + Math.random() * 0.2, 6, 1, P.spark[0], P.spark[1], P.spark[2], -900, 2.5, -0.08)
    }
    // return mode: dashed guide along the predicted homing path to the thrower
    if (returning) {
      const info = ctx.pawnOf(p.owner)
      if (info && info.alive) {
        k.teamRGB(p.owner)
        k.stripBegin(true, 1.8, 0.85, now * 4)
        let px = x
        let py = y
        let vx = p.vx
        let vy = p.vy
        const fl = k.floor(x, y) + 3
        const step = 1 / 30
        for (let i = 0; i < 26; i++) {
          const f = i / 25
          k.stripPoint(px, py, fl, 12 * (1 - f * 0.6), P.body[0], P.body[1], P.body[2], 0.42 * (1 - f) * Math.min(1, i / 2 + 0.3), k.team[0], k.team[1], k.team[2], 0.5)
          const tx = info.x - px
          const ty = info.y - py
          const d = Math.hypot(tx, ty)
          if (d < 75) break
          const ddx = (1000 * tx) / d - vx
          const ddy = (1000 * ty) / d - vy
          const dl = Math.hypot(ddx, ddy)
          if (dl > 0) {
            vx += (1000 * step * ddx) / dl
            vy += (1000 * step * ddy) / dl
          }
          px += vx * step
          py += vy * step
        }
        k.stripEnd()
      }
    }
  },
}

function nearestOwnerPawn(s: SimState | null, x: number, y: number): number | null {
  if (!s) return null
  let best: number | null = null
  let bd = 160
  for (const p of s.pawns) {
    const d = Math.hypot(p.x - x, p.y - y)
    if (p.alive && d < bd) {
      bd = d
      best = p.id
    }
  }
  return best
}

registerSpellVfx(mod)
