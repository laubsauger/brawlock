/**
 * Magnetize (column 6 Knockbackless; steel blue). spells.md §8.26.
 * Windup (0.2 s cast point): small dipole field lines arc out of the casting hand.
 * Bolt (sim r36, 800 u/s): a steel-blue core with two pole sparks orbiting it and field-line
 * flickers. On a warlock (`magnetize`, 3.5..6.5 s): a dipole field of curved lines rises around
 * it; energy dashes FLOW INTO the warlock when it attracts (enemy target: your projectiles bend
 * in) and OUT of it when it repels (self / ally: enemy projectiles bend away). The floor shows
 * the 300 field radius as a crisp ring with ripples running the same way, and every bent
 * projectile inside is tied to the warlock by a thin flickering field line.
 */
import * as THREE from 'three/webgpu'
import { float, fract, mix, pow, smoothstep, uv, vec3 } from 'three/tsl'
import type { Node } from 'three/webgpu'
import type { ModifierState, PawnState, ProjectileState, SimEvent } from '../../../sim/types'
import { isEnemy } from '../../../sim/teams'
import { PROJECTILE_H, S } from '../../coords'
import { RING_EXPAND } from '../../scene/GroundFx'
import { registerSpellVfx, type VfxCtx } from '../registry'
import {
  InstPool, STYLE_RING, STYLE_RIPPLES, TAU, burst, castFlash, drawCircle, drawCore, floorH, glowG, hexRgb, kitAdopt, kitBegin,
  kitInit, kitRelease, light, mixRgb, originOf, pal, palMix, projShadow, rand, screenAngle,
} from './kitB'

const SPELL = 'magnetize'
const H = PROJECTILE_H
// identity: steel blue (vfx/palette.ts); repel reads paler
const STEEL = pal('magnetize', 'accent', 0.9)
const STEEL_HOT = pal('magnetize', 'core', 2.0)
const STEEL_PALE = palMix('magnetize', 0.7, 1.5)
const N_LINES = 8

interface Field {
  seen: number
  since: number
}

let lines: InstPool | null = null
const fields = new Map<number, Field>()
let frameNo = 0
const team: [number, number, number] = [1, 1, 1]
const edge: [number, number, number] = [1, 1, 1]
const Y = new THREE.Vector3(0, 1, 0)

/** One dipole field line in the x/y plane: r = sin^2(theta), from the top round to below the waist. */
function lineGeometry(): THREE.BufferGeometry {
  const pts: THREE.Vector3[] = []
  for (let i = 0; i <= 32; i++) {
    const th = 0.28 + (i / 32) * 1.75
    const r = Math.sin(th) * Math.sin(th)
    pts.push(new THREE.Vector3(r * Math.sin(th), r * Math.cos(th), 0))
  }
  const curve = new THREE.CatmullRomCurve3(pts)
  return new THREE.TubeGeometry(curve, 48, 0.018, 5, false)
}

/** Flowing dashes along the line (uv.x runs top -> bottom). A0: x alpha, y flow sign, z phase. */
function lineMaterial(ctx: VfxCtx, A: Node<'vec4'>[]): THREE.Material {
  const [A0] = A
  const t = ctx.world.uTime
  const u = uv().x
  const flow = fract(u.mul(6).add(t.mul(1.6).mul(A0.y)).add(A0.z))
  const dash = smoothstep(0.0, 0.15, flow).mul(smoothstep(0.55, 0.3, flow))
  const ends = smoothstep(0.0, 0.12, u).mul(smoothstep(1.0, 0.8, u))
  const col = mix(vec3(...STEEL).mul(0.35), vec3(...STEEL_HOT), pow(dash, 2)).mul(ends)
  const m = new THREE.MeshBasicNodeMaterial()
  m.transparent = true
  m.depthWrite = false
  m.blending = THREE.AdditiveBlending
  m.colorNode = col.mul(A0.x)
  m.opacityNode = float(1)
  m.name = 'VfxB-MagnetLines'
  return m
}

