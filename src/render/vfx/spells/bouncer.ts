/**
 * Bouncer (column 3, Damage; identity pure light yellow). spells.md §8.14.
 *
 * - windup / cast: motes into the hand, muzzle
 * - windup signature: one bright spark ricocheting around the hand on a zigzag
 * - flight: a dense crackling energy ball: hot core on the sim radius (38), a
 *   flickering shell, arcs crawling over it, three sparks orbiting it, and a
 *   long bright trail that kinks hard at every ricochet (the whole bounce path
 *   stays readable for ~0.9 s, older segments fading); everything scales with
 *   the damage left (x0.7 per enemy hit), so the ball visibly weakens
 * - 'projectileBounce' (pawn retarget or pillar): punchy spark burst, ring,
 *   flash, and a short arc lashing out along the new heading toward the next
 *   target, all diminishing per hit
 * - hit: kb-scaled burst (kb 1.2); death below 10 damage: a final fizzle
 *   (dying arcs, sputtering sparks, smoke)
 */
import type { SimEvent } from '../../../sim/types'
import { RING_EXPAND } from '../../scene/GroundFx'
import { registerSpellVfx, type PawnRenderInfo, type SpellVfx, type VfxCtx } from '../registry'
import { G_SHOCK, PH, acquireKit, hash01, kflash, kring, palFor, pspawn, releaseKit, trailFrom, windupProgress, type KitA, type Pal, type TrailStyle } from './kitA'
import { spellDeath } from './deathsA'
import { LivePool } from './livePool'

/**
 * Bouncer's identity is a light pure yellow (palette). At mid luminance without much bloom
 * (Medium) a pure yellow reads olive-green, so the body/edge tones are warmed toward gold
 * (more red, less blue) while the hot core stays the palette's pale yellow.
 */
const B0 = palFor('bouncer')
const warm = (c: readonly number[], r: number, g: number, b: number): [number, number, number] => [c[0] * r, c[1] * g, c[2] * b]
const P: Pal = {
  hot: B0.hot,
  body: warm(B0.body, 1.25, 0.95, 0.45),
  edge: warm(B0.edge, 1.35, 0.9, 0.35),
  tail: warm(B0.tail, 1.5, 0.75, 0.3),
  light: warm(B0.light, 1.25, 0.95, 0.45),
  spark: warm(B0.spark, 1.1, 0.97, 0.6),
}
let K: KitA | null = null
const o = { x: 0, y: 0, h: 0 }
const dir = { x: 0, y: 0 }
/** projectile id -> damage at launch (for the diminishing look) */
const first = new Map<number, number>()
const lastPos = new Map<number, { x: number; y: number; vx: number; vy: number }>()

/** crisp ricochet line: thin bright core, the kinks stay where the bounces happened */
const TRAIL: TrailStyle = trailFrom(P, { life: 0.9, width: 24, widthTail: 0.3, intensity: 2.2, falloff: 2.4, noise: 0.1, spacing: 5, rim: 0.3 }, 0.6)
/** the comet body: a short wide flame-less tail that tapers the head into a teardrop */
const TAIL: TrailStyle = trailFrom(P, { life: 0.11, width: 30, widthTail: 0.05, intensity: 0.6, falloff: 1.8, noise: 0.75, spacing: 4, rim: 0 }, 0.4)
/** teardrop outline in collision radii: (along velocity, sideways, up); nose at +1, tail at -2.2 */
const SHELL: readonly (readonly [number, number, number])[] = [
  [1, 0, 0],
  [0.55, 0.85, 0.15],
  [-0.4, 0.9, 0.1],
  [-1.4, 0.45, 0],
  [-2.2, 0, 0],
  [-1.4, -0.45, 0],
  [-0.4, -0.9, -0.1],
  [0.55, -0.85, -0.15],
]
const SHELL_N = SHELL.length
/** golden hot centre (the palette's pale core would turn the whole head cream) */
const CORE: [number, number, number] = [P.hot[0] * 0.6 + P.body[0] * 0.8, P.hot[1] * 0.6 + P.body[1] * 0.8, P.hot[2] * 0.4 + P.body[2] * 0.5]

