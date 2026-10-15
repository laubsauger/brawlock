/**
 * Meteor (column 4 Devastator, violet-magenta). spells.md §8.17.
 * Arc: the hand gathers violet fire through the 0.2 s cast point while a rune circle burns
 * onto the floor at the (clamped) target -> cast flash and a skyward bolt -> a rift tears
 * open at z 700 and a basalt rock wreathed in magenta fire hovers 0.55 s -> it dives 0.6 s
 * with a comet tail while its shadow darkens the impact zone and the closing ring counts
 * down -> impact at the stored target (sim radius 225..304): flash, shockwave rings, molten
 * spray, rock debris, smoke ring and mushroom, scorch, cracked crater that cools for 2.5 s,
 * camera shake scaled by the radius. The circle shows the real AoE radius the whole time.
 */
import * as THREE from 'three/webgpu'
import { dot, float, mix, normalView, normalWorld, positionGeometry, positionView, pow, saturate, smoothstep, texture, vec2, vec3 } from 'three/tsl'
import type { Node } from 'three/webgpu'
import { SPELLS, attr } from '../../../sim/spells/data'
import type { ProjectileState, SimEvent } from '../../../sim/types'
import { PROJECTILE_H, S, TILE_TOP_H } from '../../coords'
import { RING_EXPAND, RING_IMPLODE } from '../../scene/GroundFx'
import { registerSpellVfx, type VfxCtx } from '../registry'
import {
  InstPool, STYLE_CRACKS, STYLE_RING, STYLE_RUNES, TAU, burst, castFlash, drawCircle,
  drawShadow, floorH, glowG, hexRgb, implode, kitAdopt, kitBegin, kitInit, kitRelease, light, originOf, projShadow, rand, screenAngle,
  type RGB,
  pal, palMix,
} from './kitB'

// identity: deep violet fire (vfx/palette.ts)
const VIOLET = pal('meteor', 'accent', 0.5)
const MAGENTA = palMix('meteor', 0.35, 0.8)
const PINK_HOT = pal('meteor', 'core', 1.7)
const VIOLET_DEEP = pal('meteor', 'accent', 0.1)

const SPELL = 'meteor'
const DEF = SPELLS[SPELL]
/** sim z of the impact plane (meteor.ts GAME_Z) */
const GAME_Z = 120
/** sim heights are compressed for the tilted camera: z 700 would sit next to the lens */
const Z_SCALE = 0.62
const ROCK_R = 92
const CRATER_LIFE = 3.4

const EMBER: RGB = [3.0, 0.7, 1.6]
const SMOKE_C = [0.025, 0.012, 0.035] as const
const DUST_C = [0.17, 0.14, 0.17] as const

interface Flight {
  id: number
  seen: number
  born: number
  sx: number
  sy: number
  lx: number
  ly: number
  lh: number
  spin: THREE.Quaternion
  axis: THREE.Vector3
}
interface Crater {
  x: number
  y: number
  r: number
  born: number
  seed: number
}

let pool: InstPool | null = null
const flights = new Map<number, Flight>()
const freeFlights: Flight[] = []
const craters: Crater[] = []
let frameNo = 0
const team: [number, number, number] = [1, 1, 1]
const qTmp = new THREE.Quaternion()

function rockGeometry(): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(1, 2)
  const pos = g.getAttribute('position') as THREE.BufferAttribute
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i)
    const y = pos.getY(i)
    const z = pos.getZ(i)
    // deterministic lumps keyed on the vertex position (shared corners move together)
    const n = Math.sin(x * 5.1 + y * 3.7) * 0.5 + Math.sin(y * 6.3 - z * 4.1) * 0.35 + Math.sin(z * 7.7 + x * 2.9) * 0.25
    const k = 0.86 + n * 0.12 + (y > 0.55 ? -0.08 : 0)
    pos.setXYZ(i, x * k * 1.08, y * k * 0.92, z * k)
  }
  g.computeVertexNormals()
  return g
}

