/**
 * Windwalk (column 4 Devastator; pale violet wraith smoke). spells.md §8.16.
 * Cast (IMMEDIATE): the warlock bursts into violet smoke and is gone. While the `windwalk`
 * modifier runs:
 *  - owner, allies, spectators: a wraith look - violet smoke wisps streaming off the body,
 *    fading after-images along the path, a cold ring at the feet, speed streaks;
 *  - enemies: the pawn is hidden; on heat-haze tiers only a faint air distortion moves where
 *    it walks (no colour at all).
 * The charge hit ('spellHit' windwalk) cracks a violet shockwave along the hit direction and
 * the walker re-forms in a smoke burst; any other end of the modifier also re-forms it.
 *
 * Hiding: render has no per-pawn visibility hook yet, so the module hides the PawnView root
 * (found by its position in ctx.scene) for the frames the modifier runs, restoring it each frame.
 */
import type * as THREE from 'three/webgpu'
import type { ModifierState, PawnState, SimEvent } from '../../../sim/types'
import { isEnemy } from '../../../sim/teams'
import { S } from '../../coords'
import { RING_EXPAND, RING_IMPLODE } from '../../scene/GroundFx'
import { registerSpellVfx, type VfxCtx } from '../registry'
import { TAU, burst, floorH, glowG, kitBegin, kitInit, kitRelease, light, rand, screenAngle, type RGB } from './kitB'

const SPELL = 'windwalk'
const WRAITH: RGB = [1.05, 0.55, 2.3]
const WRAITH_DEEP: RGB = [0.35, 0.12, 0.8]
const SMOKE_V = [0.09, 0.05, 0.16] as const
const TRAIL_N = 8
const TRAIL_DT = 0.05

interface Walker {
  seen: number
  since: number
  root: THREE.Object3D | null
  tx: Float32Array
  ty: Float32Array
  tt: Float32Array
  head: number
  lastSample: number
}

const walkers = new Map<number, Walker>()
const hidden: THREE.Object3D[] = []
let frameNo = 0

/** The PawnView root group at (x, y) (render sets root.position = (x S, h S, -y S)). */
function findRoot(ctx: VfxCtx, x: number, y: number): THREE.Object3D | null {
  const wx = x * S
  const wz = -y * S
  let best: THREE.Object3D | null = null
  let bd = 0.02
  for (const o of ctx.scene.children) {
    if (o.type !== 'Group' || o.name !== '') continue
    const d = Math.abs(o.position.x - wx) + Math.abs(o.position.z - wz)
    if (d < bd) {
      bd = d
      best = o
    }
  }
  return best
}

function walker(id: number, now: number): Walker {
  let w = walkers.get(id)
  if (!w) {
    w = { seen: 0, since: now, root: null, tx: new Float32Array(TRAIL_N), ty: new Float32Array(TRAIL_N), tt: new Float32Array(TRAIL_N).fill(-10), head: 0, lastSample: -10 }
    walkers.set(id, w)
  }
  return w
}

function smokeBurst(ctx: VfxCtx, x: number, y: number, h: number, big: number): void {
  const fh = floorH(ctx, x, y)
  const sm = ctx.smoke
  const n = sm.budget(14 * big)
  for (let i = 0; i < n; i++) {
    const a = Math.random() * TAU
    const sp = rand(60, 200) * big
    sm.spawn(x + Math.cos(a) * 20, y + Math.sin(a) * 20, h + rand(-40, 60), Math.cos(a) * sp, Math.sin(a) * sp, rand(40, 160), rand(0.7, 1.2), 50, 150 * big, SMOKE_V[0], SMOKE_V[1], SMOKE_V[2], 0, 2, 10)
  }
  burst(ctx, x, y, h, 18 * big, 80, 300, 0.35, 0.7, 30, 6, WRAITH, 0.8, 0, 2.5, 30, 20, 160, 20)
  ctx.ground.spawn(RING_IMPLODE, x, y, fh, 20, 110, 0.3, 10, WRAITH[0], WRAITH[1], WRAITH[2])
  ctx.flash(x, y, h, 0.18, 160, 160, WRAITH[0], WRAITH[1], WRAITH[2])
}

function viewerIsEnemy(ctx: VfxCtx, owner: number): boolean {
  const st = ctx.state
  const lp = ctx.localPlayer
  if (!st || lp < 0) return false
  return isEnemy(st, lp, owner)
}

