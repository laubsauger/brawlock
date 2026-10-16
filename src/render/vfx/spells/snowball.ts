/**
 * Snowball (column 4 Devastator; frost white-blue with violet ice). spells.md §8.19.
 * Arc: frost gathers at the hand through the 0.2 s cast point -> a cold flash and a snow puff ->
 * a packed snowball (sim radius 75..87, lit, faceted violet ice crystals) rolls along the floor
 * with its roll angle taken from the velocity, kicking up snow powder and leaving frost
 * patches -> warlocks it drags are chilled (`snowball` modifier): ice shards close around
 * the feet, frost spreads under them, snowflakes swirl -> at the end (any reason) a frost nova
 * of exactly r200: crisp ring, ice shard spray, powder cloud, a frost patch that thaws.
 */
import * as THREE from 'three/webgpu'
import { bumpMap, dot, float, mix, normalView, positionGeometry, positionView, pow, saturate, smoothstep, texture, vec3 } from 'three/tsl'
import type { ModifierState, PawnState, ProjectileState, SimEvent } from '../../../sim/types'
import { S, TILE_TOP_H } from '../../coords'
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js'
import { RING_EXPAND, RING_IMPLODE } from '../../scene/GroundFx'
import { registerSpellVfx, type VfxCtx } from '../registry'
import {
  InstPool, STYLE_FROST, TAU, burst, castFlash, drawCircle, floorH, glowG, implode, kitAdopt, kitBegin,
  kitInit, kitRelease, light, originOf, projShadow, rand, type RGB,
  pal, flashT, levelOfThing, tierOfLevel, tierCap,
} from './kitB'

// identity: light ice blue (vfx/palette.ts)
const FROST = pal('snowball', 'accent', 1.5)

const SPELL = 'snowball'
const MOD = 'snowball'
// red pulled down: the purple sky light otherwise turns the snow lilac
const SNOW: RGB = [0.56, 0.86, 1.0]
const MIST = [0.55, 0.68, 0.85] as const
/** powder puffs (soft smoke particles) */
const POWDER = [0.62, 0.7, 0.82] as const
/** violet ice: albedo tint and its cold glow */
const ICE_TINT: RGB = [0.3, 0.52, 1.0]
const ICE_GLOW: RGB = [0.28, 0.5, 1.0]

interface Ball {
  id: number
  seen: number
  q: THREE.Quaternion
  x: number
  y: number
  fx: number
  fy: number
}
interface Patch {
  x: number
  y: number
  r: number
  born: number
  life: number
  seed: number
  /** intensity */
  k: number
}
interface Chill {
  since: number
  seen: number
}

let balls: InstPool | null = null
let shards: InstPool | null = null
const tracks = new Map<number, Ball>()
const freeBalls: Ball[] = []
const patches: Patch[] = []
const chills = new Map<number, Chill>()
let frameNo = 0
const axis = new THREE.Vector3()
const dq = new THREE.Quaternion()
const UP = new THREE.Vector3(0, 1, 0)
const tv = new THREE.Vector3()
/** ice crystals frozen into the ball (local directions, lengths) */
const CRYSTALS: { d: THREE.Vector3; len: number; q: THREE.Quaternion }[] = []
for (let i = 0; i < 9; i++) {
  const d = new THREE.Vector3(Math.sin(i * 2.4) * Math.cos(i * 1.3), Math.cos(i * 2.4), Math.sin(i * 2.4) * Math.sin(i * 1.3)).normalize()
  CRYSTALS.push({ d, len: 0.26 + ((i * 37) % 5) * 0.04, q: new THREE.Quaternion().setFromUnitVectors(UP, d) })
}

/**
 * Packed snowball: icosphere detail 7 merged into an indexed mesh (shared vertices -> smooth
 * normals; the raw icosphere is non-indexed and shades flat), with soft clumpy lumps.
 */
function snowGeometry(): THREE.BufferGeometry {
  const raw = new THREE.IcosahedronGeometry(1, 7)
  raw.deleteAttribute('normal')
  raw.deleteAttribute('uv')
  const g = mergeVertices(raw)
  raw.dispose()
  const pos = g.getAttribute('position') as THREE.BufferAttribute
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i)
    const y = pos.getY(i)
    const z = pos.getZ(i)
    // broad packed lumps + finer clumps (deterministic, keyed on the direction)
    const n0 = Math.sin(x * 3.1 + y * 1.7) * 0.5 + Math.sin(y * 3.7 - z * 2.3) * 0.4 + Math.sin(z * 2.9 + x * 2.2) * 0.4
    const n1 = Math.sin(x * 11.3 + z * 7.1) * 0.5 + Math.sin(y * 12.7 + x * 5.3) * 0.5 + Math.sin(z * 13.9 - y * 6.1) * 0.4
    const k = 1 + n0 * 0.03 + n1 * 0.012
    pos.setXYZ(i, x * k, y * k, z * k)
  }
  g.computeVertexNormals()
  return g
}