function drawBolt(p: ProjectileState, x: number, y: number, ctx: VfxCtx): void {
  const r = p.radius
  const sp = Math.hypot(p.vx, p.vy) || 1
  const ux = p.vx / sp
  const uy = p.vy / sp
  hexRgb(ctx.colorOf(p.owner), team)
  mixRgb(STEEL, team, 0.3, edge)
  drawCore(x, y, H, r * 0.75, edge, STEEL_HOT, p.id % 7)
  const ang = screenAngle(ctx, x, y, H, ux, uy)
  glowG(x, y, H, r * 4, STEEL, 0.3, 1.6)
  glowG(x - ux * r * 1.4, y - uy * r * 1.4, H, r * 1.8, STEEL, 0.6, 1.6, 0, 3, ang, 0.2)
  // two poles orbiting the core
  for (let k = 0; k < 2; k++) {
    const a = ctx.now * 14 + k * Math.PI
    glowG(x + Math.cos(a) * r * 1.1, y + Math.sin(a) * r * 1.1, H + Math.sin(a * 0.7) * 12, r * 0.9, k ? STEEL_PALE : STEEL_HOT, 0.8, 2.5)
  }
  // field arc flicker
  glowG(x, y, H, r * 2.8, STEEL_PALE, 0.35 + 0.25 * Math.sin(ctx.now * 40), 0.08, 1, 1, ctx.now * 9)
  light(ctx, x, y, 180, 0.7, STEEL, 0.45)
  projShadow(ctx, x, y, H, r * 0.7)
  const ps = ctx.particles
  const n = ps.budget(ctx.dt * 90)
  for (let i = 0; i < n; i++) {
    ps.spawn(x - ux * rand(0, 40), y - uy * rand(0, 40), H + rand(-8, 8), -ux * 60 + rand(-50, 50), -uy * 60 + rand(-50, 50), rand(-20, 40), rand(0.2, 0.35), rand(8, 13), 2, STEEL_PALE[0], STEEL_PALE[1], STEEL_PALE[2], 0, 3, -0.05)
  }
}

