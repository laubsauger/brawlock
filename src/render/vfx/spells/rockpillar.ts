/**
 * Rockpillar (column 6 Knockbackless; earth brown). spells.md §8.27.
 * Render already draws the pillar (obstacle variant -1) and its rise. This module adds:
 * - windup (0.2 s cast point): the ground at the (clamped) target cracks open in a circle of
 *   exactly the pillar radius (90), and earth runes mark the casting hand;
 * - summon (a new variant -1 obstacle appears): an eruption of rock chips and a dust ring that
 *   stays inside the footprint, runes flaring up the stone, a short rumble;
 * - while standing: a faint rune ring at its foot; in the last 0.5 s it trembles and sheds grit;
 * - crumble when its time runs out (removed without an event): rubble and a dust slump.
 *   Destroyed by damage ('obstacleDestroyed'): render's blast plays; we add an amber rune flash.
 */
import { SPELLS, attr } from '../../../sim/spells/data'
import type { SimEvent } from '../../../sim/types'
import { S, TILE_TOP_H } from '../../coords'
import { RING_EXPAND } from '../../scene/GroundFx'
import { registerSpellVfx, type VfxCtx } from '../registry'
import { STYLE_CRACKS, STYLE_RING, TAU, castFlash, drawCircle, floorH, glowG, kitBegin, kitInit, kitRelease, light, originOf, pal, palMix, rand, flashT, levelOf, tierOfLevel } from './kitB'

const SPELL = 'rockpillar'
const DEF = SPELLS[SPELL]
// identity: earth brown (vfx/palette.ts); runes glow amber-sand
const EARTH = pal('rockpillar', 'accent', 0.5)
const RUNE = pal('rockpillar', 'core', 1.8)
const DUST = [0.2, 0.16, 0.12] as const
const GRIT = palMix('rockpillar', 0.2, 0.09)

interface Pillar {
  x: number
  y: number
  r: number
  born: number
  seen: number
  ticksLeft: number
  destroyed: boolean
}

const pillars = new Map<number, Pillar>()
let frameNo = 0
let primed = false
const tgt = { x: 0, y: 0 }

function clampTarget(px: number, py: number, x: number, y: number, range: number, out: { x: number; y: number }): void {
  const dx = x - px
  const dy = y - py
  const d = Math.hypot(dx, dy)
  if (d <= range || d === 0) {
    out.x = x
    out.y = y
    return
  }
  out.x = px + (dx / d) * range
  out.y = py + (dy / d) * range
}

function chips(ctx: VfxCtx, x: number, y: number, R: number, n: number, up: number): void {
  const nd = ctx.debris.budget(n)
  for (let i = 0; i < nd; i++) {
    const a = Math.random() * TAU
    const sp = rand(0.3, 1.0) * R
    const g = rand(0.05, 0.12)
    ctx.debris.spawn(x + Math.cos(a) * R * rand(0.3, 0.9), y + Math.sin(a) * R * rand(0.3, 0.9), TILE_TOP_H + rand(5, 40), Math.cos(a) * sp, Math.sin(a) * sp, rand(0.5, 1) * up, rand(0.6, 1.0), rand(8, 18), 6, g * 1.25, g, g * 0.75, -2000, 1.4, 0)
  }
}

function dust(ctx: VfxCtx, x: number, y: number, R: number, n: number, rise: number): void {
  const sm = ctx.smoke
  const c = sm.budget(n)
  for (let i = 0; i < c; i++) {
    const a = (i / Math.max(1, c)) * TAU + Math.random() * 0.4
    const sp = rand(0.25, 0.5) * R
    sm.spawn(x + Math.cos(a) * R * 0.6, y + Math.sin(a) * R * 0.6, TILE_TOP_H + 10, Math.cos(a) * sp, Math.sin(a) * sp, rand(20, rise), rand(0.9, 1.5), 40, R * 0.5, DUST[0], DUST[1], DUST[2], -10, 1.6, 0)
  }
}

function summon(ctx: VfxCtx, p: Pillar, tier = 0): void {
  const fh = floorH(ctx, p.x, p.y)
  ctx.aoeRing(p.x, p.y, p.r, RUNE[0], RUNE[1], RUNE[2], 0.4)
  ctx.ground.spawn(RING_EXPAND, p.x, p.y, fh, p.r * 0.3, p.r - 3, 0.3, 10, EARTH[0] * 2, EARTH[1] * 2, EARTH[2] * 2)
  chips(ctx, p.x, p.y, p.r, 30 + 12 * tier, 900)
  dust(ctx, p.x, p.y, p.r, 14, 160)
  flashT(ctx, p.x, p.y, fh + 80, 0.1, p.r, p.r * 1.2, RUNE[0] * 0.5, RUNE[1] * 0.5, RUNE[2] * 0.5)
  ctx.shakeNear(p.x, p.y, 0.22)
}

function crumble(ctx: VfxCtx, p: Pillar): void {
  const fh = floorH(ctx, p.x, p.y)
  const nd = ctx.debris.budget(46)
  for (let i = 0; i < nd; i++) {
    const a = Math.random() * TAU
    const rr = Math.random() * p.r * 0.8
    const g = rand(0.05, 0.12)
    ctx.debris.spawn(p.x + Math.cos(a) * rr, p.y + Math.sin(a) * rr, TILE_TOP_H + rand(40, 240), Math.cos(a) * rand(30, 160), Math.sin(a) * rand(30, 160), rand(-50, 120), rand(0.7, 1.2), rand(10, 24), 8, g * 1.25, g, g * 0.75, -1900, 1, 0)
  }
  dust(ctx, p.x, p.y, p.r, 18, 220)
  ctx.ground.spawn(RING_EXPAND, p.x, p.y, fh, p.r * 0.5, p.r - 2, 0.4, 8, EARTH[0], EARTH[1], EARTH[2])
  ctx.shakeNear(p.x, p.y, 0.12)
}