/**
 * Packed snow (ice blue / clean white) with blue ice veins; lit by the scene (moon + lava bounce). Surface detail is a
 * bump from the shared noise: clumps pressed together along cell seams, fine grain on top.
 */
function snowMaterial(ctx: VfxCtx): THREE.Material {
  const noise = ctx.world.noise
  const p = positionGeometry
  const uvA = p.xy.mul(0.9).add(p.z.mul(0.37))
  const clump = texture(noise, uvA.mul(0.8)).r
  const grain = texture(noise, uvA.mul(3.4).add(0.71)).g
  const seamTex = texture(noise, uvA.mul(1.15).add(p.z.mul(0.2)).add(0.13))
  const seam = smoothstep(0.09, 0.0, seamTex.b)
  // violet ice: crystalline veins in a few regions, not dots
  const region = smoothstep(0.5, 0.64, texture(noise, uvA.mul(0.42).add(1.9)).r)
  const vein = smoothstep(0.07, 0.0, texture(noise, uvA.mul(2.1).add(0.37)).b)
  const ice = saturate(vein.mul(region).add(region.mul(0.25)))
  const viewDir = positionView.negate().normalize()
  const ndv = saturate(dot(normalView, viewDir))
  const rim = pow(float(1).sub(ndv), 3)
  const m = new THREE.MeshStandardNodeMaterial()
  const snow = vec3(...SNOW).mul(clump.mul(0.18).add(0.86)).mul(grain.mul(0.18).add(0.88)).mul(float(1).sub(seam.mul(0.38)))
  m.colorNode = mix(snow, vec3(...ICE_TINT), ice.mul(0.8))
  m.roughnessNode = mix(float(0.97), float(0.22), ice)
  m.metalnessNode = float(0)
  // packed-snow relief: clumps (seams sink in) + fine grain
  m.normalNode = bumpMap(texture(noise, uvA.mul(1.15).add(p.z.mul(0.2)).add(0.13)).b.mul(0.6).add(texture(noise, uvA.mul(3.4).add(0.71)).g.mul(0.25)), float(1.3))
  // cold self-light (cancels the warm lava bounce from below): icy body + soft rim + violet ice glow
  m.emissiveNode = tierCap(
    ctx,
    vec3(...FROST).mul(rim.mul(0.2)).add(vec3(...ICE_GLOW).mul(ice.mul(0.6))).add(vec3(0.05, 0.13, 0.19).mul(clump.mul(0.4).add(0.8)).mul(float(1).sub(seam.mul(0.5)))),
    1.2, 0.45, 0.85,
  )
  m.name = 'VfxB-Snowball'
  return m
}

/** Translucent ice shard (fresnel). */
function shardMaterial(): THREE.Material {
  const viewDir = positionView.negate().normalize()
  const ndv = saturate(dot(normalView, viewDir))
  const fr = pow(float(1).sub(ndv), 2)
  const m = new THREE.MeshBasicNodeMaterial()
  m.colorNode = mix(vec3(0.16, 0.14, 0.4), vec3(...ICE_GLOW).mul(1.4), fr)
  m.opacityNode = fr.mul(0.6).add(0.35)
  m.transparent = true
  m.depthWrite = false
  m.name = 'VfxB-IceShard'
  return m
}

function addPatch(x: number, y: number, r: number, life: number, now: number, k = 1): void {
  if (patches.length >= 44) patches.shift()
  patches.push({ x, y, r, born: now, life, seed: Math.random() * 10, k })
}

