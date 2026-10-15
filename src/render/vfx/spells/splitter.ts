/**
 * Splitter (column 4 Devastator, violet-magenta). spells.md §8.18.
 * Main bolt (r50): an unstable arcane bolt whose crackling tendrils already fork forward,
 * comet tail and magenta trail. On death (any reason) it cracks open (split burst, fan of
 * sparks) into the spawner: a shrinking, pulsing orb drifting at 250 u/s that flashes once per
 * wave as it spits 2 child darts (r21) in a widening fan (4 waves, 8 darts). Darts are small
 * hot-pink arrowheads with short tails that pop on contact. Collision cores are sim-sized.
 */
import type { ProjectileState, SimEvent } from '../../../sim/types'
import { PROJECTILE_H, S } from '../../coords'
import { RING_EXPAND } from '../../scene/GroundFx'
import { registerSpellVfx, type VfxCtx } from '../registry'
import {
  TAU, burst, castFlash, drawCore, floorH, glowG, hexRgb, kitBegin, kitInit, kitRelease,
  light, mixRgb, projShadow, rand, screenAngle,
  pal, palMix,
} from './kitB'

// identity: bright magenta (vfx/palette.ts)
const MAGENTA = pal('splitter', 'accent', 0.85)
const PINK_HOT = pal('splitter', 'core', 1.8)
const VIOLET = palMix('splitter', 0.0, 0.35)

const SPELL = 'splitter'
const H = PROJECTILE_H

interface Track {
  id: number
  kind: number // 0 main, 1 spawner, 2 child
  seen: number
  x: number
  y: number
  vx: number
  vy: number
  wave: number
  born: number
}

const tracks = new Map<number, Track>()
const free: Track[] = []
let frameNo = 0
const team: [number, number, number] = [1, 1, 1]
const edge: [number, number, number] = [1, 1, 1]

function kindIdx(p: ProjectileState): number {
  return p.kind === 'splitterSpawner' ? 1 : p.kind === 'splitterChild' ? 2 : 0
}

function track(p: ProjectileState, x: number, y: number, ctx: VfxCtx): { t: Track; fresh: boolean } {
  let t = tracks.get(p.id)
  let fresh = false
  if (!t) {
    t = free.pop() ?? { id: 0, kind: 0, seen: 0, x: 0, y: 0, vx: 0, vy: 0, wave: 0, born: 0 }
    t.id = p.id
    t.kind = kindIdx(p)
    t.x = x
    t.y = y
    t.wave = 0
    t.born = ctx.now
    tracks.set(p.id, t)
    fresh = true
  }
  t.seen = frameNo
  t.vx = p.vx
  t.vy = p.vy
  return { t, fresh }
}

/** Particles along the segment travelled since the last frame. */
function trail(ctx: VfxCtx, t: Track, x: number, y: number, spacing: number, size: number, hot: number): void {
  const dx = x - t.x
  const dy = y - t.y
  const dist = Math.hypot(dx, dy)
  if (dist > 0.5 && dist < 400) {
    const ps = ctx.particles
    const sp = spacing / Math.max(0.25, ctx.tier.particles)
    const n = Math.min(16, Math.ceil(dist / sp))
    const ux = dx / dist
    const uy = dy / dist
    for (let k = 0; k < n; k++) {
      const f = (k + Math.random()) / n
      const px = t.x + dx * f + rand(-6, 6)
      const py = t.y + dy * f + rand(-6, 6)
      const c = Math.random() < 0.35 ? VIOLET : MAGENTA
      ps.spawn(px, py, H + rand(-6, 6), -ux * 60 + rand(-40, 40), -uy * 60 + rand(-40, 40), rand(10, 40), rand(0.16, 0.3), size, size * 0.2, c[0] * hot, c[1] * hot, c[2] * hot, 0, 2.5, 0)
      if (Math.random() < 0.15) {
        ps.spawn(px, py, H, rand(-200, 200), rand(-200, 200), rand(60, 200), rand(0.25, 0.4), 6, 1.5, PINK_HOT[0], PINK_HOT[1], PINK_HOT[2], -900, 2, -0.08)
      }
    }
  }
  t.x = x
  t.y = y
}

