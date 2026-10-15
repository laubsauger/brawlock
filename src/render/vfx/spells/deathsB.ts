/**
 * Cause-specific deaths for workstream B's spells, on the shared deathKit (dissolve edge in the
 * killing spell's accent, victim-colour wisps and runes). Every death <= 3 s.
 *
 *   meteor    crushed: a smoking crater with a molten centre, embers and rock blasting out
 *   splitter  shredded: the body bursts into magenta darts and sparks, ash settles
 *   snowball  frozen solid, then shatters into ice shards and mist
 *   windwalk  blown away: the warlock smears into grey wind-smoke along the charge
 *   gravity   stretched and sucked into the singularity: light and dust spiral into the orb
 *   link      yanked apart: green chain sparks burst out of the body toward the caster
 * Shield / Rush / Alteration / Warpzone / Magnetize / Grip / Rockpillar deal no lethal damage of
 * their own (pillar explosions report cause 'obstacle', drawn by deaths.ts).
 */
import type { SimEvent } from '../../../sim/types'
import { LAVA_H, TILE_TOP_H } from '../../coords'
import {
  BODY_H, charHeap, claimDeath, crater, crumbleToDust, deathTint, disintegrate, dissolvePawn, emberBurst, freezeShatter,
  type DeathLook, type DeathTint,
} from '../deathKit'
import { registerSpellVfx, type VfxCtx } from '../registry'
import { TAU, burst, implode, kitBegin, kitInit, kitRelease, pal, rand } from './kitB'

type DeathEvent = Extract<SimEvent, { type: 'death' }>

const LOOK: Record<string, DeathLook> = {
  meteor: 'meteor',
  splitter: 'ash',
  snowball: 'freeze',
  windwalk: 'ash',
  gravity: 'gravity',
  link: 'ash',
}

const tint: DeathTint = { victim: [1, 1, 1], spell: [1, 1, 1], core: [1, 1, 1], spellId: '' }
const SPLIT = pal('splitter', 'core', 2)
const WIND = pal('windwalk', 'accent', 0.25)
const GRAV = pal('gravity', 'core', 1.6)
const CHAIN = pal('link', 'core', 2)

/** Lethal direction: from the killer's pawn toward the victim (0, 0 when unknown). */
function hitDir(ctx: VfxCtx, e: DeathEvent, x: number, y: number, out: { x: number; y: number }): void {
  out.x = 0
  out.y = 0
  if (e.killer === null) return
  const k = ctx.pawnOf(e.killer)
  if (!k) return
  const dx = x - k.x
  const dy = y - k.y
  const l = Math.hypot(dx, dy)
  if (l > 1) {
    out.x = dx / l
    out.y = dy / l
  }
}
const dir = { x: 0, y: 0 }

/** Nearest live Gravity orb to (x, y) owned by the killer (the singularity that ate them). */
function orbNear(ctx: VfxCtx, killer: number | null, x: number, y: number, out: { x: number; y: number }): boolean {
  const st = ctx.state
  if (!st) return false
  let best = 1e12
  for (const p of st.projectiles) {
    if (p.spell !== 'gravity' || (killer !== null && p.owner !== killer)) continue
    const d = (p.x - x) * (p.x - x) + (p.y - y) * (p.y - y)
    if (d < best) {
      best = d
      out.x = p.x
      out.y = p.y
    }
  }
  return best < 600 * 600
}
const orb = { x: 0, y: 0 }

