/**
 * Homing (column 1, Knockout; identity magenta-red). spells.md §8.7.
 *
 * - windup: motes spiral into the cast hand, small rune, growing glow
 * - cast: muzzle flash + spark cone toward the aim point
 * - flight: teardrop comet core (nose = sim radius 30, pointed tail along the
 *   velocity, full size from the first frame), comet trail that continues the
 *   teardrop silhouette (team-tinted rim), two flame wisps braiding around the
 *   path, shed embers, halo, floor light; target lock: rotating reticle under
 *   data.target plus a faint tether hint from the bolt toward it
 * - hit: kb-scaled directional burst + fiery pop; destroyed/expired: fizzle
 * - self-detonation ('explosion' r292): fiery nova (shock ring at the true
 *   radius, flame burst, scorch, smoke); 'homingHaste' modifier: burning
 *   speed trail at the feet (burnout = darker, bigger, crimson)
 */
import type { SimEvent } from '../../../sim/types'
import { registerSpellVfx, type PawnRenderInfo, type SpellVfx, type VfxCtx } from '../registry'
import { G_RETICLE, G_RUNE, G_SHOCK, PH, acquireKit, palFor, palShade, pawnById, releaseKit, trailFrom, windupProgress, type KitA, type TrailStyle } from './kitA'
import { spellDeath } from './deathsA'
import { RING_EXPAND } from '../../scene/GroundFx'

const P = palFor('homing')
/** burnout (Homing self-detonation while thrusting): the same hue, darker, hotter core */
const BURN = palShade(P, 0.55)
let K: KitA | null = null
const o = { x: 0, y: 0, h: 0 }
const dir = { x: 0, y: 0 }
/** last self-detonation (to skip the plain destroy pop for the same bolt) */
const novaAt = { x: 0, y: 0, t: -10 }

const TRAIL: TrailStyle = trailFrom(P, { life: 0.3, width: 50, widthTail: 0.12, intensity: 2.6, falloff: 1.3, noise: 0.4, spacing: 9, rim: 0.3 })
const WISP: TrailStyle = trailFrom(P, { life: 0.36, width: 16, widthTail: 0.3, intensity: 1.6, falloff: 1.8, noise: 0.7, spacing: 7, rim: 0 }, 0.7)
const HASTE: TrailStyle = trailFrom(P, { life: 0.45, width: 46, widthTail: 0.25, intensity: 1.4, falloff: 1.3, noise: 0.8, spacing: 10, rim: 0.3, flat: true }, 0.3)
const HASTE_BURN: TrailStyle = trailFrom(BURN, { life: 0.45, width: 62, widthTail: 0.25, intensity: 1.9, falloff: 1.3, noise: 0.8, spacing: 10, rim: 0.3, flat: true }, 0.25)

