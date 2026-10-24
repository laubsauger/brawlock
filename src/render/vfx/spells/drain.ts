/**
 * Drain (column 3, Damage; identity sickly green / dark olive). spells.md §8.13.
 *
 * - windup / cast: motes into the hand, muzzle
 * - flight: a parasite orb (core = the 24.5 collision radius), dark olive
 *   tendrils writhing around the path, drips falling off it, faint halo
 * - the one-time re-aim ('turned' 0 -> 1): a snap pulse and a lash toward the
 *   new heading
 * - enemy hit: kb-scaled impact (tiny, kb 0.2) + a siphon splash pulled out of
 *   the victim; 'drainSlow': sickly goo under the feet, drips, sluggish
 *   tendrils for the slow duration
 * - 'drainHeal' orb: bright life-green orb flying back to the caster with a
 *   life-stream trail and sparkle motes; arrival: green bloom + rising motes
 * - ally hit: heal flare; 'drainHaste': green wind wisps at the feet
 */
import type { SimEvent } from '../../../sim/types'
import { secondsOf } from '../../../sim/config'
import { RING_EXPAND, RING_IMPLODE } from '../../scene/GroundFx'
import { registerSpellVfx, type PawnRenderInfo, type SpellVfx, type VfxCtx } from '../registry'
import { G_CROSS, G_DISC, G_RUNE, G_SHOCK, PH, acquireKit, kflash, kring, palFor, pawnById, pspawn, releaseKit, trailFrom, windupProgress, type KitA, type Pal, type TrailStyle } from './kitA'
import { spellDeath } from './deathsA'

const P = palFor('drain')
/** heal orb: the drain hue, lifted toward its pale life-green core */
const H: Pal = { hot: [P.hot[0] * 1.05, P.hot[1] * 1.05, P.hot[2] * 1.05], body: [P.hot[0] * 0.55, P.hot[1] * 0.65, P.hot[2] * 0.5], edge: [P.hot[0] * 0.3, P.hot[1] * 0.42, P.hot[2] * 0.25], tail: P.body, light: [P.light[0] * 1.4, P.light[1] * 1.6, P.light[2]], spark: P.hot }
/** the parasite bolt keeps a dark sickly core (no white centre): reads apart from the heal orb */
const BOLT_CORE: [number, number, number] = [P.body[0] * 1.7, P.body[1] * 1.7, P.body[2] * 1.7]
/** last '+' mote per heal orb */
const plusAt = new Map<number, number>()
let K: KitA | null = null
const o = { x: 0, y: 0, h: 0 }
const dir = { x: 0, y: 0 }
/** projectile id -> kind, owner and last turned flag */
const seen = new Map<number, { heal: boolean; turned: number; owner: number }>()

function nearestPawn(ctx: VfxCtx, x: number, y: number): number | null {
  const s = ctx.state
  if (!s) return null
  let best: number | null = null
  let bd = 200
  for (const p of s.pawns) {
    const d = Math.hypot(p.x - x, p.y - y)
    if (p.alive && d < bd) {
      bd = d
      best = p.id
    }
  }
  return best
}

function ownerOfProjectileHit(_ctx: VfxCtx, id: number): number {
  return seen.get(id)?.owner ?? -1
}

function sameTeam(ctx: VfxCtx, a: number, b: number): boolean {
  const s = ctx.state
  if (!s) return false
  let ta = -1
  let tb = -2
  for (const sl of s.slots) {
    if (sl.id === a) ta = sl.team
    if (sl.id === b) tb = sl.team
  }
  return ta === tb
}

const TRAIL: TrailStyle = trailFrom(P, { life: 0.3, width: 30, widthTail: 0.2, intensity: 1.4, falloff: 1.3, noise: 0.7, spacing: 8, rim: 0.3 }, 0.3)
const TENDRIL: TrailStyle = trailFrom(P, { life: 0.4, width: 10, widthTail: 0.3, intensity: 1.2, falloff: 1.8, noise: 0.85, spacing: 6, rim: 0 }, 0.2)
const HEAL: TrailStyle = trailFrom(H, { life: 0.45, width: 26, widthTail: 0.15, intensity: 1.8, falloff: 1.4, noise: 0.5, spacing: 8, rim: 0.2 }, 0.6)
const HASTE: TrailStyle = trailFrom(H, { life: 0.4, width: 36, widthTail: 0.3, intensity: 0.9, falloff: 1.3, noise: 0.8, spacing: 10, rim: 0.3, flat: true }, 0.3)

