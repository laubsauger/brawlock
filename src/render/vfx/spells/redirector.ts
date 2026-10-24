/**
 * Redirector (item; identity bronze). spells.md §8.3.
 *
 * - windup: bronze motes into the hand, small turning rune; cast: a bronze
 *   pulse at the hand
 * - 'spellHit' (redirector) on the redirected projectile: a bronze pivot pin
 *   flares where it turned, a bent swoosh draws the old heading bending into
 *   the new one, sparks shear off the turn, and a bronze ring rides the
 *   projectile for half a second (also on spells drawn by other modules)
 * - 'redirectorPenalty' (+30% knockback taken, 8 s): a cracked bronze ward
 *   flickering under the feet with ember flakes peeling off, fading out over
 *   the last second
 */
import type { SimEvent } from '../../../sim/types'
import { secondsOf } from '../../../sim/config'
import { registerSpellVfx, type PawnRenderInfo, type SpellVfx, type VfxCtx } from '../registry'
import { G_RETICLE, G_RUNE, G_SHOCK, G_SIGIL, PH, acquireKit, kflash, palFor, pspawn, releaseKit, windupProgress, type KitA } from './kitA'
import { LivePool } from './livePool'

const P = palFor('redirector')
let K: KitA | null = null
const o = { x: 0, y: 0, h: 0 }

interface Turn {
  id: number
  x: number
  y: number
  ox: number
  oy: number
  nx: number
  ny: number
  born: number
}
const turns = new LivePool<Turn>(8, () => ({ id: -1, x: 0, y: 0, ox: 1, oy: 0, nx: 1, ny: 0, born: -10 }), (a, b) => a.born < b.born)
/** how long the redirect stays legible: pivot rune, ground chevrons and the riding ring */
const TURN_LIFE = 1.3

function projVel(list: { id: number; vx: number; vy: number }[] | undefined, id: number, out: { x: number; y: number }): boolean {
  if (!list) return false
  for (const p of list) {
    if (p.id === id) {
      const s = Math.hypot(p.vx, p.vy)
      if (s < 1) return false
      out.x = p.vx / s
      out.y = p.vy / s
      return true
    }
  }
  return false
}
const vOld = { x: 1, y: 0 }
const vNew = { x: 1, y: 0 }

