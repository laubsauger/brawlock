/**
 * Lightning (column 1, Knockout; identity electric white-blue). spells.md §8.6.
 *
 * - windup: crackling micro-arcs dance around the cast hand, motes, glow
 * - 'beam': jagged bolt from the cast hand to where the sim stopped it, with
 *   forked branches; strobes (re-rolled shape) for ~0.13 s, then freezes as an
 *   afterimage that cools and thins out; flashes at both ends, floor light
 *   along the bolt, a scorched ember line on the floor that fades
 * - hit: kb-scaled electric burst on the victim + arcs crawling over the body
 * - blocked by an enemy bubble: the bolt ends at the bubble surface with a
 *   "tink" (white flash, sparks glancing back toward the caster, small ring)
 * - full range miss: the bolt frays into a crackle at the tip
 * - friendly Fireball detonation ('explosion', r225): storm-fire burst with
 *   radial arcs, boundary ring exactly at 225
 */
import type { SimEvent } from '../../../sim/types'
import { RING_EXPAND } from '../../scene/GroundFx'
import { registerSpellVfx, type SpellVfx, type VfxCtx } from '../registry'
import { G_SHOCK, PH, acquireKit, hash01, palFor, pawnById, releaseKit, windupProgress, type KitA, type RGB } from './kitA'
import { spellDeath } from './deathsA'

const P = palFor('lightning')
/** afterimage cools to the darker identity edge */
const AFTER: RGB = P.edge
/** the detonated Fireball's own fire */
const FB = palFor('fireball')
let K: KitA | null = null
const o = { x: 0, y: 0, h: 0 }
const dir = { x: 0, y: 0 }

interface Bolt {
  born: number
  x0: number
  y0: number
  h0: number
  x1: number
  y1: number
  h1: number
  seed: number
  blocked: boolean
  hit: boolean
  /** seconds to keep drawing */
  life: number
  /** 0 = main beam, 1 = small arc (victim crawl / detonation spoke) */
  kind: number
}

const bolts: Bolt[] = []
let nBolts = 0
for (let i = 0; i < 24; i++) bolts.push({ born: -10, x0: 0, y0: 0, h0: 0, x1: 0, y1: 0, h1: 0, seed: 0, blocked: false, hit: false, life: 0, kind: 0 })

function addBolt(now: number, x0: number, y0: number, h0: number, x1: number, y1: number, h1: number, life: number, kind: number, blocked = false, hit = false): void {
  let b: Bolt
  if (nBolts < bolts.length) b = bolts[nBolts++]
  else {
    b = bolts[0]
    for (const c of bolts) if (c.born < b.born) b = c
  }
  b.born = now
  b.x0 = x0
  b.y0 = y0
  b.h0 = h0
  b.x1 = x1
  b.y1 = y1
  b.h1 = h1
  b.seed = (Math.random() * 1e6) | 0
  b.life = life
  b.kind = kind
  b.blocked = blocked
  b.hit = hit
}

const STRIKE = 0.13

