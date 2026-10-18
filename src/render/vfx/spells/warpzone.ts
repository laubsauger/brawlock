/**
 * Warpzone (column 6 Knockbackless; teal). spells.md §8.25.
 * Windup (0.2 s cast point): a teal clock marks the hand and a clock face starts
 * to draw itself at the (clamped, 700) target. Zone (static, radius 200..260 = sim radius,
 * 4.5 s): a time sphere - a clock-face floor decal whose crisp edge IS the radius (tick marks,
 * counter-rotating dashed rings, a sweeping hand), a faint dome of slow horizontal time bands
 * with refraction, motes hanging almost still. Every projectile the zone has slowed
 * (data.timeScale < 1) drags teal after-images and a ticking clock ring, so the slow is visible.
 * Spawn: rings snap inward; end: the face collapses.
 */
import * as THREE from 'three/webgpu'
import { abs, dot, float, mrt, normalView, positionGeometry, positionView, pow, saturate, sin, smoothstep, vec3, vec4 } from 'three/tsl'
import type { Node } from 'three/webgpu'
import { SPELLS, attr } from '../../../sim/spells/data'
import type { ProjectileState, SimEvent } from '../../../sim/types'
import { PROJECTILE_H, S } from '../../coords'
import { RING_EXPAND, RING_IMPLODE } from '../../scene/GroundFx'
import { registerSpellVfx, type VfxCtx } from '../registry'
import {
  InstPool, STYLE_CLOCK, TAU, burst, castFlash, drawCircle, drawShadow, floorH, glowG, kitAdopt, kitBegin, kitInit, kitRelease,
  light, originOf, pal, rand, screenAngle, tierCap, flashT, levelOfThing, tierOfLevel,
} from './kitB'

const SPELL = 'warpzone'
const DEF = SPELLS[SPELL]
const H = PROJECTILE_H
// identity: teal (vfx/palette.ts)
const TEAL = pal('warpzone', 'accent', 1.0)
const TEAL_HOT = pal('warpzone', 'core', 1.9)
const DOME_H = 0.5

interface Zone {
  seen: number
  born: number
  seed: number
}

let domes: InstPool | null = null
const zones = new Map<number, Zone>()
let frameNo = 0
const tgt = { x: 0, y: 0 }

/** Time sphere: very faint, slow bands drifting up, fresnel edge, refraction. A0.x alpha, y seed. */
function domeMaterial(ctx: VfxCtx, A: Node<'vec4'>[]): THREE.Material {
  const [A0] = A
  const t = ctx.world.uTime
  const p = positionGeometry
  const viewDir = positionView.negate().normalize()
  const ndv = saturate(abs(dot(normalView, viewDir)))
  const rim = pow(float(1).sub(ndv), 3)
  const bands = pow(saturate(sin(p.y.mul(22).sub(t.mul(0.7)).add(A0.y))), 10)
  const base = smoothstep(0.0, 0.12, p.y)
  const col = vec3(...TEAL).mul(rim.mul(0.55).add(bands.mul(0.12).mul(rim.add(0.2))))
  const m = new THREE.MeshBasicNodeMaterial()
  m.transparent = true
  m.depthWrite = false
  m.blending = THREE.AdditiveBlending
  m.colorNode = tierCap(ctx, col.mul(A0.x).mul(base), 1.6, 0.5, 0.7)
  m.opacityNode = float(1)
  if (ctx.tier.heatHaze) m.mrtNode = mrt({ heat: vec4(rim.mul(0.5).add(0.12).mul(A0.x).mul(base), 0, 0, 1) })
  m.name = 'VfxB-WarpDome'
  return m
}

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

function drawZone(p: ProjectileState, ctx: VfxCtx): void {
  let z = zones.get(p.id)
  if (!z) {
    z = { seen: 0, born: ctx.now, seed: Math.random() * 10 }
    zones.set(p.id, z)
  }
  z.seen = frameNo
  const R = p.radius
  const x = p.x
  const y = p.y
  const fh = floorH(ctx, x, y)
  const intro = Math.min(1, (ctx.now - z.born) / 0.25)
  const outro = Math.min(1, (p.ticksLeft / 60) / 0.3)
  const k = intro * outro
  drawShadow(x, y, fh - 0.3, R * 0.98, 0.32 * k, 0.5, 0.15, p.id)
  drawCircle(x, y, fh + 0.3, R, STYLE_CLOCK, TEAL[0], TEAL[1], TEAL[2], 0.95 * k, 0, 0.35, z.seed, 0.05, 1, 0, z.born)
  const tier = tierOfLevel(ctx, levelOfThing(p))
  if (tier > 0) drawCircle(x, y, fh + 0.35, R * 0.55, STYLE_CLOCK, TEAL[0], TEAL[1], TEAL[2], 0.4 * tier * k, 0, -0.7, z.seed + 5, 0, 1, 0, z.born)
  if (domes) {
    domes.quat.identity()
    const i = domes.add(x * S, (fh + 0.5) * S, -y * S, R * k * S, R * DOME_H * k * S, R * k * S)
    domes.set(i, 0, k, z.seed, 0, 0)
  }
  light(ctx, x, y, R, 0.55 * k, TEAL, 0.4)
  // motes hanging almost still (time barely moves in here)
  const ps = ctx.particles
  const n = ps.budget(ctx.dt * 24 * k)
  for (let i = 0; i < n; i++) {
    const a = Math.random() * TAU
    const rr = Math.sqrt(Math.random()) * R * 0.9
    ps.spawn(x + Math.cos(a) * rr, y + Math.sin(a) * rr, fh + rand(20, R * DOME_H * 0.9), rand(-6, 6), rand(-6, 6), rand(2, 10), rand(1.4, 2.2), rand(6, 10), 3, TEAL_HOT[0] * 0.6, TEAL_HOT[1] * 0.6, TEAL_HOT[2] * 0.6, 0, 0, 4)
  }
}

