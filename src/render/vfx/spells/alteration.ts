/**
 * Alteration (column 5 Defense; white-gold mirror). spells.md §8.22.
 * Cast (IMMEDIATE): a mirror ring snaps up around the warlock at EXACTLY the swap radius (120):
 * a short wall of shimmering glass facets (prismatic thin-film sheen sweeping around it), a crisp
 * gold floor ring with two swap arrows chasing each other. Fades over its last 0.25 s.
 * 'swap' (spell alteration): the glass shatters at both points (shards, glints, ring, flash)
 * and a bright thread of light joins the two positions for a moment.
 */
import * as THREE from 'three/webgpu'
import { ticks } from '../../../sim/config'
import { atan, float, floor, fract, hash, mix, positionGeometry, pow, saturate, sin, smoothstep, vec3 } from 'three/tsl'
import type { Node } from 'three/webgpu'
import type { ModifierState, PawnState, SimEvent } from '../../../sim/types'
import { S } from '../../coords'
import { RING_EXPAND, RING_IMPLODE } from '../../scene/GroundFx'
import { registerSpellVfx, type VfxCtx } from '../registry'
import { InstPool, STYLE_ARROWS, TAU, burst, castFlash, drawCircle, floorH, glowG, kitAdopt, kitBegin, kitInit, kitRelease, light, rand, type RGB, pal, tierCap, flashT, levelOf, tierOfLevel } from './kitB'

// identity: silver glass (vfx/palette.ts)
const GOLD = pal('alteration', 'accent', 1.2)
const GOLD_WHITE = pal('alteration', 'core', 1.9)

const SPELL = 'alteration'
const WALL_H = 95
const FADE_TICKS = ticks(0.25)
const PRISM_A: RGB = [1.4, 2.4, 3.0]
const PRISM_B: RGB = [3.0, 1.4, 2.6]

interface Ring {
  seen: number
  since: number
  R: number
}
interface Thread {
  ax: number
  ay: number
  bx: number
  by: number
  born: number
}

let pool: InstPool | null = null
const rings = new Map<number, Ring>()
const threads: Thread[] = []
let frameNo = 0

/** Mirror wall (open cylinder, unit radius/height). A0: x alpha, y seed, z intro 0..1. */
function wallMaterial(ctx: VfxCtx, A: Node<'vec4'>[]): THREE.Material {
  const [A0] = A
  const t = ctx.world.uTime
  const p = positionGeometry
  const ang = atan(p.z, p.x)
  const u = ang.div(TAU).add(0.5)
  const facets = A0.w.mul(8).add(22)
  const cell = floor(u.mul(facets))
  const cu = fract(u.mul(facets))
  const hsh = hash(cell.add(A0.y))
  // each facet catches the light at its own moment: mirror glints running around the ring
  const glint = pow(saturate(sin(t.mul(2.2).add(hsh.mul(TAU)).add(u.mul(TAU * 2)))), 8)
  const seams = smoothstep(0.06, 0.0, cu).add(smoothstep(0.94, 1.0, cu))
  const film = mix(vec3(...PRISM_A), vec3(...PRISM_B), saturate(sin(p.y.mul(7).add(u.mul(12)).sub(t.mul(1.5))).mul(0.5).add(0.5)))
  const sweep = pow(saturate(sin(u.mul(TAU).sub(t.mul(3)))), 12)
  const vfade = smoothstep(0.0, 0.18, p.y).mul(smoothstep(1.0, 0.55, p.y))
  const col = vec3(...GOLD_WHITE).mul(glint.mul(0.6).add(seams.mul(0.35)).add(0.06))
    .add(film.mul(0.12).add(film.mul(sweep).mul(0.5)))
  const m = new THREE.MeshBasicNodeMaterial()
  m.transparent = true
  m.depthWrite = false
  m.side = THREE.DoubleSide
  m.blending = THREE.AdditiveBlending
  m.colorNode = tierCap(ctx, col.mul(vfade).mul(A0.x).mul(smoothstep(0.0, 1.0, A0.z.mul(1.6).sub(p.y.mul(0.6)))), 2.0, 0.6, 0.6)
  m.opacityNode = float(1)
  m.name = 'VfxB-AlterationWall'
  return m
}

function shatter(ctx: VfxCtx, x: number, y: number, R: number, big: boolean): void {
  const fh = floorH(ctx, x, y)
  ctx.ground.spawn(big ? RING_EXPAND : RING_IMPLODE, x, y, fh, 15, R, 0.3, 10, GOLD_WHITE[0] * 0.6, GOLD_WHITE[1] * 0.6, GOLD_WHITE[2] * 0.6)
  flashT(ctx, x, y, fh + 60, 0.08, R, R * 1.1, GOLD_WHITE[0] * 0.6, GOLD_WHITE[1] * 0.6, GOLD_WHITE[2] * 0.6)
  // glass shards: opaque pale-gold slivers + additive glints, all inside the ring
  const nd = ctx.debris.budget(26)
  for (let i = 0; i < nd; i++) {
    const a = Math.random() * TAU
    const sp = rand(0.5, 1.3) * R
    const b = rand(0.6, 0.95)
    ctx.debris.spawn(x + Math.cos(a) * R * 0.85, y + Math.sin(a) * R * 0.85, fh + rand(20, WALL_H), Math.cos(a) * sp * 0.6, Math.sin(a) * sp * 0.6, rand(150, 420), rand(0.5, 0.8), rand(6, 12), 3, b, b * 0.92, b * 0.7, -1700, 1.5, 0)
  }
  burst(ctx, x, y, fh + 60, 30, R * 0.6, R * 1.6, 0.2, 0.4, 8, 2, GOLD_WHITE, 0.9, -600, 3, -0.1, 0, 260, R * 0.7)
  burst(ctx, x, y, fh + 60, 12, R * 0.3, R * 0.8, 0.3, 0.5, 9, 2, PRISM_A, 0.7, -300, 2.5, 0, 0, 160, R * 0.5)
}

