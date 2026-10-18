/**
 * Pact (item; identity dark wine / blood). spells.md §8.4.
 *
 * - windup: a blood sigil on the hand; cast: the pact sigil slams down under
 *   the caster with a dark burst
 * - 'pact' (armed, up to 5 s): the sigil turns slowly under the feet, blood
 *   motes rise, the cast hand smoulders: the next damaging spell is boosted
 * - consumed (pact off + 'pactSlow' on in the same tick): the sigil shatters,
 *   crimson shockwave and shards
 * - expired unused: the sigil fades out in dark smoke
 * - 'pactSlow' (6 s, -66 speed): heavy dark ash and a dragging blood ring at
 *   the feet
 */
import type { SimEvent } from '../../../sim/types'
import { RING_EXPAND } from '../../scene/GroundFx'
import { registerSpellVfx, type PawnRenderInfo, type SpellVfx, type VfxCtx } from '../registry'
import { G_DISC, G_SHOCK, G_SIGIL, acquireKit, kflash, kring, palFor, pawnById, pspawn, releaseKit, trailFrom, windupProgress, type KitA, type TrailStyle } from './kitA'

const P = palFor('pact')
let K: KitA | null = null
const o = { x: 0, y: 0, h: 0 }
/** pawn id -> time Pact was consumed (to tell consumption from expiry) */
const consumedAt = new Map<number, number>()

const DRAG: TrailStyle = trailFrom(P, { life: 0.6, width: 50, widthTail: 0.5, intensity: 0.8, falloff: 1.2, noise: 0.85, spacing: 10, rim: 0.25, flat: true }, 0.15)

function shatter(k: KitA, ctx: VfxCtx, x: number, y: number, h: number): void {
  const fl = k.floor(x, y)
  k.pulse(G_SIGIL, false, x, y, fl + 2, 70, 95, 0.55, 0, 1.5, P.body, 1.6, 0.05, 1.0, x)
  k.pulse(G_SHOCK, false, x, y, fl + 1.5, 160, 160, 0.4, 0, 0, P.body, 1.2, 0.1, 0.95, 0.07)
  kring(ctx, RING_EXPAND, x, y, fl, 20, 160, 0.4, 12, P.body[0], P.body[1], P.body[2])
  const ps = ctx.particles
  const n = ps.budget(30)
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2
    const sp = 250 + Math.random() * 450
    pspawn(ps, x + Math.cos(a) * 40, y + Math.sin(a) * 40, fl + 8, Math.cos(a) * sp, Math.sin(a) * sp, 120 + Math.random() * 300, 0.35 + Math.random() * 0.3, 10, 3, P.spark[0], P.spark[1], P.spark[2], -1400, 1.5, -0.06)
  }
  const ns = ctx.smoke.budget(6)
  for (let i = 0; i < ns; i++) {
    const a = Math.random() * Math.PI * 2
    ctx.smoke.spawn(x, y, fl + 30, Math.cos(a) * 110, Math.sin(a) * 110, 50, 1.1, 40, 120, P.edge[0] * 0.12, P.edge[1] * 0.12, P.edge[2] * 0.12, 15, 1, 10)
  }
  kflash(ctx, x, y, h + 60, 0.22, 220, 140, P.hot[0] * 0.8, P.hot[1] * 0.6, P.hot[2] * 0.6)
  ctx.shakeNear(x, y, 0.12)
}

/** A blood seal held on the hand. Free blood motes belong to the committed buff. */
function signature(k: KitA, _ctx: VfxCtx, _info: PawnRenderInfo, id: number, _tx: number, _ty: number, w: number): void {
  k.air.add(G_SIGIL, o.x, o.y, o.h + 1, 31, 0, P.body[0], P.body[1], P.body[2], 0.5 + 1.0 * w, 0, id)
}

