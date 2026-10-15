/**
 * Cluster (column 3, Damage; identity amber). spells.md §8.12.
 *
 * - windup: motes into the hand; cast: four flame tongues fanning out on the
 *   real bolt headings (+-0.06 / +-0.18 rad)
 * - flight (x4): small molten fireballs, core = sim radius 22 with a short
 *   comet tail, amber halo, short heat trail, a few embers (kept cheap: four
 *   per cast, ten casters)
 * - hit: kb-scaled burst (kb factor 0.65 makes these small) + molten splash,
 *   little scorch; expiry: the fire gutters out in smoke
 */
import type { SimEvent } from '../../../sim/types'
import { RING_EXPAND } from '../../scene/GroundFx'
import { registerSpellVfx, type PawnRenderInfo, type SpellVfx, type VfxCtx } from '../registry'
import { G_SHOCK, PH, acquireKit, kflash, kring, palFor, pspawn, releaseKit, trailFrom, windupProgress, type KitA, type TrailStyle } from './kitA'
import { spellDeath } from './deathsA'

const P = palFor('cluster')
let K: KitA | null = null
const o = { x: 0, y: 0, h: 0 }
const dir = { x: 0, y: 0 }
const FAN = [-0.18, -0.06, 0.06, 0.18]
/** small bolts: keep the amber in the core too (a white core would eat the whole 22u sphere) */
const CORE: [number, number, number] = [P.hot[0] * 0.55 + P.body[0] * 0.9, P.hot[1] * 0.55 + P.body[1] * 0.9, P.hot[2] * 0.55 + P.body[2] * 0.9]

const TRAIL: TrailStyle = trailFrom(P, { life: 0.22, width: 40, widthTail: 0.15, intensity: 2.4, falloff: 1.4, noise: 0.5, spacing: 8, rim: 0.25 })

function splash(k: KitA, ctx: VfxCtx, x: number, y: number, hit: boolean): void {
  const ps = ctx.particles
  const n = ps.budget(hit ? 14 : 8)
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2
    const sp = 150 + Math.random() * 300
    pspawn(ps, x, y, PH, Math.cos(a) * sp, Math.sin(a) * sp, (Math.random() - 0.2) * 220, 0.22 + Math.random() * 0.2, 24 + Math.random() * 12, -8, P.body[0] * 1.3, P.body[1] * 1.3, P.body[2] * 1.3, -300, 5, 0)
  }
  const nd = ps.budget(hit ? 6 : 3)
  for (let i = 0; i < nd; i++) {
    const a = Math.random() * Math.PI * 2
    const sp = 120 + Math.random() * 220
    pspawn(ps, x, y, PH, Math.cos(a) * sp, Math.sin(a) * sp, 200 + Math.random() * 200, 0.5 + Math.random() * 0.3, 7, 3, P.spark[0], P.spark[1], P.spark[2], -1400, 1.2, -0.04)
  }
  const fl = k.floor(x, y)
  k.pulse(G_SHOCK, false, x, y, fl + 1.5, 55, 55, 0.24, Math.random() * 6, 0, P.body, 0.9, 0.12, 0.95, 0.1)
  if (hit) {
    kring(ctx, RING_EXPAND, x, y, fl, 8, 70, 0.26, 7, P.body[0] * 0.7, P.body[1] * 0.7, P.body[2] * 0.7)
    if (!ctx.isLava(x, y)) ctx.scorches.spawn(x, y, fl - 0.4, 30, 3)
  }
  kflash(ctx, x, y, PH, 0.12, hit ? 150 : 100, hit ? 80 : 55, P.body[0] * 1.2, P.body[1] * 1.2, P.body[2] * 1.2)
  const ns = ctx.smoke.budget(hit ? 3 : 4)
  for (let i = 0; i < ns; i++) ctx.smoke.spawn(x, y, PH, (Math.random() - 0.5) * 90, (Math.random() - 0.5) * 90, 50 + Math.random() * 30, 0.8 + Math.random() * 0.4, 24, 80, 0.05, 0.035, 0.02, 25, 1.2, 8)
}

const ORBIT: TrailStyle = trailFrom(P, { life: 0.07, width: 9, widthTail: 0.2, intensity: 1.5, falloff: 1.6, noise: 0.3, spacing: 4, rim: 0 }, 0.6)