function drawTurns(k: KitA, ctx: VfxCtx): void {
  const now = ctx.now
  turns.sweep((t) => now - t.born <= TURN_LIFE)
  for (let i = 0; i < turns.n; i++) {
    const t = turns.items[i]
    const age = now - t.born
    // the burst (pin flare + bent swoosh) is quick; the markers linger for the whole TURN_LIFE
    const fq = Math.max(0, 1 - age / 0.5)
    const fl = 1 - age / TURN_LIFE
    const linger = Math.min(1, fl / 0.35)
    // pin at the pivot: a turning bronze rune that stays put where the redirect happened
    k.air.add(G_RUNE, t.x, t.y, PH, 34, now * 4, P.body[0], P.body[1], P.body[2], 0.8 * linger + 0.6 * fq, 1, t.id)
    k.glowAt(t.x, t.y, PH, 46, P.hot[0] * 0.5 * fq, P.hot[1] * 0.5 * fq, P.hot[2] * 0.5 * fq, 2.6)
    // lingering ground marker: a bronze ring at the pivot with a chevron arrow pointing the new heading
    const flo = k.floor(t.x, t.y) + 2
    k.ground.add(G_SHOCK, t.x, t.y, flo, 46, 0, P.body[0], P.body[1], P.body[2], 0.9 * linger, 0.85, 0.08)
    for (let c = 0; c < 3; c++) {
      // three chevrons marching out along the new heading
      const d = 52 + c * 34 + ((age * 140) % 34)
      const cx = t.x + t.nx * d
      const cy = t.y + t.ny * d
      const a = linger * (1 - c * 0.25)
      k.stripBegin(true, 1.8, 0, 0)
      k.stripPoint(cx - t.nx * 14 - t.ny * 16, cy - t.ny * 14 + t.nx * 16, flo, 9, P.body[0], P.body[1], P.body[2], 1.2 * a)
      k.stripPoint(cx, cy, flo, 9, P.hot[0] * 0.7, P.hot[1] * 0.7, P.hot[2] * 0.7, 1.4 * a)
      k.stripPoint(cx - t.nx * 14 + t.ny * 16, cy - t.ny * 14 - t.nx * 16, flo, 9, P.body[0], P.body[1], P.body[2], 1.2 * a)
      k.stripEnd()
    }
    // bent swoosh: old heading in, curve through the pin, new heading out
    if (fq > 0) {
      k.stripBegin(false, 1.5, 0.3, t.born * 13)
      const N = 16
      for (let j = 0; j <= N; j++) {
        const sN = j / N
        // quadratic bezier: A (behind on the old line) -> pin -> B (ahead on the new line)
        const ax = t.x - t.ox * 140
        const ay = t.y - t.oy * 140
        const bx = t.x + t.nx * 160
        const by = t.y + t.ny * 160
        const u = 1 - sN
        const px = u * u * ax + 2 * u * sN * t.x + sN * sN * bx
        const py = u * u * ay + 2 * u * sN * t.y + sN * sN * by
        const a = Math.sin(Math.PI * sN) * fq
        k.stripPoint(px, py, PH, 26 * (0.4 + sN * 0.6), P.body[0], P.body[1], P.body[2], 1.3 * a)
      }
      k.stripEnd()
    }
    // the bronze ring riding the redirected projectile, shedding bronze sparks
    const s = ctx.state
    if (s) {
      for (const p of s.projectiles) {
        if (p.id !== t.id) continue
        k.air.add(G_SHOCK, p.x, p.y, PH, Math.max(30, p.radius) * 1.8, now * 3, P.body[0], P.body[1], P.body[2], 1.1 * linger, 0.75, 0.08)
        const ps = ctx.particles
        const n = ps.budget(ctx.dt * 30 * linger)
        for (let q = 0; q < n; q++) {
          const a = Math.random() * Math.PI * 2
          const rr = Math.max(30, p.radius) * 1.8
          pspawn(ps, p.x + Math.cos(a) * rr, p.y + Math.sin(a) * rr, PH, Math.cos(a) * 60, Math.sin(a) * 60, 40, 0.35, 6, 1, P.spark[0], P.spark[1], P.spark[2], -200, 2, 4)
        }
        break
      }
    }
  }
}

/** signature charge-up: a bronze compass, its needle swinging onto the target */
function signature(k: KitA, _ctx: VfxCtx, info: PawnRenderInfo, _id: number, tx: number, ty: number, w: number): void {
  k.air.add(G_RETICLE, o.x, o.y, o.h + 1, 28, 0, P.body[0], P.body[1], P.body[2], 0.8 + 0.6 * w, w)
  const want = Math.atan2(ty - info.y, tx - info.x)
  // The needle settles within the seal without traveling away from the palm.
  const ang = want + (1 - w) * 0.35
  const L = 23
  k.stripBegin(false, 2, 0, 0)
  k.stripPoint(o.x - Math.cos(ang) * L * 0.65, o.y - Math.sin(ang) * L * 0.65, o.h + 2, 5, P.edge[0], P.edge[1], P.edge[2], 0.9)
  k.stripPoint(o.x, o.y, o.h + 2, 7, P.body[0], P.body[1], P.body[2], 1.2)
  k.stripPoint(o.x + Math.cos(ang) * L, o.y + Math.sin(ang) * L, o.h + 2, 2, P.body[0], P.body[1], P.body[2], 1.2)
  k.stripEnd()
}

