/**
 * Grip (column 6 Knockbackless; toxic green). spells.md §8.24.
 * Windup (0.2 s cast point): spectral talons curl closed around the casting hand while
 * ectoplasm motes are drawn in. Bolt (sim r39, 1000 u/s): a toxic-green core trailing
 * ectoplasm wisps, with three talon flares raking forward. On a warlock (`grip` root, 4.5..6 s):
 * spectral claws burst out of a bubbling ectoplasm pool and close over the victim, holding it;
 * each spell the gripped warlock casts (+5 DP) makes the claws clench and flash. Release: the
 * claws sink back into the pool in a green splash. Miss: an ectoplasm splat.
 */
import * as THREE from 'three/webgpu'
import { dot, float, mix, normalView, positionGeometry, positionView, pow, saturate, smoothstep, texture, vec2, vec3 } from 'three/tsl'
import type { Node } from 'three/webgpu'
import type { ModifierState, PawnState, ProjectileState, SimEvent } from '../../../sim/types'
import { PROJECTILE_H, S } from '../../coords'
import { RING_EXPAND } from '../../scene/GroundFx'
import { registerSpellVfx, type VfxCtx } from '../registry'
import {
  InstPool, STYLE_RIPPLES, TAU, burst, castFlash, drawCircle, drawCore, floorH, glowG, hexRgb, implode, kitAdopt, kitBegin,
  kitInit, kitRelease, light, mixRgb, originOf, pal, palMix, projShadow, rand, screenAngle,
} from './kitB'

const SPELL = 'grip'
const H = PROJECTILE_H
// identity: toxic green (vfx/palette.ts)
const TOXIC = pal('grip', 'accent', 1.1)
const TOXIC_HOT = pal('grip', 'core', 2.0)
const TOXIC_DIM = palMix('grip', 0.0, 0.25)
const N_CLAW = 5

interface Hold {
  seen: number
  since: number
  clenchAt: number
  x: number
  y: number
  h: number
}

let claws: InstPool | null = null
const holds = new Map<number, Hold>()
const releases: { x: number; y: number; h: number; born: number; seed: number }[] = []
let frameNo = 0
const team: [number, number, number] = [1, 1, 1]
const edge: [number, number, number] = [1, 1, 1]
const Y = new THREE.Vector3(0, 1, 0)
const tang = new THREE.Vector3()
const q1 = new THREE.Quaternion()
const q2 = new THREE.Quaternion()

/** A tapered, hooked talon: base at the origin, rising to y = 1, curling toward -x. */
function clawGeometry(): THREE.BufferGeometry {
  const curve = new THREE.CubicBezierCurve3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0.12, 0.45, 0), new THREE.Vector3(0.05, 0.95, 0), new THREE.Vector3(-0.38, 1.05, 0))
  const TS = 20
  const RS = 7
  const g = new THREE.TubeGeometry(curve, TS, 1, RS, false)
  const pos = g.getAttribute('position') as THREE.BufferAttribute
  const c = new THREE.Vector3()
  for (let i = 0; i <= TS; i++) {
    const t = i / TS
    curve.getPoint(t, c)
    const r = 0.11 * Math.pow(1 - t, 0.85) + 0.004
    for (let j = 0; j <= RS; j++) {
      const k = i * (RS + 1) + j
      pos.setXYZ(k, c.x + (pos.getX(k) - c.x) * r, c.y + (pos.getY(k) - c.y) * r, c.z + (pos.getZ(k) - c.z) * r)
    }
  }
  g.computeVertexNormals()
  return g
}

/** Spectral claw: dark translucent body, toxic fresnel rim, veins pulsing upward, soft base. A0.x clench flash. */
function clawMaterial(ctx: VfxCtx, A: Node<'vec4'>[]): THREE.Material {
  const [A0] = A
  const t = ctx.world.uTime
  const p = positionGeometry
  const viewDir = positionView.negate().normalize()
  const ndv = saturate(dot(normalView, viewDir))
  const rim = pow(float(1).sub(ndv), 2)
  const veins = texture(ctx.world.noise, vec2(p.x.mul(2).add(p.z.mul(1.3)), p.y.mul(1.5).sub(t.mul(0.8)))).b
  const vein = smoothstep(0.1, 0.0, veins)
  const body = mix(vec3(0.01, 0.04, 0.015), vec3(...TOXIC).mul(0.25), p.y)
  const col = body.add(vec3(...TOXIC).mul(rim.mul(1.2))).add(vec3(...TOXIC_HOT).mul(vein.mul(0.5).add(A0.x.mul(0.8)).mul(rim.add(0.3))))
  const m = new THREE.MeshBasicNodeMaterial()
  m.transparent = true
  m.depthWrite = false
  m.colorNode = col
  // fade into the ectoplasm at the base: no hard cut against the floor
  m.opacityNode = smoothstep(0.0, 0.18, p.y).mul(rim.mul(0.4).add(0.6))
  m.name = 'VfxB-GripClaw'
  return m
}