function bloom(k: KitA, ctx: VfxCtx, x: number, y: number, h: number): void {
  const ps = ctx.particles
  const n = ps.budget(18)
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2
    const rr = 15 + Math.random() * 25
    pspawn(ps, x + Math.cos(a) * rr, y + Math.sin(a) * rr, h + Math.random() * 60, Math.cos(a) * 40, Math.sin(a) * 40, 140 + Math.random() * 160, 0.7 + Math.random() * 0.4, 9, 2, H.spark[0], H.spark[1], H.spark[2], -40, 1, 10)
  }
  const fl = k.floor(x, y)
  kring(ctx, RING_IMPLODE, x, y, fl, 15, 90, 0.3, 8, H.body[0], H.body[1], H.body[2])
  k.pulse(G_RUNE, false, x, y, fl + 2, 50, 80, 0.5, 0, 2, H.body, 0.9, 1, 1, x)
  kflash(ctx, x, y, h + 40, 0.22, 170, 110, H.body[0] * 1.2, H.body[1] * 1.2, H.body[2] * 1.2)
}

/** Three inward curls inked around the palm; no free gathering vortex. */
function signature(k: KitA, _ctx: VfxCtx, _info: PawnRenderInfo, id: number, _tx: number, _ty: number, w: number): void {
  const R = 27 - 7 * w
  for (let j = 0; j < 3; j++) {
    const a0 = (j / 3) * Math.PI * 2 + id
    k.stripBegin(false, 2, 0, j)
    const N = 10
    for (let i = 0; i <= N; i++) {
      const t = i / N
      const rr = R * (1 - t)
      const a = a0 + t * 2.2
      const px = o.x + Math.cos(a) * rr
      const py = o.y + Math.sin(a) * rr
      const ph = o.h + Math.sin(t * Math.PI) * 6
      k.stripPoint(px, py, ph, 5 * (1 - t * 0.6), P.body[0], P.body[1], P.body[2], 0.55 + 0.65 * w, P.body[0], P.body[1], P.body[2], 0.15)
    }
    k.stripEnd()
  }
}

