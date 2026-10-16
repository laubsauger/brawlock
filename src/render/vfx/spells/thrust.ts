/**
 * Thrust (column 2, Transport; identity arcane cyan). spells.md §8.10.
 *
 * IMMEDIATE (no cast point): the cast itself is the anticipation beat.
 * - cast: launch kick behind the caster (ground shock, dust and sparks thrown
 *   back), flash at the cast hand
 * - while 'thrust' is active: bow shock cone ahead (sized to the r60 contact
 *   collider), cyan speed streaks peeling off the body (team-tinted rim),
 *   afterimage ghosts left along the path, floor light, sparks at the feet
 * - 'spellHit' (thrust): slam at the contact point: shock ring, spark cone into
 *   the target, flash, shake; the following damage event draws the kb-scaled
 *   impact in cyan
 * - expiry without a hit: hard brake, skid dust and a forward spray
 */
import type { SimEvent } from '../../../sim/types'
import { RING_EXPAND } from '../../scene/GroundFx'
import { registerSpellVfx, type SpellVfx, type VfxCtx } from '../registry'
import { S } from '../../coords'
import { G_BOW, G_SHOCK, acquireKit, kflash, kring, palFor, palSaturate, pawnById, pspawn, releaseKit, trailFrom, type KitA, type TrailStyle } from './kitA'
import { spellDeath } from './deathsA'
import { LivePool } from './livePool'

/** Thrust's accent is a very pale cyan-white: saturate it so the dash and slam read cyan, not white */
const P = palSaturate(palFor('thrust'), 2.6)
let K: KitA | null = null
const o = { x: 0, y: 0, h: 0 }
const dir = { x: 0, y: 0 }

interface Ghost {
  x: number
  y: number
  h: number
  born: number
  r: number
  g: number
  b: number
}
const ghosts = new LivePool<Ghost>(48, () => ({ x: 0, y: 0, h: 0, born: -10, r: 0, g: 0, b: 0 }), (a, b) => a.born < b.born)
const lastGhost = new Map<number, number>()
/** pawn id -> time of its last thrust slam (to tell a hit from an expiry) */
const slamAt = new Map<number, number>()
/** pawn id -> power tier of its running thrust (from the cast event's level) */
const tierOf = new Map<number, number>()
const GHOST_LIFE = 0.28

const STREAK: TrailStyle = trailFrom(P, { life: 0.22, width: 14, widthTail: 0.2, intensity: 1.5, falloff: 1.8, noise: 0.3, spacing: 8, rim: 0.45 })
const WAKE: TrailStyle = trailFrom(P, { life: 0.35, width: 70, widthTail: 0.4, intensity: 0.7, falloff: 1.2, noise: 0.7, spacing: 12, rim: 0.3, flat: true }, 0.2)

function addGhost(k: KitA, x: number, y: number, h: number, now: number, owner: number): void {
  const g = ghosts.acquire()
  k.teamRGB(owner)
  g.x = x
  g.y = y
  g.h = h
  g.born = now
  // arcane body tinted toward the caster's team colour
  g.r = P.body[0] * 0.7 + k.team[0] * 0.6
  g.g = P.body[1] * 0.7 + k.team[1] * 0.6
  g.b = P.body[2] * 0.7 + k.team[2] * 0.6
}

function drawGhosts(k: KitA, now: number): void {
  ghosts.sweep((g) => now - g.born <= GHOST_LIFE)
  for (let i = 0; i < ghosts.n; i++) {
    const g = ghosts.items[i]
    const age = now - g.born
    const f = 1 - age / GHOST_LIFE
    const a = f * f * 0.55
    // a body-shaped vertical glow (torso + head): reads as a fading silhouette
    k.bbStreak(g.x * S, (g.h + 62) * S, -g.y * S, 60 * S, 2.1, Math.PI / 2, g.r * a, g.g * a, g.b * a, 1.4)
    k.glowAt(g.x, g.y, g.h + 128, 34, g.r * a * 1.2, g.g * a * 1.2, g.b * a * 1.2, 1.8)
  }
}

function slam(k: KitA, ctx: VfxCtx, x: number, y: number, dx: number, dy: number, h: number): void {
  const fl = k.floor(x, y)
  k.pulse(G_SHOCK, false, x, y, fl + 1.5, 120, 120, 0.32, 0, 0, P.body, 1.0, 0.12, 0.95, 0.09)
  k.pulse(G_BOW, true, x - dx * 30, y - dy * 30, h, 80, 110, 0.2, Math.atan2(dy, dx), 0, P.body, 1.0, 0, 0, 0.6)
  kring(ctx, RING_EXPAND, x, y, fl, 20, 150, 0.35, 14, P.body[0], P.body[1], P.body[2])
  const ps = ctx.particles
  const base = Math.atan2(dy, dx)
  const n = ps.budget(34)
  for (let i = 0; i < n; i++) {
    const a = base + (Math.random() - 0.5) * 1.4
    const sp = 600 + Math.random() * 1100
    pspawn(ps, x, y, h, Math.cos(a) * sp, Math.sin(a) * sp, 50 + Math.random() * 300, 0.18 + Math.random() * 0.22, 7, 1, P.spark[0], P.spark[1], P.spark[2], -1200, 3, -0.12)
  }
  const nd = ctx.debris.budget(8)  // stone chips knocked off the floor
  for (let i = 0; i < nd; i++) {
    const a = Math.random() * Math.PI * 2
    const sp = 150 + Math.random() * 300
    const g = 0.05 + Math.random() * 0.05
    ctx.debris.spawn(x, y, fl + 10, Math.cos(a) * sp, Math.sin(a) * sp, 200 + Math.random() * 250, 0.6, 6 + Math.random() * 6, 3, g, g, g * 1.1, -1700, 0.6, 0)
  }
  kflash(ctx, x, y, h, 0.12, 180, 90, P.body[0] * 0.8, P.body[1] * 0.8, P.body[2] * 0.8)
  ctx.shakeNear(x, y, 0.3)
}