/** Basalt with magenta-hot fissures; A0.x = heat 0..1, A0.y = seed. */
function rockMaterial(ctx: VfxCtx, A: Node<'vec4'>[]): THREE.Material {
  const [A0] = A
  const t = ctx.world.uTime
  const heat = A0.x
  const L = vec3(-0.42, 0.86, 0.3).normalize()
  const lam = saturate(dot(normalWorld, L))
  const viewDir = positionView.negate().normalize()
  const ndv = saturate(dot(normalView, viewDir))
  // geometry space: fissures turn with the tumbling rock
  const p = positionGeometry
  const uvA = vec2(p.x.mul(0.55).add(p.z.mul(0.31)), p.y.mul(0.55).sub(p.z.mul(0.27))).add(A0.y)
  const edge = texture(ctx.world.noise, uvA).b
  const glowN = texture(ctx.world.noise, uvA.mul(0.6).add(vec2(t.mul(0.05), t.mul(-0.08)))).r
  const fissure = smoothstep(0.11, 0.0, edge).mul(glowN.mul(0.8).add(0.5))
  const base = vec3(0.045, 0.03, 0.05).mul(lam.mul(1.1).add(0.25))
  const hot = mix(vec3(...MAGENTA), vec3(...PINK_HOT), heat)
  const rim = pow(float(1).sub(ndv), 2.5).mul(heat.mul(2.2).add(0.8))
  const col = base.add(hot.mul(fissure).mul(heat.mul(1.6).add(0.55))).add(vec3(...VIOLET).mul(rim))
  const m = new THREE.MeshBasicNodeMaterial()
  m.colorNode = col
  // drawn after the additive fire (renderOrder 9) so the rock silhouette always reads
  m.transparent = true
  m.depthWrite = true
  m.name = 'VfxB-MeteorRock'
  return m
}

function visualH(z: number): number {
  return PROJECTILE_H + (z - GAME_Z) * Z_SCALE
}

/** Same clamp as sim util.clampTarget (range 1000, no range mastery). */
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
const tgt = { x: 0, y: 0 }

