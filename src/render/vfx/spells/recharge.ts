/**
 * Recharge (column 3, Damage; identity purple). spells.md §8.15.
 *
 * - windup / cast: motes into the hand, muzzle; the bolt's look grows with
 *   the caster's streak (damage + 10 per consecutive hit)
 * - flight: purple bolt (core = sim radius 35) circled by spinning refresh
 *   arrows (more arrows and a bigger aura at higher streaks), trail, motes
 * - hit: kb-scaled burst + a purple shock; the 'rechargeRefresh' orb then
 *   homes back to the caster (bright mote with a tiny spinning refresh glyph
 *   and a sparkle trail)
 * - 'cooldownReset': refresh sparkle on the caster (expanding arrow ring,
 *   star burst, rising motes)
 * - 'streak': floating "xN" combo number above the caster (purple, like the
 *   original); a reset puffs out; the 'rechargeStreak' modifier keeps N small
 *   motes orbiting the caster so the current combo is always readable
 */
import type { SimEvent } from '../../../sim/types'
import { RING_EXPAND } from '../../scene/GroundFx'
import { registerSpellVfx, type PawnRenderInfo, type SpellVfx, type VfxCtx } from '../registry'
import { G_REFRESH, G_RUNE, G_SHOCK, PH, acquireKit, palFor, releaseKit, trailFrom, windupProgress, type KitA, type TrailStyle } from './kitA'
import { spellDeath } from './deathsA'

const P = palFor('recharge')
let K: KitA | null = null
const o = { x: 0, y: 0, h: 0 }
const dir = { x: 0, y: 0 }

const TRAIL: TrailStyle = trailFrom(P, { life: 0.26, width: 44, widthTail: 0.15, intensity: 1.8, falloff: 1.4, noise: 0.35, spacing: 9, rim: 0.3 })
const ORB: TrailStyle = trailFrom(P, { life: 0.35, width: 16, widthTail: 0.2, intensity: 1.6, falloff: 1.6, noise: 0.4, spacing: 7, rim: 0 }, 0.7)

function streakOf(ctx: VfxCtx, owner: number): number {
  const s = ctx.state
  if (!s) return 0
  for (const p of s.pawns) {
    if (p.owner !== owner) continue
    for (const m of p.modifiers) if (m.id === 'rechargeStreak') return m.data.streak ?? 0
  }
  return 0
}

function sparkle(k: KitA, ctx: VfxCtx, x: number, y: number, h: number): void {
  const fl = k.floor(x, y)
  k.pulse(G_REFRESH, false, x, y, fl + 2, 40, 110, 0.5, 0, 7, P.body, 1.5, 3, 3, 1.2)
  k.pulse(G_REFRESH, true, x, y, h + 60, 30, 70, 0.4, 0, -9, P.hot, 0.9, 2, 2, 0.8)
  ctx.ground.spawn(RING_EXPAND, x, y, fl, 20, 120, 0.4, 10, P.body[0], P.body[1], P.body[2])
  const ps = ctx.particles
  const n = ps.budget(28)
  for (let i = 0; i < n; i++) {
    const a = (i / Math.max(1, n)) * Math.PI * 2
    const sp = 220 + Math.random() * 200
    ps.spawn(x, y, h + 60, Math.cos(a) * sp, Math.sin(a) * sp, (Math.random() - 0.3) * 150, 0.3 + Math.random() * 0.15, 9, 1, P.spark[0], P.spark[1], P.spark[2], -200, 3, -0.08)
    ps.spawn(x + Math.cos(a) * 25, y + Math.sin(a) * 25, fl + 10, 0, 0, 200 + Math.random() * 250, 0.6, 7, 2, P.hot[0] * 0.8, P.hot[1] * 0.8, P.hot[2] * 0.8, 0, 1.4, 6)
  }
  ctx.flash(x, y, h + 60, 0.25, 220, 140, P.body[0] * 1.3, P.body[1] * 1.3, P.body[2] * 1.3)
}