function nova(ctx: VfxCtx, x: number, y: number, R: number, tier = 0): void {
  const fh = floorH(ctx, x, y)
  const pw = 1 + 0.35 * tier
  ctx.aoeRing(x, y, R, FROST[0], FROST[1], FROST[2], 0.55)
  ctx.ground.spawn(RING_EXPAND, x, y, fh, 30, R - 12, 0.32, 12, FROST[0] * 0.5, FROST[1] * 0.5, FROST[2] * 0.55)
  // brief icy flash (2-3 frames), coloured, never a white disc
  flashT(ctx, x, y, fh + 70, 0.06, R * 0.8, R * 0.8, FROST[0] * 0.45, FROST[1] * 0.5, FROST[2] * 0.6)
  // frozen ground that melts away
  addPatch(x, y, R * 0.97, 3.0, ctx.now, 0.9)
  // ice shards and chunks (opaque), landing inside R
  const nd = ctx.debris.budget(32 * pw)
  for (let i = 0; i < nd; i++) {
    const a = Math.random() * TAU
    const sp = rand(0.4, 1.4) * R
    const b = rand(0.5, 0.8)
    ctx.debris.spawn(x, y, fh + rand(30, 90), Math.cos(a) * sp, Math.sin(a) * sp, rand(300, 700), rand(0.7, 1.1), rand(9, 18), 4, b * 0.75, b * 0.86, b, -1900, 1.2, 0)
  }
  // glittering frost needles (additive, streaked)
  burst(ctx, x, y, fh + 50, 40, R * 0.9, R * 2.2, 0.25, 0.5, 8, 2, FROST, 0.8, -700, 2.6, -0.1, 80, 380)
  // frost mist rolling out low (inside R)
  const sm = ctx.smoke
  const n = sm.budget(16)
  for (let i = 0; i < n; i++) {
    const a = (i / Math.max(1, n)) * TAU
    const sp = rand(0.45, 0.75) * R
    sm.spawn(x + Math.cos(a) * 30, y + Math.sin(a) * 30, fh + 20, Math.cos(a) * sp, Math.sin(a) * sp, rand(10, 60), rand(1.2, 1.9), 50, R * 0.42, MIST[0], MIST[1], MIST[2], -10, 1.5, 0)
  }
  ctx.shakeNear(x, y, 0.3)
}

function drawBall(p: ProjectileState, x: number, y: number, ctx: VfxCtx): void {
  let b = tracks.get(p.id)
  if (!b) {
    b = freeBalls.pop() ?? { id: 0, seen: 0, q: new THREE.Quaternion(), x: 0, y: 0, fx: 0, fy: 0 }
    b.id = p.id
    b.q.identity()
    b.x = b.fx = x
    b.y = b.fy = y
    tracks.set(p.id, b)
  }
  b.seen = frameNo
  const r = p.radius
  const dx = x - b.x
  const dy = y - b.y
  const dist = Math.hypot(dx, dy)
  if (dist > 0.01 && dist < 300) {
    // roll: axis = up x motion (three space), angle = distance / radius
    axis.set(-dy, 0, -dx).normalize()
    dq.setFromAxisAngle(axis, dist / r)
    b.q.premultiply(dq)
  }
  b.x = x
  b.y = y
  const h = TILE_TOP_H + r
  if (balls) {
    balls.quat.copy(b.q)
    balls.add(x * S, h * S, -y * S, r * S, r * S, r * S)
  }
  if (shards) {
    // violet ice crystals jutting out of the packed snow, rolling with it
    const nc = 5 + 2 * tierOfLevel(ctx, levelOfThing(p))
    for (let ci = 0; ci < nc; ci++) {
      const c = CRYSTALS[ci]
      tv.copy(c.d).applyQuaternion(b.q)
      const L = r * c.len
      shards.quat.copy(b.q).multiply(c.q)
      shards.add((x * S) + tv.x * r * 0.9 * S, (h + tv.y * r * 0.9) * S, (-y * S) + tv.z * r * 0.9 * S, L * S, L * S, L * S)
    }
  }
  projShadow(ctx, x, y, TILE_TOP_H + 2, r * 0.9)
  // cold aura + light
  glowG(x, y, h, r * 3.2, FROST, 0.12, 1.6, 0, 1, 0, 0)
  light(ctx, x, y, r * 3, 0.7, FROST, 0.35)
  const sp = Math.hypot(p.vx, p.vy) || 1
  const ux = p.vx / sp
  const uy = p.vy / sp
  const dt = ctx.dt
  // snow powder kicked off the back and sides: small soft puffs that drift apart and are gone
  // within ~0.5 s (a broken-up dusting, never a ribbon)
  const sm = ctx.smoke
  const np = sm.budget(dt * 26)
  for (let i = 0; i < np; i++) {
    const side = Math.random() < 0.5 ? -1 : 1
    const px = x - ux * r * rand(0.5, 0.9) + -uy * side * r * rand(0.2, 0.7)
    const py = y - uy * r * rand(0.5, 0.9) + ux * side * r * rand(0.2, 0.7)
    sm.spawn(px, py, TILE_TOP_H + rand(8, 30), -uy * side * rand(50, 130) - ux * 40, ux * side * rand(50, 130) - uy * 40, rand(60, 140), rand(0.3, 0.5), rand(14, 22), rand(36, 56), POWDER[0], POWDER[1], POWDER[2], -260, 2.4, 6)
  }
  // snow clumps thrown up by the roll (opaque, small)
  if (Math.random() < dt * 22 * ctx.tier.particles) {
    const side = Math.random() < 0.5 ? -1 : 1
    ctx.debris.spawn(x - ux * r * 0.6 + -uy * side * r * 0.6, y - uy * r * 0.6 + ux * side * r * 0.6, TILE_TOP_H + 10, -uy * side * rand(60, 160), ux * side * rand(60, 160), rand(200, 380), rand(0.35, 0.5), rand(6, 10), 3, 0.62, 0.7, 0.82, -1600, 1, 0)
  }
  // glittering flakes
  const ps = ctx.particles
  const nf = ps.budget(dt * 70)
  for (let i = 0; i < nf; i++) {
    const a = Math.random() * TAU
    ps.spawn(x + Math.cos(a) * r * 0.9, y + Math.sin(a) * r * 0.9, h + rand(-r * 0.6, r * 0.8), Math.cos(a) * 40 - ux * 50, Math.sin(a) * 40 - uy * 50, rand(20, 90), rand(0.25, 0.5), rand(4, 7), 1, FROST[0] * 0.9, FROST[1] * 0.9, FROST[2] * 0.9, -60, 1, 10)
  }
  if (ctx.isLava(x, y) && Math.random() < dt * 20) {
    sm.spawn(x, y, 20, rand(-30, 30), rand(-30, 30), 160, 0.9, 40, 120, 0.5, 0.5, 0.55, 0, 1, 10)
  }
  // frost trail
  if (Math.hypot(x - b.fx, y - b.fy) > r * 0.7) {
    b.fx = x
    b.fy = y
    // the contact strip under the ball: small frost marks with sideways jitter (broken, not a band)
    const j = rand(-0.22, 0.22) * r
    const mx = x - ux * r * 0.15 - uy * j
    const my = y - uy * r * 0.15 + ux * j
    if (!ctx.isLava(mx, my)) addPatch(mx, my, r * rand(0.3, 0.42), 1.2, ctx.now, 0.55)
  }
}