function drawMain(p: ProjectileState, x: number, y: number, ctx: VfxCtx, t: Track): void {
  const r = p.radius
  const sp = Math.hypot(p.vx, p.vy) || 1
  const ux = p.vx / sp
  const uy = p.vy / sp
  hexRgb(ctx.colorOf(p.owner), team)
  mixRgb(MAGENTA, team, 0.3, edge)
  drawCore(x, y, H, r * 0.82, edge, PINK_HOT, p.id % 7)
  const ang = screenAngle(ctx, x, y, H, ux, uy)
  glowG(x, y, H, r * 4.2, VIOLET, 0.26, 1.6, 0, 1, 0, 0.6)
  glowG(x - ux * r * 1.7, y - uy * r * 1.7, H, r * 2.3, MAGENTA, 0.6, 1.5, 0, 3.2, ang, 0.4)
  glowG(x - ux * r * 0.8, y - uy * r * 0.8, H, r * 1.2, PINK_HOT, 0.5, 2.2, 0, 2.4, ang)
  // forked tendrils crackling ahead of the bolt: the split it is about to become
  const px = -uy
  const py = ux
  const now = ctx.now
  for (let k = -1; k <= 1; k += 2) {
    const flick = 0.6 + 0.4 * Math.sin(now * 53 + k * 7 + p.id)
    for (let j = 1; j <= 3; j++) {
      const f = j / 3
      const ox = ux * r * (0.4 + f * 1.1) + px * k * r * (0.15 + f * 0.75) + rand(-5, 5)
      const oy = uy * r * (0.4 + f * 1.1) + py * k * r * (0.15 + f * 0.75) + rand(-5, 5)
      glowG(x + ox, y + oy, H + rand(-6, 6), r * (0.7 - f * 0.25), PINK_HOT, 0.55 * flick, 2.5, 4)
    }
    glowG(x + ux * r * 1.6 + px * k * r * 0.95, y + uy * r * 1.6 + py * k * r * 0.95, H, r * 0.9, PINK_HOT, 0.7 * flick, 2, 2, 1, now * 4 + k)
  }
  light(ctx, x, y, 190, 0.8, MAGENTA, 0.45)
  projShadow(ctx, x, y, H, r * 0.7)
  trail(ctx, t, x, y, 9, r * 0.9, 1.1)
}

function drawSpawner(p: ProjectileState, x: number, y: number, ctx: VfxCtx, t: Track): void {
  const d = p.data
  const waves = d.waves || 4
  const wave = d.wave || 0
  const sp = Math.hypot(p.vx, p.vy) || 1
  const ux = p.vx / sp
  const uy = p.vy / sp
  if (wave > t.wave) {
    // a wave just left: muzzle flash + spark fan along both child headings
    for (let w = t.wave; w < wave; w++) {
      const a = 0.48 * (1 - w / waves)
      for (const sign of [1, -1]) {
        const cx = (ux + sign * a * -uy) / (1 + a)
        const cy = (uy + sign * a * ux) / (1 + a)
        const cl = Math.hypot(cx, cy)
        const ps = ctx.particles
        const n = ps.budget(8)
        for (let i = 0; i < n; i++) {
          const s = rand(300, 700)
          ps.spawn(x, y, H, (cx / cl) * s + rand(-60, 60), (cy / cl) * s + rand(-60, 60), rand(-30, 60), rand(0.12, 0.22), 9, 2, PINK_HOT[0], PINK_HOT[1], PINK_HOT[2], 0, 4, -0.1)
        }
      }
    }
    ctx.flash(x, y, H, 0.1, 140, 120, MAGENTA[0], MAGENTA[1], MAGENTA[2])
    t.wave = wave
  }
  const left = 1 - wave / waves
  const pulse = 0.8 + 0.2 * Math.sin(ctx.now * 40)
  hexRgb(ctx.colorOf(p.owner), team)
  mixRgb(VIOLET, team, 0.25, edge)
  drawCore(x, y, H, (14 + 16 * left) * pulse, edge, PINK_HOT, p.id % 7)
  glowG(x, y, H, 150 * (0.5 + 0.5 * left), VIOLET, 0.45, 1.4, 0, 1, 0, 0.5)
  glowG(x, y, H, 110 * (0.6 + 0.4 * left), MAGENTA, 0.55 * pulse, 0.12, 1, 1, ctx.now * 2)
  glowG(x, y, H, 90, PINK_HOT, 0.35, 2, 2, 1, ctx.now * 6)
  light(ctx, x, y, 220, 0.8, MAGENTA, 0.45)
  trail(ctx, t, x, y, 14, 18, 0.8)
}

function drawChild(p: ProjectileState, x: number, y: number, ctx: VfxCtx, t: Track): void {
  const r = p.radius
  const sp = Math.hypot(p.vx, p.vy) || 1
  const ux = p.vx / sp
  const uy = p.vy / sp
  hexRgb(ctx.colorOf(p.owner), team)
  mixRgb(MAGENTA, team, 0.3, edge)
  drawCore(x, y, H, r * 0.9, edge, PINK_HOT, p.id % 7)
  const ang = screenAngle(ctx, x, y, H, ux, uy)
  glowG(x, y, H, r * 3, MAGENTA, 0.2, 1.8)
  glowG(x - ux * r * 1.8, y - uy * r * 1.8, H, r * 1.5, MAGENTA, 0.7, 1.6, 0, 3.6, ang, 0.3)
  glowG(x + ux * r * 0.5, y + uy * r * 0.5, H, r * 1.7, PINK_HOT, 0.4, 2, 2, 1, ang + 0.785)
  projShadow(ctx, x, y, H, r * 0.8)
  trail(ctx, t, x, y, 16, r * 0.9, 0.9)
}