function nova(k: KitA, ctx: VfxCtx, x: number, y: number, radius: number): void {
  const fl = k.floor(x, y)
  const ps = ctx.particles
  // crisp boundary exactly at the damage radius, fill and fire inside it
  ctx.aoeRing(x, y, radius, P.body[0], P.body[1], P.body[2], 0.5)
  k.pulse(G_SHOCK, false, x, y, fl + 1.5, radius, radius, 0.5, Math.random() * 6, 0, P.body, 0.8, 0.955, 0.955, 0.04, true)
  k.pulse(G_SHOCK, false, x, y, fl + 2, radius, radius, 0.32, Math.random() * 6, 0, P.hot, 0.9, 0.1, 0.94, 0.07)
  ctx.ground.spawn(RING_EXPAND, x, y, fl, 30, radius - 12, 0.42, 12, P.body[0], P.body[1], P.body[2])
  const n = ps.budget(70)
  for (let i = 0; i < n; i++) {
    const a = (i / Math.max(1, n)) * Math.PI * 2 + Math.random() * 0.12
    // drag 3.2 -> travel <= sp / 3.2 < 0.9 radius
    const sp = radius * (1.5 + Math.random() * 1.35)
    ps.spawn(x, y, PH - 10 + Math.random() * 30, Math.cos(a) * sp, Math.sin(a) * sp, 40 + Math.random() * 160, 0.32 + Math.random() * 0.15, 30 + Math.random() * 20, -10, P.body[0], P.body[1], P.body[2], -200, 3.2, 0)
  }
  const nh = ps.budget(30)
  for (let i = 0; i < nh; i++) {
    const a = Math.random() * Math.PI * 2
    // sparks die at the boundary: travel <= sp / drag
    const sp = radius * (1.4 + Math.random() * 1.9)
    ps.spawn(x, y, PH, Math.cos(a) * sp, Math.sin(a) * sp, 100 + Math.random() * 300, 0.3 + Math.random() * 0.25, 7, 1.5, P.spark[0], P.spark[1], P.spark[2], -1500, 3.6, -0.1)
  }
  const ns = ctx.smoke.budget(10)
  for (let i = 0; i < ns; i++) {
    const a = Math.random() * Math.PI * 2
    const rr = Math.random() * radius * 0.6
    ctx.smoke.spawn(x + Math.cos(a) * rr, y + Math.sin(a) * rr, PH, Math.cos(a) * 90, Math.sin(a) * 90, 70 + Math.random() * 50, 1.3 + Math.random() * 0.8, 50, 170, 0.07, 0.035, 0.025, 20, 0.9, 16)
  }
  if (!ctx.isLava(x, y)) ctx.scorches.spawn(x, y, fl - 0.4, radius * 0.45, 5)
  ctx.flash(x, y, PH + 20, 0.32, radius, 140, P.hot[0], P.hot[1], P.hot[2])
  ctx.shakeNear(x, y, 0.35)
}

/** fiery pop where the bolt died (hit or destroyed) */
function pop(k: KitA, ctx: VfxCtx, x: number, y: number, big: boolean): void {
  const ps = ctx.particles
  const n = ps.budget(big ? 26 : 16)
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2
    const el = (Math.random() - 0.3) * 1.2
    const sp = 180 + Math.random() * 420
    ps.spawn(x, y, PH, Math.cos(a) * sp, Math.sin(a) * sp, el * sp * 0.6, 0.26 + Math.random() * 0.3, 34 + Math.random() * 20, -10, P.body[0], P.body[1], P.body[2], -200, 5, 0)
  }
  const fl0 = k.floor(x, y)
  k.pulse(G_SHOCK, false, x, y, fl0 + 1.5, big ? 90 : 70, big ? 90 : 70, 0.3, Math.random() * 6, 0, P.body, 1.0, 0.1, 0.95, 0.1)
  const ns = ctx.smoke.budget(big ? 6 : 4)
  for (let i = 0; i < ns; i++) {
    const a = Math.random() * Math.PI * 2
    ctx.smoke.spawn(x, y, PH, Math.cos(a) * 70, Math.sin(a) * 70, 60 + Math.random() * 40, 0.9 + Math.random() * 0.5, 34, 120, 0.05, 0.03, 0.022, 25, 1.2, 10)
  }
  ctx.flash(x, y, PH, 0.2, 260, 150, P.hot[0] * 0.9, P.hot[1] * 0.9, P.hot[2] * 0.9)
  const fl = k.floor(x, y)
  ctx.ground.spawn(RING_EXPAND, x, y, fl, 12, big ? 150 : 110, 0.36, 12, P.body[0] * 0.8, P.body[1] * 0.8, P.body[2] * 0.8)
  if (big && !ctx.isLava(x, y)) ctx.scorches.spawn(x, y, fl - 0.4, 55)
}

