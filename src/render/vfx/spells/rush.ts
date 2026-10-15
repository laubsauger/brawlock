/**
 * Rush (column 5 Defense; golden flame guard). spells.md §8.21.
 * Cast (IMMEDIATE): a golden fire whoosh rings out from the warlock. While the `rush`
 * modifier runs: flame tongues lick up around the body (gold core, red-orange tips), a burning
 * ring at the feet, heat shimmer, and speed streaks once the bonus speed builds; the aura grows
 * with every HP absorbed. Absorb (a 'damage' event with `absorbed` on a rushing warlock): the
 * flames flare outward and the absorbed fire is sucked back into the body. Ends in embers.
 * Absorbed damage numbers: render's WorldOverlay owns the number colours (orange for
 * `absorbed` is requested there).
 */
import type { ModifierState, PawnState, SimEvent } from '../../../sim/types'
import { RING_EXPAND, RING_IMPLODE } from '../../scene/GroundFx'
import { registerSpellVfx, type VfxCtx } from '../registry'
import { STYLE_RING, TAU, burst, castFlash, drawCircle, floorH, glowG, implode, kitBegin, kitInit, kitRelease, light, rand, screenAngle, type RGB, pal, palMix } from './kitB'

// identity: flame orange-gold (vfx/palette.ts)
const FLAME = pal('rush', 'accent', 1.1)
const GOLD = pal('rush', 'core', 1.8)
const GOLD_WHITE = palMix('rush', 0.85, 2.2)

const SPELL = 'rush'
const EMBER_RED: RGB = [2.6, 0.45, 0.08]

interface Aura {
  seen: number
  since: number
  flareAt: number
  flare: number
}
const auras = new Map<number, Aura>()
let frameNo = 0

function aura(id: number, now: number): Aura {
  let a = auras.get(id)
  if (!a) {
    a = { seen: 0, since: now, flareAt: -10, flare: 0 }
    auras.set(id, a)
  }
  return a
}