registerSpellVfx({
  spell: SPELL,
  modifiers: [MOD],
  init(ctx: VfxCtx) {
    kitInit(ctx)
    balls = kitAdopt(new InstPool(snowGeometry(), 0, 10, () => snowMaterial(ctx), 9, 'vfxB-snowballs'))
    balls.object.castShadow = ctx.tier.shadowMap > 0
    const sg = new THREE.OctahedronGeometry(1, 0)
    sg.scale(0.32, 1, 0.32)
    shards = kitAdopt(new InstPool(sg, 0, 80, () => shardMaterial(), 9, 'vfxB-ice-shards'))
  },
  dispose() {
    balls = null
    shards = null
    tracks.clear()
    patches.length = 0
    chills.clear()
    kitRelease()
  },
  onEvent(e: SimEvent, ctx: VfxCtx): boolean | void {
    switch (e.type) {
      case 'castStart': {
        if (e.spell !== SPELL) return
        const info = ctx.pawn(e.pawn)
        if (info) {
          const o = originOf(info)
          implode(ctx, o.x / S, -o.z / S, o.y / S, 24, 60, 130, 0.2, 10, FROST, 1.2, 70)
        }
        return
      }
      case 'cast': {
        if (e.spell !== SPELL) return
        const o = castFlash(ctx, e.pawn, FROST, 1)
        const info = ctx.pawn(e.pawn)
        if (o && info) {
          const dx = e.x - info.x
          const dy = e.y - info.y
          const l = Math.hypot(dx, dy) || 1
          const sm = ctx.smoke
          const n = sm.budget(8)
          for (let i = 0; i < n; i++) {
            sm.spawn(info.x + (dx / l) * 60, info.y + (dy / l) * 60, TILE_TOP_H + 30, (dx / l) * rand(80, 200) + rand(-60, 60), (dy / l) * rand(80, 200) + rand(-60, 60), rand(20, 80), rand(0.6, 1.0), 40, 110, SNOW[0], SNOW[1], SNOW[2], -40, 1.8, 6)
          }
          ctx.ground.spawn(RING_IMPLODE, info.x + (dx / l) * 60, info.y + (dy / l) * 60, floorH(ctx, info.x, info.y), 20, 90, 0.25, 8, FROST[0], FROST[1], FROST[2])
        }
        return
      }
      case 'explosion':
        if (e.spell !== SPELL) return
        nova(ctx, e.x, e.y, e.radius, tierOfLevel(ctx, levelOfThing(e)))
        return true
      case 'projectileHit':
      case 'projectileExpire':
        return e.spell === SPELL ? true : undefined
      case 'modifier': {
        if (e.id !== MOD || !e.on) return
        const info = ctx.pawn(e.pawn)
        if (info) burst(ctx, info.x, info.y, info.h + 60, 8, 60, 180, 0.3, 0.5, 8, 2, FROST, 1, -200, 2, 0, 20, 100)
        return
      }
      default:
        return
    }
  },
  frame(ctx: VfxCtx) {
    kitBegin(ctx)
    frameNo++
    // signature windup: frost condenses into a growing ice ball in the hand, breath of vapour
    const st = ctx.state
    if (st && balls) {
      for (const pw of st.pawns) {
        const c = pw.cast
        if (!pw.alive || !c || c.spell !== SPELL || !c.started) continue
        const info = ctx.pawn(pw.id)
        if (!info) continue
        const o = originOf(info)
        const k = 1 - c.ticksLeft / 12
        const r = 8 + 22 * k
        balls.quat.setFromAxisAngle(UP, ctx.now * 4)
        balls.add(o.x, o.y + r * 0.5 * S, o.z, r * S, r * S, r * S)
        glowG(o.x / S, -o.z / S, o.y / S + r * 0.5, r * 4, FROST, 0.25 + 0.3 * k, 1.6)
        if (Math.random() < ctx.dt * 30) ctx.smoke.spawn(o.x / S + rand(-10, 10), -o.z / S + rand(-10, 10), o.y / S, rand(-20, 20), rand(-20, 20), rand(20, 60), 0.6, 14, 40, MIST[0], MIST[1], MIST[2], 0, 1.5, 6)
      }
    }
    for (let i = patches.length - 1; i >= 0; i--) {
      const pt = patches[i]
      const u = (ctx.now - pt.born) / pt.life
      if (u >= 1) {
        patches.splice(i, 1)
        continue
      }
      drawCircle(pt.x, pt.y, floorH(ctx, pt.x, pt.y) + 0.1, pt.r, STYLE_FROST, FROST[0] * 0.38, FROST[1] * 0.42, FROST[2] * 0.48, pt.k, u, 0, pt.seed, 0, 1, 0, pt.born - 1)
    }
    for (const [id, b] of tracks) {
      if (frameNo - b.seen > 2) {
        tracks.delete(id)
        freeBalls.push(b)
      }
    }
    for (const [id, c] of chills) if (frameNo - c.seen > 3) chills.delete(id)
  },
  drawProjectile(p: ProjectileState, x: number, y: number, ctx: VfxCtx) {
    drawBall(p, x, y, ctx)
  },
  drawModifier(pawn: PawnState, _mod: ModifierState, x: number, y: number, ctx: VfxCtx) {
    let c = chills.get(pawn.id)
    if (!c) {
      c = { since: ctx.now, seen: frameNo }
      chills.set(pawn.id, c)
    }
    c.seen = frameNo
    const grow = Math.min(1, (ctx.now - c.since) / 0.18)
    const info = ctx.pawn(pawn.id)
    const fh = info ? info.h : TILE_TOP_H
    drawCircle(x, y, fh + 1.3, 70, STYLE_FROST, FROST[0] * 0.8, FROST[1] * 0.8, FROST[2] * 0.85, 1.2, 0.15, 0, pawn.id * 0.37, 0, 1, 0, c.since)
    if (shards) {
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * TAU + pawn.id * 0.9
        const rr = 30 + (i % 2) * 8
        const len = (34 + ((i * 7) % 3) * 10) * grow
        const tilt = 0.45 + (i % 3) * 0.12
        // top leans outward: rotate about up x radial
        axis.set(-Math.sin(a), 0, -Math.cos(a))
        shards.quat.setFromAxisAngle(axis, -tilt)
        shards.add((x + Math.cos(a) * rr) * S, (fh + len * 0.92) * S, -(y + Math.sin(a) * rr) * S, len * S, len * S, len * S)
      }
    }
    glowG(x, y, fh + 20, 120, FROST, 0.18, 1.6)
    const ps = ctx.particles
    const n = ps.budget(ctx.dt * 40)
    for (let i = 0; i < n; i++) {
      const a = Math.random() * TAU
      const rr = rand(20, 60)
      ps.spawn(x + Math.cos(a) * rr, y + Math.sin(a) * rr, fh + rand(60, 150), -Math.sin(a) * 60, Math.cos(a) * 60, rand(-80, -20), rand(0.6, 1.0), rand(4, 7), 2, FROST[0], FROST[1], FROST[2], 0, 0.5, 8)
    }
  },
})