function drawBolts(k: KitA, ctx: VfxCtx): void {
  const now = ctx.now
  let w = 0
  for (let i = 0; i < nBolts; i++) {
    const b = bolts[i]
    const age = now - b.born
    if (age > b.life) continue
    bolts[w++] = b
    if (b.kind === 0) {
      const len = Math.hypot(b.x1 - b.x0, b.y1 - b.y0)
      if (age < STRIKE) {
        // strobing strike: shape re-rolled ~45x per second
        const seed = b.seed + Math.floor(age * 45)
        const f = 1 - age / STRIKE
        // thin white-blue core, blue halo hugging it (sim half-width 25 -> ~50 wide)
        k.bolt(b.x0, b.y0, b.h0, b.x1, b.y1, b.h1, seed, 20 + len * 0.02, 6, P.body, P.hot, 1.3 + f * 0.7, 4, 28, 48, 0.22)
        // light the floor along the bolt (tight, brief)
        const mx = (b.x0 + b.x1) * 0.5
        const my = (b.y0 + b.y1) * 0.5
        ctx.glow.add(mx, my, 130, 0.45 * f, P.light[0] * 0.6, P.light[1] * 0.7, P.light[2])
        ctx.glow.add(b.x1, b.y1, 150, 0.7 * f, P.light[0] * 0.6, P.light[1] * 0.7, P.light[2])
        k.glowAt(b.x0, b.y0, b.h0, 55, P.body[0] * 0.5 * f, P.body[1] * 0.5 * f, P.body[2] * 0.5 * f, 2.6)
        k.glowAt(b.x1, b.y1, b.h1, 70, P.body[0] * 0.6 * f, P.body[1] * 0.6 * f, P.body[2] * 0.6 * f, 2.6)
      } else {
        // afterimage: last strike shape frozen, cooling to violet and thinning
        const f = 1 - (age - STRIKE) / (b.life - STRIKE)
        const seed = b.seed + Math.floor(STRIKE * 45) - 1
        k.bolt(b.x0, b.y0, b.h0, b.x1, b.y1, b.h1, seed, 20 + len * 0.02, 5 * f + 1.2, AFTER, P.body, 0.8 * f * f, 4, 28, 30, 0.2)
      }
      // scorched ember line on the floor
      const fade = Math.max(0, 1 - age / b.life)
      const fl = k.floor(b.x0, b.y0) + 1.2
      k.stripBegin(true, 1.6, 0.9, b.seed)
      const n = 12
      for (let j = 0; j <= n; j++) {
        const t = j / n
        const jit = (hash01(b.seed, j) - 0.5) * 18
        const px = b.x0 + (b.x1 - b.x0) * t - ((b.y1 - b.y0) / (len || 1)) * jit
        const py = b.y0 + (b.y1 - b.y0) * t + ((b.x1 - b.x0) / (len || 1)) * jit
        const env = Math.min(1, t * 6) * Math.min(1, (1 - t) * 6 + 0.3)
        k.stripPoint(px, py, fl, 22, P.body[0], P.body[1], P.body[2], 0.45 * fade * fade * env)
      }
      k.stripEnd()
    } else {
      // short crawling arc, re-rolled every frame-ish
      const f = 1 - age / b.life
      k.bolt(b.x0, b.y0, b.h0, b.x1, b.y1, b.h1, b.seed + Math.floor(age * 30), 10, 3, P.body, P.hot, 1.2 * f, 0, 14, 16, 0.25)
    }
  }
  nBolts = w
}

/** a few short arcs crawling over a pawn body */
function crawl(now: number, x: number, y: number, h: number, n: number, life: number): void {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2
    const a2 = a + 1 + Math.random() * 1.5
    const r1 = 25 + Math.random() * 15
    addBolt(now, x + Math.cos(a) * r1, y + Math.sin(a) * r1, h + Math.random() * 90, x + Math.cos(a2) * r1, y + Math.sin(a2) * r1, h + Math.random() * 90, life * (0.6 + Math.random() * 0.4), 1)
  }
}

function crackleSparks(ctx: VfxCtx, x: number, y: number, h: number, n0: number, speed: number, dx = 0, dy = 0, cone = Math.PI): void {
  const ps = ctx.particles
  const base = Math.atan2(dy, dx)
  const n = ps.budget(n0)
  for (let i = 0; i < n; i++) {
    const a = (dx === 0 && dy === 0 ? Math.random() * Math.PI * 2 : base) + (Math.random() - 0.5) * 2 * cone
    const sp = speed * (0.4 + Math.random() * 0.8)
    ps.spawn(x, y, h, Math.cos(a) * sp, Math.sin(a) * sp, (Math.random() - 0.3) * sp * 0.5, 0.1 + Math.random() * 0.16, 7, 1, P.spark[0], P.spark[1], P.spark[2], -600, 5, -0.2)
  }
}