registerSpellVfx({
  spell: SPELL,
  modifiers: [SPELL],
  init(ctx: VfxCtx) {
    kitInit(ctx)
  },
  dispose() {
    for (const r of hidden) r.visible = true
    hidden.length = 0
    walkers.clear()
    kitRelease()
  },
  onEvent(e: SimEvent, ctx: VfxCtx): boolean | void {
    switch (e.type) {
      case 'cast':
        return e.spell === SPELL ? true : undefined
      case 'modifier': {
        if (e.id !== SPELL) return
        const info = ctx.pawn(e.pawn)
        if (!info) return
        if (e.on) walker(e.pawn, ctx.now).since = ctx.now
        smokeBurst(ctx, info.x, info.y, info.h + 70, e.on ? 1.2 : 0.9)
        return
      }
      case 'spellHit': {
        if (e.spell !== SPELL) return
        const att = ctx.pawn(e.pawn)
        const vic = ctx.pawn(e.target)
        let dx = 1
        let dy = 0
        if (att && vic) {
          dx = vic.x - att.x
          dy = vic.y - att.y
          const l = Math.hypot(dx, dy) || 1
          dx /= l
          dy /= l
        }
        const h = (vic ? vic.h : 30) + 70
        const fh = floorH(ctx, e.x, e.y)
        // violet shockwave cracking along the charge direction
        ctx.ground.spawn(RING_EXPAND, e.x, e.y, fh, 10, 150, 0.32, 14, WRAITH[0], WRAITH[1], WRAITH[2])
        ctx.flash(e.x, e.y, h, 0.16, 200, 200, 2.2, 1.5, 3.0)
        const ps = ctx.particles
        const n = ps.budget(36)
        const base = Math.atan2(dy, dx)
        for (let i = 0; i < n; i++) {
          const a = base + rand(-0.6, 0.6)
          const sp = rand(400, 1100)
          ps.spawn(e.x, e.y, h, Math.cos(a) * sp, Math.sin(a) * sp, rand(-40, 200), rand(0.2, 0.4), 9, 2, WRAITH[0] * 1.3, WRAITH[1] * 1.3, WRAITH[2] * 1.3, -900, 3, -0.1)
        }
        burst(ctx, e.x, e.y, h, 14, 100, 260, 0.4, 0.7, 40, 8, WRAITH_DEEP, 1.4, 0, 2.5, 20, 0, 100)
        ctx.shakeNear(e.x, e.y, 0.2)
        return
      }
      default:
        return
    }
  },
  frame(ctx: VfxCtx) {
    kitBegin(ctx)
    frameNo++
    // re-show everything; drawModifier hides again what is still windwalking
    for (const r of hidden) r.visible = true
    hidden.length = 0
    for (const [id, w] of walkers) if (frameNo - w.seen > 2) walkers.delete(id)
  },
  drawModifier(pawn: PawnState, _mod: ModifierState, x: number, y: number, ctx: VfxCtx) {
    const w = walker(pawn.id, ctx.now)
    if (frameNo - w.seen > 2) w.since = ctx.now
    w.seen = frameNo
    const info = ctx.pawn(pawn.id)
    const fh = info ? info.h : 30
    const enemyView = viewerIsEnemy(ctx, pawn.owner)
    const fadeIn = Math.min(1, (ctx.now - w.since) / 0.2)
    if (enemyView) {
      if (!w.root || Math.abs(w.root.position.x - x * S) + Math.abs(w.root.position.z + y * S) > 0.05) w.root = findRoot(ctx, x, y)
      if (w.root) {
        w.root.visible = false
        hidden.push(w.root)
      }
      // only a faint bend in the air where the walker moves (heat-haze tiers), no colour
      const sp = Math.hypot(pawn.vx, pawn.vy)
      if (ctx.tier.heatHaze && sp > 40) glowG(x, y, fh + 70, 150, WRAITH, 0, 1.2, 3, 1.6, Math.PI / 2, 0.55 * Math.min(1, sp / 400))
      return
    }
    // --- wraith look for the owner / allies
    const t = ctx.now
    // after-images along the path
    if (t - w.lastSample > TRAIL_DT) {
      w.lastSample = t
      w.head = (w.head + 1) % TRAIL_N
      w.tx[w.head] = x
      w.ty[w.head] = y
      w.tt[w.head] = t
    }
    for (let k = 0; k < TRAIL_N; k++) {
      const age = t - w.tt[k]
      if (age > TRAIL_N * TRAIL_DT || age <= 0.0) continue
      const f = 1 - age / (TRAIL_N * TRAIL_DT)
      glowG(w.tx[k], w.ty[k], fh + 75, 120, WRAITH, 0.32 * f * f * fadeIn, 1.4, 3, 0.7, 0, 0.3)
    }
    // smoke shroud and cold rim around the body
    glowG(x, y, fh + 80, 170, WRAITH_DEEP, 1.2 * fadeIn, 1, 3, 0.75, 0, 0.6)
    glowG(x, y, fh + 70, 140, WRAITH, 0.3 * fadeIn, 1.8, 0, 0.8)
    glowG(x, y, fh + 3, 110, WRAITH, 0.25 * fadeIn, 0.06, 1)
    light(ctx, x, y, 160, 0.5 * fadeIn, WRAITH, 0.4)
    const sp = Math.hypot(pawn.vx, pawn.vy)
    const ps = ctx.particles
    const n = ps.budget(ctx.dt * 60)
    for (let i = 0; i < n; i++) {
      const a = Math.random() * TAU
      const rr = rand(10, 34)
      ps.spawn(x + Math.cos(a) * rr, y + Math.sin(a) * rr, fh + rand(10, 140), -pawn.vx * 0.3 + rand(-20, 20), -pawn.vy * 0.3 + rand(-20, 20), rand(30, 90), rand(0.4, 0.7), rand(16, 28), 4, WRAITH[0] * 0.7, WRAITH[1] * 0.7, WRAITH[2] * 0.7, 0, 1.5, 12)
    }
    if (sp > 200) {
      // speed streaks
      const ux = pawn.vx / sp
      const uy = pawn.vy / sp
      const ang = screenAngle(ctx, x, y, fh + 70, ux, uy)
      for (let k = -1; k <= 1; k += 2) {
        glowG(x - ux * 70 - uy * k * 26, y - uy * 70 + ux * k * 26, fh + 60 + k * 15, 40, WRAITH, 0.45, 2, 0, 4, ang)
      }
    }
  },
})