function spellDeath(ctx: VfxCtx, e: DeathEvent): boolean {
  const cause = e.cause ?? ''
  const look = LOOK[cause]
  if (!look) return false
  claimDeath(e)
  const p = ctx.pawn(e.pawn)
  const x = e.x ?? p?.x ?? 0
  const y = e.y ?? p?.y ?? 0
  const base = ctx.isLava(x, y) ? LAVA_H : TILE_TOP_H
  deathTint(ctx, e, tint)
  hitDir(ctx, e, x, y, dir)
  const kbk = Math.max(0.6, Math.min(2, (e.kb ?? 0) / 900))
  const s = tint.spell
  dissolvePawn(ctx, e.pawn, look, dir.x, dir.y, [s[0] * 5, s[1] * 5, s[2] * 5])
  const mid = base + BODY_H * 0.5
  switch (cause) {
    case 'meteor':
      crater(ctx, x, y, 120, 1)
      charHeap(ctx, x, y, dir.x, dir.y, 1.4, tint, 3)
      emberBurst(ctx, x, y, base + 40, 0, 0, 1.6, tint)
      disintegrate(ctx, e.pawn, x, y, base, tint, { kind: look, strength: 1.2 })
      ctx.shakeNear(x, y, 0.3)
      break
    case 'splitter': {
      // shredded: magenta darts tear out in a fan along the hit, sparks everywhere
      const ps = ctx.particles
      const n = ps.budget(40)
      const a0 = Math.atan2(dir.y, dir.x)
      for (let i = 0; i < n; i++) {
        const a = dir.x || dir.y ? a0 + rand(-0.9, 0.9) : Math.random() * TAU
        const sp = rand(300, 900)
        ps.spawn(x, y, mid, Math.cos(a) * sp, Math.sin(a) * sp, rand(0, 260), rand(0.25, 0.5), rand(8, 14), 2, SPLIT[0], SPLIT[1], SPLIT[2], -700, 2.5, -0.1)
      }
      emberBurst(ctx, x, y, mid, dir.x, dir.y, kbk, tint)
      crumbleToDust(ctx, e.pawn, x, y, base, dir.x, dir.y, kbk, [0.16, 0.08, 0.15])
      disintegrate(ctx, e.pawn, x, y, base, tint, { kind: look, strength: 1 })
      break
    }
    case 'snowball':
      freezeShatter(ctx, x, y, base, 1.2, tint)
      disintegrate(ctx, e.pawn, x, y, base, tint, { kind: look, strength: 1 })
      break
    case 'windwalk': {
      // blown away into grey wind-smoke along the charge
      const sm = ctx.smoke
      const n = sm.budget(16)
      for (let i = 0; i < n; i++) {
        const sp = rand(120, 420)
        sm.spawn(x + rand(-20, 20), y + rand(-20, 20), base + rand(20, BODY_H), dir.x * sp + rand(-60, 60), dir.y * sp + rand(-60, 60), rand(10, 80), rand(0.8, 1.4), 40, 120, WIND[0] * 0.6, WIND[1] * 0.6, WIND[2] * 0.6, 0, 1.6, 10)
      }
      crumbleToDust(ctx, e.pawn, x, y, base, dir.x, dir.y, kbk, [0.2, 0.2, 0.21])
      disintegrate(ctx, e.pawn, x, y, base, tint, { kind: look, strength: 0.9 })
      break
    }
    case 'gravity': {
      // stretched and sucked into the singularity
      const has = orbNear(ctx, e.killer, x, y, orb)
      const tx = has ? orb.x : x
      const ty = has ? orb.y : y
      const ps = ctx.particles
      const n = ps.budget(46)
      for (let i = 0; i < n; i++) {
        const sx = x + rand(-25, 25)
        const sy = y + rand(-25, 25)
        const sh = base + rand(10, BODY_H)
        const life = rand(0.35, 0.6)
        ps.spawn(sx, sy, sh, (tx - sx) / life, (ty - sy) / life, (70 - sh) / life, life, rand(8, 14), 2, GRAV[0], GRAV[1], GRAV[2], 0, 0, -0.12)
      }
      implode(ctx, tx, ty, 70, 24, 60, 140, 0.3, 10, GRAV, 1)
      disintegrate(ctx, e.pawn, x, y, base, tint, { kind: look, strength: 1.1 })
      break
    }
    case 'link': {
      // yanked apart into chain sparks, flung toward the puller
      burst(ctx, x, y, mid, 30, 200, 650, 0.3, 0.6, 9, 2, CHAIN, 1, -900, 2, -0.08, 40, 260)
      emberBurst(ctx, x, y, mid, -dir.x, -dir.y, kbk, tint)
      crumbleToDust(ctx, e.pawn, x, y, base, -dir.x, -dir.y, kbk, [0.12, 0.16, 0.12])
      disintegrate(ctx, e.pawn, x, y, base, tint, { kind: look, strength: 1 })
      break
    }
  }
  return true
}

registerSpellVfx({
  spell: '__deathsB',
  init(ctx: VfxCtx) {
    kitInit(ctx)
  },
  dispose() {
    kitRelease()
  },
  onEvent(e: SimEvent, ctx: VfxCtx): boolean | void {
    if (e.type !== 'death') return
    return spellDeath(ctx, e) ? true : undefined
  },
  frame(ctx: VfxCtx) {
    kitBegin(ctx)
  },
})