const mod: SpellVfx = {
  spell: 'thrust',
  modifiers: ['thrust'],
  init(ctx) {
    K = acquireKit(ctx)
  },
  dispose() {
    releaseKit(K)
    K = null
    ghosts.clear()
    lastGhost.clear()
    slamAt.clear()
    tierOf.clear()
  },

  onEvent(e: SimEvent, ctx) {
    const k = K
    if (!k) return
    switch (e.type) {
      case 'cast': {
        if (e.spell !== 'thrust') return
        const info = ctx.pawn(e.pawn)
        if (!info) return
        const dx0 = e.x - info.x
        const dy0 = e.y - info.y
        const l = Math.hypot(dx0, dy0) || 1
        const dx = dx0 / l
        const dy = dy0 / l
        const tier = k.tierOf(e)
        tierOf.set(e.pawn, tier)
        k.origin(info, o)
        kflash(ctx, o.x, o.y, o.h, 0.12, 140, 80, P.hot[0] * 0.8, P.hot[1] * 0.8, P.hot[2] * 0.8)
        k.levelFlash(o.x, o.y, o.h, tier, P, e.pawn)
        // launch kick: shock behind, dust and sparks thrown back
        const fl = k.floor(info.x, info.y)
        k.pulse(G_BOW, false, info.x - dx * 40, info.y - dy * 40, fl + 2, 70, 120, 0.3, Math.atan2(-dy, -dx), 0, P.body, 1.1, 0, 0, 0.8)
        kring(ctx, RING_EXPAND, info.x, info.y, fl, 15, 110, 0.3, 10, P.body[0] * 0.8, P.body[1] * 0.8, P.body[2] * 0.8)
        const ps = ctx.particles
        const n = ps.budget(20)
        for (let i = 0; i < n; i++) {
          const a = Math.atan2(-dy, -dx) + (Math.random() - 0.5) * 1.6
          const sp = 300 + Math.random() * 500
          pspawn(ps, info.x, info.y, fl + 10, Math.cos(a) * sp, Math.sin(a) * sp, 60 + Math.random() * 160, 0.2 + Math.random() * 0.2, 7, 1, P.spark[0], P.spark[1], P.spark[2], -1000, 3, -0.1)
        }
        const ns = ctx.smoke.budget(4)
        for (let i = 0; i < ns; i++) ctx.smoke.spawn(info.x, info.y, fl + 15, -dx * 160 + (Math.random() - 0.5) * 80, -dy * 160 + (Math.random() - 0.5) * 80, 30, 0.7, 26, 90, 0.08, 0.08, 0.09, 10, 1.4, 6)
        ctx.shakeNear(info.x, info.y, 0.1)
        return
      }
      case 'spellHit': {
        if (e.spell !== 'thrust') return
        slamAt.set(e.pawn, ctx.now)
        const t = pawnById(ctx.state, e.target)
        const caster = pawnById(ctx.state, e.pawn)
        if (caster) k.expect('thrust', caster.owner, e.target, e.x, e.y, 200, 0, ctx.level ? ctx.level(e) : 1)
        const tx = t ? t.x : e.x + 1
        const ty = t ? t.y : e.y
        const dx0 = tx - e.x
        const dy0 = ty - e.y
        const l = Math.hypot(dx0, dy0) || 1
        const info = ctx.pawn(e.pawn)
        slam(k, ctx, e.x + (dx0 / l) * 45, e.y + (dy0 / l) * 45, dx0 / l, dy0 / l, (info?.h ?? 30) + 60)
        return
      }
      case 'damage': {
        const a = k.attributeDamage(e)
        if (!a || a.spell !== 'thrust') return
        const v = ctx.pawn(e.target)
        k.hitDir(ctx.state, e.target, e.x - 1, e.y, e.x, e.y, dir)
        k.impact(e.x, e.y, (v?.h ?? 30) + 60, e.kb, dir.x, dir.y, P, 1.1, a.tier)
        return true
      }
      case 'modifier': {
        if (e.id !== 'thrust' || e.on) return
        if (ctx.now - (slamAt.get(e.pawn) ?? -10) < 0.05) return
        // expired: hard brake
        const p = pawnById(ctx.state, e.pawn)
        const info = ctx.pawn(e.pawn)
        if (!p || !info || !p.alive) return
        const sp = Math.hypot(p.vx, p.vy)
        const dx = sp > 1 ? p.vx / sp : 1
        const dy = sp > 1 ? p.vy / sp : 0
        const fl = k.floor(info.x, info.y)
        const ns = ctx.smoke.budget(6)
        for (let i = 0; i < ns; i++) ctx.smoke.spawn(info.x + dx * 20, info.y + dy * 20, fl + 12, dx * 180 + (Math.random() - 0.5) * 120, dy * 180 + (Math.random() - 0.5) * 120, 40, 0.8, 30, 110, 0.09, 0.09, 0.1, 15, 1.5, 6)
        const ps = ctx.particles
        const n = ps.budget(14)
        for (let i = 0; i < n; i++) {
          const a = Math.atan2(dy, dx) + (Math.random() - 0.5) * 1.2
          const v = 250 + Math.random() * 400
          pspawn(ps, info.x, info.y, fl + 8, Math.cos(a) * v, Math.sin(a) * v, 40 + Math.random() * 120, 0.2 + Math.random() * 0.15, 6, 1, P.spark[0], P.spark[1], P.spark[2], -1200, 3, -0.1)
        }
        k.pulse(G_SHOCK, false, info.x, info.y, fl + 1.5, 60, 60, 0.25, 0, 0, P.body, 0.7, 0.2, 0.95, 0.12)
        return
      }
      case 'death':
        if (e.cause !== 'thrust') return
        return spellDeath(k, ctx, e)
      default:
        return
    }
  },

  frame(ctx) {
    const k = K
    if (!k || ghosts.n === 0) return
    k.begin()
    drawGhosts(k, ctx.now)
  },

  drawModifier(pawn, m, x, y, ctx) {
    const k = K
    if (!k) return
    k.begin()
    const info = ctx.pawn(pawn.id)
    const h0 = info ? info.h : k.floor(x, y)
    const dx = m.data.dx
    const dy = m.data.dy
    const sp = Math.hypot(pawn.vx, pawn.vy)
    const k01 = Math.min(1, sp / 1300)
    const now = ctx.now
    // bow shock on the r60 contact collider, flat at chest height + a ground arc
    k.air.add(G_BOW, x + dx * 20, y + dy * 20, h0 + 62, 64, Math.atan2(dy, dx), P.body[0], P.body[1], P.body[2], 0.4 + 0.45 * k01, now * 3, 0.6)
    k.ground.add(G_BOW, x + dx * 10, y + dy * 10, k.floor(x, y) + 2, 70, Math.atan2(dy, dx), P.body[0], P.body[1], P.body[2], 0.4 * k01, now * 3, 0.9)
    // speed streaks peeling off shoulders, hips and staff side
    const px = -dy
    const py = dx
    k.trailPoint(-2000 - pawn.id * 8, x + px * 24, y + py * 24, h0 + 104, STREAK, pawn.owner)
    k.trailPoint(-2001 - pawn.id * 8, x - px * 24, y - py * 24, h0 + 98, STREAK, pawn.owner)
    k.trailPoint(-2002 - pawn.id * 8, x + px * 16, y + py * 16, h0 + 46, STREAK, pawn.owner)
    k.trailPoint(-2003 - pawn.id * 8, x - px * 16, y - py * 16, h0 + 40, STREAK, pawn.owner)
    k.trailPoint(-2004 - pawn.id * 8, x, y, k.floor(x, y) + 3, WAKE, pawn.owner)
    // power tiers: a white-hot core streak through the body (1+), embers off the bow (2)
    const tier = tierOf.get(pawn.id) ?? 0
    k.powerLayers(-2005 - pawn.id * 8, x, y, h0 + 70, P, tier, dx, dy, 30)
    // afterimages every ~35 ms
    const lg = lastGhost.get(pawn.id) ?? -10
    if (now - lg > 0.035) {
      lastGhost.set(pawn.id, now)
      addGhost(k, x, y, h0, now, pawn.owner)
    }
    k.halo(x + dx * 30, y + dy * 30, h0 + 60, 90, P.body[0] * 0.22 * k01, P.body[1] * 0.22 * k01, P.body[2] * 0.22 * k01, 1.8, 0.6)
    ctx.glow.add(x, y, 150, 0.55, P.light[0], P.light[1], P.light[2])
    const ps = ctx.particles
    const n = ps.budget(ctx.dt * 70)
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2
      pspawn(ps, x + Math.cos(a) * 20, y + Math.sin(a) * 20, h0 + 6, -dx * 300 + (Math.random() - 0.5) * 160, -dy * 300 + (Math.random() - 0.5) * 160, 40 + Math.random() * 100, 0.18 + Math.random() * 0.15, 6, 1, P.spark[0], P.spark[1], P.spark[2], -900, 3, -0.08)
    }
  },
}

registerSpellVfx(mod)