/** short lashing arcs (retarget flash, dying fizzle) */
interface Arc {
  x0: number
  y0: number
  x1: number
  y1: number
  born: number
  life: number
  seed: number
  s: number
}
const arcs = new LivePool<Arc>(16, () => ({ x0: 0, y0: 0, x1: 0, y1: 0, born: -10, life: 0.15, seed: 0, s: 1 }), (a, b) => a.born < b.born)

function addArc(now: number, x0: number, y0: number, x1: number, y1: number, life: number, s: number): void {
  const a = arcs.acquire()
  a.x0 = x0
  a.y0 = y0
  a.x1 = x1
  a.y1 = y1
  a.born = now
  a.life = life
  a.seed = (Math.random() * 1e6) | 0
  a.s = s
}

function drawArcs(k: KitA, now: number): void {
  arcs.sweep((a) => now - a.born <= a.life)
  for (let i = 0; i < arcs.n; i++) {
    const a = arcs.items[i]
    const age = now - a.born
    const f = 1 - age / a.life
    k.bolt(a.x0, a.y0, PH, a.x1, a.y1, PH - 6, a.seed + Math.floor(age * 40), 12, 4 + 3 * a.s, P.body, P.hot, (1.2 + 1.2 * a.s) * f, 1, 16, 26, 0.3)
  }
}

function strength(id: number, dmg: number): number {
  const d0 = first.get(id) ?? dmg
  return Math.max(0.15, Math.min(1, dmg / Math.max(1, d0)))
}

function ricochet(k: KitA, ctx: VfxCtx, x: number, y: number, s: number, vx: number, vy: number, nvx: number, nvy: number): void {
  // lash along the new intercept heading, toward the next target
  const nl = Math.hypot(nvx, nvy)
  if (nl > 1) addArc(ctx.now, x, y, x + (nvx / nl) * (110 + 70 * s), y + (nvy / nl) * (110 + 70 * s), 0.16, s)
  const nr = ctx.particles.budget(10 * s + 4)
  for (let i = 0; i < nr; i++) {
    const a = Math.random() * Math.PI * 2
    const sp = 500 + Math.random() * 600
    pspawn(ctx.particles, x, y, PH, Math.cos(a) * sp, Math.sin(a) * sp, (Math.random() - 0.3) * 300, 0.08 + Math.random() * 0.08, 5, 1, P.hot[0], P.hot[1], P.hot[2], -600, 5, -0.18)
  }
  const ps = ctx.particles
  const n = ps.budget(8 + 18 * s)
  const sp0 = Math.hypot(vx, vy) || 1
  const bx = -vx / sp0
  const by = -vy / sp0
  for (let i = 0; i < n; i++) {
    const a = Math.atan2(by, bx) + (Math.random() - 0.5) * 2.4
    const sp = (350 + Math.random() * 700) * (0.5 + s * 0.5)
    pspawn(ps, x, y, PH, Math.cos(a) * sp, Math.sin(a) * sp, 60 + Math.random() * 240, 0.16 + Math.random() * 0.18, 6, 1, P.spark[0], P.spark[1], P.spark[2], -1300, 3, -0.12)
  }
  kflash(ctx, x, y, PH, 0.1, 110 + 90 * s, 60 + 60 * s, P.hot[0] * (0.4 + 0.5 * s), P.hot[1] * (0.4 + 0.5 * s), P.hot[2] * (0.4 + 0.5 * s))
  k.pulse(G_SHOCK, true, x, y, PH, 50 + 40 * s, 50 + 40 * s, 0.2, Math.random() * 6, 0, P.body, 0.6 + 0.8 * s, 0.15, 0.95, 0.12)
  kring(ctx, RING_EXPAND, x, y, k.floor(x, y), 8, 50 + 50 * s, 0.25, 6, P.body[0] * s, P.body[1] * s, P.body[2] * s)
  ctx.shakeNear(x, y, 0.06 * s)
}

const za = { x: 0, y: 0, h: 0 }
const zb = { x: 0, y: 0, h: 0 }