const mod: SpellVfx = {
  spell: 'redirector',
  modifiers: ['redirectorPenalty'],
  init(ctx) {
    K = acquireKit(ctx)
  },
  dispose() {
    releaseKit(K)
    K = null
    turns.clear()
  },

  onEvent(e: SimEvent, ctx) {
    const k = K
    if (!k) return
    switch (e.type) {
      case 'castStart':
        if (e.spell === 'redirector') k.windupTotal.set(e.pawn, e.ticks)
        return
      case 'cast': {
        if (e.spell !== 'redirector') return
        const info = ctx.pawn(e.pawn)
        if (!info) return
        k.origin(info, o)
        kflash(ctx, o.x, o.y, o.h, 0.14, 130, 70, P.body[0] * 1.2, P.body[1] * 1.2, P.body[2] * 1.2)
        k.pulse(G_RUNE, true, o.x, o.y, o.h - 6, 30, 60, 0.3, 0, 5, P.body, 1.1, 1, 1, e.pawn)
        return
      }
      case 'spellHit': {
        if (e.spell !== 'redirector') return
        const hasOld = projVel(ctx.prev?.projectiles, e.target, vOld)
        const hasNew = projVel(ctx.state?.projectiles, e.target, vNew)
        if (!hasNew) return
        if (!hasOld) {
          vOld.x = vNew.x
          vOld.y = vNew.y
        }
        const t = turns.acquire()
        t.id = e.target
        t.x = e.x
        t.y = e.y
        t.ox = vOld.x
        t.oy = vOld.y
        t.nx = vNew.x
        t.ny = vNew.y
        t.born = ctx.now
        // sparks shearing off the turn, flash
        const ps = ctx.particles
        const n = ps.budget(18)
        for (let i = 0; i < n; i++) {
          const a = Math.atan2(vOld.y, vOld.x) + (Math.random() - 0.5) * 0.9
          const sp = 300 + Math.random() * 600
          pspawn(ps, e.x, e.y, PH, Math.cos(a) * sp, Math.sin(a) * sp, 60 + Math.random() * 200, 0.2 + Math.random() * 0.2, 6, 1, P.spark[0], P.spark[1], P.spark[2], -1100, 3, -0.12)
        }
        kflash(ctx, e.x, e.y, PH, 0.14, 160, 90, P.hot[0] * 0.8, P.hot[1] * 0.8, P.hot[2] * 0.8)
        k.pulse(G_SHOCK, false, e.x, e.y, k.floor(e.x, e.y) + 1.5, 70, 70, 0.3, 0, 0, P.body, 0.9, 0.12, 0.95, 0.1)
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
      if (!p.alive || !p.cast || p.cast.spell !== 'redirector' || p.cast.started === false) continue
      const info = ctx.pawn(p.id)
      if (!info) continue
      k.begin()
      k.origin(info, o)
      const w = windupProgress(k, ctx, p.id, p.cast.ticksLeft)
      k.windupAt(o.x, o.y, o.h, w, P, ctx.now, ctx.dt, p.id)
      signature(k, ctx, info, p.id, p.cast.x, p.cast.y, w)
    }
    if (turns.n > 0) {
      k.begin()
      drawTurns(k, ctx)
    }
  },

  drawModifier(pawn, m, x, y, ctx) {
    const k = K
    if (!k) return
    k.begin()
    const info = ctx.pawn(pawn.id)
    const h0 = info ? info.h : k.floor(x, y)
    const now = ctx.now
    const left = secondsOf(m.ticksLeft)
    const fade = Math.min(1, left / 1.0)
    // cracked ward: the sigil shape, permanently half-shattered, flickering
    const flick = 0.75 + 0.25 * Math.sin(now * 23 + pawn.id) * Math.sin(now * 7)
    k.ground.add(G_SIGIL, x, y, h0 + 1.8, 58, now * 0.5, P.body[0], P.body[1], P.body[2], 0.75 * fade * flick, 0.45, pawn.id)
    const ps = ctx.particles
    const n = ps.budget(ctx.dt * 12)
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2
      pspawn(ps, x + Math.cos(a) * 30, y + Math.sin(a) * 30, h0 + 20 + Math.random() * 80, Math.cos(a) * 30, Math.sin(a) * 30, 60 + Math.random() * 60, 0.7 + Math.random() * 0.4, 7, 2, P.spark[0], P.spark[1], P.spark[2], 30, 1, 8)
    }
  },
}

registerSpellVfx(mod)