/** After-images + a ticking clock ring on every projectile the zone slowed. */
function drawSlowed(ctx: VfxCtx): void {
  const st = ctx.state
  if (!st) return
  for (const q of st.projectiles) {
    const ts = q.data.timeScale
    if (ts === undefined || ts >= 1 || q.spell === 'warpzone') continue
    let x = q.x
    let y = q.y
    if (ctx.prev) {
      for (const pq of ctx.prev.projectiles) {
        if (pq.id === q.id) {
          x = pq.x + (q.x - pq.x) * ctx.alpha
          y = pq.y + (q.y - pq.y) * ctx.alpha
          break
        }
      }
    }
    const sp = Math.hypot(q.vx, q.vy)
    const slow = 1 - ts
    if (sp > 1) {
      const ux = q.vx / sp
      const uy = q.vy / sp
      const ang = screenAngle(ctx, x, y, H, ux, uy)
      // echoes of where it "should" be: stretched ghosts strung out behind it
      for (let k = 1; k <= 4; k++) {
        const back = k * 34 * (0.5 + slow)
        glowG(x - ux * back, y - uy * back, H, 46 - k * 6, TEAL, 0.45 * (1 - k / 5) * slow, 1.6, 0, 1.8 + slow, ang)
      }
    }
    glowG(x, y, H, 90, TEAL_HOT, 0.45 * slow, 0.09, 1, 1, ctx.now * 0.5)
    glowG(x, y, H, 70, TEAL, 0.35 * slow, 0.06, 1, 1, -ctx.now * 1.3)
  }
}

registerSpellVfx({
  spell: SPELL,
  init(ctx: VfxCtx) {
    kitInit(ctx)
    const geo = new THREE.SphereGeometry(1, 48, 16, 0, TAU, 0, Math.PI / 2)
    domes = kitAdopt(new InstPool(geo, 1, 8, (A) => domeMaterial(ctx, A), 8, 'vfxB-warp-domes'))
  },
  dispose() {
    domes = null
    zones.clear()
    kitRelease()
  },
  onEvent(e: SimEvent, ctx: VfxCtx): boolean | void {
    switch (e.type) {
      case 'cast':
        if (e.spell !== SPELL) return
        castFlash(ctx, e.pawn, TEAL, 0.9)
        return true
      case 'projectileSpawn': {
        if (e.spell !== SPELL || !ctx.state) return
        const p = ctx.state.projectiles.find((q) => q.id === e.id)
        if (!p) return true
        const fh = floorH(ctx, p.x, p.y)
        ctx.ground.spawn(RING_IMPLODE, p.x, p.y, fh, p.radius * 0.3, p.radius - 2, 0.3, 10, TEAL[0], TEAL[1], TEAL[2])
        burst(ctx, p.x, p.y, fh + 60, 20, 30, 120, 0.5, 0.9, 10, 3, TEAL_HOT, 0.7, 0, 2, 6, 10, 60, p.radius * 0.8)
        flashT(ctx, p.x, p.y, fh + 60, 0.08, p.radius, p.radius, TEAL[0] * 0.5, TEAL[1] * 0.5, TEAL[2] * 0.5)
        return true
      }
      case 'projectileExpire':
      case 'projectileHit': {
        if (e.spell !== SPELL) return
        const fh = floorH(ctx, e.x, e.y)
        ctx.ground.spawn(RING_IMPLODE, e.x, e.y, fh, 20, 240, 0.3, 10, TEAL[0] * 0.8, TEAL[1] * 0.8, TEAL[2] * 0.8)
        ctx.ground.spawn(RING_EXPAND, e.x, e.y, fh, 10, 120, 0.3, 8, TEAL_HOT[0] * 0.5, TEAL_HOT[1] * 0.5, TEAL_HOT[2] * 0.5)
        return true
      }
      default:
        return
    }
  },
  frame(ctx: VfxCtx) {
    kitBegin(ctx)
    frameNo++
    for (const [id, z] of zones) if (frameNo - z.seen > 30) zones.delete(id)
    drawSlowed(ctx)
    // windup: clock rings at the hand + the face starting to draw itself at the target
    const st = ctx.state
    if (!st) return
    for (const pw of st.pawns) {
      const c = pw.cast
      if (!pw.alive || !c || c.spell !== SPELL || !c.started) continue
      const lvl = pw.levels[c.slot] || 1
      clampTarget(pw.x, pw.y, c.x, c.y, attr(DEF, 'range', lvl), tgt)
      const k = 1 - c.ticksLeft / 12
      const R = attr(DEF, 'radius', lvl)
      drawCircle(tgt.x, tgt.y, floorH(ctx, tgt.x, tgt.y) + 0.3, R, STYLE_CLOCK, TEAL[0], TEAL[1], TEAL[2], 0.5 * k, 0, 2.5, pw.id, 0, 1, 0, ctx.now - k * 0.2)
      const info = ctx.pawn(pw.id)
      if (!info) continue
      const o = originOf(info)
      drawCircle(o.x / S, -o.z / S, o.y / S + 1, 30, STYLE_CLOCK, TEAL[0], TEAL[1], TEAL[2], 0.6 + 0.7 * k, 0, 0, pw.id, 0, 1.2, 0, ctx.now - 1)
      glowG(o.x / S, -o.z / S, o.y / S, 25, TEAL, 0.3 + 0.3 * k, 2.2)
    }
  },
  drawProjectile(p: ProjectileState, _x: number, _y: number, ctx: VfxCtx) {
    drawZone(p, ctx)
  },
})
