/**
 * Rush (column 5 Defense; golden flame guard). spells.md §8.21.
 * Cast (IMMEDIATE): a golden fire whoosh rings out from the warlock. While the `rush`
 * modifier runs: flame tongues lick up around the body (gold core, red-orange tips), a burning
 * ring at the feet, heat shimmer, and speed streaks once the bonus speed builds; the aura grows
 * with every HP absorbed. Absorb (a 'damage' event with `absorbed` on a rushing warlock), sized
 * by the absorbed amount: a gold-orange flame shield flares on the side the hit came from and
 * ripples outward, the hit's energy streaks from that side into the warlock, and a short burst
 * of speed trails shoots off behind it. Ends in embers.
 * Absorbed damage numbers: render's WorldOverlay owns the number colours (orange for
 * `absorbed` is requested there).
 */
import type { ModifierState, PawnState, SimEvent } from '../../../sim/types'
import { RING_EXPAND } from '../../scene/GroundFx'
import { registerSpellVfx, type VfxCtx } from '../registry'
import { STYLE_RING, TAU, burst, castFlash, drawCircle, flatGain, floorH, glowG, kitBegin, kitInit, kitRelease, light, rand, screenAngle, type RGB, pal, palMix, flashT, levelOf, tierOfLevel } from './kitB'

// identity: flame orange-gold (vfx/palette.ts)
const FLAME = pal('rush', 'accent', 1.1)
const GOLD = pal('rush', 'core', 1.8)
const GOLD_WHITE = palMix('rush', 0.85, 2.2)

const SPELL = 'rush'
const EMBER_RED: RGB = [2.6, 0.45, 0.08]

interface Hit {
  /** unit direction from the warlock toward where the hit came from */
  dx: number
  dy: number
  at: number
  /** 0.4..1.5 from the absorbed amount */
  k: number
}
interface Aura {
  seen: number
  since: number
  flareAt: number
  flare: number
  hits: Hit[]
  head: number
  /** speed-trail burst */
  boostAt: number
  boost: number
  bx: number
  by: number
}
const HIT_LIFE = 0.42
const BOOST_LIFE = 0.6
const auras = new Map<number, Aura>()
let frameNo = 0

