/**
 * Warlock deaths by cause (VFX workstream C). Replaces the built-in
 * MatchWorld.deathBurst: this module claims EVERY 'death' event and draws it
 * in frame(), after all modules saw the event, unless a spell module claimed
 * it with deathKit.claimDeath(e) to draw its own.
 *
 * Every death = a cause-specific body + the shared soul-release layer
 * (deathKit.disintegrate): the dissolve edge burns in the killing spell's
 * palette accent, the escaping wisps and runes carry the victim's colour.
 *
 *   lava        splash crown, burning ring on the lava, the robe burns while
 *               the body thrashes and sinks, smoke plume (lava-coloured;
 *               victim-colour wisps)
 *   fireball    blown apart along the hit into burning embers and robe
 *               scraps, warm shock ring, charred heap that smoulders and fades
 *   scourge     implosion, shadow burn eating the body from the edges,
 *               crimson veined sigil
 *   obstacle    thrown, crumbles into grit and a slumping dust cloud, dust pile
 *   disconnect  quiet fade to smoke (no flash, no shake)
 *   anything else (generic): spell-accent burst, crumbles into an ash pile
 *               that blows away; looks the character already has (lightning
 *               x-ray, snowball freeze, meteor, gravity, drain) get their kit
 *               piece until the spell's own module claims its death
 *
 * Total <= 3 s; every leftover fades by then.
 */
import type { EntityId } from '../../../sim/types'
import { deathKindFor } from '../../character'
import { LAVA_H, TILE_TOP_H } from '../../coords'
import { RING_EXPAND, RING_IMPLODE } from '../../scene/GroundFx'
import {
  BODY_H, ashPile, charHeap, crater, crumbleToDust, deathClaimed, deathTint, disintegrate, dissolvePawn, disposeDeathKit,
  emberBurst, fadeToSmoke, freezeShatter, initDeathKit, shadowBurn, sinkInLava, tickDeathKit, xrayFlash,
  type DeathEvent, type DeathLook, type DeathTint,
} from '../deathKit'
import { registerSpellVfx, type VfxCtx } from '../registry'

const MAX_PENDING = 16
interface Pending {
  e: DeathEvent | null
  /** lethal push direction (unit, or 0,0), resolved from the death's own tick */
  dx: number
  dy: number
}
const pending: Pending[] = []
for (let i = 0; i < MAX_PENDING; i++) pending.push({ e: null, dx: 0, dy: 0 })
let nPending = 0
const tint: DeathTint = { victim: [1, 1, 1], spell: [1, 1, 1], core: [1, 1, 1], spellId: '' }
const dir = { x: 0, y: 0 }
const rnd = Math.random

/**
 * Direction the lethal hit pushed the victim (unit, or 0,0 when unknown /
 * lava), from the events of the death's tick (call inside onEvent).
 */
function lethalDir(ctx: VfxCtx, e: DeathEvent, x: number, y: number): void {
  dir.x = 0
  dir.y = 0
  const id = e.pawn
  const set = (dx: number, dy: number): boolean => {
    const l = Math.hypot(dx, dy)
    if (l < 1e-3) return false
    dir.x = dx / l
    dir.y = dy / l
    return true
  }
  const st = ctx.state
  const evs = ctx.tickEvents
  for (let i = evs.length - 1; i >= 0; i--) {
    const r = evs[i]
    if (r.type === 'projectileHit' && r.target === id) {
      if (set(x - r.x, y - r.y)) return
      const pv = ctx.prev?.projectiles.find((p) => p.id === r.id)
      if (pv && set(pv.vx, pv.vy)) return
    } else if (r.type === 'beam' && r.target === id) {
      if (set(r.toX - r.fromX, r.toY - r.fromY)) return
    } else if (r.type === 'spellHit' && r.target === id) {
      const c = st?.pawns.find((p) => p.id === r.pawn)
      if (c && set(x - c.x, y - c.y)) return
    } else if (r.type === 'explosion' && Math.hypot(x - r.x, y - r.y) <= r.radius + 40) {
      if (set(x - r.x, y - r.y)) return
    } else if (r.type === 'damage' && r.target === id && r.kb > 0 && r.source !== null) {
      const c = st?.pawns.find((p) => p.owner === r.source)
      if (c && set(x - c.x, y - c.y)) return
    }
  }
  // last known knockback velocity
  const pp = ctx.prev?.pawns.find((p) => p.id === id)
  if (pp) set(pp.vx - pp.walkVx, pp.vy - pp.walkVy)
}

function lookFor(e: DeathEvent): DeathLook {
  return deathKindFor(e.cause, e.kb ?? 0) as DeathLook
}

/** Warm, coloured death flash (never a white-out), scaled by fx intensity. */
function flash(ctx: VfxCtx, x: number, y: number, h: number, c: readonly number[], k: number, radius = 300, size = 210, life = 0.35): void {
  const f = (0.45 + 0.55 * ctx.fx) * k
  ctx.flash(x, y, h, life, radius, size, c[0] * f, c[1] * f, c[2] * f)
}