registerSpellVfx({
  spell: SPELL,
  modifiers: [SPELL],
  init(ctx: VfxCtx) {
    kitInit(ctx)
    lines = kitAdopt(new InstPool(lineGeometry(), 1, 12 * N_LINES, (A) => lineMaterial(ctx, A), 7, 'vfxB-magnet-lines'))
  },
  dispose() {
    lines = null
    fields.clear()
    kitRelease()
  },
  onEvent(e: SimEvent, ctx: VfxCtx): boolean | void {
    switch (e.type) {
      case 'cast':
        if (e.spell !== SPELL) return
        castFlash(ctx, e.pawn, STEEL_PALE, 0.9)
        return true
      case 'projectileHit':
      case 'projectileExpire': {
        if (e.spell !== SPELL) return
        burst(ctx, e.x, e.y, H, e.type === 'projectileHit' ? 22 : 10, 150, 450, 0.2, 0.4, 9, 2, STEEL_PALE, 1, -500, 3, -0.08, 0, 160)
        ctx.ground.spawn(RING_EXPAND, e.x, e.y, floorH(ctx, e.x, e.y), 10, 80, 0.25, 6, STEEL[0], STEEL[1], STEEL[2])
        ctx.flash(e.x, e.y, H, 0.08, 120, 100, STEEL[0], STEEL[1], STEEL[2])
        return true
      }
      case 'projectileBounce':
        if (e.spell !== SPELL) return
        burst(ctx, e.x, e.y, H, 12, 150, 380, 0.15, 0.3, 8, 2, STEEL_HOT, 0.8, -500, 3, -0.08, 0, 140)
        return true
      default:
        return
    }
  },
  frame(ctx: VfxCtx) {
    kitBegin(ctx)
    frameNo++
    for (const [id, f] of fields) if (frameNo - f.seen > 2) fields.delete(id)
    const st = ctx.state
    if (!st) return
    // windup: little dipole arcs blooming out of the hand
    for (const pw of st.pawns) {
      const c = pw.cast
      if (!pw.alive || !c || c.spell !== SPELL || !c.started || !lines) continue
      const info = ctx.pawn(pw.id)
      if (!info) continue
      const o = originOf(info)
      const k = 1 - c.ticksLeft / 12
      for (let i = 0; i < 4; i++) {
        lines.quat.setFromAxisAngle(Y, (i / 4) * TAU + ctx.now * 2)
        const L = (16 + 22 * k) * S
        const idx = lines.add(o.x, o.y, o.z, L, L, L)
        lines.set(idx, 0, 1.2, 1, i * 0.25, 0)
      }
      glowG(o.x / S, -o.z / S, o.y / S, 40 + 40 * k, STEEL_HOT, 0.4 + 0.4 * k, 2.2)
    }
  },
  drawProjectile(p: ProjectileState, x: number, y: number, ctx: VfxCtx) {
    drawBolt(p, x, y, ctx)
  },
  drawModifier(pawn: PawnState, mod: ModifierState, x: number, y: number, ctx: VfxCtx) {
    let f = fields.get(pawn.id)
    if (!f) {
      f = { seen: frameNo, since: ctx.now }
      fields.set(pawn.id, f)
    }
    if (frameNo - f.seen > 2) f.since = ctx.now
    f.seen = frameNo
    const sign = mod.data.sign ?? 1
    const R = mod.data.radius || 300
    const info = ctx.pawn(pawn.id)
    const fh = info ? info.h : 30
    const intro = Math.min(1, (ctx.now - f.since) / 0.3)
    const fade = mod.ticksLeft < 0 ? 1 : Math.min(1, mod.ticksLeft / 15)
    const k = intro * fade
    const col = sign > 0 ? STEEL : STEEL_PALE
    if (lines) {
      for (let i = 0; i < N_LINES; i++) {
        lines.quat.setFromAxisAngle(Y, (i / N_LINES) * TAU + ctx.now * 0.4 * sign)
        const L = (95 + (i % 3) * 22) * k
        const idx = lines.add(x * S, (fh + 80) * S, -y * S, L * S, L * S, L * S)
        // dashes run bottom -> top -> into the body for attract (flow -1 along uv), outward for repel
        lines.set(idx, 0, 1.1 * k, -sign, i * 0.37, 0)
      }
    }
    drawCircle(x, y, fh + 1.2, R, STYLE_RING, col[0], col[1], col[2], 0.5 * k, 0, 0, pawn.id, 0, 0.6, 0, f.since)
    drawCircle(x, y, fh + 1.1, R, STYLE_RIPPLES, col[0] * 0.6, col[1] * 0.6, col[2] * 0.6, 0.6 * k, 0, 6 * sign, pawn.id, 0, 0.6, 0, f.since)
    glowG(x, y, fh + 80, 150, col, 0.25 * k, 1.8)
    light(ctx, x, y, 200, 0.5 * k, col, 0.4)
    // tie every bent projectile to the warlock with a flickering field line
    const st = ctx.state
    if (!st) return
    const r2 = R * R
    for (const q of st.projectiles) {
      if (q.spell === 'meteor' || q.spell === 'warpzone' || !isEnemy(st, q.owner, pawn.owner)) continue
      const dx = x - q.x
      const dy = y - q.y
      const d2 = dx * dx + dy * dy
      if (d2 > r2 || d2 < 1) continue
      const d = Math.sqrt(d2)
      const s = 1 - d2 / r2
      const ang = screenAngle(ctx, q.x, q.y, H, dx / d, dy / d)
      const n = Math.min(5, Math.ceil(d / 60))
      for (let j = 1; j <= n; j++) {
        const u = j / (n + 1)
        glowG(q.x + dx * u, q.y + dy * u, H + Math.sin(u * Math.PI) * 25, 30, col, (0.25 + 0.35 * s) * (0.6 + 0.4 * Math.sin(ctx.now * 30 + j)), 2, 0, 2.4, ang)
      }
    }
  },
})