/** corner c of the little ricochet triangle around the hand */
function corner(c: number, id: number, now: number, out: { x: number; y: number; h: number }): void {
  const a = (c / 3) * Math.PI * 2 + id + now * 0.7
  out.x = o.x + Math.cos(a) * 36
  out.y = o.y + Math.sin(a) * 36
  out.h = o.h + (c % 2 === 0 ? 14 : -14)
}

/** signature charge-up: one bright spark ricocheting around the hand on a zigzag */
function signature(k: KitA, ctx: VfxCtx, _info: PawnRenderInfo, id: number, _tx: number, _ty: number, w: number): void {
  const now = ctx.now
  const speed = 5 + 9 * w
  k.stripBegin(false, 1.8, 0, 0)
  const N = 9
  for (let i = 0; i <= N; i++) {
    const s = now * speed - (N - i) * 0.07
    const e = Math.floor(s)
    const f = s - e
    corner(((e % 3) + 3) % 3, id, now, za)
    corner((((e + 1) % 3) + 3) % 3, id, now, zb)
    k.stripPoint(za.x + (zb.x - za.x) * f, za.y + (zb.y - za.y) * f, za.h + (zb.h - za.h) * f, 8 * (i / N), P.hot[0], P.hot[1], P.hot[2], (0.5 + w) * (i / N))
  }
  k.stripEnd()
  const s = now * speed
  const e = Math.floor(s)
  corner(((e % 3) + 3) % 3, id, now, za)
  corner((((e + 1) % 3) + 3) % 3, id, now, zb)
  const f = s - e
  k.glowAt(za.x + (zb.x - za.x) * f, za.y + (zb.y - za.y) * f, za.h + (zb.h - za.h) * f, 22 + 12 * w, P.hot[0], P.hot[1], P.hot[2], 2.6)
}