function drawDeath(ctx: VfxCtx, e: DeathEvent, dx: number, dy: number): void {
  const p = ctx.pawn(e.pawn)
  const x = e.x ?? p?.x ?? 0
  const y = e.y ?? p?.y ?? 0
  const onLava = ctx.isLava(x, y)
  const base = onLava ? LAVA_H : TILE_TOP_H
  const kb = e.kb ?? 0
  const cause = e.cause ?? (p?.onLava ? 'lava' : '')
  deathTint(ctx, e, tint)
  dir.x = dx
  dir.y = dy
  const k = Math.max(0.6, Math.min(2, kb / 900))
  const look = cause === 'lava' ? 'lava' : lookFor(e)
  const s = tint.spell
  dissolvePawn(ctx, e.pawn, look, dir.x, dir.y, [s[0] * 5, s[1] * 5, s[2] * 5])

  if (cause === 'lava') return lavaDeath(ctx, e.pawn, x, y)
  if (cause === 'fireball') return fireballDeath(ctx, e.pawn, x, y, base, k, onLava, look)
  if (cause.startsWith('scourge')) return scourgeDeath(ctx, e.pawn, x, y, base, look)
  if (cause === 'obstacle') return obstacleDeath(ctx, e.pawn, x, y, base, k, onLava, look)
  if (cause === 'disconnect') return disconnectDeath(ctx, e.pawn, x, y, base)
  genericDeath(ctx, e.pawn, x, y, base, k, onLava, look)
}

function lavaDeath(ctx: VfxCtx, pawn: EntityId, x: number, y: number): void {
  sinkInLava(ctx, pawn, x, y, 1, tint)
  disintegrate(ctx, pawn, x, y, LAVA_H, tint, { kind: 'lava', strength: 0.75 })
  // no sprite flash over bright lava (it only whites out): floor light only
  ctx.glow.add(x, y, 260, 0.8, 1.0, 0.35, 0.06)
  ctx.shakeNear(x, y, 0.25)
}

function fireballDeath(ctx: VfxCtx, pawn: EntityId, x: number, y: number, base: number, k: number, onLava: boolean, look: DeathLook): void {
  const c = tint.core
  const s = tint.spell
  emberBurst(ctx, x, y, base + 60, dir.x, dir.y, k, tint)
  // warm shock ring + a scorched, blown-out mark
  ctx.ground.spawn(RING_EXPAND, x, y, base + 1.5, 24, 210 * Math.min(1.4, k), 0.5, 18, s[0] * 3, s[1] * 3, s[2] * 3)
  ctx.ground.spawn(RING_EXPAND, x, y, base + 1.5, 10, 120, 0.35, 26, c[0] * 1.6, c[1] * 1.2, c[2] * 0.8)
  if (!onLava) {
    ctx.scorches.spawn(x + dir.x * 20, y + dir.y * 20, TILE_TOP_H + 0.6, 80 * Math.min(1.3, k), 3)
    // the body is thrown back along the hit: the heap lies where it lands
    charHeap(ctx, x + dir.x * 34 * k, y + dir.y * 34 * k, dir.x, dir.y, k, tint)
  }
  flash(ctx, x, y, base + 70, [s[0] * 1.2 + c[0] * 0.2, s[1] * 1.2 + c[1] * 0.2, s[2] * 1.2 + c[2] * 0.2], 0.8, 300, 150, 0.28)
  disintegrate(ctx, pawn, x, y, base, tint, { kind: look, strength: k })
  ctx.shakeNear(x, y, 0.22 * k)
  ctx.kick(dir.x, dir.y, 120 * k)
}

function scourgeDeath(ctx: VfxCtx, pawn: EntityId, x: number, y: number, base: number, look: DeathLook): void {
  shadowBurn(ctx, pawn, x, y, base, tint)
  disintegrate(ctx, pawn, x, y, base, tint, { kind: look, strength: 1 })
  flash(ctx, x, y, base + 70, tint.spell, 1.8, 260, 200, 0.3)
  ctx.shakeNear(x, y, 0.2)
}

/** pale stone dust: lighter than the dark tiles so the pile reads */
const DUST = [0.3, 0.27, 0.235] as const

function obstacleDeath(ctx: VfxCtx, pawn: EntityId, x: number, y: number, base: number, k: number, onLava: boolean, look: DeathLook): void {
  crumbleToDust(ctx, pawn, x, y, base, dir.x, dir.y, k, DUST)
  if (!onLava) {
    ashPile(ctx, x + dir.x * 20, y + dir.y * 20, { radius: 62, ash: DUST, embers: 0, windX: dir.x || 0.8, windY: dir.y || 0.35 })
    ctx.ground.spawn(RING_EXPAND, x, y, base + 1.2, 20, 150, 0.6, 14, 0.55, 0.48, 0.4)
  }
  disintegrate(ctx, pawn, x, y, base, tint, { kind: look, strength: 0.8, runes: 5 })
  flash(ctx, x, y, base + 60, [1.0, 0.8, 0.55], 0.7, 220, 120, 0.22)
  ctx.shakeNear(x, y, 0.25 * k)
}