/** signature charge-up: four small embers circling the hand */
function signature(k: KitA, ctx: VfxCtx, _info: PawnRenderInfo, id: number, _tx: number, _ty: number, w: number): void {
  k.orbit(o.x, o.y, o.h, 4, 34 - 8 * w, -ctx.now * (6 + 8 * w), 6 + 3 * w, P, 0.8 + 0.5 * w, -7000 - id * 4, ORBIT, 6)
}

const mod: SpellVfx = {
  spell: 'cluster',
  init(ctx) {
    K = acquireKit(ctx)
  },
  // our signature occupies the palm: keep render's arm rings + ground ring, drop its palm orb
  windupStyle: () => ({ hide: ['orb'] }),
  dispose() {
    releaseKit(K)
    K = null
  },

  onEvent(e: SimEvent, ctx) {
    const k = K
    if (!k) return
    switch (e.type) {
      case 'castStart':
        if (e.spell === 'cluster') k.windupTotal.set(e.pawn, e.ticks)
        return
      case 'cast': {
        if (e.spell !== 'cluster') return
        const info = ctx.pawn(e.pawn)
        if (!info) return
        k.origin(info, o)
        k.levelFlash(o.x, o.y, o.h, k.tierOf(e), P, e.pawn)
        const base = Math.atan2(e.y - info.y, e.x - info.x)
        kflash(ctx, o.x, o.y, o.h, 0.14, 150, 90, P.hot[0] * 0.7, P.hot[1] * 0.7, P.hot[2] * 0.7)
        const ps = ctx.particles
        for (const off of FAN) {
          const a0 = base + off
          const n = ps.budget(5)
          for (let i = 0; i < n; i++) {
            const a = a0 + (Math.random() - 0.5) * 0.12
            const sp = 200 + Math.random() * 350
            pspawn(ps, o.x, o.y, o.h, Math.cos(a) * sp, Math.sin(a) * sp, (Math.random() - 0.3) * 60, 0.16 + Math.random() * 0.1, 22, -6, P.body[0] * 1.3, P.body[1] * 1.3, P.body[2] * 1.3, 40, 5, 0)
          }
        }
        return
      }
      case 'damage': {
        const a = k.attributeDamage(e)
        if (!a || a.spell !== 'cluster') return
        const v = ctx.pawn(e.target)
        k.hitDir(ctx.state, e.target, e.x - 1, e.y, e.x, e.y, dir)
        k.impact(e.x, e.y, (v?.h ?? 30) + 55, e.kb, dir.x, dir.y, P, 0.9, a.tier)
        return true
      }
      case 'projectileHit':
        if (e.spell === 'cluster') splash(k, ctx, e.x, e.y, true)
        return
      case 'projectileExpire':
        if (e.spell === 'cluster') splash(k, ctx, e.x, e.y, false)
        return
      case 'death':
        if (e.cause !== 'cluster') return
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
      if (!p.alive || !p.cast || p.cast.spell !== 'cluster' || p.cast.started === false) continue
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
    const r = p.radius
    const sp = Math.hypot(p.vx, p.vy)
    const dx = sp > 1 ? p.vx / sp : 1
    const dy = sp > 1 ? p.vy / sp : 0
    k.cores.add(x, y, PH, r, dx, dy, 0.8, p.id, P.edge, P.body, CORE)
    k.halo(x, y, PH, r * 3.6, P.body[0] * 0.6, P.body[1] * 0.6, P.body[2] * 0.6, 1.8, 0.5)
    // ground light: one per pair of bolts (shared GLOW budget)
    if (p.id % 2 === 0) ctx.glow.add(x, y, 140, 0.45, P.light[0], P.light[1], P.light[2])
    ctx.projectileShadow(x, y, PH, r)
    k.trailPoint(p.id * 16, x, y, PH, TRAIL, p.owner)
    k.powerLayers(p.id * 16 + 15, x, y, PH, P, k.tierOf(p), dx, dy, r)
    const ps = ctx.particles
    const n = ps.budget(ctx.dt * 22)
    for (let i = 0; i < n; i++) {
      pspawn(ps, x - dx * r, y - dy * r, PH + (Math.random() - 0.5) * 10, -dx * 80 + (Math.random() - 0.5) * 70, -dy * 80 + (Math.random() - 0.5) * 70, 20 + Math.random() * 60, 0.3 + Math.random() * 0.2, 6, -2, P.spark[0], P.spark[1], P.spark[2], -120, 2, 3)
    }
  },
}

registerSpellVfx(mod)