function impact(ctx: VfxCtx, x: number, y: number, R: number): void {
  const fh = floorH(ctx, x, y)
  const onTile = !ctx.isLava(x, y)
  const k = R / 260
  // authoritative edge first, then everything stays inside it
  ctx.aoeRing(x, y, R, MAGENTA[0], MAGENTA[1], MAGENTA[2], 0.6)
  // short coloured flash (2-3 frames): bloom glows, nothing flattens to white
  ctx.flash(x, y, fh + 90, 0.06, R * 0.9, R * 0.9, VIOLET[0] * 0.7, VIOLET[1] * 0.7, VIOLET[2] * 0.7)
  ctx.flash(x, y, fh + 40, 0.18, R * 0.6, R * 0.35, PINK_HOT[0] * 0.3, PINK_HOT[1] * 0.3, PINK_HOT[2] * 0.3)
  ctx.ground.spawn(RING_EXPAND, x, y, fh, 30, R - 14, 0.38, 18 * k, VIOLET[0] * 0.55, VIOLET[1] * 0.55, VIOLET[2] * 0.55)
  if (onTile) ctx.scorches.spawn(x, y, TILE_TOP_H + 0.6, R * 0.78, 7)
  const ps = ctx.particles
  // rolling violet fire: billows pushed out low and up, cooling fast (hot cores only at the start)
  let n = ps.budget(30 * k)
  for (let i = 0; i < n; i++) {
    const a = Math.random() * TAU
    const sp = rand(0.6, 1.9) * R
    const hot = i < n * 0.25
    const c = hot ? PINK_HOT : Math.random() < 0.5 ? VIOLET : MAGENTA
    const kk = hot ? 0.3 : 0.5
    ps.spawn(x, y, fh + rand(20, 60), Math.cos(a) * sp, Math.sin(a) * sp, rand(150, 450), rand(0.3, 0.55), rand(50, 85) * k, -rand(70, 110) * k, c[0] * kk, c[1] * kk, c[2] * kk, 120, 3.6, 0)
  }
  // fire column climbing out of the crater
  n = ps.budget(22 * k)
  for (let i = 0; i < n; i++) {
    const a = Math.random() * TAU
    const rr = Math.random() * 50
    ps.spawn(x + Math.cos(a) * rr, y + Math.sin(a) * rr, fh + 20, Math.cos(a) * 50, Math.sin(a) * 50, rand(600, 1200), rand(0.4, 0.75), rand(36, 56), 8, VIOLET[0] * 0.5, VIOLET[1] * 0.5, VIOLET[2] * 0.5, -400, 2.6, 6)
  }
  // molten splash: glowing droplets arcing out and landing inside R
  n = ps.budget(44 * k)
  for (let i = 0; i < n; i++) {
    const a = Math.random() * TAU
    const sp = rand(0.6, 1.9) * R
    ps.spawn(x, y, fh + 40, Math.cos(a) * sp, Math.sin(a) * sp, rand(350, 950), rand(0.6, 0.95), rand(8, 14), 4, EMBER[0], EMBER[1], EMBER[2], -1900, 1.5, -0.05)
  }
  // rock debris: heavy chunks flung out (opaque) + a few big boulders
  let nd = ctx.debris.budget(54 * k)
  for (let i = 0; i < nd; i++) {
    const a = Math.random() * TAU
    const sp = rand(0.45, 1.45) * R
    const g = rand(0.03, 0.08)
    ctx.debris.spawn(x + Math.cos(a) * 30, y + Math.sin(a) * 30, fh + rand(10, 70), Math.cos(a) * sp, Math.sin(a) * sp, rand(350, 900), rand(0.9, 1.4), rand(14, 30), 10, g * 1.15, g * 0.85, g * 1.25, -2100, 1.2, 0)
  }
  nd = ctx.debris.budget(8 * k)
  for (let i = 0; i < nd; i++) {
    const a = Math.random() * TAU
    const sp = rand(0.3, 1.0) * R
    ctx.debris.spawn(x, y, fh + 50, Math.cos(a) * sp, Math.sin(a) * sp, rand(500, 800), rand(1.0, 1.3), rand(34, 48), 24, 0.035, 0.025, 0.04, -2200, 1.3, 0)
  }
  // dust ring hugging the floor + black-violet smoke billowing outward and up
  const sm = ctx.smoke
  n = sm.budget(18 * k)
  for (let i = 0; i < n; i++) {
    const a = (i / Math.max(1, n)) * TAU + Math.random() * 0.3
    const sp = rand(0.5, 0.8) * R
    sm.spawn(x + Math.cos(a) * R * 0.25, y + Math.sin(a) * R * 0.25, fh + 15, Math.cos(a) * sp, Math.sin(a) * sp, rand(10, 50), rand(1.0, 1.6), 50, R * 0.36, DUST_C[0], DUST_C[1], DUST_C[2], 10, 1.6, 0)
  }
  n = sm.budget(26 * k)
  for (let i = 0; i < n; i++) {
    const a = Math.random() * TAU
    const sp = rand(0.15, 0.55) * R
    sm.spawn(x + Math.cos(a) * 40, y + Math.sin(a) * 40, fh + rand(40, 120), Math.cos(a) * sp, Math.sin(a) * sp, rand(250, 600), rand(1.3, 2.2), 70, rand(150, 230) * k, SMOKE_C[0], SMOKE_C[1], SMOKE_C[2], -120, 1.5, 20)
  }
  // close to the camera focus: big shake + a shove away from the impact
  ctx.shakeNear(x, y, 0.45 + 0.35 * k)
  if (craters.length >= 4) craters.shift()
  craters.push({ x, y, r: R, born: ctx.now, seed: Math.random() * 10 })
}

function drawTelegraph(ctx: VfxCtx, x: number, y: number, R: number, prog: number, born: number, ownerColor: number, seed: number): void {
  const fh = floorH(ctx, x, y)
  const pulse = 0.85 + 0.15 * Math.sin(ctx.now * 18)
  const danger = 0.55 + 0.9 * prog * prog
  drawCircle(x, y, fh, R, STYLE_RUNES, MAGENTA[0], MAGENTA[1], MAGENTA[2], danger * pulse, prog, 0.6, seed, 0.05 + 0.12 * prog, 1.4, 28, born)
  hexRgb(ownerColor, team)
  // crisp authoritative edge at exactly R, team tinted
  drawCircle(x, y, fh + 0.3, R, STYLE_RING, team[0] * 0.8 + 1.2, team[1] * 0.8 + 0.2, team[2] * 0.8 + 1.0, 1.1, 0, 0, seed, 0, 0.5, 0, born)
}

