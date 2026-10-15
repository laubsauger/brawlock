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
  TAU, burst, castFlash, drawCore, drawShard, floorH, glowG, hexRgb, kitBegin, kitInit, kitRelease,
  light, mixRgb, projShadow, rand, screenAngle,
  pal, palMix, flashT, levelOfThing, tierOfLevel,
} from './kitB'

// identity: bright magenta (vfx/palette.ts)
const MAGENTA = pal('splitter', 'accent', 0.85)
const PINK_HOT = pal('splitter', 'core', 1.8)
const VIOLET = palMix('splitter', 0.0, 0.35)
const DART_CORE = palMix('splitter', 0.6, 1.0)

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
      const px = t.x + dx * f + rand(-3, 3)
      const py = t.y + dy * f + rand(-3, 3)
      const c = Math.random() < 0.35 ? VIOLET : MAGENTA
      ps.spawn(px, py, H + rand(-4, 4), -ux * 40 + rand(-25, 25), -uy * 40 + rand(-25, 25), rand(5, 25), rand(0.12, 0.22), size, size * 0.2, c[0] * hot, c[1] * hot, c[2] * hot, 0, 2.5, 0)
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
  drawCore(x, y, H, r * 0.92, edge, PINK_HOT, p.id % 7)
  const ang = screenAngle(ctx, x, y, H, ux, uy)
  // tight glow only (no cloud): a crisp rim and a short hot tail
  glowG(x, y, H, r * 2.2, MAGENTA, 0.45, 3.5)
  glowG(x - ux * r * 1.5, y - uy * r * 1.5, H, r * 1.3, MAGENTA, 0.75, 2.4, 0, 3.4, ang, 0.3)
  glowG(x - ux * r * 0.7, y - uy * r * 0.7, H, r * 0.8, PINK_HOT, 0.6, 3, 0, 2.6, ang)
  // forked tendrils crackling ahead of the bolt: the split it is about to become
  const px = -uy
  const py = ux
  const now = ctx.now
  const tier = tierOfLevel(ctx, levelOfThing(p))
  for (let k = -1; k <= 1; k += 2) {
    const flick = 0.6 + 0.4 * Math.sin(now * 53 + k * 7 + p.id)
    const nj = 2 + tier
    for (let j = 1; j <= nj; j++) {
      const f = j / nj
      const ox = ux * r * (0.5 + f * 1.1) + px * k * r * (0.15 + f * 0.75) + rand(-4, 4)
      const oy = uy * r * (0.5 + f * 1.1) + py * k * r * (0.15 + f * 0.75) + rand(-4, 4)
      glowG(x + ox, y + oy, H + rand(-5, 5), r * (0.45 - f * 0.15), PINK_HOT, 0.7 * flick, 3, 4)
    }
    glowG(x + ux * r * 1.6 + px * k * r * 0.95, y + uy * r * 1.6 + py * k * r * 0.95, H, r * 0.7, PINK_HOT, 0.8 * flick, 3, 2, 1, now * 4 + k)
  }
  light(ctx, x, y, 130, 0.6, MAGENTA, 0.45)
  projShadow(ctx, x, y, H, r * 0.7)
  trail(ctx, t, x, y, 10, 16, 1.1)
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
        const n = ps.budget(6)
        for (let i = 0; i < n; i++) {
          const s = rand(300, 700)
          ps.spawn(x, y, H, (cx / cl) * s + rand(-40, 40), (cy / cl) * s + rand(-40, 40), rand(-30, 60), rand(0.1, 0.18), 7, 1.5, PINK_HOT[0], PINK_HOT[1], PINK_HOT[2], 0, 4, -0.1)
        }
      }
    }
    t.wave = wave
    t.born = ctx.now
  }
  const left = 1 - wave / waves
  const kick = Math.max(0, 1 - (ctx.now - t.born) / 0.08)
  const pulse = 0.85 + 0.15 * Math.sin(ctx.now * 40) + 0.35 * kick
  hexRgb(ctx.colorOf(p.owner), team)
  mixRgb(MAGENTA, team, 0.25, edge)
  // a clear, pulsing core that shrinks with every wave it spends
  drawCore(x, y, H, (12 + 14 * left) * pulse, edge, PINK_HOT, p.id % 7)
  glowG(x, y, H, (60 + 40 * left) * pulse, MAGENTA, 0.6, 3.2)
  glowG(x, y, H, (70 + 30 * left) * pulse, PINK_HOT, 0.7 + 0.8 * kick, 0.06, 1, 1, ctx.now * 3)
  light(ctx, x, y, 140, 0.6 + 0.6 * kick, MAGENTA, 0.45)
  trail(ctx, t, x, y, 18, 10, 0.8)
}

function drawChild(p: ProjectileState, x: number, y: number, ctx: VfxCtx, t: Track): void {
  const r = p.radius
  const sp = Math.hypot(p.vx, p.vy) || 1
  const ux = p.vx / sp
  const uy = p.vy / sp
  hexRgb(ctx.colorOf(p.owner), team)
  mixRgb(MAGENTA, team, 0.3, edge)
  // a crisp shard pointing along its own heading (hitbox r21 across, slightly longer)
  drawShard(x, y, H, r * 0.75, 2.0, ux, uy, edge, DART_CORE, p.id % 7)
  const ang = screenAngle(ctx, x, y, H, ux, uy)
  // its own short, tight trail: separate darts, not one cloud
  glowG(x - ux * r * 2.2, y - uy * r * 2.2, H, r * 0.7, MAGENTA, 0.55, 2.8, 0, 4.5, ang, 0.2)
  glowG(x, y, H, r * 2.2, MAGENTA, 0.18, 3.5)
  projShadow(ctx, x, y, H, r * 0.8)
  trail(ctx, t, x, y, 26, 7, 0.6)
}

function splitBurst(ctx: VfxCtx, x: number, y: number, vx: number, vy: number): void {
  const fh = floorH(ctx, x, y)
  const sp = Math.hypot(vx, vy) || 1
  const ux = vx / sp
  const uy = vy / sp
  flashT(ctx, x, y, H, 0.16, 160, 200, PINK_HOT[0], PINK_HOT[1], PINK_HOT[2])
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
  flashT(ctx, x, y, H, 0.12, 120, 90, MAGENTA[0], MAGENTA[1], MAGENTA[2])
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
        flashT(ctx, e.x, e.y, H, 0.12, 100, 90, VIOLET[0], VIOLET[1], VIOLET[2])
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
