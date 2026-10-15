/**
 * Swap (column 2, Transport; identity deep arcane blue with a cyan partner hue). spells.md §8.11.
 *
 * IMMEDIATE (no cast point).
 * - cast: arcane flash at the cast hand and a swirl opening at the feet
 * - flight: fast vortex orb (spinning spiral, sized to the r40 collider, hot
 *   core), blue trail, and a thin tether back to the caster's hand: "you go
 *   where this goes"
 * - 'swap' with a target: dual implosion at both spots (swirls collapse,
 *   motes drawn in) then bursts; two ghost ribbons arc between the spots in
 *   opposite directions (caster blue, the other cyan): the circle of exchange
 * - 'swap' without a target (blink to where the orb stopped): implode at the
 *   old spot, burst at the new one, one ghost ribbon
 */
import type { SimEvent } from '../../../sim/types'
import { RING_EXPAND, RING_IMPLODE } from '../../scene/GroundFx'
import { registerSpellVfx, type SpellVfx, type VfxCtx } from '../registry'
import { G_SWIRL, PH, acquireKit, palFor, releaseKit, trailFrom, type KitA, type Pal, type RGB, type TrailStyle } from './kitA'

const P: Pal = palFor('swap')
/** the partner / edge hue: the transport column's arcane cyan */
const Q: Pal = palFor('teleport')
let K: KitA | null = null
const o = { x: 0, y: 0, h: 0 }

const TRAIL: TrailStyle = trailFrom(P, { life: 0.2, width: 56, widthTail: 0.2, intensity: 1.9, falloff: 1.4, noise: 0.45, spacing: 12, rim: 0.35 })

interface Ghost {
  fx: number
  fy: number
  tx: number
  ty: number
  born: number
  side: number
  c: RGB
}
const ghosts: Ghost[] = []
let nGhost = 0
for (let i = 0; i < 12; i++) ghosts.push({ fx: 0, fy: 0, tx: 0, ty: 0, born: -10, side: 1, c: P.body })
const GHOST_LIFE = 0.55

function addGhost(fx: number, fy: number, tx: number, ty: number, side: number, c: RGB, now: number): void {
  let g: Ghost
  if (nGhost < ghosts.length) g = ghosts[nGhost++]
  else {
    g = ghosts[0]
    for (const q of ghosts) if (q.born < g.born) g = q
  }
  g.fx = fx
  g.fy = fy
  g.tx = tx
  g.ty = ty
  g.side = side
  g.c = c
  g.born = now
}

function drawGhosts(k: KitA, now: number): void {
  let w = 0
  for (let i = 0; i < nGhost; i++) {
    const g = ghosts[i]
    const age = now - g.born
    if (age > GHOST_LIFE) continue
    ghosts[w++] = g
    const dx = g.tx - g.fx
    const dy = g.ty - g.fy
    const len = Math.hypot(dx, dy) || 1
    const bulge = Math.min(220, len * 0.28) * g.side
    const px = -dy / len
    const py = dx / len
    // the ribbon is drawn from the start up to a head that races to the end
    const head = Math.min(1, age / 0.16)
    const fade = Math.pow(1 - age / GHOST_LIFE, 1.5)
    k.stripBegin(false, 1.5, 0.6, g.born * 10)
    const N = 22
    for (let j = 0; j <= N; j++) {
      const f = (j / N) * head
      const b = 4 * f * (1 - f) * bulge
      const tail = j / N
      const hgt = 60 + Math.sin(Math.PI * f) * 70
      k.stripPoint(g.fx + dx * f + px * b, g.fy + dy * f + py * b, hgt, 30 * (0.3 + tail * 0.7), g.c[0], g.c[1], g.c[2], 1.1 * fade * (0.15 + 0.85 * tail))
    }
    k.stripEnd()
  }
  nGhost = w
}

/** swirl collapsing into a spot (the pawn leaving) */
function implode(k: KitA, ctx: VfxCtx, x: number, y: number, c: Pal): void {
  const fl = k.floor(x, y)
  k.pulse(G_SWIRL, false, x, y, fl + 2, 130, 30, 0.32, 0, -9, c.body, 1.4, 7, 7, 3)
  ctx.ground.spawn(RING_IMPLODE, x, y, fl, 15, 130, 0.3, 10, c.body[0], c.body[1], c.body[2])
  const ps = ctx.particles
  const n = ps.budget(24)
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2
    const rr = 70 + Math.random() * 50
    const life = 0.18 + Math.random() * 0.08
    const hh = fl + 20 + Math.random() * 110
    ps.spawn(x + Math.cos(a) * rr, y + Math.sin(a) * rr, hh, (-Math.cos(a) * rr + Math.sin(a) * rr * 0.8) / life, (-Math.sin(a) * rr - Math.cos(a) * rr * 0.8) / life, 0, life, 11, 3, c.spark[0], c.spark[1], c.spark[2], 0, 0, -0.04)
  }
  ctx.flash(x, y, fl + 70, 0.16, 180, 120, c.body[0], c.body[1], c.body[2])
}