function drawRock(ctx: VfxCtx, p: ProjectileState, x: number, y: number, f: Flight, falling: boolean, prog: number): void {
  const d = p.data
  // interpolate height with the previous snapshot
  let z = d.z
  if (ctx.prev) {
    for (const q of ctx.prev.projectiles) {
      if (q.id === p.id) {
        z = q.data.z + (d.z - q.data.z) * ctx.alpha
        break
      }
    }
  }
  const h = visualH(z)
  const heat = falling ? 0.45 + 0.55 * Math.min(1, prog) : 0.3
  // tumble
  qTmp.setFromAxisAngle(f.axis, ctx.dt * (falling ? 2.0 : 0.7))
  f.spin.premultiply(qTmp)
  if (pool) {
    pool.quat.copy(f.spin)
    const i = pool.add(x * S, h * S, -y * S, ROCK_R * S, ROCK_R * S, ROCK_R * S)
    pool.set(i, 0, heat, (p.id % 13) * 0.37, 0, 0)
  }
  // fire wreath
  glowG(x, y, h, ROCK_R * 4.2, VIOLET, 0.16 + heat * 0.22, 1.8, 0, 1, 0, 0.9)
  glowG(x, y, h + 18, ROCK_R * 3.0, MAGENTA, 0.35 + heat * 0.3, 2, 3, 1, ctx.now * 0.7 + p.id)
  const dt = ctx.dt
  const ps = ctx.particles
  let vx = 0
  let vy = 0
  let vh = 0
  if (falling) {
    vx = (d.tx - f.sx) / Math.max(0.01, d.fallTime)
    vy = (d.ty - f.sy) / Math.max(0.01, d.fallTime)
    vh = ((visualH(GAME_Z) - visualH(d.z0 ?? 700)) / Math.max(0.01, d.fallTime))
    // comet tail: stretched streaks opposite to the screen-space motion
    const sp = Math.hypot(vx, vy, vh)
    const ux = vx / sp
    const uy = vy / sp
    const uh = vh / sp
    const ang = screenAngle(ctx, x, y, h, ux, uy, uh)
    for (let k = 0; k < 3; k++) {
      const back = ROCK_R * (2.0 + k * 1.7)
      glowG(x - ux * back, y - uy * back, h - uh * back, ROCK_R * (2.3 - k * 0.45), k === 0 ? PINK_HOT : MAGENTA, 0.75 - k * 0.15, 1.6, 0, 2.6 + k * 0.8, ang, 0.6)
    }
    // shed fire along the dive
    const n = ps.budget(dt * 520)
    for (let i = 0; i < n; i++) {
      const a = Math.random() * TAU
      const rr = ROCK_R * rand(0.4, 1.0)
      ps.spawn(x + Math.cos(a) * rr, y + Math.sin(a) * rr, h + rand(-30, 30), -vx * 0.18 + rand(-60, 60), -vy * 0.18 + rand(-60, 60), -vh * 0.18 + rand(0, 80), rand(0.22, 0.5), rand(30, 54), 8, MAGENTA[0], MAGENTA[1], MAGENTA[2], 0, 2.4, 0)
    }
    if (Math.random() < dt * 30 * ctx.tier.particles) {
      ctx.smoke.spawn(x, y, h + 20, -vx * 0.1, -vy * 0.1, 40, rand(0.8, 1.3), 50, 150, SMOKE_C[0], SMOKE_C[1], SMOKE_C[2], 0, 1.2, 10)
    }
  } else {
    // hovering: flames lick upward, rift glow behind
    const n = ps.budget(dt * 180)
    for (let i = 0; i < n; i++) {
      const a = Math.random() * TAU
      const rr = ROCK_R * rand(0.7, 1.05)
      ps.spawn(x + Math.cos(a) * rr, y + Math.sin(a) * rr, h + rand(-20, 30), Math.cos(a) * 50, Math.sin(a) * 50, rand(120, 300), rand(0.25, 0.45), rand(22, 40), 5, MAGENTA[0], MAGENTA[1], MAGENTA[2], 0, 2, 6)
    }
    const rift = Math.min(1, (ctx.now - f.born) / 0.25)
    glowG(f.sx, f.sy, h + 40, ROCK_R * 5.2 * rift, VIOLET, 0.75, 0.07, 1, 1, ctx.now * 0.6)
    glowG(f.sx, f.sy, h + 40, ROCK_R * 6 * rift, VIOLET_DEEP, 1.4, 1, 3, 1, ctx.now * 0.4)
  }
  projShadow(ctx, x, y, h, ROCK_R)
  f.lx = x
  f.ly = y
  f.lh = h
}