const mod: SpellVfx = {
  spell: 'pact',
  modifiers: ['pact', 'pactSlow'],
  init(ctx) {
    K = acquireKit(ctx)
  },
  dispose() {
    releaseKit(K)
    K = null
    consumedAt.clear()
  },

  onEvent(e: SimEvent, ctx) {
    const k = K
    if (!k) return
    switch (e.type) {
      case 'castStart':
        if (e.spell === 'pact') k.windupTotal.set(e.pawn, e.ticks)
        return
      case 'cast': {
        if (e.spell !== 'pact') return
        const info = ctx.pawn(e.pawn)
        if (!info) return
        const fl = k.floor(info.x, info.y)
        k.pulse(G_SIGIL, false, info.x, info.y, fl + 2, 120, 70, 0.35, 0, 2, P.body, 1.6, 0, 0, e.pawn)
        kring(ctx, RING_EXPAND, info.x, info.y, fl, 30, 120, 0.3, 10, P.body[0], P.body[1], P.body[2])
        k.origin(info, o)
        kflash(ctx, o.x, o.y, o.h, 0.16, 150, 90, P.body[0] * 1.4, P.body[1] * 1.4, P.body[2] * 1.4)
        const ps = ctx.particles
        const n = ps.budget(20)
        for (let i = 0; i < n; i++) {
          const a = Math.random() * Math.PI * 2
          const sp = 100 + Math.random() * 200
          pspawn(ps, info.x, info.y, fl + 10, Math.cos(a) * sp, Math.sin(a) * sp, 150 + Math.random() * 200, 0.5, 9, 2, P.spark[0], P.spark[1], P.spark[2], -300, 2, 4)
        }
        return
      }
      case 'modifier': {
        if (e.id === 'pactSlow' && e.on) {
          consumedAt.set(e.pawn, ctx.now)
          const info = ctx.pawn(e.pawn)
          if (info) shatter(k, ctx, info.x, info.y, info.h)
          return
        }
        if (e.id === 'pact' && !e.on) {
          // expired unused (consumption also turns it off, in the same tick as pactSlow)
          const p = pawnById(ctx.state, e.pawn)
          const hasSlow = !!p && p.modifiers.some((m) => m.id === 'pactSlow')
          if (hasSlow || ctx.now - (consumedAt.get(e.pawn) ?? -10) < 0.1) return
          const info = ctx.pawn(e.pawn)
          if (!info || !info.alive) return
          const fl = k.floor(info.x, info.y)
          k.pulse(G_SIGIL, false, info.x, info.y, fl + 2, 70, 60, 0.6, 0, 0.5, P.edge, 1.0, 0, 0, e.pawn)
          ctx.smoke.spawn(info.x, info.y, fl + 20, 0, 0, 40, 1.2, 50, 130, 0.04, 0.01, 0.015, 15, 1, 12)
        }
        return
      }
      default:
        return
    }
  },

  frame(ctx) {
    const k = K
    const s = ctx.state
    if (!k || !s) return
    for (const p of s.pawns) {
      if (!p.alive || !p.cast || p.cast.spell !== 'pact' || p.cast.started === false) continue
      const info = ctx.pawn(p.id)
      if (!info) continue
      k.begin()
      k.origin(info, o)
      const w = windupProgress(k, ctx, p.id, p.cast.ticksLeft)
      k.windupAt(o.x, o.y, o.h, w, P, ctx.now, ctx.dt, p.id)
      signature(k, ctx, info, p.id, p.cast.x, p.cast.y, w)
    }
  },

  drawModifier(pawn, m, x, y, ctx) {
    const k = K
    if (!k) return
    k.begin()
    const info = ctx.pawn(pawn.id)
    const h0 = info ? info.h : k.floor(x, y)
    const now = ctx.now
    const left = m.ticksLeft / 60
    const ps = ctx.particles
    if (m.id === 'pact') {
      // armed: slow-turning sigil, rising blood motes, smouldering hand
      const fade = Math.min(1, left / 0.6)
      const beat = 0.8 + 0.2 * Math.sin(now * 5.5)
      k.ground.add(G_SIGIL, x, y, h0 + 1.8, 70, now * 0.7, P.body[0], P.body[1], P.body[2], 1.1 * fade * beat, 0, pawn.id)
      k.ground.add(G_DISC, x, y, h0 + 1.5, 76, 0, P.edge[0], P.edge[1], P.edge[2], 0.5 * fade, 1.2)
      const n = ps.budget(ctx.dt * 22)
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2
        const rr = 20 + Math.random() * 45
        pspawn(ps, x + Math.cos(a) * rr, y + Math.sin(a) * rr, h0 + 5, 0, 0, 90 + Math.random() * 90, 0.8 + Math.random() * 0.4, 8, 2, P.spark[0], P.spark[1], P.spark[2], 20, 1, 6)
      }
      if (info) {
        k.origin(info, o)
        k.glowAt(o.x, o.y, o.h, 46 * beat, P.body[0] * 0.8, P.body[1] * 0.8, P.body[2] * 0.8, 2.2)
        if (Math.random() < ctx.dt * 10) pspawn(ps, o.x, o.y, o.h, (Math.random() - 0.5) * 40, (Math.random() - 0.5) * 40, 40, 0.5, 6, 2, P.spark[0], P.spark[1], P.spark[2], 40, 1, 4)
      }
      ctx.glow.add(x, y, 120, 0.5 * fade, P.light[0], P.light[1], P.light[2])
    } else {
      // pactSlow: dragging blood ring + heavy ash
      const fade = Math.min(1, left / 0.8)
      k.trailPoint(-4000 - pawn.id, x, y, h0 + 3, DRAG, pawn.owner, fade)
      k.ground.add(G_SHOCK, x, y, h0 + 1.6, 48, now, P.body[0], P.body[1], P.body[2], 0.6 * fade, 0.85, 0.12)
      const n = ps.budget(ctx.dt * 10)
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2
        pspawn(ps, x + Math.cos(a) * 24, y + Math.sin(a) * 24, h0 + 90 + Math.random() * 50, 0, 0, -20, 0.9, 7, 4, P.edge[0] * 0.8, P.edge[1] * 0.8, P.edge[2] * 0.8, -220, 0, 0)
      }
      if (Math.random() < ctx.dt * 4) ctx.smoke.spawn(x, y, h0 + 30, 0, 0, 20, 1.0, 30, 80, 0.03, 0.01, 0.012, 20, 1, 6)
    }
  },
}

registerSpellVfx(mod)