/** signature charge-up: a purple charge-meter ring filling around the hand */
function signature(k: KitA, ctx: VfxCtx, info: PawnRenderInfo, _id: number, _tx: number, _ty: number, w: number): void {
  const now = ctx.now
  k.air.add(G_RUNE, o.x, o.y, o.h - 4, 46, 0, P.body[0], P.body[1], P.body[2], 1.3, w, 3)
  k.air.add(G_REFRESH, o.x, o.y, o.h - 3, 30, -now * (4 + 8 * w), P.hot[0], P.hot[1], P.hot[2], 0.3 + 0.6 * w, 2, 1)
  const st = streakOf(ctx, info.owner)
  if (st > 0) k.air.add(G_RUNE, o.x, o.y, o.h - 5, 56, now, P.edge[0], P.edge[1], P.edge[2], 0.6, Math.min(1, st / 5), 9)
}

const mod: SpellVfx = {
  spell: 'recharge',
  kinds: ['rechargeRefresh'],
  modifiers: ['rechargeStreak'],
  init(ctx) {
    K = acquireKit(ctx)
  },
  dispose() {
    releaseKit(K)
    K = null
  },

  onEvent(e: SimEvent, ctx) {
    const k = K
    if (!k) return
    switch (e.type) {
      case 'castStart':
        if (e.spell === 'recharge') k.windupTotal.set(e.pawn, e.ticks)
        return
      case 'cast': {
        if (e.spell !== 'recharge') return
        const info = ctx.pawn(e.pawn)
        if (!info) return
        k.origin(info, o)
        const dx = e.x - info.x
        const dy = e.y - info.y
        const l = Math.hypot(dx, dy) || 1
        const st = streakOf(ctx, info.owner)
        k.muzzle(o.x, o.y, o.h, dx / l, dy / l, P, 1 + Math.min(1, st * 0.2))
        return
      }
      case 'damage': {
        const a = k.attributeDamage(e)
        if (!a || a.spell !== 'recharge') return
        const v = ctx.pawn(e.target)
        k.hitDir(ctx.state, e.target, e.x - 1, e.y, e.x, e.y, dir)
        const h = (v?.h ?? 30) + 55
        k.impact(e.x, e.y, h, e.kb, dir.x, dir.y, P)
        k.pulse(G_REFRESH, true, e.x, e.y, h, 50, 120, 0.35, 0, 12, P.body, 1.1, 3, 3, 1)
        return true
      }
      case 'projectileHit':
      case 'projectileExpire': {
        if (e.spell !== 'recharge') return
        const fl = k.floor(e.x, e.y)
        k.pulse(G_SHOCK, false, e.x, e.y, fl + 1.5, 70, 70, 0.3, 0, 0, P.body, 0.9, 0.12, 0.95, 0.1)
        ctx.flash(e.x, e.y, PH, 0.12, 120, 70, P.body[0], P.body[1], P.body[2])
        return
      }
      case 'cooldownReset': {
        if (e.spell !== 'recharge') return
        const info = ctx.pawn(e.pawn)
        if (info) sparkle(k, ctx, info.x, info.y, info.h)
        return
      }
      case 'streak': {
        if (e.spell !== 'recharge') return
        const info = ctx.pawn(e.pawn)
        if (!info) return
        if (e.value > 0) {
          k.labels.show(`x${e.value}`, '#c48bff', '#9945e4', info.x, info.y, info.h + 175, ctx.now, 1.4)
        } else {
          // streak lost: a small purple puff
          ctx.smoke.spawn(info.x, info.y, info.h + 140, 0, 0, 40, 0.8, 30, 80, 0.06, 0.03, 0.09, 20, 1, 8)
        }
        return
      }
      case 'death':
        if (e.cause !== 'recharge') return
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
      if (!p.alive || !p.cast || p.cast.spell !== 'recharge' || p.cast.started === false) continue
      const info = ctx.pawn(p.id)
      if (!info) continue
      k.begin()
      k.origin(info, o)
      const w = windupProgress(k, ctx, p.id, p.cast.ticksLeft)
      k.windupAt(o.x, o.y, o.h, w, P, ctx.now, ctx.dt, p.id)
      signature(k, ctx, info, p.id, p.cast.x, p.cast.y, w)
    }
  },

  drawProjectile(p, x, y, ctx) {
    const k = K
    if (!k) return
    k.begin()
    k.track(p, x, y)
    const now = ctx.now
    const sp = Math.hypot(p.vx, p.vy)
    const dx = sp > 1 ? p.vx / sp : 1
    const dy = sp > 1 ? p.vy / sp : 0
    if (p.kind === 'rechargeRefresh') {
      // refresh orb flying home
      k.cores.add(x, y, PH + 15, 14, dx, dy, 1.0, p.id, P.edge, P.body, P.hot)
      k.air.add(G_REFRESH, x, y, PH + 15, 34, now * 10, P.body[0], P.body[1], P.body[2], 1.2, 2, 1.3)
      k.glowAt(x, y, PH + 15, 70, P.body[0] * 0.4, P.body[1] * 0.4, P.body[2] * 0.4, 1.8)
      ctx.glow.add(x, y, 130, 0.5, P.light[0], P.light[1], P.light[2])
      ctx.projectileShadow(x, y, PH + 15, 14)
      k.trailPoint(p.id * 4, x, y, PH + 15, ORB, p.owner)
      return
    }
    const r = p.radius
    const st = streakOf(ctx, p.data.origOwner ?? p.owner)
    const boost = Math.min(1, st / 5)
    k.cores.add(x, y, PH, r * 0.9, dx, dy, 0.7, p.id, P.edge, P.body, P.hot, 1 + boost * 0.3)
    // refresh arrows circling the bolt: 2 arrows, 3 from streak 3 up
    k.air.add(G_REFRESH, x, y, PH - 2, r * (1.35 + boost * 0.35), -now * 8, P.body[0], P.body[1], P.body[2], 1.1 + boost * 0.6, st >= 3 ? 3 : 2, 1.1)
    k.glowAt(x, y, PH, r * (3 + boost), P.body[0] * 0.38, P.body[1] * 0.38, P.body[2] * 0.38, 1.7, 0.5)
    ctx.glow.add(x, y, 200, 0.8 + boost * 0.4, P.light[0], P.light[1], P.light[2])
    ctx.projectileShadow(x, y, PH, r)
    k.trailPoint(p.id * 4, x, y, PH, TRAIL, p.owner)
    const ps = ctx.particles
    const n = ps.budget(ctx.dt * (30 + st * 10))
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2
      ps.spawn(x + Math.cos(a) * r * 1.4, y + Math.sin(a) * r * 1.4, PH, -Math.sin(a) * 160 - dx * 120, Math.cos(a) * 160 - dy * 120, (Math.random() - 0.5) * 60, 0.25 + Math.random() * 0.2, 7, 1, P.spark[0], P.spark[1], P.spark[2], 0, 2, -0.05)
    }
  },

  drawModifier(pawn, m, x, y, ctx) {
    const k = K
    if (!k) return
    const n = Math.min(6, m.data.streak ?? 0)
    if (n <= 0) return
    k.begin()
    const info = ctx.pawn(pawn.id)
    const h0 = info ? info.h : k.floor(x, y)
    const now = ctx.now
    for (let i = 0; i < n; i++) {
      const a = now * 2.4 + (i / n) * Math.PI * 2 + pawn.id
      const ox = Math.cos(a) * 44
      const oy = Math.sin(a) * 44
      const hh = h0 + 70 + Math.sin(now * 3 + i) * 10
      k.glowAt(x + ox, y + oy, hh, 22, P.body[0] * 0.9, P.body[1] * 0.9, P.body[2] * 0.9, 2.4)
      k.glowAt(x + ox, y + oy, hh, 8, P.hot[0] * 0.8, P.hot[1] * 0.8, P.hot[2] * 0.8, 3)
    }
  },
}

registerSpellVfx(mod)