const mod: SpellVfx = {
  spell: 'drain',
  kinds: ['drainHeal'],
  modifiers: ['drainSlow', 'drainHaste'],
  init(ctx) {
    K = acquireKit(ctx)
  },
  dispose() {
    releaseKit(K)
    K = null
    seen.clear()
    plusAt.clear()
  },

  onEvent(e: SimEvent, ctx) {
    const k = K
    if (!k) return
    switch (e.type) {
      case 'castStart':
        if (e.spell === 'drain') k.windupTotal.set(e.pawn, e.ticks)
        return
      case 'cast': {
        if (e.spell !== 'drain') return
        const info = ctx.pawn(e.pawn)
        if (!info) return
        k.origin(info, o)
        const dx = e.x - info.x
        const dy = e.y - info.y
        const l = Math.hypot(dx, dy) || 1
        k.muzzle(o.x, o.y, o.h, dx / l, dy / l, P, 0.9)
        k.levelFlash(o.x, o.y, o.h, k.tierOf(e), P, e.pawn)
        return
      }
      case 'damage': {
        const a = k.attributeDamage(e)
        if (!a || a.spell !== 'drain') return
        const v = ctx.pawn(e.target)
        const h = (v?.h ?? 30) + 60
        k.hitDir(ctx.state, e.target, e.x - 1, e.y, e.x, e.y, dir)
        k.impact(e.x, e.y, h, e.kb, dir.x, dir.y, P, 0.8, a.tier)
        // siphon: essence ripped out of the victim, swirling up
        const ps = ctx.particles
        const n = ps.budget(18)
        for (let i = 0; i < n; i++) {
          const ang = Math.random() * Math.PI * 2
          const sp = 60 + Math.random() * 160
          pspawn(ps, e.x + Math.cos(ang) * 20, e.y + Math.sin(ang) * 20, h - 30 + Math.random() * 60, Math.cos(ang) * sp, Math.sin(ang) * sp, 80 + Math.random() * 120, 0.4 + Math.random() * 0.3, 14, 3, P.body[0] * 1.5, P.body[1] * 1.5, P.body[2] * 1.5, -100, 2, 6)
        }
        return true
      }
      case 'projectileHit': {
        if (e.spell !== 'drain') return
        const st = seen.get(e.id)
        if (st?.heal) {
          // heal orb arrived: life bloom on the caster
          const pid = nearestPawn(ctx, e.x, e.y)
          const v = pid !== null ? ctx.pawn(pid) : null
          if (v) bloom(k, ctx, v.x, v.y, v.h + 20)
          return
        }
        const tp = e.target !== null ? pawnById(ctx.state, e.target) : undefined
        const owner = tp && ctx.state ? ownerOfProjectileHit(ctx, e.id) : -1
        if (tp && owner >= 0 && sameTeam(ctx, owner, tp.owner)) {
          // ally: heal flare on them (their 'drainHaste' wisps follow)
          const v = ctx.pawn(tp.id)
          if (v) bloom(k, ctx, v.x, v.y, v.h + 20)
          return
        }
        const fl = k.floor(e.x, e.y)
        k.pulse(G_SHOCK, false, e.x, e.y, fl + 1.5, 70, 70, 0.3, Math.random() * 6, 0, P.body, 1.0, 0.1, 0.95, 0.1)
        kflash(ctx, e.x, e.y, PH, 0.16, 140, 80, P.hot[0] * 0.6, P.hot[1] * 0.6, P.hot[2] * 0.6)
        const ns = ctx.smoke.budget(4)
        for (let i = 0; i < ns; i++) ctx.smoke.spawn(e.x, e.y, PH, (Math.random() - 0.5) * 80, (Math.random() - 0.5) * 80, 40, 1.0, 30, 100, P.edge[0] * 0.08, P.edge[1] * 0.08, P.edge[2] * 0.08, 20, 1.2, 8)
        return
      }
      case 'projectileExpire': {
        if (e.spell !== 'drain') return
        const ps = ctx.particles
        const n = ps.budget(10)
        for (let i = 0; i < n; i++) pspawn(ps, e.x, e.y, PH, (Math.random() - 0.5) * 160, (Math.random() - 0.5) * 160, -60 - Math.random() * 60, 0.5, 9, 2, P.body[0], P.body[1], P.body[2], -400, 1, 0)
        ctx.smoke.spawn(e.x, e.y, PH, 0, 0, 30, 1.0, 30, 90, 0.04, 0.05, 0.02, 20, 1, 8)
        return
      }
      case 'projectileBounce':
        if (e.spell !== 'drain') return
        kflash(ctx, e.x, e.y, PH, 0.1, 110, 60, P.body[0], P.body[1], P.body[2])
        kring(ctx, RING_EXPAND, e.x, e.y, k.floor(e.x, e.y), 8, 50, 0.2, 5, P.body[0], P.body[1], P.body[2])
        return
      case 'death':
        if (e.cause !== 'drain') return
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
      if (!p.alive || !p.cast || p.cast.spell !== 'drain' || p.cast.started === false) continue
      const info = ctx.pawn(p.id)
      if (!info) continue
      k.begin()
      k.origin(info, o)
      const w = windupProgress(k, ctx, p.id, p.cast.ticksLeft)
      k.windupAt(o.x, o.y, o.h, w, P, ctx.now, ctx.dt, p.id)
      signature(k, ctx, info, p.id, p.cast.x, p.cast.y, w)
    }
    if (seen.size > 0) {
      for (const id of seen.keys()) {
        let alive = false
        for (const q of s.projectiles) {
          if (q.id === id) {
            alive = true
            break
          }
        }
        if (!alive) {
          seen.delete(id)
          plusAt.delete(id)
        }
      }
    }
  },

  drawProjectile(p, x, y, ctx) {
    const k = K
    if (!k) return
    k.begin()
    k.track(p, x, y)
    const now = ctx.now
    const heal = p.kind === 'drainHeal'
    let st = seen.get(p.id)
    if (!st) {
      st = { heal, turned: p.data.turned ?? 0, owner: p.owner }
      seen.set(p.id, st)
    }
    const sp = Math.hypot(p.vx, p.vy)
    const dx = sp > 1 ? p.vx / sp : 1
    const dy = sp > 1 ? p.vy / sp : 0
    if (heal) {
      // life orb returning to the caster
      const r = 20
      k.cores.add(x, y, PH + 10, r, dx, dy, 1.2, p.id, H.edge, H.body, H.hot)
      k.halo(x, y, PH + 10, 90, H.body[0] * 0.45, H.body[1] * 0.45, H.body[2] * 0.45, 1.7, 0.3)
      ctx.glow.add(x, y, 130, 0.5, H.light[0], H.light[1], H.light[2])
      ctx.projectileShadow(x, y, PH + 10, r)
      k.trailPoint(p.id * 16, x, y, PH + 10, HEAL, p.owner)
      // '+' glyphs on the orb and shed along its path: unmistakably a heal
      k.air.add(G_CROSS, x, y, PH + 12, 22, Math.PI / 4, H.hot[0], H.hot[1], H.hot[2], 1.1, 1)
      if (ctx.now - (plusAt.get(p.id) ?? -1) > 0.07) {
        plusAt.set(p.id, ctx.now)
        k.pulse(G_CROSS, true, x, y, PH + 14, 15, 11, 0.45, Math.PI / 4, 0, H.body, 1.0, 1, 1, 0)
      }
      const ps = ctx.particles
      const n = ps.budget(ctx.dt * 40)
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2
        pspawn(ps, x + Math.cos(a) * 16, y + Math.sin(a) * 16, PH + 10 + (Math.random() - 0.5) * 20, -dx * 60, -dy * 60, 30 + Math.random() * 50, 0.5 + Math.random() * 0.3, 6, 1, H.spark[0], H.spark[1], H.spark[2], 0, 1, 6)
      }
      return
    }
    // the parasite orb
    const r = Math.max(18, p.radius)
    const t = p.data.turned ?? 0
    if (t === 1 && st.turned === 0) {
      // the one-time re-aim: snap pulse + a lash along the new heading
      k.pulse(G_SHOCK, true, x, y, PH, 60, 60, 0.25, 0, 0, P.body, 1.2, 0.15, 0.95, 0.12)
      kflash(ctx, x, y, PH, 0.12, 120, 70, P.hot[0] * 0.6, P.hot[1] * 0.6, P.hot[2] * 0.6)
      const ps = ctx.particles
      const n = ps.budget(10)
      for (let i = 0; i < n; i++) {
        const a = Math.atan2(dy, dx) + (Math.random() - 0.5) * 0.5
        const v = 300 + Math.random() * 400
        pspawn(ps, x, y, PH, Math.cos(a) * v, Math.sin(a) * v, (Math.random() - 0.5) * 60, 0.15, 7, 1, P.spark[0], P.spark[1], P.spark[2], 0, 4, -0.12)
      }
    }
    st.turned = t
    k.cores.add(x, y, PH, r, dx, dy, 0.6, p.id, P.edge, P.body, BOLT_CORE)
    k.halo(x, y, PH, r * 4, P.body[0] * 0.3, P.body[1] * 0.3, P.body[2] * 0.3, 1.5, 0.6)
    ctx.glow.add(x, y, 140, 0.45, P.light[0], P.light[1], P.light[2])
    ctx.projectileShadow(x, y, PH, r)
    k.trailPoint(p.id * 16, x, y, PH, TRAIL, p.owner)
    k.powerLayers(p.id * 16 + 15, x, y, PH, P, k.tierOf(p), dx, dy, r)
    // three writhing tendrils
    const px = -dy
    const py = dx
    for (let j = 0; j < 3; j++) {
      const ph = now * (9 + j * 2.3) + p.id + j * 2.1
      const s = Math.sin(ph) * (14 + j * 4)
      const c = Math.cos(ph * 1.3) * 12
      k.trailPoint(p.id * 16 + 1 + j, x - dx * r * 0.5 + px * s, y - dy * r * 0.5 + py * s, PH + c, TENDRIL)
    }
    // drips
    const ps = ctx.particles
    const n = ps.budget(ctx.dt * 20)
    for (let i = 0; i < n; i++) pspawn(ps, x + (Math.random() - 0.5) * r, y + (Math.random() - 0.5) * r, PH - r * 0.5, 0, 0, -20, 0.45, 7, 4, P.body[0], P.body[1], P.body[2], -500, 0, 0)
  },

  drawModifier(pawn, m, x, y, ctx) {
    const k = K
    if (!k) return
    k.begin()
    const info = ctx.pawn(pawn.id)
    const h0 = info ? info.h : k.floor(x, y)
    const now = ctx.now
    const left = secondsOf(m.ticksLeft)
    const fade = Math.min(1, left / 0.5)
    if (m.id === 'drainSlow') {
      // sickly goo pooled under the feet, drips off the robe
      const pulse = 0.75 + 0.25 * Math.sin(now * 4 + pawn.id)
      k.ground.add(G_DISC, x, y, h0 + 1.6, 62, 0, P.edge[0], P.edge[1], P.edge[2], 0.9 * fade * pulse, 1.6)
      k.ground.add(G_RUNE, x, y, h0 + 1.8, 56, -now * 0.6, P.body[0], P.body[1], P.body[2], 0.45 * fade, 1, pawn.id)
      const ps = ctx.particles
      const n = ps.budget(ctx.dt * 16)
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2
        pspawn(ps, x + Math.cos(a) * 22, y + Math.sin(a) * 22, h0 + 40 + Math.random() * 70, 0, 0, -10, 0.55, 8, 4, P.body[0], P.body[1], P.body[2], -380, 0, 0)
      }
    } else {
      // drainHaste: green wind wisps trailing at the feet
      k.trailPoint(-3000 - pawn.id, x, y, h0 + 3, HASTE, pawn.owner)
      const ps = ctx.particles
      const n = ps.budget(ctx.dt * 18)
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2
        pspawn(ps, x + Math.cos(a) * 20, y + Math.sin(a) * 20, h0 + 10, -pawn.vx * 0.2, -pawn.vy * 0.2, 60 + Math.random() * 60, 0.4, 7, 1, H.spark[0], H.spark[1], H.spark[2], 0, 2, 5)
      }
    }
  },
}

registerSpellVfx(mod)