const meteorVfx = {
  spell: SPELL,
  init(ctx: VfxCtx) {
    kitInit(ctx)
    pool = kitAdopt(new InstPool(rockGeometry(), 1, 12, (A) => rockMaterial(ctx, A), 9, 'vfxB-meteor-rocks'))
  },
  dispose() {
    pool = null
    flights.clear()
    craters.length = 0
    kitRelease()
  },
  onEvent(e: SimEvent, ctx: VfxCtx): boolean | void {
    switch (e.type) {
      case 'castStart':
        if (e.spell !== SPELL) return
        {
          const info = ctx.pawn(e.pawn)
          if (info) {
            const o = originOf(info)
            implode(ctx, o.x / S, -o.z / S, o.y / S, 22, 70, 140, 0.2, 14, MAGENTA, 1.2, 60)
          }
        }
        return
      case 'cast':
        if (e.spell !== SPELL) return
        {
          const o = castFlash(ctx, e.pawn, MAGENTA, 1.2)
          if (o) {
            // a bolt of violet light thrown up into the sky
            const gx = o.x / S
            const gy = -o.z / S
            const gh = o.y / S
            const ps = ctx.particles
            const n = ps.budget(26)
            for (let i = 0; i < n; i++) {
              ps.spawn(gx + rand(-10, 10), gy + rand(-10, 10), gh, rand(-40, 40), rand(-40, 40), rand(1200, 2000), rand(0.3, 0.5), rand(14, 22), 4, PINK_HOT[0], PINK_HOT[1], PINK_HOT[2], 0, 0.5, -0.12)
            }
          }
        }
        return
      case 'projectileSpawn': {
        if (e.spell !== SPELL || !ctx.state) return
        const p = ctx.state.projectiles.find((q) => q.id === e.id)
        if (!p) return
        const h = visualH(p.data.z)
        // the rift tears open
        burst(ctx, p.x, p.y, h, 40, 200, 700, 0.3, 0.6, 26, 6, VIOLET, 1.3, 0, 3, 0, -200, 200)
        ctx.flash(p.x, p.y, h, 0.3, 10, ROCK_R * 6, VIOLET[0], VIOLET[1], VIOLET[2])
        return
      }
      case 'explosion':
        if (e.spell !== SPELL) return
        impact(ctx, e.x, e.y, e.radius)
        return true
      default:
        return
    }
  },
  frame(ctx: VfxCtx) {
    kitBegin(ctx)
    frameNo++
    const st = ctx.state
    if (!st) return
    // windup: telegraph the impact zone from the cast point on
    for (const pw of st.pawns) {
      const c = pw.cast
      if (!pw.alive || !c || c.spell !== SPELL || !c.started) continue
      const lvl = pw.levels[c.slot] || 1
      const R = attr(DEF, 'radius', lvl)
      clampTarget(pw.x, pw.y, c.x, c.y, attr(DEF, 'range', lvl), tgt)
      const total = Math.max(1, Math.round(DEF.castPoint * 60))
      const k = 1 - c.ticksLeft / total
      drawTelegraph(ctx, tgt.x, tgt.y, R, 0, ctx.now - k * DEF.castPoint, ctx.colorOf(pw.owner), pw.id * 0.71)
      const info = ctx.pawn(pw.id)
      if (info) {
        const o = originOf(info)
        glowG(o.x / S, -o.z / S, o.y / S, 60 + 120 * k, MAGENTA, 0.6 + 1.2 * k, 2.2)
        glowG(o.x / S, -o.z / S, o.y / S, 40 + 60 * k, PINK_HOT, 0.5 + k, 2, 2, 1, ctx.now * 3)
      }
    }
    // craters cooling
    for (let i = craters.length - 1; i >= 0; i--) {
      const c = craters[i]
      const age = ctx.now - c.born
      if (age > CRATER_LIFE) {
        craters.splice(i, 1)
        continue
      }
      const u = age / CRATER_LIFE
      const fh = floorH(ctx, c.x, c.y)
      const cool = 1 - u
      drawCircle(c.x, c.y, fh + 0.2, c.r * 0.85, STYLE_CRACKS, PINK_HOT[0] * cool + VIOLET[0] * u, PINK_HOT[1] * cool + VIOLET[1] * u, PINK_HOT[2] * cool + VIOLET[2] * u, 1.1 * cool, u * 0.85, 0, c.seed, 0, 1, 0, c.born - 1)
      const lu = Math.max(0, 1 - age / 0.5)
      if (lu > 0) light(ctx, c.x, c.y, c.r * 0.8, 1.4 * lu * lu, MAGENTA, 0.5, true)
      const ps = ctx.particles
      const n = ps.budget(ctx.dt * 60 * (1 - u))
      for (let j = 0; j < n; j++) {
        const a = Math.random() * TAU
        const rr = Math.sqrt(Math.random()) * c.r * 0.6
        ps.spawn(c.x + Math.cos(a) * rr, c.y + Math.sin(a) * rr, fh + 5, rand(-20, 20), rand(-20, 20), rand(60, 160), rand(0.8, 1.6), rand(5, 9), 1.5, EMBER[0], EMBER[1], EMBER[2], 20, 0.4, 18)
      }
    }
    for (const [id, f] of flights) {
      if (f.seen !== frameNo - 1 && f.seen !== frameNo) {
        flights.delete(id)
        freeFlights.push(f)
      }
    }
  },
  drawProjectile(p: ProjectileState, x: number, y: number, ctx: VfxCtx) {
    const d = p.data
    let f = flights.get(p.id)
    if (!f) {
      f = freeFlights.pop() ?? { id: 0, seen: 0, born: 0, sx: 0, sy: 0, lx: 0, ly: 0, lh: 0, spin: new THREE.Quaternion(), axis: new THREE.Vector3() }
      f.id = p.id
      f.born = ctx.now
      f.sx = p.x
      f.sy = p.y
      f.spin.identity()
      f.axis.set(rand(-1, 1), rand(-0.3, 0.3), rand(-1, 1)).normalize()
      flights.set(p.id, f)
    }
    f.seen = frameNo
    const falling = d.falling === 1
    if (!falling) {
      f.sx = p.x
      f.sy = p.y
    }
    const hover = d.hoverTime ?? 0.55
    const fall = d.fallTime ?? 0.6
    const el = (d.elapsed ?? 0) / 60
    const tLeft = falling ? Math.max(0, fall - el) : hover - el + fall
    const prog = Math.max(0, Math.min(1, 1 - tLeft / (hover + fall)))
    const R = d.radius
    drawTelegraph(ctx, d.tx, d.ty, R, prog, f.born - 1, ctx.colorOf(p.owner), p.id * 0.71)
    const fh = floorH(ctx, d.tx, d.ty)
    // the shadow of the rock swallows the zone as it falls (never past the hit radius)
    drawShadow(d.tx, d.ty, fh - 0.4, R * (0.6 + 0.4 * prog), 0.15 + 0.7 * prog * prog, 0.7, 0.25, p.id)
    light(ctx, d.tx, d.ty, R, 0.25 + 1.5 * prog * prog, MAGENTA, 0.45, true)
    drawRock(ctx, p, x, y, f, falling, falling ? el / fall : 0)
  },
}

registerSpellVfx(meteorVfx)
void RING_IMPLODE
