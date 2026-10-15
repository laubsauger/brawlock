/**
 * Cause-specific deaths for workstream A's spells, built on the shared
 * deathKit (one visual language: dissolve edge in the killing spell's
 * accent, victim-colour wisps and runes). Every death <= 3 s.
 *
 *   boomerang  sliced: a copper cut flashes across the body, it collapses
 *              into dust along the throw
 *   lightning  skeleton x-ray flash, then an ash pile
 *   homing     engulfed: magenta burst swallows the body, embers
 *   twin       caught in the crossfire: two ember bursts from both arcs
 *   thrust     slammed: flung along the hit, crumbles, small crater
 *   cluster    riddled with embers from several directions, charred heap
 *   bouncer    riddled with yellow sparks, charred heap
 *   drain      withers: shadow-burn veins eat the body, crumbles to dust
 *   recharge   unravels into purple runes and sparks
 * Swap, Redirector and Pact never deal the lethal damage themselves.
 */
import type { SimEvent } from '../../../sim/types'
import { LAVA_H, TILE_TOP_H } from '../../coords'
import {
  BODY_H, ashPile, charHeap, claimDeath, crater, crumbleToDust, deathTint, disintegrate, dissolvePawn, emberBurst,
  shadowBurn, soulRunes, xrayFlash, type DeathLook, type DeathTint,
} from '../deathKit'
import type { VfxCtx } from '../registry'
import { G_CROSS, G_SHOCK, kflash, palFor, type KitA } from './kitA'

type DeathEvent = Extract<SimEvent, { type: 'death' }>

const tint: DeathTint = { victim: [1, 1, 1], spell: [1, 1, 1], core: [1, 1, 1], spellId: '' }

const LOOK: Record<string, DeathLook> = {
  boomerang: 'ash',
  lightning: 'lightning',
  homing: 'fireball',
  twin: 'fireball',
  thrust: 'ash',
  cluster: 'fireball',
  bouncer: 'fireball',
  drain: 'drain',
  recharge: 'ash',
}