function splitBurst(ctx: VfxCtx, x: number, y: number, vx: number, vy: number): void {
  const fh = floorH(ctx, x, y)
  const sp = Math.hypot(vx, vy) || 1
  const ux = vx / sp
  const uy = vy / sp
  ctx.flash(x, y, H, 0.16, 160, 200, PINK_HOT[0], PINK_HOT[1], PINK_HOT[2])
  ctx.ground.spawn(RING_EXPAND, x, y, fh, 12, 120, 0.3, 10, MAGENTA[0], MAGENTA[1], MAGENTA[2])
  // forward fan of sparks: the shape of the coming spread
  const ps = ctx.particles
  const n = ps.budget(34)
  for (let i = 0; i < n; i++) {
    const a = Math.atan2(uy, ux) + rand(-0.5, 0.5)
    const s = rand(400, 1000)
    ps.spawn(x, y, H, Math.cos(a) * s, Math.sin(a) * s, rand(-40, 120), rand(0.18, 0.35), 10, 2, PINK_HOT[0], PINK_HOT[1], PINK_HOT[2], -600, 3, -0.1)
  }
  burst(ctx, x, y, H, 20, 100, 320, 0.25, 0.45, 34, 6, VIOLET, 1, 0, 3, 0, -40, 120)
  ctx.shakeNear(x, y, 0.1)
}

function popBurst(ctx: VfxCtx, x: number, y: number, hit: boolean): void {
  const fh = floorH(ctx, x, y)
  ctx.flash(x, y, H, 0.12, 120, 90, MAGENTA[0], MAGENTA[1], MAGENTA[2])
  ctx.ground.spawn(RING_EXPAND, x, y, fh, 8, 60, 0.22, 6, MAGENTA[0], MAGENTA[1], MAGENTA[2])
  burst(ctx, x, y, H, hit ? 16 : 9, 200, 600, 0.15, 0.3, 8, 2, PINK_HOT, 1, -800, 3, -0.08, 0, 200)
  burst(ctx, x, y, H, hit ? 8 : 4, 60, 200, 0.2, 0.35, 26, 4, MAGENTA, 0.8, 0, 3, 0, 0, 60)
}

registerSpellVfx({
  spell: SPELL,
  init(ctx: VfxCtx) {
    kitInit(ctx)
  },
  dispose() {
    tracks.clear()
    free.length = 0
    kitRelease()
  },
  onEvent(e: SimEvent, ctx: VfxCtx): boolean | void {
    if (e.type === 'cast' && e.spell === SPELL) {
      const o = castFlash(ctx, e.pawn, MAGENTA, 1)
      if (o) glowG(o.x / S, -o.z / S, o.y / S, 120, PINK_HOT, 0.8, 2, 2, 1, rand(0, TAU))
      return
    }
    if ((e.type === 'projectileHit' || e.type === 'projectileExpire') && e.spell === SPELL) {
      const t = tracks.get(e.id)
      const kind = t ? t.kind : 2
      if (kind === 0) splitBurst(ctx, e.x, e.y, t ? t.vx : 1, t ? t.vy : 0)
      else if (kind === 2) popBurst(ctx, e.x, e.y, e.type === 'projectileHit' && e.target !== null)
      else {
        // spawner spent: the orb gutters out
        burst(ctx, e.x, e.y, H, 12, 40, 160, 0.3, 0.5, 20, 3, VIOLET, 0.9, 0, 2, 4, 0, 80)
        ctx.flash(e.x, e.y, H, 0.12, 100, 90, VIOLET[0], VIOLET[1], VIOLET[2])
      }
      return true
    }
  },
  frame(ctx: VfxCtx) {
    kitBegin(ctx)
    frameNo++
    for (const [id, t] of tracks) {
      if (frameNo - t.seen > 30) {
        tracks.delete(id)
        free.push(t)
      }
    }
  },
  drawProjectile(p: ProjectileState, x: number, y: number, ctx: VfxCtx) {
    const { t } = track(p, x, y, ctx)
    if (t.kind === 0) drawMain(p, x, y, ctx, t)
    else if (t.kind === 1) drawSpawner(p, x, y, ctx, t)
    else drawChild(p, x, y, ctx, t)
  },
})