const mod: SpellVfx = {
  spell: 'bouncer',
  init(ctx) {
    K = acquireKit(ctx)
  },
  // our signature occupies the palm: keep render's arm rings + ground ring, drop its palm orb
  windupStyle: () => ({ hide: ['orb'] }),
  dispose() {
    releaseKit(K)
    K = null
    first.clear()
    lastPos.clear()
    arcs.clear()
  },

  onEvent(e: SimEvent, ctx) {
    const k = K
    if (!k) return
    switch (e.type) {
      case 'castStart':
        if (e.spell === 'bouncer') k.windupTotal.set(e.pawn, e.ticks)
        return
      case 'cast': {
        if (e.spell !== 'bouncer') return
        const info = ctx.pawn(e.pawn)
        if (!info) return
        k.origin(info, o)
        const dx = e.x - info.x
        const dy = e.y - info.y
        const l = Math.hypot(dx, dy) || 1
        k.muzzle(o.x, o.y, o.h, dx / l, dy / l, P, 1)
        k.levelFlash(o.x, o.y, o.h, k.tierOf(e), P, e.pawn)
        return
      }
      case 'damage': {
        const a = k.attributeDamage(e)
        if (!a || a.spell !== 'bouncer') return
        const v = ctx.pawn(e.target)
        k.hitDir(ctx.state, e.target, e.x - 1, e.y, e.x, e.y, dir)
        k.impact(e.x, e.y, (v?.h ?? 30) + 55, e.kb, dir.x, dir.y, P, 1, a.tier)
        return true
      }
      case 'projectileBounce': {
        if (e.spell !== 'bouncer') return
        let s = 1
        let vx = 1
        let vy = 0
        const lp = lastPos.get(e.id)
        if (lp) {
          vx = lp.vx
          vy = lp.vy
        }
        if (ctx.state) {
          for (const p of ctx.state.projectiles) {
            if (p.id === e.id) {
              s = strength(p.id, p.data.damage)
              break
            }
          }
        }
        let nvx = vx
        let nvy = vy
        if (ctx.state) {
          for (const p of ctx.state.projectiles) {
            if (p.id === e.id) {
              nvx = p.vx
              nvy = p.vy
              break
            }
          }
        }
        ricochet(k, ctx, e.x, e.y, s, vx, vy, nvx, nvy)
        return
      }
      case 'projectileHit': {
        if (e.spell !== 'bouncer') return
        // final fizzle (dropped under 10 damage) or destroyed by a projectile:
        // dying arcs flail out, sparks sputter, smoke
        for (let i = 0; i < 4; i++) {
          const a = Math.random() * Math.PI * 2
          const l = 50 + Math.random() * 60
          addArc(ctx.now, e.x, e.y, e.x + Math.cos(a) * l, e.y + Math.sin(a) * l, 0.22, 0.4)
        }
        const ps = ctx.particles
        const n = ps.budget(16)
        for (let i = 0; i < n; i++) {
          const a = Math.random() * Math.PI * 2
          const sp = 150 + Math.random() * 300
          pspawn(ps, e.x, e.y, PH, Math.cos(a) * sp, Math.sin(a) * sp, (Math.random() - 0.2) * 200, 0.2 + Math.random() * 0.2, 7, 1, P.spark[0], P.spark[1], P.spark[2], -900, 3, -0.1)
        }
        kflash(ctx, e.x, e.y, PH, 0.14, 130, 70, P.body[0], P.body[1], P.body[2])
        k.pulse(G_SHOCK, false, e.x, e.y, k.floor(e.x, e.y) + 1.5, 60, 60, 0.28, 0, 0, P.body, 0.8, 0.12, 0.95, 0.1)
        const ns = ctx.smoke.budget(3)
        for (let i = 0; i < ns; i++) ctx.smoke.spawn(e.x, e.y, PH, (Math.random() - 0.5) * 70, (Math.random() - 0.5) * 70, 40, 0.9, 26, 90, 0.05, 0.05, 0.03, 20, 1, 6)
        return
      }
      case 'projectileExpire':
        if (e.spell !== 'bouncer') return
        kflash(ctx, e.x, e.y, PH, 0.1, 90, 50, P.body[0] * 0.7, P.body[1] * 0.7, P.body[2] * 0.7)
        ctx.smoke.spawn(e.x, e.y, PH, 0, 0, 40, 0.8, 26, 80, 0.05, 0.05, 0.03, 20, 1, 6)
        return
      case 'death':
        if (e.cause !== 'bouncer') return
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
      if (!p.alive || !p.cast || p.cast.spell !== 'bouncer' || p.cast.started === false) continue
      const info = ctx.pawn(p.id)
      if (!info) continue
      k.begin()
      k.origin(info, o)
      const w = windupProgress(k, ctx, p.id, p.cast.ticksLeft)
      k.windupAt(o.x, o.y, o.h, w, P, ctx.now, ctx.dt, p.id)
      signature(k, ctx, info, p.id, p.cast.x, p.cast.y, w)
    }
    if (arcs.n > 0) {
      k.begin()
      drawArcs(k, ctx.now)
    }
    if (first.size > 0) {
      for (const id of first.keys()) {
        let alive = false
        for (const q of s.projectiles) {
          if (q.id === id) {
            alive = true
            break
          }
        }
        if (!alive) {
          first.delete(id)
          lastPos.delete(id)
        }
      }
    }
  },

  drawProjectile(p, x, y, ctx) {
    const k = K
    if (!k) return
    k.begin()
    k.track(p, x, y)
    if (!first.has(p.id)) first.set(p.id, p.data.damage)
    let lp = lastPos.get(p.id)
    if (!lp) {
      lp = { x, y, vx: p.vx, vy: p.vy }
      lastPos.set(p.id, lp)
    }
    lp.x = x
    lp.y = y
    lp.vx = p.vx
    lp.vy = p.vy
    const s = strength(p.id, p.data.damage)
    const now = ctx.now
    const r = p.radius
    const sp = Math.hypot(p.vx, p.vy)
    const dx = sp > 1 ? p.vx / sp : 1
    const dy = sp > 1 ? p.vy / sp : 0
    // spark-comet: teardrop head (nose = collision radius 38) along the velocity, a tapered
    // comet tail, jagged electric filaments streaming back, sparks shedding; everything weakens
    // with the damage left (x0.7 per enemy hit). No round halo: it reads as a disc without bloom.
    // small white-gold nose spark; the collision size (r) is drawn by a crackling teardrop
    // shell of electric arcs instead of a smooth sphere
    k.cores.add(x, y, PH, r * 0.55, dx, dy, 2.4, p.id, P.edge, P.body, CORE, 0.7 + 0.45 * s)
    {
      const pxs = -dy
      const pys = dx
      const seedS = p.id * 97 + Math.floor(now * 30)
      for (let i = 0; i < SHELL_N; i++) {
        // skip one random segment per frame: the shell crackles instead of glowing solid
        if (Math.floor(hash01(seedS, 99) * SHELL_N) === i) continue
        const a0 = SHELL[i]
        const a1 = SHELL[(i + 1) % SHELL_N]
        k.bolt(
          x + dx * a0[0] * r + pxs * a0[1] * r, y + dy * a0[0] * r + pys * a0[1] * r, PH + a0[2] * r,
          x + dx * a1[0] * r + pxs * a1[1] * r, y + dy * a1[0] * r + pys * a1[1] * r, PH + a1[2] * r,
          seedS + i * 13, 5, 2.4, P.body, CORE, 1.1 * s + 0.35, 0, 7, 10, 0.3,
        )
      }
    }
    k.trailPoint(p.id * 16 + 1, x - dx * r * 0.4, y - dy * r * 0.4, PH, TAIL, -1, 0.45 + 0.55 * s)
    k.streakAt(x - dx * r * 0.6, y - dy * r * 0.6, PH, r * 1.3, 2.6, dx, dy, P.body[0] * 0.45 * s, P.body[1] * 0.45 * s, P.body[2] * 0.45 * s, 1.8, 0.4)
    ctx.glow.add(x, y, 130, 0.35 + 0.35 * s, P.light[0], P.light[1], P.light[2])
    ctx.projectileShadow(x, y, PH, r)
    // long ricochet trail
    k.trailPoint(p.id * 16, x, y, PH, TRAIL, p.owner, 0.4 + 0.6 * s)
    k.powerLayers(p.id * 16 + 15, x, y, PH, P, k.tierOf(p), dx, dy, r)
    // jagged filaments streaming back from the head (re-rolled ~24x per second)
    const px = -dy
    const py = dx
    const nf = 2 + Math.round(2 * s)
    for (let i = 0; i < nf; i++) {
      const seed = p.id * 31 + i * 7 + Math.floor(now * 24)
      const side = (hash01(seed, 1) - 0.5) * 2
      const len = r * (2.4 + hash01(seed, 2) * 1.8) * (0.6 + 0.4 * s)
      const sx = x + dx * r * 0.5 + px * side * r * 0.5
      const sy = y + dy * r * 0.5 + py * side * r * 0.5
      const ex = x - dx * len + px * side * r * 0.9
      const ey = y - dy * len + py * side * r * 0.9
      k.bolt(sx, sy, PH + (hash01(seed, 6) - 0.5) * 24, ex, ey, PH + (hash01(seed, 8) - 0.5) * 40, seed, 11, 3.5, P.body, CORE, 1.8 * s + 0.4, 0, 12, 16, 0.35)
    }
    // crackle on the nose
    const seedN = p.id * 13 + Math.floor(now * 30)
    const an = Math.atan2(dy, dx) + (hash01(seedN, 1) - 0.5) * 2.2
    k.bolt(x + dx * r * 0.6, y + dy * r * 0.6, PH, x + Math.cos(an) * r * 1.5, y + Math.sin(an) * r * 1.5, PH + (hash01(seedN, 3) - 0.5) * 30, seedN, 6, 2, P.body, P.hot, 0.9 * s + 0.2, 0, 8, 10, 0.3)
    // sparks shed backward
    const ps = ctx.particles
    const ns = ps.budget(ctx.dt * 60 * (0.4 + s))
    for (let i = 0; i < ns; i++) {
      const a = Math.atan2(-dy, -dx) + (Math.random() - 0.5) * 1.6
      const v = 200 + Math.random() * 300
      pspawn(ps, x - dx * r * 0.5, y - dy * r * 0.5, PH + (Math.random() - 0.5) * 20, Math.cos(a) * v, Math.sin(a) * v, (Math.random() - 0.3) * 160, 0.14 + Math.random() * 0.14, 5, 1, P.spark[0], P.spark[1], P.spark[2], -900, 3, -0.12)
    }
  },
}

registerSpellVfx(mod)