/** signature charge-up: a magenta seeker eye locking down above the hand */
function signature(k: KitA, ctx: VfxCtx, info: PawnRenderInfo, _id: number, _tx: number, _ty: number, w: number): void {
  const now = ctx.now
  const hh = o.h + 44
  const r = 72 - 40 * w
  k.air.add(G_RETICLE, o.x, o.y, hh, r, now * 2.5, P.body[0], P.body[1], P.body[2], 0.7 + 0.9 * w, w)
  k.air.add(G_RETICLE, o.x, o.y, hh + 1, r * 0.5, -now * 5, P.hot[0], P.hot[1], P.hot[2], 0.25 + 0.6 * w, 1)
  k.glowAt(o.x, o.y, hh, 14 + 16 * w, P.hot[0] * w, P.hot[1] * w, P.hot[2] * w, 3)
  void info
}

const mod: SpellVfx = {
  spell: 'homing',
  modifiers: ['homingHaste'],
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
        if (e.spell === 'homing') k.windupTotal.set(e.pawn, e.ticks)
        return
      case 'cast': {
        if (e.spell !== 'homing') return
        const info = ctx.pawn(e.pawn)
        if (!info) return
        k.origin(info, o)
        const dx = e.x - info.x
        const dy = e.y - info.y
        const l = Math.hypot(dx, dy) || 1
        k.muzzle(o.x, o.y, o.h, dx / l, dy / l, P, 1.1)
        k.pulse(G_RUNE, true, o.x, o.y, o.h - 6, 30, 70, 0.3, Math.atan2(dy, dx), 4, P.body, 1.1, 1, 1, e.pawn)
        return
      }
      case 'damage': {
        const a = k.attributeDamage(e)
        if (!a || a.spell !== 'homing') return
        const v = ctx.pawn(e.target)
        k.hitDir(ctx.state, e.target, novaAt.x, novaAt.y, e.x, e.y, dir)
        k.impact(e.x, e.y, (v?.h ?? 30) + 55, e.kb, dir.x, dir.y, P)
        return true
      }
      case 'explosion':
        if (e.spell !== 'homing') return
        novaAt.x = e.x
        novaAt.y = e.y
        novaAt.t = ctx.now
        k.expect('homing', -1, -1, e.x, e.y, e.radius)
        nova(k, ctx, e.x, e.y, e.radius)
        return
      case 'projectileHit':
        if (e.spell !== 'homing') return
        if (ctx.now - novaAt.t < 0.1 && Math.hypot(e.x - novaAt.x, e.y - novaAt.y) < 80) return
        pop(k, ctx, e.x, e.y, e.target !== null)
        return
      case 'projectileExpire':
        if (e.spell !== 'homing') return
        pop(k, ctx, e.x, e.y, false)
        return
      case 'death':
        if (e.cause !== 'homing') return
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
      if (!p.alive || !p.cast || p.cast.spell !== 'homing' || p.cast.started === false) continue
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
    const r = p.radius
    // teardrop comet core: nose = collision radius, tail along -velocity
    k.cores.add(x, y, PH, r, dx, dy, 1.75, p.id, P.edge, P.body, P.hot)
    // halo kept under ~150 units so the camera-facing sprite never cuts the floor
    k.glowAt(x, y, PH, r * 3.6, P.body[0] * 0.42, P.body[1] * 0.42, P.body[2] * 0.42, 1.7, 0.6)
    k.streakAt(x - dx * r * 1.1, y - dy * r * 1.1, PH, r * 1.5, 2.2, dx, dy, P.hot[0] * 0.5, P.hot[1] * 0.45, P.hot[2] * 0.4, 2.4)
    ctx.glow.add(x, y, 230, 0.95, P.light[0], P.light[1], P.light[2])
    ctx.projectileShadow(x, y, PH, r)
    // comet trail continues the teardrop; two flame wisps braid around the path
    k.trailPoint(p.id * 4, x, y, PH, TRAIL, p.owner)
    const ph = now * 15 + p.id * 1.7
    const px = -dy
    const py = dx
    for (let j = 0; j < 2; j++) {
      const s = Math.sin(ph + j * Math.PI)
      const c = Math.cos(ph + j * Math.PI)
      k.trailPoint(p.id * 4 + 1 + j, x - dx * r * 0.6 + px * s * 17, y - dy * r * 0.6 + py * s * 17, PH + c * 11, WISP)
    }
    // shed embers off the tail
    const ps = ctx.particles
    const n = ps.budget(ctx.dt * 70)
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2
      const sv = 40 + Math.random() * 90
      ps.spawn(x - dx * r * 1.4, y - dy * r * 1.4, PH + (Math.random() - 0.5) * 16, -dx * 120 + Math.cos(a) * sv, -dy * 120 + Math.sin(a) * sv, 20 + Math.random() * 80, 0.3 + Math.random() * 0.3, 7 + Math.random() * 5, -2, P.spark[0], P.spark[1], P.spark[2], -120, 2, 4)
    }
    // target lock: reticle under the target + faint tether hint
    const t = p.data.target
    if (t !== undefined && t >= 0) {
      const tp = pawnById(ctx.state, t)
      const info = tp && tp.alive ? ctx.pawn(t) : null
      if (info && info.alive) {
        const fl = k.floor(info.x, info.y)
        const pulse = 0.5 + 0.5 * Math.sin(now * 9 + p.id)
        k.teamRGB(p.owner)
        k.ground.add(G_RETICLE, info.x, info.y, fl + 1.5, 64, -now * 1.8, P.body[0], P.body[1], P.body[2], 0.55 + pulse * 0.35, pulse)
        k.ground.add(G_RETICLE, info.x, info.y, fl + 1.2, 74, now * 0.9, k.team[0] * 1.4, k.team[1] * 1.4, k.team[2] * 1.4, 0.25, 0)
        const tx = info.x - x
        const ty = info.y - y
        const d = Math.hypot(tx, ty)
        if (d > 90) {
          k.stripBegin(false, 2.4, 0.7, now * 3)
          const N = 10
          const reach = Math.min(1, 420 / d)
          for (let i = 0; i <= N; i++) {
            const f = (i / N) * reach
            const a = (1 - i / N) * (i === 0 ? 0.2 : 1)
            k.stripPoint(x + tx * f, y + ty * f, PH - 10 * f, 6, P.body[0], P.body[1], P.body[2], 0.32 * a)
          }
          k.stripEnd()
        }
      }
    }
  },

  drawModifier(pawn, m, x, y, ctx) {
    const k = K
    if (!k) return
    k.begin()
    const burn = m.data.burnout === 1
    const pal = burn ? BURN : P
    const info = ctx.pawn(pawn.id)
    const fl = info ? info.h + 2 : k.floor(x, y)
    k.trailPoint(-1000 - pawn.id, x, y, fl + 3, burn ? HASTE_BURN : HASTE, pawn.owner)
    const ps = ctx.particles
    const n = ps.budget(ctx.dt * (burn ? 70 : 40))
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2
      const rr = 14 + Math.random() * 20
      ps.spawn(x + Math.cos(a) * rr, y + Math.sin(a) * rr, fl + 6 + Math.random() * 30, -pawn.vx * 0.15, -pawn.vy * 0.15, 120 + Math.random() * 140, 0.28 + Math.random() * 0.2, burn ? 26 : 18, -4, pal.body[0], pal.body[1], pal.body[2], 120, 2, 4)
    }
    if (burn && Math.random() < ctx.dt * 8) ctx.smoke.spawn(x, y, fl + 60, 0, 0, 90, 0.9, 30, 90, 0.05, 0.01, 0.01, 30, 0.8, 10)
    ctx.glow.add(x, y, 150, burn ? 0.6 : 0.4, pal.light[0], pal.light[1], pal.light[2])
  },
}

registerSpellVfx(mod)
