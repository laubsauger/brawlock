/**
 * Link (column 6 Knockbackless; chain green). spells.md §8.28.
 * Windup (0.2 s cast point): chain links spin up and lock together around the hand.
 * Throw (sim r35 head, 950 u/s, retracts after 860 range): a glowing shackle head on an
 * energy chain paid out from the caster's hand (chain links + a green energy core in a
 * camera-facing ribbon). Latched ('link' modifier on the caster): the chain runs from the hand
 * to the linked warlock's chest (or the pillar), pulled taut, tension pulses running toward
 * whoever is being dragged, a shackle ring around the victim, sparks on each DPS tick.
 * Break (modifier removed): the chain snaps - links fly apart along the line, both ends flash.
 */
import * as THREE from 'three/webgpu'
import { abs, floor, fract, length, max, mix, pow, smoothstep, uv, vec2, vec3 } from 'three/tsl'
import type { Node } from 'three/webgpu'
import type { ModifierState, PawnState, ProjectileState, SimEvent } from '../../../sim/types'
import { PROJECTILE_H, S, TILE_TOP_H } from '../../coords'
import { registerSpellVfx, type VfxCtx } from '../registry'
import {
  InstPool, TAU, burst, castFlash, drawCore, glowG, hexRgb, kitAdopt, kitBegin, kitInit, kitRelease, light, mixRgb, originOf, pal,
  palMix, projShadow, rand,
} from './kitB'

const SPELL = 'link'
const H = PROJECTILE_H
// identity: chain green (vfx/palette.ts)
const CHAIN = pal('link', 'accent', 1.0)
const CHAIN_HOT = pal('link', 'core', 2.0)
const CHAIN_DIM = palMix('link', 0.0, 0.3)
const LINK_LEN = 22
const WIDTH = 16

interface Tether {
  seen: number
  ax: number
  ay: number
  ah: number
  bx: number
  by: number
  bh: number
  dpsTimer: number
  tickAt: number
  pullToCaster: number
}

let chains: InstPool | null = null
const tethers = new Map<number, Tether>()
let frameNo = 0
const team: [number, number, number] = [1, 1, 1]
const edge: [number, number, number] = [1, 1, 1]
const vA = new THREE.Vector3()
const vB = new THREE.Vector3()
const xA = new THREE.Vector3()
const yA = new THREE.Vector3()
const zA = new THREE.Vector3()
const mtx = new THREE.Matrix4()

/**
 * Chain ribbon (unit quad, x = along the chain). A0: x length (game units), y alpha,
 * z pulse direction (+1 toward x=0 end / -1), w tension 0..1.
 */
function chainMaterial(ctx: VfxCtx, A: Node<'vec4'>[]): THREE.Material {
  const [A0] = A
  const t = ctx.world.uTime
  const u = uv().x.mul(A0.x).div(LINK_LEN)
  const v = uv().y.sub(0.5).mul(2)
  const li = floor(u)
  const lu = fract(u).sub(0.5).mul(2)
  const odd = fract(li.mul(0.5)).mul(2)
  // face-on links: oval rings; edge-on links: short bars through the middle
  const oval = length(vec2(lu.mul(1.0), v.mul(1.25)))
  const ring = smoothstep(0.22, 0.05, abs(oval.sub(0.7)))
  const bar = smoothstep(0.32, 0.12, abs(v)).mul(smoothstep(1.05, 0.75, abs(lu)))
  const links = mix(ring, bar, odd)
  // energy core running through the chain + tension pulses
  const core = smoothstep(0.45, 0.0, abs(v))
  const pulse = pow(fract(u.mul(0.08).add(t.mul(2.2).mul(A0.z))), 10)
  const metal = vec3(0.05, 0.08, 0.06).add(vec3(...CHAIN).mul(0.4))
  const col = mix(metal, vec3(...CHAIN_HOT), pulse.mul(A0.w)).mul(links).add(vec3(...CHAIN).mul(core.mul(0.35).add(pulse.mul(core).mul(1.2).mul(A0.w))))
  const m = new THREE.MeshBasicNodeMaterial()
  m.transparent = true
  m.depthWrite = false
  m.side = THREE.DoubleSide
  m.colorNode = col
  m.opacityNode = max(links, core.mul(0.5)).mul(A0.y).mul(smoothstep(0.0, 0.02, uv().x)).mul(smoothstep(1.0, 0.98, uv().x))
  m.name = 'VfxB-LinkChain'
  return m
}