registerSpellVfx({
  spell: SPELL,
  init(ctx: VfxCtx) {
    kitInit(ctx)
    primed = false
  },
  dispose() {
    pillars.clear()
    kitRelease()
  },
  onEvent(e: SimEvent, ctx: VfxCtx): boolean | void {
    if (e.type === 'cast' && e.spell === SPELL) {
      castFlash(ctx, e.pawn, RUNE, 0.8)
      return true
    }
    if (e.type === 'obstacleDestroyed') {
      const p = pillars.get(e.id)
      if (p) {
        p.destroyed = true
        // the built-in pillar blast plays (not claimed); add the runes bursting
        flashT(ctx, e.x, e.y, TILE_TOP_H + 120, 0.15, p.r, 220, RUNE[0] * 0.5, RUNE[1] * 0.5, RUNE[2] * 0.5)
        ctx.ground.spawn(RING_EXPAND, e.x, e.y, floorH(ctx, e.x, e.y), 20, p.r, 0.3, 10, RUNE[0], RUNE[1], RUNE[2])
      }
    }
  },
  frame(ctx: VfxCtx) {
    kitBegin(ctx)
    frameNo++
    const st = ctx.state
    if (!st) return
    // track rockpillars (variant -1): appear -> summon, vanish without a blast -> crumble
    for (const o of st.obstacles) {
      if (o.variant !== -1) continue
      let p = pillars.get(o.id)
      if (!p) {
        p = { x: o.x, y: o.y, r: o.radius, born: ctx.now, seen: frameNo, ticksLeft: o.ticksLeft ?? 0, destroyed: false }
        pillars.set(o.id, p)
        if (primed) summon(ctx, p, tierOfLevel(ctx, o.owner === undefined ? 1 : levelOf(ctx, o.owner, SPELL)))
      }
      p.seen = frameNo
      p.ticksLeft = o.ticksLeft ?? 0
      const fh = floorH(ctx, p.x, p.y)
      const age = ctx.now - p.born
      const rune = Math.max(0, 1 - age / 0.8)
      drawCircle(p.x, p.y, fh + 0.4, p.r, STYLE_RING, RUNE[0], RUNE[1], RUNE[2], 0.25 + 0.9 * rune, 0, 0, o.id, 0, 0.7, 0, p.born)
      if (rune > 0) {
        drawCircle(p.x, p.y, fh + 0.3, p.r, STYLE_CRACKS, RUNE[0], RUNE[1], RUNE[2], 1.2 * rune, 1 - rune, 0, o.id * 0.3, 0, 1, 0, p.born - 1)
        // runes flaring up the stone
        for (let k = 0; k < 4; k++) {
          const a = (k / 4) * TAU + o.id
          glowG(p.x + Math.cos(a) * p.r * 0.95, p.y + Math.sin(a) * p.r * 0.95, TILE_TOP_H + 30 + rune * 0 + (1 - rune) * 180, 50, RUNE, 0.8 * rune, 2.2)
        }
        light(ctx, p.x, p.y, p.r * 1.2, 0.8 * rune, RUNE, 0.4)
      }
      // last 0.5 s: trembling, grit falling
      const secs = p.ticksLeft / 60
      if (secs > 0 && secs < 0.5 && Math.random() < ctx.dt * 30) {
        const a = Math.random() * TAU
        ctx.debris.spawn(p.x + Math.cos(a) * p.r * 0.8, p.y + Math.sin(a) * p.r * 0.8, TILE_TOP_H + rand(60, 200), 0, 0, 0, 0.6, rand(5, 9), 3, GRIT[0], GRIT[1], GRIT[2], -1500, 0, 0)
      }
    }
    for (const [id, p] of pillars) {
      if (p.seen === frameNo) continue
      if (!p.destroyed && p.ticksLeft <= 3) crumble(ctx, p)
      pillars.delete(id)
    }
    primed = true
    // windup: the ground at the target cracks open (exactly the pillar footprint)
    for (const pw of st.pawns) {
      const c = pw.cast
      if (!pw.alive || !c || c.spell !== SPELL || !c.started) continue
      const lvl = pw.levels[c.slot] || 1
      clampTarget(pw.x, pw.y, c.x, c.y, attr(DEF, 'range', lvl), tgt)
      const R = attr(DEF, 'radius', lvl) || 90
      const k = 1 - c.ticksLeft / 12
      const fh = floorH(ctx, tgt.x, tgt.y)
      drawCircle(tgt.x, tgt.y, fh + 0.3, R, STYLE_CRACKS, RUNE[0], RUNE[1], RUNE[2], 0.5 + 1.0 * k, 0.6 - 0.6 * k, 0, pw.id, 0, 1, 0, ctx.now - 1)
      drawCircle(tgt.x, tgt.y, fh + 0.4, R, STYLE_RING, RUNE[0], RUNE[1], RUNE[2], 0.4 + 0.6 * k, 0, 0, pw.id, 0, 0.6, 0, ctx.now - 1)
      // Target cracks are an immediate aiming mark. Flying grit starts only at summon.
      const info = ctx.pawn(pw.id)
      if (info) {
        const o = originOf(info)
        drawCircle(o.x / S, -o.z / S, o.y / S + 1, 29, STYLE_CRACKS, RUNE[0], RUNE[1], RUNE[2], 0.5 + 0.7 * k, 0, 0, pw.id, 0, 1.2, 0, ctx.now - 1)
      }
    }
  },
})