function splash(ctx: VfxCtx, x: number, y: number, h: number, n: number): void {
  burst(ctx, x, y, h, n, 120, 420, 0.3, 0.55, 16, 3, TOXIC, 0.9, -900, 2, 0, 80, 260)
  burst(ctx, x, y, h, n * 0.5, 40, 140, 0.5, 0.8, 34, 8, TOXIC_DIM, 1.2, 0, 2.5, 18, 20, 80)
  ctx.ground.spawn(RING_EXPAND, x, y, floorH(ctx, x, y), 10, 90, 0.3, 8, TOXIC[0] * 0.7, TOXIC[1] * 0.7, TOXIC[2] * 0.7)
}

function drawBolt(p: ProjectileState, x: number, y: number, ctx: VfxCtx): void {
  const r = p.radius
  const sp = Math.hypot(p.vx, p.vy) || 1
  const ux = p.vx / sp
  const uy = p.vy / sp
  hexRgb(ctx.colorOf(p.owner), team)
  mixRgb(TOXIC, team, 0.3, edge)
  drawCore(x, y, H, r * 0.9, edge, TOXIC_HOT, p.id % 7)
  const ang = screenAngle(ctx, x, y, H, ux, uy)
  glowG(x, y, H, r * 4, TOXIC_DIM, 1.2, 1.4, 3, 1, ctx.now + p.id)
  glowG(x - ux * r * 1.5, y - uy * r * 1.5, H, r * 1.8, TOXIC, 0.6, 1.6, 0, 3.2, ang, 0.3)
  // talons raking forward
  const px = -uy
  const py = ux
  for (let k = -1; k <= 1; k++) {
    const fl = 0.7 + 0.3 * Math.sin(ctx.now * 30 + k * 2)
    glowG(x + ux * r * 0.9 + px * k * r * 0.55, y + uy * r * 0.9 + py * k * r * 0.55, H + 4, r * 1.1, TOXIC_HOT, 0.4 * fl, 2.5, 0, 2.2, ang + k * 0.35)
  }
  light(ctx, x, y, 200, 0.8, TOXIC, 0.4)
  projShadow(ctx, x, y, H, r * 0.7)
  // ectoplasm trail: lazy wisps that sag
  const ps = ctx.particles
  const n = ps.budget(ctx.dt * 160)
  for (let i = 0; i < n; i++) {
    ps.spawn(x - ux * rand(0, 60) + rand(-10, 10), y - uy * rand(0, 60) + rand(-10, 10), H + rand(-8, 8), -ux * 80 + rand(-30, 30), -uy * 80 + rand(-30, 30), rand(-60, 10), rand(0.3, 0.55), rand(18, 30), 4, TOXIC[0] * 0.7, TOXIC[1] * 0.7, TOXIC[2] * 0.7, -200, 2.5, 8)
  }
}