/** Camera-facing chain ribbon from A to B (three world units). */
function drawChain(ctx: VfxCtx, a: THREE.Vector3, b: THREE.Vector3, alpha: number, pulseDir: number, tension: number): void {
  if (!chains) return
  xA.subVectors(b, a)
  const len = xA.length()
  if (len < 1e-3) return
  xA.divideScalar(len)
  zA.subVectors(ctx.camera.position, a)
  zA.addScaledVector(xA, -zA.dot(xA)).normalize()
  yA.crossVectors(zA, xA).normalize()
  mtx.makeBasis(xA, yA, zA)
  chains.quat.setFromRotationMatrix(mtx)
  const i = chains.add((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2, len, WIDTH * S, 1)
  chains.set(i, 0, len / S, alpha, pulseDir, tension)
}

function snap(ctx: VfxCtx, t: Tether): void {
  const n = 10
  const ps = ctx.particles
  for (let k = 0; k <= n; k++) {
    const u = k / n
    const x = t.ax + (t.bx - t.ax) * u
    const y = t.ay + (t.by - t.ay) * u
    const h = t.ah + (t.bh - t.ah) * u
    const c = ps.budget(3)
    for (let j = 0; j < c; j++) {
      const a = Math.random() * TAU
      ps.spawn(x, y, h, Math.cos(a) * rand(80, 300), Math.sin(a) * rand(80, 300), rand(50, 250), rand(0.3, 0.6), rand(7, 12), 2, CHAIN_HOT[0], CHAIN_HOT[1], CHAIN_HOT[2], -900, 2, -0.06)
    }
    if (k % 2 === 0) ctx.debris.spawn(x, y, h, rand(-150, 150), rand(-150, 150), rand(100, 300), 0.7, 9, 6, 0.05, 0.09, 0.06, -1800, 1, 0)
  }
  ctx.flash(t.ax, t.ay, t.ah, 0.1, 120, 120, CHAIN[0], CHAIN[1], CHAIN[2])
  ctx.flash(t.bx, t.by, t.bh, 0.12, 140, 140, CHAIN[0], CHAIN[1], CHAIN[2])
}

/** End point of the link on its target: pawn chest or pillar mid-height (game units). */
function targetPoint(ctx: VfxCtx, mod: ModifierState, out: { x: number; y: number; h: number }): boolean {
  const id = mod.data.target
  if (mod.data.obstacle) {
    const st = ctx.state
    const o = st?.obstacles.find((q) => q.id === id)
    if (!o) return false
    out.x = o.x
    out.y = o.y
    out.h = TILE_TOP_H + 110
    return true
  }
  const info = ctx.pawn(id)
  if (!info) return false
  out.x = info.x
  out.y = info.y
  out.h = info.h + 75
  return true
}
const tp = { x: 0, y: 0, h: 0 }

registerSpellVfx({
  spell: SPELL,
  modifiers: [SPELL],
  init(ctx: VfxCtx) {
    kitInit(ctx)
    chains = kitAdopt(new InstPool(new THREE.PlaneGeometry(1, 1), 1, 24, (A) => chainMaterial(ctx, A), 8, 'vfxB-link-chains'))
  },
  dispose() {
    chains = null
    tethers.clear()
    kitRelease()
  },
  onEvent(e: SimEvent, ctx: VfxCtx): boolean | void {
    switch (e.type) {
      case 'cast':
        if (e.spell !== SPELL) return
        castFlash(ctx, e.pawn, CHAIN, 0.8)
        return true
      case 'projectileHit':
      case 'projectileExpire':
        if (e.spell !== SPELL) return
        burst(ctx, e.x, e.y, H, e.type === 'projectileHit' && e.target !== null ? 20 : 6, 120, 380, 0.2, 0.4, 8, 2, CHAIN_HOT, 0.9, -600, 3, -0.08, 0, 160)
        if (e.type === 'projectileHit' && e.target !== null) ctx.flash(e.x, e.y, H, 0.1, 140, 120, CHAIN[0], CHAIN[1], CHAIN[2])
        return true
      case 'modifier': {
        if (e.id !== SPELL || e.on) return
        const t = tethers.get(e.pawn)
        if (t) {
          snap(ctx, t)
          tethers.delete(e.pawn)
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
    for (const [id, t] of tethers) if (frameNo - t.seen > 30) tethers.delete(id)
    // windup: chain links locking together around the hand
    const st = ctx.state
    if (!st) return
    for (const pw of st.pawns) {
      const c = pw.cast
      if (!pw.alive || !c || c.spell !== SPELL || !c.started) continue
      const info = ctx.pawn(pw.id)
      if (!info) continue
      const o = originOf(info)
      const k = 1 - c.ticksLeft / 12
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * TAU + ctx.now * (4 + 3 * k)
        const rr = 40 * (1 - 0.5 * k)
        glowG(o.x / S + Math.cos(a) * rr, -o.z / S + Math.sin(a) * rr, o.y / S + Math.sin(a * 2) * 8, 22, CHAIN, 0.6 + 0.4 * k, 0.12, 1, 1.6, a)
      }
      glowG(o.x / S, -o.z / S, o.y / S, 50 + 40 * k, CHAIN_HOT, 0.3 + 0.4 * k, 2.2)
    }
  },
  drawProjectile(p: ProjectileState, x: number, y: number, ctx: VfxCtx) {
    const info = ctx.pawnOf(p.owner)
    hexRgb(ctx.colorOf(p.owner), team)
    mixRgb(CHAIN, team, 0.3, edge)
    drawCore(x, y, H, p.radius * 0.7, edge, CHAIN_HOT, p.id % 7)
    glowG(x, y, H, p.radius * 3.4, CHAIN, 0.35, 1.6)
    glowG(x, y, H, p.radius * 2.4, CHAIN_HOT, 0.4, 0.1, 1, 1, ctx.now * 5)
    light(ctx, x, y, 160, 0.6, CHAIN, 0.4)
    projShadow(ctx, x, y, H, p.radius * 0.7)
    if (info) {
      const o = originOf(info)
      vA.copy(o)
      vB.set(x * S, H * S, -y * S)
      drawChain(ctx, vA, vB, 1, p.data.retracting ? 1 : -1, 0.4)
    }
  },
  drawModifier(pawn: PawnState, mod: ModifierState, _x: number, _y: number, ctx: VfxCtx) {
    const info = ctx.pawn(pawn.id)
    if (!info || !targetPoint(ctx, mod, tp)) return
    let t = tethers.get(pawn.id)
    if (!t) {
      t = { seen: frameNo, ax: 0, ay: 0, ah: 0, bx: 0, by: 0, bh: 0, dpsTimer: mod.data.dpsTimer ?? 0, tickAt: -10, pullToCaster: 1 }
      tethers.set(pawn.id, t)
    }
    t.seen = frameNo
    const o = originOf(info)
    t.ax = o.x / S
    t.ay = -o.z / S
    t.ah = o.y / S
    t.bx = tp.x
    t.by = tp.y
    t.bh = tp.h
    // pulses run toward whoever gets dragged: the victim (pawn link) or the caster (pillar)
    const toVictim = mod.data.obstacle ? -1 : 1
    if ((mod.data.dpsTimer ?? 0) > t.dpsTimer + 0.5) t.tickAt = ctx.now
    t.dpsTimer = mod.data.dpsTimer ?? 0
    vA.copy(o)
    vB.set(tp.x * S, tp.h * S, -tp.y * S)
    drawChain(ctx, vA, vB, 1, -toVictim, 1)
    // shackle around the victim / pillar
    glowG(tp.x, tp.y, tp.h, mod.data.obstacle ? 200 : 110, CHAIN, 0.8, 0.07, 1, 1, ctx.now * 2)
    glowG(tp.x, tp.y, tp.h, 90, CHAIN_DIM, 1.2, 1.5)
    const tick = Math.max(0, 1 - (ctx.now - t.tickAt) / 0.15)
    if (tick > 0.95 && mod.data.dps > 0) burst(ctx, tp.x, tp.y, tp.h, 8, 100, 260, 0.15, 0.3, 8, 2, CHAIN_HOT, 1, -500, 3, -0.08)
    glowG(tp.x, tp.y, tp.h, 70, CHAIN_HOT, 0.4 * tick, 2.2)
    light(ctx, tp.x, tp.y, 150, 0.5 + 0.6 * tick, CHAIN, 0.4)
  },
})