function aura(id: number, now: number): Aura {
  let a = auras.get(id)
  if (!a) {
    a = { seen: 0, since: now, flareAt: -10, flare: 0, hits: [], head: 0, boostAt: -10, boost: 0, bx: 1, by: 0 }
    for (let i = 0; i < 3; i++) a.hits.push({ dx: 1, dy: 0, at: -10, k: 0 })
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
        const kk = Math.max(0.4, Math.min(1.5, e.absorbed / 30))
        a.flareAt = ctx.now
        a.flare = 0.5 + 0.5 * kk
        // impact side: toward the attacker, else toward the reported hit point
        let dx = 0
        let dy = 0
        const src = e.source !== null ? ctx.pawnOf(e.source) : null
        if (src) {
          dx = src.x - info.x
          dy = src.y - info.y
        }
        if (Math.hypot(dx, dy) < 1) {
          dx = e.x - info.x
          dy = e.y - info.y
        }
        let l = Math.hypot(dx, dy)
        if (l < 1) {
          dx = 1
          dy = 0
          l = 1
        }
        dx /= l
        dy /= l
        a.head = (a.head + 1) % a.hits.length
        const hit = a.hits[a.head]
        hit.dx = dx
        hit.dy = dy
        hit.at = ctx.now
        hit.k = kk
        // the speed burst runs away from the hit (the knockback direction)
        a.boostAt = ctx.now
        a.boost = kk
        a.bx = -dx
        a.by = -dy
        const h = info.h + 70
        // the hit's energy streaks in from the impact side and is soaked into the body
        const ps = ctx.particles
        const g = flatGain(ctx)
        const n = ps.budget(18 * kk)
        const base = Math.atan2(dy, dx)
        for (let i = 0; i < n; i++) {
          const ang = base + rand(-0.75, 0.75)
          const rr = rand(120, 190)
          const life = rand(0.16, 0.24)
          const sx = info.x + Math.cos(ang) * rr
          const sy = info.y + Math.sin(ang) * rr
          const sh = h + rand(-45, 45)
          const c = Math.random() < 0.5 ? GOLD : FLAME
          ps.spawn(sx, sy, sh, (info.x - sx) / life, (info.y - sy) / life, (h - sh) / life, life, rand(9, 14), 3, c[0] * g, c[1] * g, c[2] * g, 0, 0, -0.07)
        }
        flashT(ctx, info.x + dx * 55, info.y + dy * 55, h, 0.07, 120, 90, FLAME[0] * 0.7, FLAME[1] * 0.7, FLAME[2] * 0.7)
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
    const tierK = 1 + 0.3 * tierOfLevel(ctx, levelOf(ctx, pawn.owner, SPELL))
    const n = ps.budget(dt * 90 * k * tierK)
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
    glowG(x, y, fh + 70, 190 * (0.85 + 0.15 * power), FLAME, 0.2 * intro * power, 1.5, 0, 1, 0, 0.8)
    glowG(x, y, fh + 90, 150, GOLD, 0.3 * k, 1.6, 3, 0.8, 0, 0.6)
    drawCircle(x, y, fh + 1.4, 62, STYLE_RING, FLAME[0], FLAME[1], FLAME[2], 0.6 * intro, 0, 0, pawn.id, 0.08, 1.8, 0, a.since)
    light(ctx, x, y, 200, 0.7 * intro * power, FLAME, 0.45)
    // absorb flares: a curved wall of flame on the side each hit came from (a shield the hit
    // splashes against), then a second ripple running outward from it
    for (const hit of a.hits) {
      const u = (ctx.now - hit.at) / HIT_LIFE
      if (u < 0 || u >= 1) continue
      const base = Math.atan2(hit.dy, hit.dx)
      for (let wave = 0; wave < 2; wave++) {
        const uw = wave === 0 ? u : (u - 0.18) / 0.82
        if (uw < 0 || uw >= 1) continue
        const f = (1 - uw) * (1 - uw) * (wave === 0 ? 1 : 0.6)
        // the wall stands clear of the impact flash and ripples outward past it
        const R = (wave === 0 ? 78 : 96) + (wave === 0 ? 30 : 110) * uw
        const spread = 0.8 + 0.35 * uw
        for (let row = 0; row < 3; row++) {
          const hh = fh + 25 + row * 45
          // the wall bulges toward the hit at mid height
          const rowR = R * (row === 1 ? 1 : 0.92)
          for (let j = -6; j <= 6; j++) {
            const ang = base + (j / 6) * spread
            const edge = 1 - (Math.abs(j) / 7) ** 2
            const c = wave === 0 && Math.abs(j) <= 2 ? GOLD : FLAME
            glowG(x + Math.cos(ang) * rowR, y + Math.sin(ang) * rowR, hh, 26 + 8 * hit.k, c, 0.9 * f * edge * hit.k, 3.4)
          }
        }
      }
      // contact flare where it struck (first instants only)
      if (u < 0.3) glowG(x + hit.dx * 64, y + hit.dy * 64, fh + 70, 100 + 40 * hit.k, GOLD, 0.8 * (1 - u / 0.3) * hit.k, 2.2, 2, 1, base + Math.PI / 4)
    }
    // speed-trail burst after an absorb, length by the absorbed amount
    const bu = (ctx.now - a.boostAt) / BOOST_LIFE
    if (bu >= 0 && bu < 1) {
      const sp0 = Math.hypot(pawn.vx, pawn.vy)
      let ux = a.bx
      let uy = a.by
      if (sp0 > 80) {
        ux = pawn.vx / sp0
        uy = pawn.vy / sp0
      }
      const bk = a.boost * (1 - bu)
      const ang = screenAngle(ctx, x, y, fh + 60, ux, uy)
      for (let s2 = -1; s2 <= 1; s2++) {
        const off = s2 * 22
        const back = 70 + 40 * a.boost
        glowG(x - ux * back - uy * off, y - uy * back + ux * off, fh + 55 + Math.abs(s2) * 18, 40, s2 === 0 ? GOLD : FLAME, 0.55 * bk, 2, 0, 2.5 + 4 * a.boost, ang, 0.4)
      }
      const nb = ps.budget(dt * 80 * bk)
      const g = flatGain(ctx)
      for (let i = 0; i < nb; i++) {
        ps.spawn(x - ux * 30 + rand(-20, 20), y - uy * 30 + rand(-20, 20), fh + rand(30, 110), -ux * rand(250, 450), -uy * rand(250, 450), rand(0, 60), rand(0.18, 0.3), rand(10, 16), 2, FLAME[0] * g, FLAME[1] * g, FLAME[2] * g, 0, 2, -0.06)
      }
    }
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