const mod: SpellVfx = {
  spell: 'lightning',
  init(ctx) {
    K = acquireKit(ctx)
  },
  dispose() {
    releaseKit(K)
    K = null
    nBolts = 0
  },

  onEvent(e: SimEvent, ctx) {
    const k = K
    if (!k) return
    switch (e.type) {
      case 'castStart':
        if (e.spell === 'lightning') k.windupTotal.set(e.pawn, e.ticks)
        return
      case 'cast': {
        if (e.spell !== 'lightning') return
        const caster = pawnById(ctx.state, e.pawn)
        // the hit lands in this same tick, before the 'beam' event: expect it
        if (caster) k.expect('lightning', caster.owner, -1, caster.x, caster.y, 900)
        return
      }
      case 'damage': {
        const a = k.attributeDamage(e)
        if (!a || a.spell !== 'lightning') return
        const v = ctx.pawn(e.target)
        const h = (v?.h ?? 30) + 55
        k.hitDir(ctx.state, e.target, e.x - 1, e.y, e.x, e.y, dir)
        k.impact(e.x, e.y, h, e.kb, dir.x, dir.y, P)
        crackleSparks(ctx, e.x, e.y, h, 16, 900, dir.x, dir.y, 0.7)
        crawl(ctx.now, e.x, e.y, (v?.h ?? 30) + 10, 4, 0.32)
        return true
      }
      case 'beam': {
        if (e.spell !== 'lightning') return
        k.unexpect('lightning', e.owner)
        const info = ctx.pawnOf(e.owner)
        let x0 = e.fromX
        let y0 = e.fromY
        let h0 = PH
        if (info) {
          k.origin(info, o)
          x0 = o.x
          y0 = o.y
          h0 = o.h
        }
        let x1 = e.toX
        let y1 = e.toY
        let h1 = PH
        const dx = e.toX - e.fromX
        const dy = e.toY - e.fromY
        const len = Math.hypot(dx, dy) || 1
        const ux = dx / len
        const uy = dy / len
        const tp = e.target !== null ? pawnById(ctx.state, e.target) : undefined
        if (e.blocked && tp) {
          // stop on the bubble surface, not its centre
          let br = 0
          for (const m of tp.modifiers) if ((m.id === 'shield' || m.id === 'alteration') && m.data.radius) br = Math.max(br, m.data.radius)
          const back = Math.min(len - 40, br)
          x1 -= ux * back
          y1 -= uy * back
        } else if (tp) {
          const tv = ctx.pawn(tp.id)
          if (tv) h1 = tv.h + 70
        }
        addBolt(ctx.now, x0, y0, h0, x1, y1, h1, 0.55, 0, e.blocked, e.target !== null)
        ctx.flash(x0, y0, h0, 0.1, 120, 70, P.body[0] * 0.8, P.body[1] * 0.8, P.body[2] * 0.8)
        crackleSparks(ctx, x0, y0, h0, 8, 500, ux, uy, 0.9)
        ctx.shakeNear(x0, y0, 0.12)
        const fl = k.floor(x1, y1)
        if (e.blocked) {
          // tink: glancing sparks back toward the caster, small bright ring
          ctx.flash(x1, y1, h1, 0.1, 150, 90, P.hot[0], P.hot[1], P.hot[2])
          crackleSparks(ctx, x1, y1, h1, 22, 900, -ux, -uy, 1.0)
          k.pulse(G_SHOCK, true, x1, y1, h1, 55, 55, 0.22, 0, 0, P.hot, 1.2, 0.2, 0.9, 0.12)
        } else if (e.target === null) {
          // full range: the bolt frays into a crackle
          crackleSparks(ctx, x1, y1, h1, 14, 500)
          ctx.flash(x1, y1, h1, 0.12, 160, 90, P.body[0], P.body[1], P.body[2])
          for (let i = 0; i < 3; i++) {
            const a = Math.atan2(uy, ux) + (Math.random() - 0.5) * 2.2
            const l = 50 + Math.random() * 60
            addBolt(ctx.now, x1, y1, h1, x1 + Math.cos(a) * l, y1 + Math.sin(a) * l, h1 - 20 - Math.random() * 30, 0.2, 1)
          }
        } else {
          ctx.flash(x1, y1, h1, 0.12, 150, 90, P.body[0], P.body[1], P.body[2])
          if (!ctx.isLava(x1, y1)) ctx.scorches.spawn(x1, y1, fl - 0.4, 40, 3)
        }
        ctx.ground.spawn(RING_EXPAND, x1, y1, fl, 8, 90, 0.3, 8, P.body[0] * 0.7, P.body[1] * 0.7, P.body[2] * 0.7)
        return
      }
      case 'explosion': {
        if (e.spell !== 'lightning') return
        const R = e.radius
        k.expect('lightning', -1, -1, e.x, e.y, R)
        const fl = k.floor(e.x, e.y)
        ctx.aoeRing(e.x, e.y, R, P.body[0], P.body[1], P.body[2], 0.5)
        k.pulse(G_SHOCK, false, e.x, e.y, fl + 2, R, R, 0.38, Math.random() * 6, 0, P.hot, 1.0, 0.1, 0.93, 0.08)
        // fireball fuel + storm: orange fire core inside, electric spokes to the edge
        const ps = ctx.particles
        const n = ps.budget(50)
        for (let i = 0; i < n; i++) {
          const a = Math.random() * Math.PI * 2
          const sp = R * (1.2 + Math.random() * 1.6)
          ps.spawn(e.x, e.y, PH, Math.cos(a) * sp, Math.sin(a) * sp, 40 + Math.random() * 200, 0.32 + Math.random() * 0.2, 34 + Math.random() * 20, -10, FB.body[0] * 1.3, FB.body[1] * 1.3, FB.body[2] * 1.3, -200, 3.4, 0)
        }
        crackleSparks(ctx, e.x, e.y, PH, 30, R * 3.2)
        for (let i = 0; i < 7; i++) {
          const a = (i / 7) * Math.PI * 2 + Math.random() * 0.5
          const l = R * (0.75 + Math.random() * 0.22)
          addBolt(ctx.now, e.x, e.y, PH, e.x + Math.cos(a) * l, e.y + Math.sin(a) * l, fl + 10, 0.28, 1)
        }
        const ns = ctx.smoke.budget(8)
        for (let i = 0; i < ns; i++) {
          const a = Math.random() * Math.PI * 2
          ctx.smoke.spawn(e.x, e.y, PH, Math.cos(a) * 80, Math.sin(a) * 80, 60 + Math.random() * 40, 1.2 + Math.random() * 0.6, 50, 160, 0.05, 0.05, 0.06, 20, 1, 14)
        }
        if (!ctx.isLava(e.x, e.y)) ctx.scorches.spawn(e.x, e.y, fl - 0.4, R * 0.45, 5)
        ctx.flash(e.x, e.y, PH + 20, 0.24, R, 160, P.body[0] * 1.4, P.body[1] * 1.4, P.body[2] * 1.4)
        ctx.shakeNear(e.x, e.y, 0.35)
        return
      }
      case 'death':
        if (e.cause !== 'lightning') return
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
      if (!p.alive || !p.cast || p.cast.spell !== 'lightning' || p.cast.started === false) continue
      const info = ctx.pawn(p.id)
      if (!info) continue
      k.begin()
      k.origin(info, o)
      const w = windupProgress(k, ctx, p.id, p.cast.ticksLeft)
      k.windupAt(o.x, o.y, o.h, w, P, ctx.now, ctx.dt, p.id)
      // signature: arcs jumping between the fingers and crawling up the arm
      const sx = info.x + (o.x - info.x) * 0.25
      const sy = info.y + (o.y - info.y) * 0.25
      const sh = info.h + 112
      const armSeed = p.id * 53 + Math.floor(ctx.now * 22)
      k.bolt(o.x, o.y, o.h, sx, sy, sh, armSeed, 9, 2.5, P.body, P.hot, 0.6 + w * 0.8, w > 0.5 ? 1 : 0, 9, 14, 0.25)
      const arcs = 1 + Math.floor(w * 3)
      for (let i = 0; i < arcs; i++) {
        const seed = p.id * 97 + i * 13 + Math.floor(ctx.now * 28)
        const a = hash01(seed, 1) * Math.PI * 2
        const l = 30 + w * 40
        k.bolt(o.x, o.y, o.h, o.x + Math.cos(a) * l, o.y + Math.sin(a) * l, o.h + (hash01(seed, 2) - 0.5) * 60, seed, 8, 2.5, P.body, P.hot, 0.7 + w * 0.6, 0, 10, 14, 0.25)
      }
    }
    if (nBolts > 0) {
      k.begin()
      drawBolts(k, ctx)
    }
  },
}

registerSpellVfx(mod)