function disconnectDeath(ctx: VfxCtx, pawn: EntityId, x: number, y: number, base: number): void {
  fadeToSmoke(ctx, pawn, x, y, base, tint)
  disintegrate(ctx, pawn, x, y, base, tint, { kind: 'ash', strength: 0.5, quiet: true })
}

function genericDeath(ctx: VfxCtx, pawn: EntityId, x: number, y: number, base: number, k: number, onLava: boolean, look: DeathLook): void {
  const s = tint.spell
  const c = tint.core
  // the killing spell's identity bursts out of the body
  const n = ctx.particles.budget(40 * k)
  const omni = dir.x === 0 && dir.y === 0
  const a0 = Math.atan2(dir.y, dir.x)
  for (let i = 0; i < n; i++) {
    const a = omni ? rnd() * Math.PI * 2 : a0 + (rnd() - 0.5) * 2.2
    const sp = 200 + rnd() * 500
    ctx.particles.spawn(x, y, base + 30 + rnd() * 80, Math.cos(a) * sp, Math.sin(a) * sp, 80 + rnd() * 280, 0.3 + rnd() * 0.4, 7 + rnd() * 5, 1, s[0] * 3.4, s[1] * 3.4, s[2] * 3.4, -700, 2.6, -0.1)
  }
  ctx.ground.spawn(RING_EXPAND, x, y, base + 1.5, 20, 200 * Math.min(1.3, k), 0.5, 16, s[0] * 2.4, s[1] * 2.4, s[2] * 2.4)
  flash(ctx, x, y, base + 70, [c[0] * 0.5 + s[0], c[1] * 0.5 + s[1], c[2] * 0.5 + s[2]], 1.2, 300, 210, 0.3)
  // looks the character already has get their kit piece
  if (look === 'lightning') xrayFlash(ctx, x, y, base, tint)
  else if (look === 'freeze') freezeShatter(ctx, x, y, base, k, tint)
  else if (look === 'meteor') {
    emberBurst(ctx, x, y, base + 50, dir.x, dir.y, k, tint)
    if (!onLava) crater(ctx, x, y, 90, 1)
  } else if (look === 'gravity') {
    ctx.ground.spawn(RING_IMPLODE, x, y, base + 1.5, 8, 160, 0.5, 14, s[0] * 2, s[1] * 2, s[2] * 2)
  } else if (look === 'fireball') {
    emberBurst(ctx, x, y, base + 60, dir.x, dir.y, k * 0.8, tint)
  }
  // crumble: ash flakes fall off the body, then the pile blows away
  const nd = ctx.debris.budget(26)
  for (let i = 0; i < nd; i++) {
    const a = rnd() * Math.PI * 2
    const sp = 30 + rnd() * 120
    const g = 0.1 + rnd() * 0.07
    ctx.debris.spawn(x + Math.cos(a) * 18, y + Math.sin(a) * 18, base + rnd() * BODY_H * 0.9, Math.cos(a) * sp, Math.sin(a) * sp, 40 + rnd() * 120, 0.6 + rnd() * 0.5, 3 + rnd() * 4, 1.5, g, g * 0.96, g * 0.92, -1200, 0.6, 0)
  }
  if (!onLava && look !== 'freeze' && look !== 'gravity') {
    ashPile(ctx, x, y, { radius: 52, windX: omni ? 0.8 : dir.x, windY: omni ? 0.35 : dir.y })
  }
  disintegrate(ctx, pawn, x, y, base, tint, { kind: look, strength: k })
  ctx.shakeNear(x, y, 0.2 * k)
}

registerSpellVfx({
  spell: '__deaths',
  init(ctx) {
    initDeathKit(ctx)
  },
  onEvent(e, ctx) {
    if (e.type !== 'death') return false
    if (nPending < MAX_PENDING) {
      const p = ctx.pawn(e.pawn)
      lethalDir(ctx, e, e.x ?? p?.x ?? 0, e.y ?? p?.y ?? 0)
      const r = pending[nPending++]
      r.e = e
      r.dx = dir.x
      r.dy = dir.y
    }
    // always claimed: the built-in deathBurst is replaced by this module
    return true
  },
  frame(ctx) {
    // drawn here, after every module saw the event (a spell module may claimDeath(e) it)
    for (let i = 0; i < nPending; i++) {
      const r = pending[i]
      if (r.e && !deathClaimed(r.e)) drawDeath(ctx, r.e, r.dx, r.dy)
      r.e = null
    }
    nPending = 0
    tickDeathKit(ctx)
  },
  dispose() {
    for (const r of pending) r.e = null
    nPending = 0
    disposeDeathKit()
  },
})