/** Draw and claim a death whose cause is one of our spells. Returns false if not ours. */
export function spellDeath(k: KitA, ctx: VfxCtx, e: DeathEvent): boolean {
  const cause = e.cause ?? ''
  const look = LOOK[cause]
  if (!look) return false
  claimDeath(e)
  const p = ctx.pawn(e.pawn)
  const x = e.x ?? p?.x ?? 0
  const y = e.y ?? p?.y ?? 0
  const onLava = ctx.isLava(x, y)
  const base = onLava ? LAVA_H : TILE_TOP_H
  deathTint(ctx, e, tint)
  // direction of the lethal hit we drew a moment ago (else omni)
  let dx = 0
  let dy = 0
  if (k.lastHit.target === e.pawn && ctx.now - k.lastHit.t < 0.25) {
    dx = k.lastHit.x
    dy = k.lastHit.y
  }
  const kbk = Math.max(0.6, Math.min(2, (e.kb ?? 0) / 900))
  const s = tint.spell
  dissolvePawn(ctx, e.pawn, look, dx, dy, [s[0] * 5, s[1] * 5, s[2] * 5])
  const P = palFor(cause)
  const fx = 0.45 + 0.55 * ctx.fx
  switch (cause) {
    case 'boomerang': {
      // the cut: a bright copper slash across the chest, perpendicular to the throw
      const px = -dy || 1
      const py = dx
      k.stripBegin(false, 1.6, 0, 0)
      for (let i = 0; i <= 6; i++) {
        const f = i / 6 - 0.5
        k.stripPoint(x + px * f * 120, y + py * f * 120, base + 70 + f * 40, 16 * (1 - Math.abs(f) * 1.6), P.hot[0], P.hot[1], P.hot[2], 2.2)
      }
      k.stripEnd()
      k.pulse(G_CROSS, true, x, y, base + 70, 70, 90, 0.25, Math.atan2(py, px) + Math.PI / 4, 0, P.body, 1.4, 1, 1, 0)
      crumbleToDust(ctx, e.pawn, x, y, base, dx, dy, kbk, [0.22, 0.14, 0.1])
      disintegrate(ctx, e.pawn, x, y, base, tint, { kind: look, strength: 0.9 })
      kflash(ctx, x, y, base + 70, 0.2, 200, 120, P.body[0] * fx, P.body[1] * fx, P.body[2] * fx)
      break
    }
    case 'lightning':
      xrayFlash(ctx, x, y, base, tint)
      if (!onLava) ashPile(ctx, x, y, { radius: 46, life: 2.8, embers: 6 })
      disintegrate(ctx, e.pawn, x, y, base, tint, { kind: look })
      kflash(ctx, x, y, base + 80, 0.18, 220, 130, P.body[0] * fx, P.body[1] * fx, P.body[2] * fx)
      ctx.shakeNear(x, y, 0.2)
      break
    case 'homing':
      // engulfed: a magenta burst swallows the body
      emberBurst(ctx, x, y, base + 60, dx, dy, kbk, tint)
      emberBurst(ctx, x, y, base + 90, 0, 0, 0.8, tint)
      k.pulse(G_SHOCK, false, x, y, (onLava ? LAVA_H + 2 : TILE_TOP_H + 1.5), 110, 110, 0.4, 0, 0, P.body, 1.2, 0.1, 0.95, 0.08)
      if (!onLava) charHeap(ctx, x, y, dx, dy, kbk, tint, 2.8)
      disintegrate(ctx, e.pawn, x, y, base, tint, { kind: look })
      kflash(ctx, x, y, base + 70, 0.3, 280, 200, P.body[0] * fx, P.body[1] * fx, P.body[2] * fx)
      ctx.shakeNear(x, y, 0.3)
      break
    case 'twin': {
      // two bolts, two bursts from the mirrored sides
      const c = Math.cos(0.7)
      const sn = Math.sin(0.7)
      emberBurst(ctx, x, y, base + 60, dx * c - dy * sn, dx * sn + dy * c, kbk, tint)
      emberBurst(ctx, x, y, base + 60, dx * c + dy * sn, -dx * sn + dy * c, kbk, tint)
      if (!onLava) charHeap(ctx, x, y, dx, dy, kbk, tint, 2.8)
      disintegrate(ctx, e.pawn, x, y, base, tint, { kind: look })
      kflash(ctx, x, y, base + 70, 0.26, 240, 160, P.body[0] * fx, P.body[1] * fx, P.body[2] * fx)
      break
    }
    case 'thrust':
      crumbleToDust(ctx, e.pawn, x, y, base, dx, dy, Math.max(1.2, kbk), [0.18, 0.2, 0.22])
      if (!onLava) crater(ctx, x, y, 70, 0.3, [0.16, 0.18, 0.2])
      disintegrate(ctx, e.pawn, x, y, base, tint, { kind: look, strength: 1.1 })
      kflash(ctx, x, y, base + 70, 0.2, 220, 130, P.body[0] * fx, P.body[1] * fx, P.body[2] * fx)
      ctx.shakeNear(x, y, 0.35)
      break
    case 'cluster':
    case 'bouncer': {
      // riddled: embers burst out from several sides
      for (let i = 0; i < 3; i++) {
        const a = Math.atan2(dy, dx) + (i - 1) * 1.1 + (Math.random() - 0.5) * 0.4
        emberBurst(ctx, x, y, base + 40 + i * 25, Math.cos(a), Math.sin(a), 0.7, tint)
      }
      if (!onLava) charHeap(ctx, x, y, dx, dy, kbk, tint, 2.8)
      disintegrate(ctx, e.pawn, x, y, base, tint, { kind: look })
      kflash(ctx, x, y, base + 70, 0.24, 220, 150, P.body[0] * fx, P.body[1] * fx, P.body[2] * fx)
      break
    }
    case 'drain':
      shadowBurn(ctx, e.pawn, x, y, base, tint)
      crumbleToDust(ctx, e.pawn, x, y, base, 0, 0, 0.7, [0.16, 0.18, 0.12])
      if (!onLava) ashPile(ctx, x, y, { radius: 50, life: 2.8, ash: [0.13, 0.15, 0.1], embers: 0 })
      disintegrate(ctx, e.pawn, x, y, base, tint, { kind: look, strength: 0.8 })
      break
    case 'recharge':
      emberBurst(ctx, x, y, base + 60, dx, dy, kbk * 0.8, tint)
      soulRunes(ctx, x, y, base + BODY_H * 0.6, P.body, 10)
      disintegrate(ctx, e.pawn, x, y, base, tint, { kind: look, runes: 10 })
      kflash(ctx, x, y, base + 70, 0.24, 220, 150, P.body[0] * fx, P.body[1] * fx, P.body[2] * fx)
      break
  }
  return true
}