/** arrival burst: ring, rising column, sparks */
function arrive(k: KitA, ctx: VfxCtx, x: number, y: number, c: Pal): void {
  const fl = k.floor(x, y)
  k.pulse(G_SWIRL, false, x, y, fl + 2, 40, 150, 0.4, 0, 6, c.body, 1.2, -7, -7, 3)
  ctx.ground.spawn(RING_EXPAND, x, y, fl, 15, 170, 0.42, 12, c.body[0], c.body[1], c.body[2])
  const ps = ctx.particles
  const n = ps.budget(26)
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2
    const sp = 180 + Math.random() * 320
    ps.spawn(x, y, fl + 15, Math.cos(a) * sp, Math.sin(a) * sp, 60 + Math.random() * 120, 0.4, 11, 2, c.spark[0], c.spark[1], c.spark[2], -200, 3, -0.08)
    ps.spawn(x + Math.cos(a) * 22, y + Math.sin(a) * 22, fl, 0, 0, 260 + Math.random() * 320, 0.5, 9, 2, c.body[0] * 1.2, c.body[1] * 1.2, c.body[2] * 1.2, 0, 1.5, 6)
  }
  ctx.flash(x, y, fl + 70, 0.26, 260, 200, c.hot[0], c.hot[1], c.hot[2])
}

const mod: SpellVfx = {
  spell: 'swap',
  init(ctx) {
    K = acquireKit(ctx)
  },
  dispose() {
    releaseKit(K)
    K = null
    nGhost = 0
  },

  onEvent(e: SimEvent, ctx) {
    const k = K
    if (!k) return
    switch (e.type) {
      case 'cast': {
        if (e.spell !== 'swap') return
        const info = ctx.pawn(e.pawn)
        if (!info) return
        k.origin(info, o)
        const dx = e.x - info.x
        const dy = e.y - info.y
        const l = Math.hypot(dx, dy) || 1
        k.muzzle(o.x, o.y, o.h, dx / l, dy / l, P, 0.9)
        k.pulse(G_SWIRL, false, info.x, info.y, k.floor(info.x, info.y) + 2, 40, 90, 0.3, 0, 8, P.body, 0.9, 6, 6, 3)
        return
      }
      case 'swap': {
        if (e.spell !== 'swap') return
        const now = ctx.now
        if (e.other !== null) {
          // both spots implode and burst: caster blue, the other cyan
          implode(k, ctx, e.fromX, e.fromY, P)
          implode(k, ctx, e.toX, e.toY, Q)
          arrive(k, ctx, e.toX, e.toY, P)
          arrive(k, ctx, e.fromX, e.fromY, Q)
          addGhost(e.fromX, e.fromY, e.toX, e.toY, 1, P.body, now)
          addGhost(e.toX, e.toY, e.fromX, e.fromY, 1, Q.body, now)
          ctx.shakeNear(e.toX, e.toY, 0.15)
        } else {
          implode(k, ctx, e.fromX, e.fromY, P)
          arrive(k, ctx, e.toX, e.toY, P)
          addGhost(e.fromX, e.fromY, e.toX, e.toY, Math.random() < 0.5 ? 1 : -1, P.body, now)
        }
        return
      }
      default:
        return
    }
  },

  frame(ctx) {
    const k = K
    if (!k || nGhost === 0) return
    k.begin()
    drawGhosts(k, ctx.now)
  },

  drawProjectile(p, x, y, ctx) {
    const k = K
    if (!k) return
    k.begin()
    k.track(p, x, y)
    const now = ctx.now
    const r = p.radius
    const sp = Math.hypot(p.vx, p.vy)
    const dx = sp > 1 ? p.vx / sp : 1
    const dy = sp > 1 ? p.vy / sp : 0
    // vortex orb on the collision radius, hot core
    k.air.add(G_SWIRL, x, y, PH, r, -now * 14 + p.id, P.body[0], P.body[1], P.body[2], 1.3, 7, 3)
    k.air.add(G_SWIRL, x, y, PH + 1, r * 0.8, now * 9, Q.body[0], Q.body[1], Q.body[2], 0.6, -6, 2)
    k.cores.add(x, y, PH, r * 0.42, dx, dy, 0.8, p.id, P.edge, P.body, P.hot)
    k.glowAt(x, y, PH, r * 3, P.body[0] * 0.35, P.body[1] * 0.35, P.body[2] * 0.35, 1.7, 0.5)
    ctx.glow.add(x, y, 220, 0.85, P.light[0], P.light[1], P.light[2])
    ctx.projectileShadow(x, y, PH, r)
    k.trailPoint(p.id * 4, x, y, PH, TRAIL, p.owner)
    // tether back to the caster's hand
    const info = ctx.pawnOf(p.owner)
    if (info && info.alive) {
      k.origin(info, o)
      const len = Math.hypot(x - o.x, y - o.y)
      if (len > 50) {
        k.teamRGB(p.owner)
        k.stripBegin(false, 2.4, 0.9, now * 6)
        const N = 14
        for (let i = 0; i <= N; i++) {
          const f = i / N
          const wob = Math.sin(f * 9 - now * 30) * 6 * Math.sin(Math.PI * f)
          k.stripPoint(o.x + (x - o.x) * f - dy * wob, o.y + (y - o.y) * f + dx * wob, o.h + (PH - o.h) * f, 8, P.body[0], P.body[1], P.body[2], 0.35 + 0.25 * f, k.team[0], k.team[1], k.team[2], 0.35)
        }
        k.stripEnd()
      }
    }
    const ps = ctx.particles
    const n = ps.budget(ctx.dt * 60)
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2
      ps.spawn(x + Math.cos(a) * r * 0.8, y + Math.sin(a) * r * 0.8, PH + (Math.random() - 0.5) * 20, -Math.sin(a) * 200 - dx * 200, Math.cos(a) * 200 - dy * 200, (Math.random() - 0.5) * 60, 0.2 + Math.random() * 0.15, 7, 1, P.spark[0], P.spark[1], P.spark[2], 0, 3, -0.05)
    }
  },
}

registerSpellVfx(mod)