registerSpellVfx({
  spell: SPELL,
  modifiers: [SPELL],
  init(ctx: VfxCtx) {
    kitInit(ctx)
    claws = kitAdopt(new InstPool(clawGeometry(), 1, 12 * N_CLAW, (A) => clawMaterial(ctx, A), 8, 'vfxB-grip-claws'))
  },
  dispose() {
    claws = null
    holds.clear()
    releases.length = 0
    kitRelease()
  },
  onEvent(e: SimEvent, ctx: VfxCtx): boolean | void {
    switch (e.type) {
      case 'cast': {
        // a gripped warlock casting: the claws clench (+5 DP)
        const hold = holds.get(e.pawn)
        if (hold) hold.clenchAt = ctx.now
        if (e.spell !== SPELL) return
        castFlash(ctx, e.pawn, TOXIC, 0.9)
        return true
      }
      case 'castStart': {
        if (e.spell !== SPELL) return
        const info = ctx.pawn(e.pawn)
        if (info) {
          const o = originOf(info)
          implode(ctx, o.x / S, -o.z / S, o.y / S, 20, 80, 150, 0.2, 10, TOXIC, 1, 60)
        }
        return
      }
      case 'projectileHit':
      case 'projectileExpire':
        if (e.spell !== SPELL) return
        splash(ctx, e.x, e.y, H, e.type === 'projectileHit' ? 26 : 14)
        return true
      case 'modifier': {
        if (e.id !== SPELL || e.on) return
        const hold = holds.get(e.pawn)
        if (hold) {
          if (releases.length >= 8) releases.shift()
          releases.push({ x: hold.x, y: hold.y, h: hold.h, born: ctx.now, seed: e.pawn })
          splash(ctx, hold.x, hold.y, hold.h + 20, 20)
        }
        return
      }
      default:
        return
    }
  },
  frame(ctx: VfxCtx) {
    kitBegin(ctx)
    frameNo++
    for (const [id, h] of holds) if (frameNo - h.seen > 2) holds.delete(id)
    // windup flavour: spectral talons curl closed around the hand
    const st = ctx.state
    if (st) {
      for (const pw of st.pawns) {
        const c = pw.cast
        if (!pw.alive || !c || c.spell !== SPELL || !c.started) continue
        const info = ctx.pawn(pw.id)
        if (!info) continue
        const o = originOf(info)
        const k = 1 - c.ticksLeft / 12
        for (let i = 0; i < 4; i++) {
          const a = (i / 4) * TAU + ctx.now * 3
          const rr = 34 * (1 - 0.6 * k)
          glowG(o.x / S + Math.cos(a) * rr, -o.z / S + Math.sin(a) * rr, o.y / S + 8, 26, TOXIC, 0.5 + 0.5 * k, 2.4, 0, 2.2, a + Math.PI / 2)
        }
        glowG(o.x / S, -o.z / S, o.y / S, 50 + 50 * k, TOXIC_HOT, 0.3 + 0.4 * k, 2.2)
      }
    }
    // released claws sinking back into the pool
    for (let i = releases.length - 1; i >= 0; i--) {
      const r = releases[i]
      const u = (ctx.now - r.born) / 0.4
      if (u >= 1) {
        releases.splice(i, 1)
        continue
      }
      drawClaws(r.x, r.y, r.h, (1 - u) * (1 - u), 0, r.seed, ctx.now)
    }
  },
  drawProjectile(p: ProjectileState, x: number, y: number, ctx: VfxCtx) {
    drawBolt(p, x, y, ctx)
  },
  drawModifier(pawn: PawnState, _mod: ModifierState, x: number, y: number, ctx: VfxCtx) {
    let hold = holds.get(pawn.id)
    if (!hold) {
      hold = { seen: frameNo, since: ctx.now, clenchAt: -10, x, y, h: 30 }
      holds.set(pawn.id, hold)
    }
    if (frameNo - hold.seen > 2) hold.since = ctx.now
    hold.seen = frameNo
    const info = ctx.pawn(pawn.id)
    const fh = info ? info.h : 30
    hold.x = x
    hold.y = y
    hold.h = fh
    const age = ctx.now - hold.since
    const rise = Math.min(1, age / 0.22)
    const grow = 1 - Math.pow(1 - rise, 3)
    const clench = Math.max(0, 1 - (ctx.now - hold.clenchAt) / 0.35)
    drawClaws(x, y, fh, grow, clench, pawn.id, ctx.now)
    // bubbling ectoplasm pool and rising wisps
    drawCircle(x, y, fh + 1.3, 85, STYLE_RIPPLES, TOXIC[0] * 0.6, TOXIC[1] * 0.6, TOXIC[2] * 0.6, 0.9 * grow, 0, 5, pawn.id, 0.35, 1, 0, hold.since)
    glowG(x, y, fh + 20, 170, TOXIC_DIM, 1.0 * grow, 1, 3, 1, ctx.now * 0.5 + pawn.id)
    glowG(x, y, fh + 70, 120, TOXIC, 0.15 + 0.4 * clench, 1.8)
    light(ctx, x, y, 180, (0.6 + 0.8 * clench) * grow, TOXIC, 0.45)
    const ps = ctx.particles
    const n = ps.budget(ctx.dt * 50)
    for (let i = 0; i < n; i++) {
      const a = Math.random() * TAU
      const rr = rand(20, 70)
      ps.spawn(x + Math.cos(a) * rr, y + Math.sin(a) * rr, fh + 5, 0, 0, rand(60, 160), rand(0.5, 0.9), rand(10, 18), 3, TOXIC[0] * 0.8, TOXIC[1] * 0.8, TOXIC[2] * 0.8, 30, 1, 10)
    }
  },
})

/** Five talons around (x, y): grow 0..1 rise, clench 0..1 extra curl + flash. */
function drawClaws(x: number, y: number, fh: number, grow: number, clench: number, seed: number, now: number): void {
  if (!claws || grow <= 0.01) return
  for (let i = 0; i < N_CLAW; i++) {
    const a = (i / N_CLAW) * TAU + seed * 1.3
    const rr = 44 + (i % 2) * 8
    const L = (120 + ((i * 37) % 3) * 18) * grow
    const sway = Math.sin(now * 3 + i * 1.7) * 0.06
    // yaw: local +x points outward, so the hook curls toward the victim
    q1.setFromAxisAngle(Y, a)
    // lean in over the victim (about the claw's tangent axis)
    tang.set(Math.sin(a), 0, Math.cos(a))
    q2.setFromAxisAngle(tang, 0.12 + 0.25 * clench + sway)
    claws.quat.copy(q2).multiply(q1)
    const idx = claws.add((x + Math.cos(a) * rr) * S, (fh - 4) * S, -(y + Math.sin(a) * rr) * S, L * S, L * S, L * S)
    claws.set(idx, 0, clench, 0, 0, 0)
  }
}