registerSpellVfx({
  spell: SPELL,
  modifiers: [SPELL],
  init(ctx: VfxCtx) {
    kitInit(ctx)
  },
  dispose() {
    auras.clear()
    kitRelease()
  },
  onEvent(e: SimEvent, ctx: VfxCtx): boolean | void {
    switch (e.type) {
      case 'cast': {
        if (e.spell !== SPELL) return
        castFlash(ctx, e.pawn, GOLD, 1)
        const info = ctx.pawn(e.pawn)
        if (info) {
          const fh = floorH(ctx, info.x, info.y)
          ctx.ground.spawn(RING_EXPAND, info.x, info.y, fh, 20, 170, 0.35, 14, FLAME[0], FLAME[1], FLAME[2])
          const ps = ctx.particles
          const n = ps.budget(40)
          for (let i = 0; i < n; i++) {
            const a = Math.random() * TAU
            const sp = rand(150, 420)
            ps.spawn(info.x + Math.cos(a) * 20, info.y + Math.sin(a) * 20, fh + rand(10, 50), Math.cos(a) * sp, Math.sin(a) * sp, rand(100, 320), rand(0.3, 0.55), rand(26, 44), 6, FLAME[0], FLAME[1], FLAME[2], 120, 3, 0)
          }
          aura(e.pawn, ctx.now).since = ctx.now
        }
        return true
      }
      case 'damage': {
        if (!e.absorbed || e.absorbed <= 0) return
        const info = ctx.pawn(e.target)
        if (!info) return
        const a = aura(e.target, ctx.now)
        a.flareAt = ctx.now
        a.flare = Math.min(1.5, 0.5 + e.absorbed / 40)
        const h = info.h + 70
        // flames flare outward, then the fire is drawn back into the body
        burst(ctx, info.x, info.y, h, 22 * a.flare, 200, 520, 0.25, 0.45, 30, 6, FLAME, 1, 100, 3, 0, 60, 260)
        implode(ctx, info.x, info.y, h, 16, 110, 170, 0.28, 12, GOLD_WHITE, 1, 80)
        ctx.ground.spawn(RING_IMPLODE, info.x, info.y, floorH(ctx, info.x, info.y), 25, 120, 0.3, 10, GOLD[0], GOLD[1], GOLD[2])
        ctx.flash(info.x, info.y, h, 0.12, 180, 160, FLAME[0], FLAME[1], FLAME[2])
        return
      }
      case 'modifier': {
        if (e.id !== SPELL || e.on) return
        const info = ctx.pawn(e.pawn)
        if (info) burst(ctx, info.x, info.y, info.h + 60, 24, 40, 160, 0.6, 1.1, 8, 2, EMBER_RED, 1, 60, 1.2, 14, 40, 160, 30)
        return
      }
      default:
        return
    }
  },
  frame(ctx: VfxCtx) {
    kitBegin(ctx)
    frameNo++
    for (const [id, a] of auras) if (frameNo - a.seen > 2) auras.delete(id)
  },
  drawModifier(pawn: PawnState, mod: ModifierState, x: number, y: number, ctx: VfxCtx) {
    const a = aura(pawn.id, ctx.now)
    if (frameNo - a.seen > 2 && a.seen !== 0) a.since = ctx.now
    a.seen = frameNo
    const info = ctx.pawn(pawn.id)
    const fh = info ? info.h : 30
    // absorbed so far (speed = 35 + 1.5 x absorbed) drives the size of the fire
    const absorbed = Math.max(0, ((mod.data.speed ?? 35) - 35) / (mod.data.perHp || 1.5))
    const power = 1 + Math.min(1.2, absorbed / 70)
    const flare = Math.max(0, 1 - (ctx.now - a.flareAt) / 0.35) * a.flare
    const intro = Math.min(1, (ctx.now - a.since) / 0.2)
    const k = intro * (power + flare)
    const dt = ctx.dt
    const ps = ctx.particles
    // flame tongues: gold at the root, cooling to red-orange as they rise
    const n = ps.budget(dt * 90 * k)
    for (let i = 0; i < n; i++) {
      const ang = Math.random() * TAU
      const rr = rand(16, 36) * (1 + flare * 0.6)
      const hot = Math.random() < 0.35
      const c = hot ? GOLD : FLAME
      ps.spawn(x + Math.cos(ang) * rr, y + Math.sin(ang) * rr, fh + rand(5, 60), Math.cos(ang) * 25 - pawn.vx * 0.2, Math.sin(ang) * 25 - pawn.vy * 0.2, rand(180, 340) * (0.8 + 0.2 * power), rand(0.28, 0.5), rand(22, 36) * (0.85 + 0.15 * power), -6, c[0], c[1], c[2], 120, 1.6, 5)
    }
    // stray sparks
    if (Math.random() < dt * 14 * k) {
      ps.spawn(x + rand(-20, 20), y + rand(-20, 20), fh + rand(40, 120), rand(-80, 80), rand(-80, 80), rand(200, 380), rand(0.5, 0.9), 6, 1.5, GOLD_WHITE[0], GOLD_WHITE[1], GOLD_WHITE[2], -400, 1, -0.05)
    }
    glowG(x, y, fh + 70, 190 * (0.85 + 0.15 * power), FLAME, 0.22 * k, 1.5, 0, 1, 0, 0.8)
    glowG(x, y, fh + 90, 150, GOLD, 0.3 * k, 1.6, 3, 0.8, 0, 0.6)
    drawCircle(x, y, fh + 1.4, 62, STYLE_RING, FLAME[0], FLAME[1], FLAME[2], 0.6 * intro, 0, 0, pawn.id, 0.08, 1.8, 0, a.since)
    light(ctx, x, y, 200, (0.7 + 0.5 * flare) * k, FLAME, 0.45)
    // speed streaks once the bonus builds
    const sp = Math.hypot(pawn.vx, pawn.vy)
    if (sp > 260) {
      const ux = pawn.vx / sp
      const uy = pawn.vy / sp
      const ang = screenAngle(ctx, x, y, fh + 70, ux, uy)
      glowG(x - ux * 80, y - uy * 80, fh + 70, 60, FLAME, 0.4 * intro, 1.8, 0, 3.5, ang, 0.4)
    }
  },
})