registerSpellVfx({
  spell: SPELL,
  modifiers: [SPELL],
  init(ctx: VfxCtx) {
    kitInit(ctx)
    const geo = new THREE.CylinderGeometry(1, 1, 1, 72, 6, true)
    geo.translate(0, 0.5, 0)
    pool = kitAdopt(new InstPool(geo, 1, 12, (A) => wallMaterial(ctx, A), 8, 'vfxB-alteration-walls'))
  },
  dispose() {
    pool = null
    rings.clear()
    threads.length = 0
    kitRelease()
  },
  onEvent(e: SimEvent, ctx: VfxCtx): boolean | void {
    switch (e.type) {
      case 'cast':
        if (e.spell !== SPELL) return
        castFlash(ctx, e.pawn, GOLD_WHITE, 0.9)
        return true
      case 'modifier': {
        if (e.id !== SPELL) return
        const info = ctx.pawn(e.pawn)
        if (!info) return
        if (e.on) {
          const r = rings.get(e.pawn)
          if (r) r.since = ctx.now
          ctx.ground.spawn(RING_IMPLODE, info.x, info.y, floorH(ctx, info.x, info.y), 30, 119, 0.22, 8, GOLD_WHITE[0] * 0.7, GOLD_WHITE[1] * 0.7, GOLD_WHITE[2] * 0.7)
        }
        return
      }
      case 'swap': {
        if (e.spell !== SPELL) return
        const R = rings.get(e.pawn)?.R ?? 120
        shatter(ctx, e.fromX, e.fromY, R, true)
        shatter(ctx, e.toX, e.toY, R * 0.7, false)
        if (threads.length >= 6) threads.shift()
        threads.push({ ax: e.fromX, ay: e.fromY, bx: e.toX, by: e.toY, born: ctx.now })
        ctx.shakeNear(e.toX, e.toY, 0.15)
        return true
      }
      default:
        return
    }
  },
  frame(ctx: VfxCtx) {
    kitBegin(ctx)
    frameNo++
    for (const [id, r] of rings) if (frameNo - r.seen > 2) rings.delete(id)
    // light thread joining the swapped positions
    for (let i = threads.length - 1; i >= 0; i--) {
      const th = threads[i]
      const u = (ctx.now - th.born) / 0.35
      if (u >= 1) {
        threads.splice(i, 1)
        continue
      }
      const f = (1 - u) * (1 - u)
      const n = 12
      for (let k = 0; k <= n; k++) {
        const s = k / n
        const x = th.ax + (th.bx - th.ax) * s
        const y = th.ay + (th.by - th.ay) * s
        glowG(x, y, floorH(ctx, x, y) + 70 + Math.sin(s * Math.PI) * 40, 50, k % 2 ? GOLD_WHITE : PRISM_A, 0.6 * f, 2.2)
      }
    }
  },
  drawModifier(pawn: PawnState, mod: ModifierState, x: number, y: number, ctx: VfxCtx) {
    let r = rings.get(pawn.id)
    if (!r) {
      r = { seen: frameNo, since: ctx.now, R: 120 }
      rings.set(pawn.id, r)
    }
    if (frameNo - r.seen > 2) r.since = ctx.now
    r.seen = frameNo
    const R = mod.data.radius || 120
    r.R = R
    const intro = Math.min(1, (ctx.now - r.since) / 0.15)
    const fade = mod.ticksLeft < 0 ? 1 : Math.min(1, mod.ticksLeft / FADE_TICKS)
    const info = ctx.pawn(pawn.id)
    const fh = info ? info.h : 30
    if (pool) {
      pool.quat.identity()
      const i = pool.add(x * S, (fh + 1) * S, -y * S, R * S, WALL_H * S, R * S)
      pool.set(i, 0, 0.9 * fade, pawn.id * 0.77, intro, tierOfLevel(ctx, levelOf(ctx, pawn.owner, SPELL)))
    }
    drawCircle(x, y, fh + 1.4, R, STYLE_ARROWS, GOLD[0], GOLD[1], GOLD[2], 0.85 * fade * intro, 0, 2.2, pawn.id, 0.05, 0.8, 0, r.since)
    glowG(x, y, fh + 60, 150, GOLD_WHITE, 0.12 * fade, 1.6)
    light(ctx, x, y, R, 0.4 * fade, GOLD_WHITE, 0.4)
  },
})
